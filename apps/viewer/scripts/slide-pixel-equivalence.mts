import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium, devices, firefox, webkit } from 'playwright-core'
import { createServer } from 'vite'
import { PNG as PNGImage } from 'pngjs'
import pixelmatch from 'pixelmatch'
import JSZip from 'jszip'
import { createBlankPptx } from '@genoffice/pptx-engine'
import { createParseServer } from '../../parse-server/src/server'

/**
 * Pixel-level visual equivalence drill (plan §4.3): render one complex slide
 * (theme accent + group + animation + chart) through the real viewer, restart the
 * parse server on the same dataDir, reopen the same file from its artifact and
 * compare the canvas raster pixel by pixel (Firefox's canvas PNG encoder is not
 * byte-stable across page instances even when every pixel matches, so byte
 * equality alone would be a false negative). This is still one browser/one
 * machine; it is a local drill, not a multi-device visual regression suite.
 *
 * Usage:
 *   node --import tsx scripts/slide-pixel-equivalence.mts [--out /tmp/...]
 */

const outIndex = process.argv.indexOf('--out')
const output = outIndex >= 0 && process.argv[outIndex + 1]
  ? process.argv[outIndex + 1] : join(tmpdir(), 'genoffice-slide-pixel')
const browserIndex = process.argv.indexOf('--browser')
const browserName = browserIndex >= 0 ? process.argv[browserIndex + 1] : 'chromium'
if (!['chromium', 'firefox', 'webkit'].includes(browserName)) throw new Error(`unknown browser: ${browserName}`)
const widthIndex = process.argv.indexOf('--width')
const viewportWidth = (() => {
  const value = widthIndex >= 0 ? Number(process.argv[widthIndex + 1]) : 1200
  if (!Number.isSafeInteger(value) || value < 600 || value > 2000)
    throw new Error('invalid --width')
  return value
})()
const failFirstPart = process.argv.includes('--fail-first-part')
const deviceIndex = process.argv.indexOf('--device')
const deviceName = deviceIndex >= 0 ? process.argv[deviceIndex + 1] : undefined
if (deviceName && !(deviceName in devices)) throw new Error(`unknown device: ${deviceName}`)
const deviceProfile = deviceName ? devices[deviceName as keyof typeof devices] : undefined
const dprIndex = process.argv.indexOf('--dpr')
const deviceScaleFactor = (() => {
  const value = dprIndex >= 0 ? Number(process.argv[dprIndex + 1]) : 1
  if (!Number.isFinite(value) || value < 1 || value > 3) throw new Error('invalid --dpr')
  return value
})()
const token = 'pixel-equivalence-test'
const dataDir = await mkdtemp(join(tmpdir(), 'slide-pixel-data-'))
const frontend = await createServer({
  configFile: resolve(import.meta.dirname, '../vite.config.ts'),
  server: { host: '127.0.0.1', port: 0 },
})
await frontend.listen()
const origin = `http://127.0.0.1:${(frontend.httpServer!.address() as { port: number }).port}`
let parser = await createParseServer({ dataDir, token, allowedOrigins: [origin] })
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
const SHAPE = '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Themed"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="2000000" cy="800000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>Pixel equivalence</a:t></a:r></a:p></p:txBody></p:sp>'
const GROUP = '<p:grpSp><p:nvGrpSpPr><p:cNvPr id="10" name="Group"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="2000000" cy="800000"/><a:chOff x="0" y="0"/><a:chExt cx="2000000" cy="800000"/></a:xfrm></p:grpSpPr>' + SHAPE + '</p:grpSp>'
const PIC = '<p:pic><p:nvPicPr><p:cNvPr id="3" name="Logo"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rIdImg"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="4000000" y="0"/><a:ext cx="1000000" cy="1000000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>'
const TIMING = '<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst><p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst><p:par><p:cTn id="3" fill="hold"><p:stCondLst><p:cond delay="indefinite"/></p:stCondLst><p:childTnLst><p:par><p:cTn id="4" presetID="1" presetClass="entr" presetSubtype="0" fill="hold" nodeType="clickEffect"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst><p:set><p:cBhvr><p:cTn id="5" dur="1" fill="hold"/><p:tgtEl><p:spTgt spid="2"/></p:tgtEl><p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr><p:to><p:strVal val="visible"/></p:to></p:set></p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn><p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst><p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst></p:seq></p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>'

async function complexDeck(): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(await createBlankPptx())
  let slide = await zip.file('ppt/slides/slide1.xml')!.async('string')
  const rels = await zip.file('ppt/slides/_rels/slide1.xml.rels')!.async('string')
  const types = await zip.file('[Content_Types].xml')!.async('string')
  zip.file('ppt/media/image1.png', PNG)
  slide = slide.replace('</p:spTree>', GROUP + PIC + '</p:spTree>').replace('</p:sld>', TIMING + '</p:sld>')
  zip.file('ppt/slides/slide1.xml', slide)
  zip.file('ppt/slides/_rels/slide1.xml.rels', rels.replace('</Relationships>',
    '<Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/></Relationships>'))
  zip.file('[Content_Types].xml', types.replace('</Types>', '<Default Extension="png" ContentType="image/png"/></Types>'))
  let theme = await zip.file('ppt/theme/theme1.xml')!.async('string')
  theme = theme.replace(/<a:accent1>[\s\S]*?<\/a:accent1>/, '<a:accent1><a:srgbClr val="FF00AA"/></a:accent1>')
  zip.file('ppt/theme/theme1.xml', theme)
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}

async function capture(browser: Awaited<ReturnType<typeof chromium.launch>>, origin: string, fileId: string) {
  const page = await browser.newPage(deviceProfile
    ?? { viewport: { width: viewportWidth, height: 900 }, deviceScaleFactor })
  if (failFirstPart) {
    let failed = false
    await page.route('**/parts/**', (route) => {
      if (failed) return route.continue()
      failed = true
      return route.fulfill({ status: 403, body: '' })
    })
  }
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(origin + '/viewer/?' + new URLSearchParams({
    parse: 'server', server: parser.url, fileId, token, name: 'pixel-equivalence.pptx',
  }))
  const frame = page.frameLocator('iframe')
  await frame.locator('canvas').first().waitFor({ timeout: 30_000 })
  // Let fonts/images/layout settle, then take two samples until the canvas is stable.
  let previous = ''
  for (let attempt = 0; attempt < 80; attempt++) {
    await page.waitForTimeout(250)
    const current = await frame.locator('canvas').first().evaluate(() => {
      const canvases = [...document.querySelectorAll('canvas')]
        .sort((a, b) => b.width * b.height - a.width * a.height)
      return canvases[0]?.toDataURL('image/png') ?? ''
    })
    if (current && current === previous) { await page.close(); return { data: current, errors } }
    previous = current
  }
  await page.close()
  throw new Error('canvas never stabilized')
}

function decodeFrame(dataUrl: string) {
  const comma = dataUrl.indexOf(',')
  if (comma < 0) throw new Error('invalid canvas data URL')
  return PNGImage.sync.read(Buffer.from(dataUrl.slice(comma + 1), 'base64'))
}

/**
 * Rendering equivalence is defined per pixel. Chromium/WebKit happen to encode
 * byte-identical PNGs across the restart, Firefox does not even though every
 * pixel matches, so the byte hash is reported for traceability only.
 */
function compareFrames(before: string, after: string) {
  const byteEqual = before === after
  const first = decodeFrame(before)
  const second = decodeFrame(after)
  if (first.width !== second.width || first.height !== second.height) {
    return { byteEqual, pixelEqual: false, diffPixels: first.width * first.height, width: first.width, height: first.height }
  }
  const diff = new PNGImage({ width: first.width, height: first.height })
  const diffPixels = pixelmatch(first.data, second.data, diff.data, first.width, first.height, {
    threshold: 0.1,
    includeAA: true,
  })
  return { byteEqual, pixelEqual: diffPixels === 0, diffPixels, width: first.width, height: first.height }
}

try {
  const browserType = browserName === 'webkit' ? webkit : browserName === 'firefox' ? firefox : chromium
  browser = await browserType.launch(browserName !== 'chromium'
    ? { headless: true }
    : {
        headless: true,
        executablePath: process.env.CHROME_PATH ||
          (process.platform === 'darwin'
            ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined),
      })
  const uploaded = await fetch(parser.url + '/v1/files', {
    method: 'POST', headers: { Authorization: `Bearer ${token}` },
    body: Buffer.from(await complexDeck()),
  })
  const { fileId } = await uploaded.json() as { fileId: string }
  const before = await capture(browser, origin, fileId)
  await parser.close()
  parser = await createParseServer({ dataDir, token, allowedOrigins: [origin] })
  const after = await capture(browser, origin, fileId)
  await writeFile(output + '-before.png', Buffer.from(before.data.split(',')[1]!, 'base64'))
  await writeFile(output + '-after.png', Buffer.from(after.data.split(',')[1]!, 'base64'))
  const hash = (data: string) => createHash('sha256').update(data).digest('hex')
  const comparison = compareFrames(before.data, after.data)
  const report = {
    equal: comparison.pixelEqual,
    byteEqual: comparison.byteEqual,
    pixelEqual: comparison.pixelEqual,
    diffPixels: comparison.diffPixels,
    canvas: `${comparison.width}x${comparison.height}`,
    before: hash(before.data), after: hash(after.data),
    errors: [...before.errors, ...after.errors],
    viewportWidth: deviceProfile?.viewport?.width ?? viewportWidth,
    deviceScaleFactor: deviceProfile?.deviceScaleFactor ?? deviceScaleFactor,
    browser: browserName,
    ...(deviceName ? { device: deviceName } : {}),
    ...(failFirstPart ? { failFirstPart } : {}),
    note: 'single browser/machine local drill; not a multi-device visual regression suite',
  }
  await writeFile(output + '.json', JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  assert.equal(report.equal, true)
} finally {
  await browser?.close().catch(() => undefined)
  await parser.close().catch(() => undefined)
  await frontend.close().catch(() => undefined)
  await rm(dataDir, { recursive: true, force: true }).catch(() => undefined)
}