import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, resolve, sep } from 'node:path'
import { chromium } from 'playwright-core'
import { expect } from '@playwright/test'
import JSZip from 'jszip'
import UTIF from 'utif2'
import { createBlankPptx } from '@genoffice/pptx-engine'
import { app, root } from './paths.mjs'
import { createParseServer } from '../../parse-server/src/server'

const output = process.env.VIEWER_PORTING_OUTPUT || '/tmp/genoffice-porting-regression'
await mkdir(output, { recursive: true })
// Match the existing UI smoke's static host: test the actual packaged browser
// build by default, without dev-server hot reload or dependency optimization.
const base = resolve(app, 'dist/web')
const server = process.env.VIEWER_PORTING_URL
  ? null
  : createServer(async (req, res) => {
      try {
        const name =
          decodeURIComponent(new URL(req.url!, 'http://localhost').pathname).replace(
            /^\/viewer(?=\/|$)/,
            '',
          ) || '/'
        const path = resolve(base, '.' + (name === '/' ? '/index.html' : name))
        if (!path.startsWith(base + sep)) throw Error('Invalid path')
        const bytes = await readFile(path)
        res.setHeader(
          'Content-Type',
          (
            {
              '.html': 'text/html',
              '.js': 'text/javascript',
              '.mjs': 'text/javascript',
              '.css': 'text/css',
              '.woff2': 'font/woff2',
              '.ttf': 'font/ttf',
              '.json': 'application/json',
              '.wasm': 'application/wasm',
            } as Record<string, string>
          )[extname(path)] || 'application/octet-stream',
        )
        res.end(bytes)
      } catch {
        res.writeHead(404).end()
      }
    })
if (server) await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
const url =
  process.env.VIEWER_PORTING_URL || `http://127.0.0.1:${(server!.address() as any).port}/viewer/`
const remote = process.env.VIEWER_PORTING_MODE === 'server'
const dataDir = remote ? await mkdtemp(resolve(tmpdir(), 'porting-remote-')) : undefined
const parser = dataDir
  ? await createParseServer({
      dataDir,
      token: 'porting-test',
      allowedOrigins: [new URL(url).origin],
    })
  : undefined
const query = parser
  ? '?' + new URLSearchParams({ parse: 'server', server: parser.url, token: 'porting-test' })
  : '?parse=local'
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
})
const report: unknown[] = []

try {
  const cases = [
    { scheme: 'agile', answers: ['Password1234_'] },
    { scheme: 'standard', answers: ['Password1234_'] },
    { scheme: 'agile', answers: ['wrong', 'Password1234_'] },
    { scheme: 'agile', answers: [null], cancel: true },
    { scheme: 'standard', answers: ['wrong', null], cancel: true },
    { scheme: 'agile', answers: [], plain: true },
  ]
  for (const [index, item] of cases.entries()) {
    const context = await browser.newContext(),
      page = await context.newPage()
    const errors: string[] = [],
      prompts: string[] = []
    let alerts = 0
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('dialog', async (dialog) => {
      if (dialog.type() === 'alert') {
        alerts++
        await dialog.accept()
        return
      }
      const answer = item.answers[prompts.length]
      prompts.push(dialog.message())
      if (answer == null) await dialog.dismiss()
      else await dialog.accept(answer)
    })
    await page.goto(url + query)
    const bytes = await readFile(
      resolve(
        root,
        `apps/docs/tests/encrypted-fixtures/office-${item.scheme}-${item.plain ? 'plain' : 'password'}.docx`,
      ),
    )
    await page.getByLabel('打开文件').setInputFiles({
      name: `encrypted-${index}.docx`,
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: bytes,
    })
    const frame = page.frameLocator('iframe')
    if (item.cancel) {
      await expect((remote ? page : frame).getByRole('alert')).toContainText('已取消密码输入', {
        timeout: 30000,
      })
      const plain = await readFile(
        resolve(root, `apps/docs/tests/encrypted-fixtures/office-${item.scheme}-plain.docx`),
      )
      await page.getByLabel('打开文件').setInputFiles({
        name: 'replacement.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        buffer: plain,
      })
    }
    await expect(frame.getByRole('document', { name: 'Word 文档正文' })).toContainText(
      /lorem ipsum/i,
      { timeout: 30000 },
    )
    await expect(frame.getByRole('toolbar', { name: 'Word 控制栏' })).toBeVisible()
    await expect(frame.getByRole('alert')).toHaveCount(0)
    const geometry = await frame.locator('.viewer-doc-reading-paper').evaluate((paper) => {
      const style = getComputedStyle(paper),
        mark = getComputedStyle(paper, '::before')
      return {
        width: paper.getBoundingClientRect().width,
        height: paper.getBoundingClientRect().height,
        pageHeight: parseFloat(style.getPropertyValue('--page-h')),
        minHeight: parseFloat(style.minHeight),
        padding: parseFloat(style.paddingTop),
        markLeft: parseFloat(mark.left),
        markWidth: parseFloat(mark.width),
        markBottom: parseFloat(mark.top) + parseFloat(mark.height),
      }
    })
    assert.ok(Math.abs(geometry.markLeft) < 0.1, JSON.stringify(geometry))
    assert.ok(Math.abs(geometry.minHeight - geometry.pageHeight) < 0.1, JSON.stringify(geometry))
    assert.ok(geometry.height >= geometry.pageHeight - 0.1, JSON.stringify(geometry))
    assert.ok(Math.abs(geometry.markWidth - geometry.width) < 0.1, JSON.stringify(geometry))
    assert.ok(Math.abs(geometry.markBottom - geometry.padding) < 0.1, JSON.stringify(geometry))
    assert.equal(prompts.length, item.answers.length)
    assert.equal(alerts, item.answers.includes('wrong') ? 1 : 0)
    assert.deepEqual(errors, [])
    await page.screenshot({ path: resolve(output, `word-${index}.png`) })
    report.push({
      name: `word-${index}`,
      scheme: item.scheme,
      prompts: prompts.length,
      alerts,
      status: 'passed',
    })
    console.log(`word-${index}: passed`)
    if (remote) {
      prompts.length = 0
      alerts = 0
      await page.goto(url + 'upload.html' + query)
      await page.locator('input[type=file]').setInputFiles({
        name: `upload-${index}.docx`,
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        buffer: bytes,
      })
      if (item.cancel) {
        await expect(page.getByRole('alert')).toContainText('已取消密码输入')
        await page.locator('input[type=file]').setInputFiles({
          name: 'replacement.docx',
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          buffer: await readFile(
            resolve(root, `apps/docs/tests/encrypted-fixtures/office-${item.scheme}-plain.docx`),
          ),
        })
      }
      await expect(page.getByText('上传成功', { exact: true })).toBeVisible({ timeout: 30000 })
      assert.equal(prompts.length, item.answers.length)
      assert.equal(alerts, item.answers.includes('wrong') ? 1 : 0)
      assert.deepEqual(errors, [])
      const history = await page.evaluate(
        () => localStorage.getItem('genoffice-upload-history') || '',
      )
      assert(!history.includes('Password1234_'))
      await page.screenshot({ path: resolve(output, `word-upload-${index}.png`) })
      report.push({
        name: `word-upload-${index}`,
        status: 'passed',
        prompts: prompts.length,
        alerts,
      })
      console.log(`word-upload-${index}: passed`)
    }
    await context.close()
  }
  // Build an actual deck and run it through the real browser parser, media
  // adapter and canvas renderer. No renderer or decoder is mocked here.
  const zip = await JSZip.loadAsync(await createBlankPptx())
  const picture = (id: number, rid: string, x: number) =>
    `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="${rid}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="${x}" y="1000000"/><a:ext cx="2500000" cy="2000000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`
  const slidePath = 'ppt/slides/slide1.xml',
    relPath = 'ppt/slides/_rels/slide1.xml.rels'
  zip.file(
    slidePath,
    (await zip.file(slidePath)!.async('string')).replace(
      '</p:spTree>',
      picture(10, 'rIdTiff', 1000000) + picture(11, 'rIdSvg', 5000000) + '</p:spTree>',
    ),
  )
  zip.file(
    relPath,
    (await zip.file(relPath)!.async('string')).replace(
      '</Relationships>',
      '<Relationship Id="rIdTiff" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/sample.tif"/><Relationship Id="rIdSvg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/sample.svg"/></Relationships>',
    ),
  )
  const rgba = new Uint8Array(20 * 16 * 4)
  for (let i = 0; i < rgba.length; i += 4) rgba.set([220, 30, 40, 255], i)
  zip.file('ppt/media/sample.tif', UTIF.encodeImage(rgba, 20, 16))
  zip.file(
    'ppt/media/sample.svg',
    '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="80"><style>.MsftOfcThm_Accent1_Fill_v2{fill:#111111;}</style><rect class="MsftOfcThm_Accent1_Fill_v2" width="100" height="80"/></svg>',
  )
  zip.file(
    'ppt/theme/theme1.xml',
    (await zip.file('ppt/theme/theme1.xml')!.async('string')).replace(
      /<a:accent1>[\s\S]*?<\/a:accent1>/,
      '<a:accent1><a:srgbClr val="00CC44"/></a:accent1>',
    ),
  )
  zip.file(
    '[Content_Types].xml',
    (await zip.file('[Content_Types].xml')!.async('string')).replace(
      '</Types>',
      '<Default Extension="tif" ContentType="image/tiff"/><Default Extension="svg" ContentType="image/svg+xml"/></Types>',
    ),
  )
  const context = await browser.newContext(),
    page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(url + query)
  await page.getByLabel('打开文件').setInputFiles({
    name: 'ported-media.pptx',
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    buffer: await zip.generateAsync({ type: 'nodebuffer' }),
  })
  const frame = page.frameLocator('iframe')
  await expect(frame.getByLabel('PPT 当前页')).toHaveText('1 / 1', { timeout: 30000 })
  await expect
    .poll(
      () =>
        frame.locator('.viewer-slide-stage canvas').evaluateAll((canvases) => {
          let red = 0,
            green = 0
          for (const canvas of canvases as HTMLCanvasElement[]) {
            const pixels = canvas
              .getContext('2d')!
              .getImageData(0, 0, canvas.width, canvas.height).data
            for (let i = 0; i < pixels.length; i += 4) {
              if (pixels[i]! > 180 && pixels[i + 1]! < 80 && pixels[i + 2]! < 100) red++
              if (pixels[i]! < 60 && pixels[i + 1]! > 150 && pixels[i + 2]! < 120) green++
            }
          }
          return red > 1000 && green > 1000
        }),
      { timeout: 30000 },
    )
    .toBe(true)
  assert.deepEqual(errors, [])
  await page.screenshot({ path: resolve(output, 'pptx-tiff-svg.png') })
  report.push({ name: 'pptx-tiff-svg', status: 'passed' })
  console.log('pptx-tiff-svg: passed')
  await context.close()
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2))
} finally {
  await parser?.close()
  if (dataDir) await rm(dataDir, { recursive: true, force: true })
  await browser.close()
  if (server) {
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
  }
}
