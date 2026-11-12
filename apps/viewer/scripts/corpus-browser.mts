/** Browser evidence for a local corpus-drill JSON; source documents stay outside the repository. */
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'
import { PAGE_MARK, TOTAL_PAGES_MARK } from '@genoffice/docx-engine'
import { formatNoteNumber } from '@genoffice/viewer-renderers/docs/renderer/note-format'

const option = (name: string, fallback = '') => {
  const index = process.argv.indexOf(`--${name}`)
  return index < 0 ? fallback : (process.argv[index + 1] ?? fallback)
}
if (!option('corpus')) throw new Error('--corpus is required')
const corpus = JSON.parse(await readFile(resolve(option('corpus')), 'utf8')) as any
if (!corpus.documents && corpus.samples)
  corpus.documents = corpus.samples.map((sample: any) => ({ ...sample, format: 'docx' }))
const output = resolve(option('out', '/tmp/genoffice-corpus-browser'))
const token = process.env.PARSE_SERVER_TOKEN ?? ''
const serverUrl = option('server', corpus.base ?? 'http://127.0.0.1:18787')
process.env.PARSE_SERVER_URL = serverUrl
await mkdir(output, { recursive: true })
const frontend = await createServer({
  configFile: resolve(import.meta.dirname, '../vite.config.ts'),
  server: {
    host: '127.0.0.1',
    port: Number(process.env.VIEWER_TEST_PORT || 11019),
    strictPort: true,
  },
})
await frontend.listen()
const viewerOrigin = `http://127.0.0.1:${(frontend.httpServer!.address() as { port: number }).port}`
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.CHROME_PATH ||
    (process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : undefined),
})
const report: any = {
  startedAt: new Date().toISOString(),
  status: 'running',
  samples: [],
  scope:
    'Representative business pages; optional playback smoke; no independent Office visual baseline',
}
try {
  for (const document of corpus.documents.filter((item: any) => item.status === 'passed')) {
    if (option('only-name') && document.name !== option('only-name')) continue
    const indices: number[] =
      document.format === 'pptx'
        ? [...new Set([0, Math.floor(document.unitCount / 2), document.unitCount - 1])]
        : [0]
    for (const index of indices) {
      if (option('only-index') && index !== Number(option('only-index'))) continue
      const context = await browser.newContext({ viewport: { width: 1200, height: 900 } })
      await context.addInitScript(
        ({ fileId, page }) => {
          localStorage.setItem(
            'genoffice.reading-position.v1',
            JSON.stringify({
              [fileId]: { page, savedAt: Date.now() },
            }),
          )
        },
        { fileId: document.fileId, page: index },
      )
      const page = await context.newPage()
      const sample: any = {
        name: document.name,
        format: document.format,
        index,
        errors: [],
        httpErrors: [],
      }
      report.samples.push(sample)
      page.on('pageerror', (error) => sample.errors.push(error.message))
      page.on('response', (response) => {
        if (response.status() >= 400)
          sample.httpErrors.push({
            status: response.status(),
            origin: new URL(response.url()).origin,
            path: new URL(response.url()).pathname,
          })
      })
      try {
        const params = new URLSearchParams({
          parse: 'server',
          server: serverUrl,
          fileId: document.fileId,
          name: document.name,
          ...(token ? { token } : {}),
        })
        await page.goto(`${viewerOrigin}/?${params}`)
        const frame = page.frameLocator('iframe')
        if (document.format === 'docx') {
          await frame.locator('.viewer-doc-remote-page').first().waitFor({ timeout: 60_000 })
        } else {
          await frame.locator('canvas').first().waitFor({ timeout: 60_000 })
        }
        const contentFrame = page.frames().find((value) => value.url().includes('preview.html'))!
        await contentFrame.evaluate(async () => {
          await document.fonts.ready
        })
        if (document.format === 'pptx') {
          await contentFrame.waitForFunction(
            () => Boolean((window as any).__viewerPerformance?.stages?.currentPageImagesReady),
            undefined,
            { timeout: 60_000 },
          )
        }
        await page.waitForTimeout(1000)
        sample.screenshot = `${document.fileId.slice(0, 12)}-${index}.png`
        await page.screenshot({ path: join(output, sample.screenshot) })
        sample.metrics = await contentFrame.evaluate(() => ({
          canvasCount: document.querySelectorAll('canvas').length,
          pages: document.querySelectorAll('.viewer-doc-remote-page').length,
          fontCount: document.fonts.size,
          fontErrors: [...document.fonts]
            .filter((font) => font.status === 'error')
            .map((font) => font.family),
          alerts: [...document.querySelectorAll('[role="alert"]')].map(
            (element) => element.textContent,
          ),
          performance: (window as any).__viewerPerformance,
        }))
        if (process.argv.includes('--docx-layout') && document.format === 'docx') {
          const auth = token ? { Authorization: `Bearer ${token}` } : {}
          const opened = (await (
            await fetch(serverUrl + '/v1/sessions', {
              method: 'POST',
              headers: { ...auth, 'Content-Type': 'application/json' },
              body: JSON.stringify({ fileId: document.fileId }),
            })
          ).json()) as any
          const reading = opened.model.docx
          assert.ok(reading?.sections?.length, 'section model missing')
          await fetch(`${serverUrl}/v1/sessions/${opened.sessionId}`, {
            method: 'DELETE',
            headers: auth,
          })
          const observed = new Map<number, any>()
          const sections = new Set<number>()
          const images: any[] = []
          const strip = (text: string) => text.replace(/\s+/g, '')
          for (let step = 0; step < 100; step++) {
            const view = await contentFrame.evaluate(() => {
              const viewport = document.querySelector<HTMLElement>('.viewer-doc-remote-viewport')!
              return {
                top: viewport.scrollTop,
                height: viewport.clientHeight,
                total: viewport.scrollHeight,
                pages: [...document.querySelectorAll<HTMLElement>('.viewer-doc-remote-page')].map(
                  (paper) => ({
                    index: Number(paper.dataset.pageIndex),
                    section: Number(paper.dataset.sectionIndex),
                    number: paper.dataset.pageNumber,
                    width: paper.getBoundingClientRect().width,
                    height: paper.getBoundingClientRect().height,
                    columns: [
                      ...paper.querySelectorAll<HTMLElement>('.viewer-doc-remote-column'),
                    ].map((column) => ({
                      height: column.getBoundingClientRect().height,
                      bottomGap:
                        paper.getBoundingClientRect().bottom -
                        column.getBoundingClientRect().bottom,
                    })),
                    notes: [...paper.querySelectorAll<HTMLElement>('sup[data-note-ref]')].map(
                      (note) => ({
                        id: note.dataset.noteRef,
                        kind: note.dataset.noteKind,
                        text: note.textContent ?? '',
                      }),
                    ),
                    top: Number(
                      /translateY\(([-.\d]+)px\)/.exec(paper.parentElement!.style.transform)?.[1] ??
                        0,
                    ),
                    regions: [
                      ...paper.querySelectorAll<HTMLElement>('.viewer-doc-remote-region'),
                    ].map((region) => ({
                      section: Number(region.dataset.sectionIndex),
                      columns: Number(region.dataset.columns),
                    })),
                    parts: [...paper.querySelectorAll<HTMLElement>('[data-hf-part]')].map(
                      (part) => ({ id: part.dataset.hfPart!, text: part.textContent ?? '' }),
                    ),
                    images: [...paper.querySelectorAll<HTMLImageElement>('[data-hf-part] img')].map(
                      (image) => ({
                        complete: image.complete,
                        width: image.naturalWidth,
                        url: image.src.split('?')[0],
                      }),
                    ),
                  }),
                ),
              }
            })
            for (const paper of view.pages) {
              observed.set(paper.index, paper)
              assert.ok(
                Math.abs(paper.width - reading.sections[paper.section].settings.pageWidth / 15) < 2,
                'wrong section paper width',
              )
              assert.ok(
                paper.columns.every((column) => column.bottomGap >= -2),
                'body column overflows its paper',
              )
              for (const region of paper.regions) {
                sections.add(region.section)
                assert.equal(region.columns, reading.sections[region.section].settings.columns)
              }
              for (const part of paper.parts) {
                const expected = reading.hfParts[part.id].text
                  .replaceAll(TOTAL_PAGES_MARK, String(observed.size))
                  .replaceAll(PAGE_MARK, paper.number)
                // NUMPAGES can still grow while later chunks are being indexed.
                if (!reading.hfParts[part.id].text.includes(TOTAL_PAGES_MARK))
                  assert.ok(
                    strip(part.text).includes(strip(expected)),
                    `header/footer ${part.id} text/field mismatch`,
                  )
              }
              for (const note of paper.notes) {
                const number = reading.noteNumbers[`${note.kind}:${note.id}`]
                const fmt =
                  note.kind === 'endnote'
                    ? (reading.endnoteProps?.numFmt ?? 'lowerRoman')
                    : (reading.footnoteProps?.numFmt ?? 'decimal')
                assert.equal(
                  note.text,
                  formatNoteNumber(fmt, number),
                  'rendered note marker differs',
                )
              }
              images.push(...paper.images)
            }
            if (view.top + view.height >= view.total - 2) break
            await contentFrame.locator('.viewer-doc-remote-viewport').evaluate((element) => {
              element.scrollTop += Math.max(100, element.clientHeight * 0.8)
            })
            await page.waitForTimeout(200)
          }
          assert.equal(
            sections.size,
            reading.sections.length,
            'not every source section was rendered',
          )
          for (const paper of observed.values())
            for (const part of paper.parts) {
              const expected = reading.hfParts[part.id].text
                .replaceAll(TOTAL_PAGES_MARK, String(observed.size))
                .replaceAll(PAGE_MARK, paper.number)
              assert.ok(
                strip(part.text).includes(strip(expected)),
                `header/footer ${part.id} final PAGE/NUMPAGES mismatch`,
              )
            }
          if (
            reading.sections.length === 1 &&
            reading.sections[0].settings.columns === 2 &&
            observed.size === 1
          )
            assert.equal(
              [...observed.values()][0].columns.filter((column: any) => column.height > 0).length,
              2,
              'final two-column page did not balance',
            )
          assert.ok(
            images.every((image) => image.complete && image.width > 0),
            `header/footer image did not decode: ${JSON.stringify(images.filter((image) => !image.complete || !image.width))}`,
          )
          sample.layoutAudit = {
            sourceSections: reading.sections.length,
            renderedSections: [...sections],
            pages: [...observed.values()].map((paper) => ({
              ...paper,
              parts: paper.parts.map((part: any) => ({ id: part.id })),
            })),
            headerFooterImageChecks: images.length,
          }
          for (const section of sections) {
            const paper = [...observed.values()].find((paper) =>
              paper.regions.some((region: any) => region.section === section),
            )!
            await contentFrame.locator('.viewer-doc-remote-viewport').evaluate((element, top) => {
              element.scrollTop = top
            }, paper.top)
            await page.waitForTimeout(200)
            await page.screenshot({
              path: join(output, `${document.fileId.slice(0, 12)}-section-${section}.png`),
            })
          }
          if (
            [...observed.values()].some((paper) =>
              paper.parts.some((part: any) => reading.hfParts[part.id].hasPageNumber),
            )
          ) {
            const firstPaper = [...observed.values()][0]
            await contentFrame.locator('.viewer-doc-remote-viewport').evaluate((element, paper) => {
              element.scrollTop = Math.max(0, paper.top + paper.height - element.clientHeight + 24)
            }, firstPaper)
            await page.waitForTimeout(200)
            await page.screenshot({
              path: join(output, `${document.fileId.slice(0, 12)}-footer.png`),
            })
          }
        }
        if (document.format !== 'docx') {
          // Screenshots work for legitimate cross-origin images too; reading
          // canvas pixels in page JS would reject tainted canvases.
          const canvasIndex = await contentFrame
            .locator('canvas')
            .evaluateAll((elements) =>
              elements.reduce(
                (largest, element, index) =>
                  (element as HTMLCanvasElement).width * (element as HTMLCanvasElement).height >
                  (elements[largest] as HTMLCanvasElement).width *
                    (elements[largest] as HTMLCanvasElement).height
                    ? index
                    : largest,
                0,
              ),
            )
          const pixels = await contentFrame.locator('canvas').nth(canvasIndex).screenshot()
          sample.pixelHash = createHash('sha256').update(pixels).digest('hex')
        }
        assert.equal(sample.errors.length, 0, sample.errors.join('\n'))
        assert.equal(sample.metrics.fontErrors.length, 0, 'font loading failures')
        sample.fontFallbackWarnings = sample.metrics.alerts.filter((text: string) =>
          text?.startsWith('以下字体未包含在字体包中'),
        )
        assert.equal(
          sample.metrics.alerts.filter(
            (text: string) => text && !text.startsWith('以下字体未包含在字体包中'),
          ).length,
          0,
          'document error alert',
        )
        sample.status = sample.fontFallbackWarnings.length ? 'passed_with_warnings' : 'passed'
        if (process.argv.includes('--playback') && document.format === 'pptx') {
          await frame.getByRole('button', { name: '开始放映', exact: true }).click()
          await page.waitForTimeout(1000)
          await contentFrame.locator('body').press('ArrowRight')
          await page.waitForTimeout(2500)
          sample.playbackScreenshot = `${document.fileId.slice(0, 12)}-${index}-playback.png`
          await page.screenshot({ path: join(output, sample.playbackScreenshot) })
          await contentFrame.locator('body').press('Escape')
          await frame.getByRole('button', { name: '开始放映', exact: true }).waitFor()
          assert.equal(sample.errors.length, 0, sample.errors.join('\n'))
          sample.playback =
            'entered, advanced with keyboard, exited; animation timing not reference-verified'
        }
      } catch (error) {
        sample.status = 'failed'
        sample.error = String(error)
        await page
          .screenshot({ path: join(output, `${document.fileId.slice(0, 12)}-${index}-failed.png`) })
          .catch(() => undefined)
      } finally {
        console.log(
          JSON.stringify({
            name: document.name,
            index,
            status: sample.status,
            error: sample.error,
          }),
        )
        await context.close()
        await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2))
      }
    }
  }
  report.status = report.samples.some((sample: any) => sample.status === 'failed')
    ? 'failed'
    : report.samples.some((sample: any) => sample.status === 'passed_with_warnings')
      ? 'passed_with_warnings'
      : 'passed'
  if (report.status === 'failed') process.exitCode = 1
} finally {
  report.completedAt = new Date().toISOString()
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2))
  await browser.close()
  await frontend.close()
}
