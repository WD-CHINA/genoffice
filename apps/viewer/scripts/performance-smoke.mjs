import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, writeFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { deflateSync } from 'node:zlib'
import { chromium } from 'playwright-core'
import JSZip from 'jszip'
import { app, root } from './paths.mjs'

// Use a local Chrome installation, or CHROME_PATH on CI. No running dev server needed.
const executablePath = process.env.CHROME_PATH || (process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  : undefined)
const baseline = process.env.VIEWER_BASELINE_DIR
const mime = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.ttf': 'font/ttf', '.woff2': 'font/woff2' }
const errors = []
const results = []
const servers = []
const publicBase = (process.env.VIEWER_BASE || '/viewer/').replace(/\/$/, '')

async function serve(directory) {
  const base = resolve(directory)
  const server = createServer(async (req, res) => {
    try {
      let pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
      if (publicBase !== '/' && (pathname === publicBase || pathname.startsWith(publicBase + '/')))
        pathname = pathname.slice(publicBase.length) || '/'
      const file = resolve(base, '.' + (pathname === '/' ? '/index.html' : pathname))
      if (!file.startsWith(base + sep)) throw new Error('Invalid path')
      const bytes = await readFile(file)
      res.setHeader('Content-Type', mime[extname(file)] || 'application/octet-stream')
      res.end(bytes)
    } catch { res.writeHead(404); res.end() }
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  servers.push(server)
  return `http://127.0.0.1:${server.address().port}`
}

// Observe the actual worker protocol without changing its messages or transfer lists.
function observeWorker() {
  const NativeWorker = window.Worker
  window.__workerReads = []
  window.Worker = class extends NativeWorker {
    constructor(...args) {
      super(...args)
      const pending = new Map()
      const send = this.postMessage.bind(this)
      this.postMessage = (message, ...rest) => {
        pending.set(message.id, { op: message.op, ref: message.input?.ref })
        send(message, ...rest)
      }
      this.addEventListener('message', ({ data }) => {
        const request = pending.get(data.id)
        window.__workerReads.push({ ...request, bytes: data.result?.byteLength,
          updates: data.result?.slideUpdates?.length, error: data.error })
        pending.delete(data.id)
      })
    }
  }
}

const poll = async (read, check, message) => {
  const until = Date.now() + 30000
  while (Date.now() < until) {
    const value = await read()
    if (check(value)) return value
    await new Promise((done) => setTimeout(done, 50))
  }
  throw new Error(message)
}
const paint = (frame) => frame.locator('.viewer-slide-stage canvas').first().evaluate(() =>
  new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))

// Host controls may change the available document area between builds. Compare
// content at the same canvas size rather than conflating that with a rendering change.
async function matchCanvas(target) {
  await target.page.setViewportSize({ width: 1440, height: 900 })
  for (let attempt = 0; attempt < 3; attempt++) {
    await paint(target.frame)
    const height = await target.frame.locator('.viewer-slide-stage canvas').first().evaluate(canvas => canvas.getBoundingClientRect().height)
    if (Math.abs(height - 500) < 0.05) return
    await target.page.setViewportSize({ width: 1440, height: target.page.viewportSize().height + Math.round(500 - height) })
  }
  await paint(target.frame)
}

async function open(browser, url, fixture, embed = false) {
  const context = await browser.newContext({ viewport: { width: 1130, height: 657 } })
  await context.addInitScript(observeWorker)
  const page = await context.newPage()
  page.on('pageerror', (error) => errors.push(error.message))
  const fonts = new Map()
  page.on('response', (response) => {
    if (/\.(ttf|woff2)(\?|$)/.test(response.url()))
      fonts.set(response.url(), Number(response.headers()['content-length'] || 0))
  })
  await page.goto(`${url}/${embed ? '?embed=1' : ''}`)
  await page.getByLabel('打开文件').evaluate((input) => input.addEventListener('change', () => {
    window.__importStart = performance.now()
  }, { once: true }))
  await page.getByLabel('打开文件').setInputFiles(fixture)
  const frame = page.frameLocator('iframe')
  await frame.locator('.viewer-slide-stage canvas').first().waitFor({ timeout: 60000 })
  await paint(frame)
  const firstCanvasMs = await page.evaluate(() => performance.now() - window.__importStart)
  await poll(() => frame.locator('body').evaluate(() =>
    !window.__viewerPerformance || window.__viewerPerformance.stages.currentPageImagesReady?.elapsedMs > 0),
    Boolean, 'Current page pictures did not finish')
  const metrics = await frame.locator('body').evaluate(() => window.__viewerPerformance)
  const record = { fixture: typeof fixture === 'string' ? fixture.split('/').pop() : fixture.name,
    embed, firstCanvasMs: Math.round(firstCanvasMs), fontRequests: fonts.size,
    fontBytes: [...fonts.values()].reduce((sum, bytes) => sum + bytes, 0),
    thumbCanvases: await frame.locator('.viewer-thumbs canvas').count(), metrics }
  results.push(record)
  return { context, page, frame, record }
}

const picture = (color) => {
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b }
  const chunk = (name, bytes) => {
    const body = Buffer.concat([Buffer.from(name), bytes])
    let crc = ~0
    for (const byte of body) {
      crc ^= byte
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
    return Buffer.concat([u32(bytes.length), body, u32(~crc)])
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0])),
    chunk('IDAT', deflateSync(Buffer.from([0, ...color]))), chunk('IEND', Buffer.alloc(0)),
    Buffer.alloc(100 * 1024)])
}

async function longDeck(fixture) {
  const zip = await JSZip.loadAsync(await readFile(fixture))
  const slide = await zip.file('ppt/slides/slide1.xml').async('string')
  const rels = await zip.file('ppt/slides/_rels/slide1.xml.rels').async('string')
  const ns = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
  const ids = [], links = []
  for (let i = 1; i <= 40; i++) {
    ids.push(`<p:sldId id="${255 + i}" r:id="perf${i}"/>`)
    links.push(`<Relationship Id="perf${i}" Type="${ns}/slide" Target="slides/slide${i}.xml"/>`)
    const pic = `<p:pic><p:nvPicPr><p:cNvPr id="99" name="Perf picture"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="picture"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="914400" y="914400"/><a:ext cx="914400" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`
    zip.file(`ppt/slides/slide${i}.xml`, slide.replace('Q3 Business Review', `Performance slide ${i}`).replace('</p:spTree>', pic + '</p:spTree>'))
    zip.file(`ppt/slides/_rels/slide${i}.xml.rels`, rels.replace('</Relationships>', `<Relationship Id="picture" Type="${ns}/image" Target="../media/perf${i}.png"/></Relationships>`))
    zip.file(`ppt/media/perf${i}.png`, picture([211, 31, i]))
  }
  zip.file('ppt/presentation.xml', (await zip.file('ppt/presentation.xml').async('string')).replace(/<p:sldIdLst>.*?<\/p:sldIdLst>/s, `<p:sldIdLst>${ids.join('')}</p:sldIdLst>`))
  zip.file('ppt/_rels/presentation.xml.rels', (await zip.file('ppt/_rels/presentation.xml.rels').async('string')).replace(/<Relationship\b[^>]*Type="[^"]*\/slide"[^>]*\/>/g, '').replace('</Relationships>', links.join('') + '</Relationships>'))
  const types = await zip.file('[Content_Types].xml').async('string')
  const extra = Array.from({ length: 35 }, (_, i) => `<Override PartName="/ppt/slides/slide${i + 6}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('')
  zip.file('[Content_Types].xml', types.replace('</Types>', '<Default Extension="png" ContentType="image/png"/>' + extra + '</Types>'))
  return { name: 'performance-40-pages.pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', buffer: await zip.generateAsync({ type: 'nodebuffer' }) }
}

async function hasPicture(frame, blue) {
  return frame.locator('.viewer-slide-stage canvas').first().evaluate((canvas, b) => {
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
    for (let i = 0; i < pixels.length; i += 4)
      if (pixels[i] === 211 && pixels[i + 1] === 31 && pixels[i + 2] === b && pixels[i + 3] === 255) return true
    return false
  }, blue)
}

let browser
try {
  const url = await serve(resolve(app, 'dist/web'))
  const baselineUrl = baseline ? await serve(baseline) : null
  browser = await chromium.launch({ executablePath, headless: true })
  const fixtures = ['01_standard_business', '05_unicode_cjk_emoji'].map((name) => resolve(root, `packages/pptx-engine/tests/fixtures/${name}.pptx`))
  for (const fixture of fixtures) {
    const current = await open(browser, url, fixture)
    assert.ok(current.record.fontRequests < 23, 'Unused metric fonts must not be downloaded')
    if (baselineUrl) {
      const old = await open(browser, baselineUrl, fixture)
      await matchCanvas(current)
      await matchCanvas(old)
      const count = await current.frame.getByLabel('PPT 页码').locator('option').count()
      for (let page = 1; page <= count; page++) {
        for (const target of [current, old]) {
          await target.frame.getByLabel('PPT 页码').selectOption(String(page))
          await paint(target.frame)
        }
        const snapshot = (target) => target.frame.locator('.viewer-slide-stage canvas').first().evaluate((canvas) => canvas.toDataURL())
        assert.equal(await snapshot(current), await snapshot(old), `Canvas changed: ${fixture}, page ${page}`)
      }
      await old.context.close()
    }
    await current.context.close()
    const embedded = await open(browser, url, fixture, true)
    assert.equal(await embedded.frame.locator('.viewer-thumbs canvas').count(), 0)
    await embedded.context.close()
  }
  const generated = await longDeck(fixtures[0])
  const long = await open(browser, url, generated)
  await long.frame.getByRole('button', { name: '幻灯片预览', exact: true }).click()
  await poll(() => long.frame.locator('.viewer-thumbs canvas').count(), (count) => count > 0 && count < 15, 'Thumbnails were not virtualized')
  await poll(() => hasPicture(long.frame, 1), Boolean, 'First page picture missing')
  const reads = await long.frame.locator('body').evaluate(() => window.__workerReads)
  const bytes = reads.filter((read) => read.op === 'bytes')
  long.record.initialMediaReads = bytes.length
  long.record.totalMediaParts = 40
  assert.ok(bytes.length > 0 && bytes.length < 15, 'Offscreen media was eagerly fetched')
  assert.ok(bytes.every((read) => read.bytes > 72 * 1024), 'Large media bytes were not returned intact')
  assert.ok(reads.some((read) => read.op === 'measure' && read.updates > 0), 'Canvas width refinement did not return slide patches')
  await long.frame.locator('.viewer-thumbs').evaluate((pane) => { pane.scrollTop = pane.scrollHeight })
  await long.frame.locator('[data-slide-index="39"] canvas').waitFor()
  await long.frame.getByLabel('PPT 页码').selectOption('40')
  await poll(() => hasPicture(long.frame, 40), Boolean, 'Jumped page picture missing')
  await long.frame.getByLabel('PPT 页码').selectOption('1')
  await poll(() => hasPicture(long.frame, 1), Boolean, 'Returning to first page lost its picture')
  await long.frame.getByRole('button', { name: '开始放映', exact: true }).click()
  await long.frame.locator('.slideshow canvas').first().waitFor()
  await long.page.keyboard.press('ArrowRight')
  await paint(long.frame)
  await long.page.keyboard.press('Escape')
  await long.frame.locator('.slideshow').waitFor({ state: 'detached' })
  assert.equal(await long.frame.getByLabel('PPT 页码').inputValue(), '2')
  await long.context.close()
  assert.deepEqual(errors, [], 'Browser errors occurred')
  console.log(JSON.stringify(results, null, 2))
  if (process.env.VIEWER_PERF_REPORT) await writeFile(process.env.VIEWER_PERF_REPORT, JSON.stringify(results, null, 2))
  console.log('PPT font demand, thumbnails, media transfer, navigation and slideshow passed' + (baseline ? '; baseline canvases match' : ''))
} finally {
  await browser?.close()
  await Promise.all(servers.map((server) => new Promise((done) => server.close(done))))
}
