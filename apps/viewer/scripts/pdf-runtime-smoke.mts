import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { chromium, type BrowserContext, type Page } from 'playwright-core'
import { expect } from '@playwright/test'
import { PNG } from 'pngjs'
import pdfCrypt from '../../pdf/src/main/pdf-crypt'
import { largePdfFixture, pdfPageFixture } from '../tests/fixtures/pdf-pages'
import { root } from './paths.mjs'

const { encryptDocument } = pdfCrypt
// Use the encryptor's pdf-lib instance (its classes are checked with instanceof).
const { PDFDocument } = createRequire(new URL('../../pdf/package.json', import.meta.url))('pdf-lib')

const viewer = process.env.VIEWER_PDF_RUNTIME_URL || 'http://127.0.0.1:11042/'
const output = process.env.VIEWER_PDF_RUNTIME_OUTPUT || '/tmp/genoffice-pdf-runtime'
await mkdir(output, { recursive: true })
const files = new Map<string, Buffer>([['large.pdf', largePdfFixture()]])
const sent = new Map<string, { bytes: number; ranges: number; requests: string[] }>()
for (const name of [
  'encrc4.pdf',
  'enc128.pdf',
  'enc256.pdf',
  'enc-r3-rc4.pdf',
  'enc-r4-aes128.pdf',
  'enc-r5-aes256.pdf',
  'enc-r5-owneronly.pdf',
])
  files.set(name, await readFile(resolve(root, 'apps/pdf/tests/fixtures', name)))
for (const empty of [false, true]) {
  const doc = await PDFDocument.load(pdfPageFixture())
  encryptDocument(doc, {
    userPassword: empty ? '' : 'reader-secret',
    ownerPassword: 'owner-secret',
    permissions: { printing: true, modifying: false, copying: false, annotating: false },
  })
  files.set(
    empty ? 'r6-empty.pdf' : 'r6.pdf',
    Buffer.from(await doc.save({ useObjectStreams: false })),
  )
}
{
  // Exercise actual high-resolution image decoding, not just text-page canvases.
  const image = new PNG({ width: 4096, height: 4096 })
  for (let y = 0; y < image.height; y++)
    for (let x = 0; x < image.width; x++) {
      const i = (y * image.width + x) * 4
      image.data[i] = x % 256
      image.data[i + 1] = y % 256
      image.data[i + 2] = 80
      image.data[i + 3] = 255
    }
  const doc = await PDFDocument.create(),
    embedded = await doc.embedPng(PNG.sync.write(image))
  doc.addPage([600, 800]).drawImage(embedded, { x: 0, y: 0, width: 600, height: 800 })
  files.set('image.pdf', Buffer.from(await doc.save()))
}

// A real HTTP source with byte ranges and a modest transfer rate. This measures
// actual bytes written, including the initial request aborted after its headers.
const source = createServer((req, res) => {
  const target = new URL(req.url!, 'http://localhost')
  const bytes = files.get(target.pathname.slice(1))
  if (!bytes) {
    res.writeHead(404).end()
    return
  }
  const key = target.searchParams.get('run') || target.pathname
  const count = sent.get(key) || { bytes: 0, ranges: 0, requests: [] }
  count.requests.push(req.headers.range || 'full')
  sent.set(key, count)
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Expose-Headers', 'Accept-Ranges, Content-Range, Content-Length')
  if (key !== 'no-range') res.setHeader('Accept-Ranges', 'bytes')
  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Cache-Control', 'no-store')
  const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '')
  const start = match ? Number(match[1]) : 0
  const end = match
    ? Math.min(Number(match[2] || bytes.length - 1), bytes.length - 1)
    : bytes.length - 1
  if (match) {
    count.ranges++
    res.setHeader('Content-Range', `bytes ${start}-${end}/${bytes.length}`)
  }
  res.setHeader('Content-Length', end - start + 1)
  res.writeHead(match ? 206 : 200)
  res.flushHeaders()
  let offset = start
  const timer = setInterval(() => {
    if (res.destroyed) {
      clearInterval(timer)
      return
    }
    const next = Math.min(offset + 65536, end + 1)
    count.bytes += next - offset
    res.write(bytes.subarray(offset, next))
    offset = next
    if (offset > end) {
      clearInterval(timer)
      res.end()
    }
  }, 8)
  res.on('close', () => clearInterval(timer))
})
await new Promise<void>((done) => source.listen(0, '127.0.0.1', done))
const sourceUrl = `http://127.0.0.1:${(source.address() as any).port}`
const targetUrl = (file: string, run: string) =>
  new URL(
    `preview.html?format=pdf&src=${encodeURIComponent(`${sourceUrl}/${file}?run=${run}`)}`,
    viewer,
  ).href
const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
})
const report: any = {
  fileBytes: files.get('large.pdf')!.length,
  baselineRef: process.env.VIEWER_PDF_BASELINE_REF,
  runs: [],
  encryption: [],
}
let baselinePath: string | undefined

async function observe(context: BrowserContext, baselineModule?: string) {
  await context.addInitScript(() => {
    ;(window as any).__name = (value: unknown) => value
    ;(window as any).__pdfRead = {
      pages: [],
      text: [],
      cleanup: [],
      activeRenders: 0,
      peakRenders: 0,
    }
    const canvases = new Set<HTMLCanvasElement>()
    const create = document.createElement.bind(document)
    document.createElement = ((...args: any[]) => {
      const node = (create as any)(...args)
      if (args[0] === 'canvas') canvases.add(node)
      return node
    }) as typeof document.createElement
    ;(window as any).__pdfCanvases = canvases
  })
  await context.route('**/__pdf_runtime_api.mjs', async (route) => {
    const specifier = (context as any).__pdfSpecifier
    await route.fulfill({
      contentType: 'text/javascript',
      body: `
      import {getDocument as nativeGetDocument} from ${JSON.stringify(specifier)};
      export * from ${JSON.stringify(specifier)};
      const bind=(target,key)=>{const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value};
      export function getDocument(options) {
        const task=nativeGetDocument(options);
        const promise=task.promise.then(doc=>new Proxy(doc,{get(target,key){
          if(key!=='getPage')return bind(target,key);
          return async n=>{window.__pdfRead.pages.push(n);const page=await target.getPage(n);return new Proxy(page,{get(native,method){
            if(method==='render')return (...args)=>{
              const task=native.render(...args),stats=window.__pdfRead;
              stats.activeRenders++;stats.peakRenders=Math.max(stats.peakRenders,stats.activeRenders);
              task.promise.then(()=>stats.activeRenders--,()=>stats.activeRenders--);
              return task;
            };
            if(method==='getTextContent')return (...args)=>{window.__pdfRead.text.push(n);return native.getTextContent(...args)};
            if(method==='cleanup')return (...args)=>{window.__pdfRead.cleanup.push(n);return native.cleanup(...args)};
            return bind(native,method);
          }})};
        }}));
        return new Proxy(task,{get(target,key){return key==='promise'?promise:bind(target,key)},set(target,key,value){return Reflect.set(target,key,value,target)}});
      }`,
    })
  })
  await context.route(/\/pdf\.tsx(?:\?|$)/, async (route) => {
    const headers = { ...route.request().headers() }
    delete headers['if-none-match']
    delete headers['if-modified-since']
    const response = await route.fetch({
      headers,
      ...(baselineModule ? { url: new URL(baselineModule, viewer).href } : {}),
    })
    const body = await response.text()
    const match = /import\s*\{\s*getDocument,\s*GlobalWorkerOptions\s*\}\s*from\s*"([^"]+)"/.exec(
      body,
    )
    assert.ok(match, 'locate the PDF.js loading boundary')
    ;(context as any).__pdfSpecifier = match[1]
    await route.fulfill({
      response,
      body: body.replace(
        match[0],
        'import {getDocument,GlobalWorkerOptions} from "/__pdf_runtime_api.mjs"',
      ),
    })
  })
}

async function ink(page: Page, n: number) {
  const root = page.locator(`.viewer-pdf-page[data-idx="${n - 1}"]`)
  await expect(root.locator('.textLayer')).toContainText(`LARGE_PDF_PAGE_${n}`, { timeout: 60000 })
  await expect
    .poll(() =>
      root.locator('canvas').evaluate((canvas: HTMLCanvasElement) => {
        const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
        for (let i = 0; i < pixels.length; i += 4)
          if (pixels[i]! < 100 && pixels[i + 3]! > 100) return true
        return false
      }),
    )
    .toBe(true)
}

try {
  const baselineRef = process.env.VIEWER_PDF_BASELINE_REF
  if (baselineRef) {
    baselinePath = resolve(root, `apps/viewer/src/web/pdf-benchmark-${process.pid}.tsx`)
    await writeFile(
      baselinePath,
      execFileSync('git', ['show', `${baselineRef}:apps/viewer/src/web/pdf.tsx`]),
    )
  }
  for (const baseline of baselineRef ? [true, false] : [false]) {
    const name = baseline ? 'baseline' : 'optimized'
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      deviceScaleFactor: 2,
    })
    await observe(context, baseline ? `/pdf-benchmark-${process.pid}.tsx` : undefined)
    const page = await context.newPage(),
      errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (message) => {
      if (message.type() === 'warning') console.log(name, message.text())
    })
    const started = Date.now()
    await page.goto(targetUrl('large.pdf', name))
    await ink(page, 1)
    const initial = await page.evaluate(() => (window as any).__pdfRead)
    const result = {
      name,
      firstPaintMs: Date.now() - started,
      transferredAtPaint: sent.get(name)!.bytes,
      pagesReadAtPaint: new Set(initial.pages).size,
      textScansAtPaint: initial.text.length,
    }
    report.runs.push(result)
    console.log(JSON.stringify(result))
    if (!baseline) {
      assert.ok(result.pagesReadAtPaint <= 3, 'opening must not probe every page')
      assert.equal(result.textScansAtPaint, 0, 'opening must not build a full text outline')
      assert.ok(
        result.transferredAtPaint < report.fileBytes / 3,
        'first paint reads a small subset through real ranges',
      )
      assert.ok(sent.get(name)!.ranges > 0)
      for (const n of [120, 7, 240, 1]) {
        await page.getByLabel('PDF 页码').selectOption(String(n), { force: true })
        await ink(page, n)
        await expect(page.getByLabel('PDF 当前页')).toHaveText(`${n} / 240`)
        await expect
          .poll(() => page.locator('.pdf-page-content canvas').count())
          .toBeLessThanOrEqual(32)
        await expect
          .poll(() =>
            page
              .locator('.pdf-page-content canvas')
              .evaluateAll((nodes) =>
                nodes.reduce((sum, node: HTMLCanvasElement) => sum + node.width * node.height, 0),
              ),
          )
          .toBeLessThanOrEqual(24_000_000)
      }
      // Reach maximum zoom, then minimum zoom, retaining references to detached
      // test canvases to prove backing stores are explicitly zeroed on release.
      for (let n = 0; n < 12; n++)
        await page.getByRole('button', { name: '放大', exact: true }).first().click()
      await ink(page, 1)
      const peakPagePixels = await page
        .locator('.pdf-page-content canvas')
        .evaluateAll((nodes) =>
          Math.max(...nodes.map((c: HTMLCanvasElement) => c.width * c.height)),
        )
      assert.ok(peakPagePixels <= 8_000_000)
      for (let n = 0; n < 20; n++)
        await page.getByRole('button', { name: '缩小', exact: true }).first().click()
      await ink(page, 1)
      await expect(page.locator('.viewer-pdf-page[data-idx="8"] .textLayer')).toContainText(
        'LARGE_PDF_PAGE_9',
      )
      await expect
        .poll(() => page.locator('.pdf-page-content canvas').count())
        .toBeLessThanOrEqual(32)
      await expect
        .poll(() =>
          page.evaluate(() =>
            [...(window as any).__pdfCanvases]
              .filter((c: HTMLCanvasElement) => c.style.width.endsWith('px') && !c.isConnected)
              .reduce((n: number, c: HTMLCanvasElement) => n + c.width * c.height, 0),
          ),
        )
        .toBe(0)
      const memory = await page.evaluate(() => {
        const all = [...(window as any).__pdfCanvases] as HTMLCanvasElement[]
        const pages = all.filter((c) => c.style.width.endsWith('px'))
        return {
          allocated: pages.filter((c) => c.width * c.height > 0).length,
          detachedPixels: pages
            .filter((c) => !c.isConnected)
            .reduce((n, c) => n + c.width * c.height, 0),
          cleanupPages: new Set((window as any).__pdfRead.cleanup).size,
          peakRenders: (window as any).__pdfRead.peakRenders,
          residentPixels: pages
            .filter((c) => c.isConnected)
            .reduce((n, c) => n + c.width * c.height, 0),
        }
      })
      assert.equal(memory.detachedPixels, 0)
      assert.ok(memory.allocated <= 32 && memory.cleanupPages > 0)
      assert.ok(memory.residentPixels <= 24_000_000)
      assert.ok(memory.peakRenders <= 2)
      report.memory = { ...memory, peakPagePixels }
      await page.screenshot({ path: resolve(output, 'large-pdf.png') })
    }
    assert.deepEqual(errors, [])
    await context.close()
  }
  {
    const context = await browser.newContext(),
      page = await context.newPage()
    await page.goto(targetUrl('large.pdf', 'no-range'))
    await ink(page, 1)
    assert.equal(sent.get('no-range')!.ranges, 0)
    assert.ok(sent.get('no-range')!.bytes >= report.fileBytes)
    report.noRangeFallback = 'passed'
    await page.goto(targetUrl('image.pdf', 'image'))
    await expect
      .poll(
        () =>
          page.locator('.pdf-page-content canvas').evaluate((canvas: HTMLCanvasElement) => {
            const ctx = canvas.getContext('2d')!
            const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data
            let colored = 0
            for (let i = 0; i < pixels.length; i += 4)
              if (pixels[i + 2]! < 150 && pixels[i + 3]! > 200) colored++
            return colored > (canvas.width * canvas.height) / 2
          }),
        { timeout: 20000 },
      )
      .toBe(true)
    await expect(page.getByRole('alert')).toHaveCount(0)
    report.largeImage = 'passed'
    await page.screenshot({ path: resolve(output, 'large-image.png') })
    await context.close()
  }
  const cases = [
    ...['encrc4.pdf', 'enc128.pdf', 'enc256.pdf'].map((file) => ({
      file,
      answers: ['user123'],
      pages: 2,
      text: 'confidential',
    })),
    ...['enc-r3-rc4.pdf', 'enc-r4-aes128.pdf', 'enc-r5-aes256.pdf'].map((file) => ({
      file,
      answers: ['s3cret'],
      pages: 1,
      text: 'Encrypted Edit Probe',
    })),
    { file: 'enc-r5-owneronly.pdf', answers: [], pages: 1, text: 'Encrypted Edit Probe' },
    { file: 'r6.pdf', answers: ['reader-secret'], pages: 3, text: 'PDF_ISOLATION_PAGE_ONE' },
    { file: 'r6.pdf', answers: ['owner-secret'], pages: 3, text: 'PDF_ISOLATION_PAGE_ONE' },
    { file: 'r6-empty.pdf', answers: [], pages: 3, text: 'PDF_ISOLATION_PAGE_ONE' },
    {
      file: 'r6.pdf',
      answers: ['wrong', 'reader-secret'],
      pages: 3,
      text: 'PDF_ISOLATION_PAGE_ONE',
    },
    { file: 'r6.pdf', answers: [null], cancelled: true },
    { file: 'r6.pdf', answers: ['wrong', null], cancelled: true },
  ]
  for (const [index, item] of cases.entries()) {
    const context = await browser.newContext()
    const page = await context.newPage(),
      errors: string[] = [],
      prompts: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('dialog', async (dialog) => {
      const answer = item.answers[prompts.length]
      prompts.push(dialog.message())
      if (answer == null) await dialog.dismiss()
      else await dialog.accept(answer)
    })
    await page.goto(targetUrl(item.file, `encrypted-${index}`))
    if (item.cancelled) {
      await expect(page.getByRole('alert')).toHaveText('已取消密码输入', { timeout: 20000 })
      await expect(page.locator('.viewer-pdf-page')).toHaveCount(0)
    } else {
      await expect(page.getByLabel('PDF 页码').locator('option')).toHaveCount(item.pages!, {
        timeout: 20000,
      })
      await expect(page.locator('.viewer-pdf-page[data-idx="0"] .textLayer')).toContainText(
        item.text!,
      )
      await expect(page.locator('.viewer-pdf-page[data-idx="0"] canvas')).toBeVisible()
      await expect(page.getByRole('alert')).toHaveCount(0)
    }
    assert.equal(prompts.length, item.answers.length)
    if (item.answers[0] === 'wrong') assert.match(prompts[1]!, /不正确/)
    if (item.cancelled) {
      page.removeAllListeners('dialog')
      page.on('dialog', (dialog) => dialog.accept('reader-secret'))
      await page.goto(targetUrl('r6.pdf', `reopen-${index}`))
      await expect(page.locator('.viewer-pdf-page[data-idx="0"] .textLayer')).toContainText(
        'PDF_ISOLATION_PAGE_ONE',
        { timeout: 20000 },
      )
      await expect(page.getByRole('alert')).toHaveCount(0)
    }
    assert.deepEqual(errors, [])
    report.encryption.push({
      file: item.file,
      scenario: index,
      prompts: prompts.length,
      cancelled: !!item.cancelled,
      status: 'passed',
    })
    console.log(`encryption ${index}: passed`)
    await context.close()
  }
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2))
} finally {
  await browser.close()
  source.closeAllConnections()
  await new Promise<void>((done) => source.close(() => done()))
  if (baselinePath) await unlink(baselinePath)
}
