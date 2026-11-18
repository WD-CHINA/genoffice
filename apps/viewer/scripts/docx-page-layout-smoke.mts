/** Real browser local/HTTP page-layout regression; no mocked parser or layout. */
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import { chromium } from 'playwright-core'
const output = resolve(process.env.WORD_EVIDENCE_DIR || '/tmp/genoffice-word-pages')
const viewer = process.env.VIEWER_URL || 'http://127.0.0.1:11001/'
const backend = process.env.PARSE_SERVER_URL || viewer.replace(/\/$/, '')
const root = resolve(import.meta.dirname, '../../..')
await mkdir(output, { recursive: true })
const inputs = [
  '05-long-table',
  '06-with-footnotes',
  '08-multi-section-paper',
  '21-continuous-section',
  '22-two-columns',
  '23-tblheader-repeat',
].map((name) => ({
  name,
  path: join(root, 'apps/docs/tests/pagination-corpus/docx', name + '.docx'),
}))
if (process.env.WORD_BUSINESS_FILE)
  inputs.unshift({ name: 'business', path: process.env.WORD_BUSINESS_FILE })
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
})
const results: any[] = []
try {
  for (const input of inputs) {
    const bytes = await readFile(input.path)
    const uploaded = await fetch(backend + '/v1/files', { method: 'POST', body: bytes })
    assert.equal(uploaded.status, 201)
    const file = (await uploaded.json()) as { fileId: string; sha256: string }
    assert.equal(file.sha256, createHash('sha256').update(bytes).digest('hex'))
    for (const mode of ['local', 'server']) {
      const context = await browser.newContext({
        viewport: { width: 1200, height: 900 },
        locale: 'zh-CN',
        deviceScaleFactor: 2,
      })
      const page = await context.newPage(),
        errors: string[] = [],
        requests: any[] = []
      page.on('pageerror', (e) => errors.push(e.message))
      page.on('response', (r) => {
        if (r.url().includes('/v1/'))
          requests.push({ url: r.url(), method: r.request().method(), status: r.status() })
      })
      try {
        if (mode === 'local') {
          await page.goto(viewer)
          await page.getByLabel('打开文件', { exact: true }).setInputFiles(input.path)
        } else
          await page.goto(
            new URL('preview.html?fileId=' + file.fileId + '&view=read&theme=light', viewer).href,
          )
        let frame: any
        for (let i = 0; i < 180; i++) {
          frame =
            mode === 'local'
              ? page.frames().find((f) => f.url().includes('preview.html'))
              : page.mainFrame()
          if (frame && (await frame.locator('.pv-page .pv-content').count())) break
          await page.waitForTimeout(300)
        }
        assert.ok(frame, 'Word frame missing')
        await frame
          .locator('.pv-page .pv-content')
          .first()
          .waitFor({ state: 'visible', timeout: 60000 })
        await page.waitForTimeout(1000)
        const state = await frame.evaluate(async () => {
          await document.fonts.ready
          const source = document.querySelector<HTMLElement>(
              '.viewer-doc-electron-source .ProseMirror',
            )!,
            clone = document.querySelector<HTMLElement>('.pv-page .pv-content')!
          return {
            pages: document.querySelectorAll('.pv-page').length,
            paper: document.querySelector('.pv-page')!.getBoundingClientRect().toJSON(),
            blocks: source.children.length,
            source: [...source.children].slice(0, 12).map((n) => ({
              idx: (n as HTMLElement).dataset.idx,
              h: n.getBoundingClientRect().height,
            })),
            clone: [...clone.children].slice(0, 12).map((n) => ({
              idx: (n as HTMLElement).dataset.idx,
              h: n.getBoundingClientRect().height,
            })),
            pitch: [source, clone].map((e) =>
              getComputedStyle(e).getPropertyValue('--doc-grid-pitch'),
            ),
            editable: document.querySelectorAll('[contenteditable="true"]').length,
            modeSwitch: !!document.querySelector('[aria-label="Word 显示模式"]'),
            continuous: !!document.querySelector('.viewer-doc-reading-paper'),
            fonts: document.fonts.status,
            alerts: [...document.querySelectorAll('[role=alert]')].map((e) => e.textContent),
          }
        })
        assert.ok(state.pages > 0)
        assert.equal(state.editable, 0)
        assert.equal(state.modeSwitch, false)
        assert.equal(state.continuous, false)
        assert.equal(state.fonts, 'loaded')
        assert.deepEqual(state.alerts, [])
        // The original failure measured a grid but drew the clone without it.
        assert.equal(state.pitch[1], state.pitch[0])
        if (input.name === 'business') assert.deepEqual(state.clone, state.source)
        const before = await frame.locator('.viewer-doc-pages').textContent()
        await frame
          .locator('.pv-page .pv-content')
          .first()
          .click({ position: { x: 30, y: 15 }, force: true })
        await page.keyboard.type('READ_ONLY_PROBE')
        await page.keyboard.press('Backspace')
        assert.equal(await frame.locator('.viewer-doc-pages').textContent(), before)
        await page.screenshot({ path: join(output, input.name + '-' + mode + '-first.png') })
        await frame.evaluate(() => {
          const s = document.querySelector('.pv-scroll')!
          s.scrollTop = s.scrollHeight
        })
        await page.waitForTimeout(800)
        const last = await frame
          .locator('.pv-page')
          .last()
          .evaluate((e: HTMLElement) => ({
            mounted: e.children.length,
            text: e.textContent?.slice(-180),
            footer: e.querySelector('.page-hf-footer')?.textContent,
          }))
        assert.ok(last.mounted)
        assert.ok(last.text?.trim(), 'Last page is blank')
        await page.screenshot({ path: join(output, input.name + '-' + mode + '-last.png') })
        if (mode === 'server') {
          assert.ok(
            requests.some((r) => r.method === 'POST' && r.url.includes('/v1/sessions')),
            'No actual HTTP session',
          )
          assert.ok(
            requests.some((r) => r.url.includes('/styles')),
            'No actual HTTP styles',
          )
          assert.equal(
            requests.filter((r) => r.url.endsWith('/content')).length,
            0,
            'HTTP model fell back to local source parsing',
          )
        }
        assert.deepEqual(errors, [])
        results.push({ name: input.name, mode, fileId: file.fileId, state, last, requests })
        await writeFile(join(output, 'browser-results.json'), JSON.stringify(results, null, 2))
        console.log(input.name, mode, state.pages, 'pages; readonly and tail PASS')
      } finally {
        await context.close()
      }
    }
  }
} finally {
  await browser.close()
}
