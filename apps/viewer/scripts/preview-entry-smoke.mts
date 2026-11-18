/** Real HTTP/browser regression for the canonical preview URL and retired-link rejection. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { expect } from '@playwright/test'
import { preview as createPreviewServer } from 'vite'
import { createBlankPptx } from '@genoffice/pptx-engine'
import { createParseServer } from '../../parse-server/src/server'
import { previewUrl } from '../src/web/preview-target'

const output = process.env.PREVIEW_ENTRY_EVIDENCE_DIR || join(tmpdir(), 'genoffice-preview-entry')
await mkdir(output, { recursive: true })
const dataDir = await mkdtemp(join(tmpdir(), 'preview-entry-data-'))
const token = 'preview-entry-test'
let parser = await createParseServer({ dataDir, token })
process.env.PARSE_SERVER_URL = parser.url
process.env.VIEWER_BASE = '/viewer/'
const frontend = await createPreviewServer({
  configFile: resolve(import.meta.dirname, '../vite.config.ts'),
  preview: { host: '127.0.0.1', port: 0, strictPort: false },
})
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
const results: unknown[] = []
try {
  const origin = `http://127.0.0.1:${(frontend.httpServer!.address() as { port: number }).port}`
  const port = parser.port
  await parser.close()
  parser = await createParseServer({ dataDir, token, port, allowedOrigins: [origin] })
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROME_PATH ||
      (process.platform === 'darwin'
        ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
        : undefined),
  })
  // A small valid PDF needs no external fixture or dependency.
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>',
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const start = Buffer.byteLength(pdf)
  pdf += `xref\n0 4\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => `${String(n).padStart(10, '0')} 00000 n \n`)
    .join('')}trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`
  const files = [
    {
      format: 'pptx',
      body: Buffer.from(await createBlankPptx()),
      selector: '.viewer-slide-stage canvas',
    },
    {
      format: 'docx',
      body: await readFile(
        resolve(import.meta.dirname, '../../parse-server/tests/fixtures/docx/table.docx'),
      ),
      selector: '.viewer-doc-pages .pv-page .pv-content',
    },
    { format: 'pdf', body: Buffer.from(pdf), selector: '.viewer-pdf-page canvas' },
  ]
  for (const input of files) {
    const uploaded = await fetch(parser.url + '/v1/files', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: input.body,
    })
    assert.equal(uploaded.status, 201)
    const { fileId } = (await uploaded.json()) as { fileId: string }
    for (const mode of ['same-origin', 'cross-origin']) {
      const page = await browser.newPage()
      const requests: string[] = [],
        errors: string[] = [],
        documents: string[] = []
      page.on('request', (r) => {
        requests.push(r.url())
        if (r.isNavigationRequest()) documents.push(r.url())
      })
      page.on('pageerror', (e) => errors.push(e.message))
      const target = previewUrl(
        '/viewer/',
        { fileId, token, ...(mode === 'cross-origin' ? { server: parser.url } : {}) },
        origin,
      )
      await page.goto(new URL(target, origin).href)
      await expect(page.locator(input.selector).first()).toBeVisible({ timeout: 30_000 })
      assert.equal(await page.locator('iframe').count(), 0)
      assert.equal(documents.length, 1, JSON.stringify(documents))
      assert.deepEqual(errors, [])
      const metadata = requests.filter((url) => new URL(url).pathname === `/v1/files/${fileId}`)
      assert.equal(metadata.length, 1)
      const signatures = requests.filter((url) => new URL(url).pathname.endsWith('/content-url'))
      assert.equal(signatures.length, input.format === 'pdf' ? 1 : 0)
      if (input.format !== 'pdf')
        assert.ok(!requests.some((url) => new URL(url).pathname === `/v1/files/${fileId}/content`))
      await page.screenshot({ path: join(output, `${input.format}-${mode}.png`) })
      results.push({
        format: input.format,
        mode,
        entry: new URL(page.url()).pathname,
        documents: documents.length,
        metadataRequests: metadata.length,
        signatureRequests: signatures.length,
        frames: 0,
        errors,
      })
      await page.close()
    }
    for (const retired of [
      `/viewer/preview.html?${new URLSearchParams({ fileId, src: 'bundle', format: input.format, token })}`,
      `/viewer/preview.html?${new URLSearchParams({ fileId, contentUrl: 'https://files.example/old.pdf', token })}`,
      `/viewer/?${new URLSearchParams({ parse: 'server', fileId, token })}`,
      `/viewer/?${new URLSearchParams({ url: 'https://files.example/old.docx' })}`,
    ]) {
      const oldPage = await browser.newPage()
      const fileRequests: string[] = []
      oldPage.on('request', (request) => {
        if (new URL(request.url()).pathname.startsWith('/v1/')) fileRequests.push(request.url())
      })
      await oldPage.goto(origin + retired)
      await expect(oldPage.getByRole('alert')).toContainText('不再支持')
      assert.equal(await oldPage.locator('iframe').count(), 0)
      assert.deepEqual(fileRequests, [], 'retired links must not fetch files or open sessions')
      await oldPage.close()
    }
    // An unauthorized entry reports an error; it must not try a local download instead.
    const rejected = await browser.newPage()
    await rejected.goto(origin + previewUrl('/viewer/', { fileId }, origin))
    await expect(rejected.getByRole('alert')).toContainText('HTTP 401')
    await rejected.close()
  }
  await writeFile(
    join(output, 'result.json'),
    JSON.stringify({ status: 'passed', results }, null, 2),
  )
  console.log(
    JSON.stringify({
      status: 'passed',
      cases: results.length,
      retiredLinksRejected: files.length * 4,
      directNavigation: true,
    }),
  )
} finally {
  await browser?.close()
  await new Promise<void>((resolve, reject) =>
    frontend.httpServer.close((error) => (error ? reject(error) : resolve())),
  )
  await parser.close()
  await rm(dataDir, { recursive: true, force: true })
}
