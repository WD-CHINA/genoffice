import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve, basename } from 'node:path'
import { chromium } from 'playwright-core'
import JSZip from 'jszip'
import { openPptx, materializeSlide } from '@genoffice/pptx-engine'
import { createBundledMetrics, type ParsedFace } from '../src/web/bundled-metrics'
import { createMetricFontLoader } from '../src/web/load-metric-font'
import type { MetricFont } from '../src/web/metric-font-types'
import { root } from './paths.mjs'

const origin = process.env.VIEWER_FONT_URL || 'http://127.0.0.1:11042/'
const output = process.env.VIEWER_FONT_OUTPUT || '/tmp/genoffice-pptx-fonts'
await mkdir(output, { recursive: true })
const samples = [
  ['Aptos', 'AVMW 012'],
  ['Aptos Display', 'AVMW 012'],
  ['Aptos Narrow', 'AVMW 012'],
  ['Calibri Light', 'AVMW 012'],
  ['Bookman Old Style', 'AVMW 012'],
  ['Century Gothic', 'AVMW 012'],
  ['Segoe UI', 'AVMW 012'],
  ['Consolas', 'AVMW 012'],
  ['Garamond', 'AVMW 012'],
  ['Montserrat', 'AVMW 012'],
  ['Poppins', 'AVMW 012'],
  ['DM Sans', 'AVMW 012'],
  ['Cambria', 'БГДЖ'],
  ['David', 'אבגד'],
  ['Meiryo UI', 'あうア'],
  ['Malgun Gothic', '한글'],
  ['Batang', '한글'],
  ['NanumGothic', '한글'],
  ['Sarabun', 'การศึกษา'],
  ['Cordia New', 'การศึกษา'],
  ['Latha', 'தமிழ்'],
  ['Nirmala UI', 'বাংলা'],
  ['微软雅黑', '全局散度矩阵'],
  ['宋体', '全局散度矩阵'],
  ['Arial', 'العربية'],
  ['Symbol', 'abm\uf0e5'],
  ['Wingdings', '\uf070\uf0fc'],
  ['Wingdings 2', '\uf050\uf052'],
  ['Wingdings 3', '\uf021\uf022'],
  ['Webdings', '\uf030\uf05c'],
]
const catalog: Array<MetricFont & { path: string }> = JSON.parse(
  await readFile(resolve(root, 'apps/viewer/src/web/fonts/catalog.json'), 'utf8'),
)
for (const font of catalog) {
  font.url = resolve(root, font.path)
  if (font.path.endsWith('.woff2'))
    font.metricsUrl = resolve(
      root,
      'apps/viewer/src/web/fonts/metrics',
      basename(font.path, '.woff2') + '.json',
    )
}
const loader = createMetricFontLoader(async (input) => new Response(await readFile(String(input))))
const faces = (await Promise.all(catalog.map(loader))).filter(Boolean) as ParsedFace[]
assert.equal(faces.length, catalog.length)
const metrics = createBundledMetrics(faces)
const zip = await JSZip.loadAsync(
  await readFile(resolve(root, 'packages/pptx-engine/tests/fixtures/01_standard_business.pptx')),
)
const path = 'ppt/slides/slide1.xml'
const source = await zip.file(path)!.async('string')
const shapes = samples
  .map(([family, text], index) => {
    const font = family!.replace(/&/g, '&amp;')
    const x = (index % 3) * 2900000,
      y = Math.floor(index / 3) * 420000
    const bold = index % 4 === 1 || index % 4 === 3
    const italic = index % 4 >= 2
    return `<p:sp><p:nvSpPr><p:cNvPr id="${900 + index}" name="${font}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="2850000" cy="420000"/></a:xfrm></p:spPr><p:txBody><a:bodyPr wrap="none"/><a:lstStyle/><a:p><a:pPr><a:buNone/></a:pPr><a:r><a:rPr sz="2000" kern="0" b="${+bold}" i="${+italic}"><a:latin typeface="${font}"/><a:ea typeface="${font}"/><a:cs typeface="${font}"/></a:rPr><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`
  })
  .join('')
zip.file(
  path,
  source.replace(
    /<p:spTree>[\s\S]*?<\/p:spTree>/,
    `<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${shapes}</p:spTree>`,
  ),
)
const bytes = await zip.generateAsync({ type: 'nodebuffer' })
await writeFile(resolve(output, 'font-matrix.pptx'), bytes)
const opened = await openPptx(bytes)
materializeSlide(opened, 0)
const model = {
  slide: opened.deck.slides[0],
  size: opened.deck.size,
  media: [],
  playback: {},
  mediaRefs: [],
}
const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
})
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.addInitScript('globalThis.__name = (value) => value')
  await context.route('**/font-smoke-model/layout/slides/0', (route) =>
    route.fulfill({ json: model }),
  )
  const page = await context.newPage()
  const faults: string[] = []
  page.on('pageerror', (error) => faults.push(error.message))
  await page.goto(origin + '?parse=local')
  await page.getByLabel('打开文件').setInputFiles({
    name: 'font-matrix.pptx',
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    buffer: bytes,
  })
  const frame = page.frameLocator('iframe')
  await frame
    .getByLabel('PPT 页码')
    .locator('option')
    .first()
    .waitFor({ state: 'attached', timeout: 90000 })
  await page.screenshot({ path: resolve(output, 'font-matrix.png') })
  const doc = page.frames().find((frame) => /preview.html/.test(frame.url()))!
  const widthRows = []
  for (const [index, [family, text]] of samples.entries()) {
    const style = {
      fontFamily: family!,
      fontSizePx: 100,
      bold: index % 4 === 1 || index % 4 === 3,
      italic: index % 4 >= 2,
      kerning: false,
    }
    const display = metrics.provider.displayFamily!(style, text)
    const width = await doc.evaluate(
      ({ display, text, style }) => {
        const ctx = document.createElement('canvas').getContext('2d')!
        ctx.font = `${style.italic ? 'italic ' : ''}${style.bold ? 'bold ' : ''}100px "${display}"`
        ctx.fontKerning = 'none'
        return {
          width: ctx.measureText(text!).width,
          ready:
            document.fonts.check(ctx.font, text) &&
            [...document.fonts].some(
              (face) =>
                face.family.replace(/^["']|["']$/g, '') === display && face.status === 'loaded',
            ),
        }
      },
      { display, text, style },
    )
    assert.ok(width.ready, `font not loaded: ${family} → ${display}`)
    const predicted = metrics.provider.measure(text!, style)
    // No ligatures/complex shaping in these ASCII probes: range adjustments
    // and file metrics must agree with the browser before feedback refinement.
    if (index < 12)
      assert.ok(
        Math.abs(predicted - width.width) < 0.15,
        `${family}: worker=${predicted}, canvas=${width.width}`,
      )
    widthRows.push({ family, display, predicted, canvas: width.width, ready: width.ready })
  }
  // Exercise the actual server-model worker with real parsed models. HTTP is
  // simulated here; parsing, fonts, layout and browser measurements are real.
  const remote = await doc.evaluate(
    async ({ origin }) => {
      const worker = new Worker(new URL('pptx-model-worker.ts', origin), { type: 'module' })
      const call = (op: string, input: unknown, id: number) =>
        new Promise<any>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('model font worker timeout')), 60000)
          worker.onmessage = (event) => {
            clearTimeout(timer)
            event.data.ok ? resolve(event.data.result) : reject(new Error(event.data.error))
          }
          worker.onerror = (event) => {
            clearTimeout(timer)
            reject(new Error(event.message))
          }
          worker.postMessage({ id, op, input })
        })
      try {
        const result = await call(
          'open',
          { sessionBase: origin + 'font-smoke-model', fonts: [], width: 960 },
          1,
        )
        const ctx = document.createElement('canvas').getContext('2d')!
        const widths: Record<string, number> = {}
        for (const item of result.measurements) {
          ctx.font = `${item.italic ? 'italic ' : ''}${item.bold ? 'bold ' : ''}100px "${item.family}"`
          ctx.fontKerning = item.kerning === false ? 'none' : 'normal'
          widths[item.key] = ctx.measureText(item.text).width
        }
        const refined = await call('measure', { widths }, 2)
        return {
          families: [...new Set(result.measurements.map((item: any) => item.family))],
          fallbacks: result.fallbacks,
          pending: refined.measurements.length,
          updates: refined.updates.length,
        }
      } finally {
        worker.terminate()
      }
    },
    { origin },
  )
  assert.equal(remote.pending, 0)
  assert.ok(remote.updates > 0)
  assert.ok(remote.families.includes('GenOffice Wingdings 3'))
  assert.equal(faults.length, 0, faults.join('\n'))
  const report = {
    samples: widthRows,
    remote,
    faults,
    fontFaces: await doc.evaluate(() => document.fonts.size),
  }
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} finally {
  await browser.close()
}
