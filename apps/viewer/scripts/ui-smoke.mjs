import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, readFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { chromium } from 'playwright-core'
import { expect } from '@playwright/test'
import { app, root } from './paths.mjs'

const base = resolve(app, 'dist/web')
const output = process.env.VIEWER_UI_SCREENSHOTS || '/tmp/genoffice-viewer-ui'
await mkdir(output, { recursive: true })
const server = createServer(async (req, res) => {
  try {
    const name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
    const path = resolve(base, '.' + (name === '/' ? '/index.html' : name))
    if (!path.startsWith(base + sep)) throw new Error('Invalid path')
    const bytes = await readFile(path)
    res.setHeader(
      'Content-Type',
      {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.mjs': 'text/javascript',
        '.css': 'text/css',
        '.ttf': 'font/ttf',
        '.woff2': 'font/woff2',
      }[extname(path)] || 'application/octet-stream',
    )
    res.end(bytes)
  } catch {
    res.writeHead(404)
    res.end()
  }
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const url = `http://127.0.0.1:${server.address().port}`

// Small two-page PDF with known text; avoids external downloads and test-only dependencies.
function samplePdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>',
    null,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  for (const [index, label] of [
    [3, 'Office Viewer / PDF preview'],
    [5, 'Page two / Reading without distractions'],
  ]) {
    const text = `BT /F1 22 Tf 48 740 Td (${label}) Tj ET`
    objects[index] = `<< /Length ${text.length} >>\nstream\n${text}\nendstream`
  }
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = Buffer.byteLength(pdf)
  pdf +=
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets
      .slice(1)
      .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
      .join('')
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  return { name: 'viewer-ui.pdf', mimeType: 'application/pdf', buffer: Buffer.from(pdf) }
}
const fixtures = {
  PPT: resolve(root, 'packages/pptx-engine/tests/fixtures/01_standard_business.pptx'),
  Word: resolve(root, 'apps/docs/tests/pagination-corpus/docx/07-page-breaks.docx'),
  PDF: samplePdf(),
}
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ||
    (process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : undefined),
  headless: true,
})
const faults = []
async function load(page, format, query = '') {
  await page.goto(url + '/' + query)
  await page.getByLabel('打开文件').setInputFiles(fixtures[format])
  const frame = page.frameLocator('iframe')
  try {
    await expect(frame.getByLabel(`${format} 页码`).locator('option').nth(1)).toBeAttached({
      timeout: 60000,
    })
  } catch (error) {
    console.error(format, await frame.locator('body').innerText())
    throw error
  }
  return frame
}
async function layout(frame) {
  const result = await frame.locator('.viewer-preview').evaluate((root) => {
    const rect = root.getBoundingClientRect()
    const bar = root.querySelector(':scope > .viewer-floating-bar')
    const bounds = bar.getBoundingClientRect()
    const body = root.querySelector('.viewer-reading-body, .viewer-deck').getBoundingClientRect()
    const controls = [...bar.querySelectorAll('button, select, summary')].filter((el) =>
      el.checkVisibility(),
    )
    return {
      width: innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      inBounds:
        bounds.left >= rect.left + 7 &&
        bounds.right <= rect.right - 7 &&
        bounds.bottom <= rect.bottom - 7,
      overlay: Math.abs(body.top - rect.top) < 2,
      smallControls: controls
        .filter((el) => el.getBoundingClientRect().height < 32)
        .map((el) => el.getAttribute('aria-label')),
      zoom: bar.querySelector('.viewer-bar-track').style.zoom,
    }
  })
  assert.ok(result.inBounds, `Floating controls outside viewport: ${JSON.stringify(result)}`)
  assert.ok(result.overlay, 'Toolbar is taking up document layout space')
  assert.ok(
    result.scrollWidth <= result.width + 1,
    `Horizontal viewport overflow: ${JSON.stringify(result)}`,
  )
  assert.deepEqual(result.smallControls, [], 'Controls became too small')
  assert.equal(result.zoom, '', 'Toolbar uses JS zoom')
  const sizes = await frame.locator('.viewer-preview').evaluate(async (root) => {
    const page = root.querySelector('.viewer-slide-stage, .pv-page, .viewer-pdf-page')
    const read = () => {
      const rect = page.getBoundingClientRect()
      return { width: rect.width, height: rect.height }
    }
    const paint = () =>
      new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
    const visible = read()
    const original = document.documentElement.dataset.viewerToolbar
    document.documentElement.dataset.viewerToolbar = 'false'
    await paint()
    const hidden = read()
    if (original === undefined) delete document.documentElement.dataset.viewerToolbar
    else document.documentElement.dataset.viewerToolbar = original
    await paint()
    return { visible, hidden }
  })
  assert.ok(
    Math.abs(sizes.visible.width - sizes.hidden.width) < 0.5 &&
      Math.abs(sizes.visible.height - sizes.hidden.height) < 0.5,
    `Toolbar visibility changes content fit: ${JSON.stringify(sizes)}`,
  )
  if (await frame.locator('.viewer-doc').count()) {
    const state = await frame.locator('.pv-scroll').evaluate((scroll) => {
      const viewport = scroll.getBoundingClientRect()
      const pages = [...scroll.querySelectorAll('.pv-page')]
      const height = (page) => {
        const rect = page.getBoundingClientRect()
        return Math.max(
          0,
          Math.min(rect.bottom, viewport.bottom) - Math.max(rect.top, viewport.top),
        )
      }
      const visible = pages.reduce(
        (best, page) => (!best || height(page) > height(best) ? page : best),
        null,
      )
      return {
        expected: Number(visible.dataset.pvPage) + 1,
        current: Number(document.querySelector('[aria-label="Word 页码"]').value),
      }
    })
    assert.equal(state.current, state.expected, 'Word page status does not match the visible page')
  }
}
try {
  for (const theme of ['light', 'dark']) {
    for (const format of Object.keys(fixtures).filter(
      (format) => !process.env.VIEWER_UI_FORMAT || process.env.VIEWER_UI_FORMAT === format,
    )) {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 820 },
        colorScheme: theme,
      })
      const page = await context.newPage()
      page.on('pageerror', (error) => faults.push(`${format}: ${error.message}`))
      const frame = await load(page, format)
      const bar = frame.getByRole('toolbar', { name: `${format} 控制栏` })
      if (format !== 'PPT') await expect(frame.locator('.viewer-navigation')).toBeHidden()
      await expect(frame.locator('.viewer-thumbs')).toHaveCount(0)
      for (const width of [1440, 768, 375, 320]) {
        await page.setViewportSize({ width, height: 820 })
        await page.waitForTimeout(180)
        await layout(frame)
        await bar.locator('summary').click()
        const panel = await bar.locator('.viewer-more-panel').boundingBox()
        assert.ok(panel.x >= 0 && panel.x + panel.width <= width, 'More panel outside viewport')
        await bar.getByRole('button', { name: '适合页面', exact: true }).click()
        await expect(bar.locator('details')).not.toHaveAttribute('open')
        await page.screenshot({ path: `${output}/${format}-${theme}-${width}.png` })
      }
      await page.setViewportSize({ width: 375, height: 520 })
      await page.waitForTimeout(180)
      await layout(frame)
      await page.setViewportSize({ width: 1440, height: 820 })
      await page.waitForTimeout(180)
      await frame.getByLabel(`${format} 页码`).selectOption('2')
      await page.waitForTimeout(100)
      await expect(frame.getByLabel(`${format} 页码`)).toHaveValue('2')
      await bar.getByRole('button', { name: '上一页', exact: true }).click()
      await expect(frame.getByLabel(`${format} 页码`)).toHaveValue('1')
      const zoom = await bar.getByLabel('缩放比例').innerText()
      if (format === 'PPT') await expect(bar.getByLabel('缩放比例')).toBeHidden()
      else await expect(bar.getByLabel('缩放比例')).toBeVisible()
      await bar.getByRole('button', { name: '放大', exact: true }).click()
      await expect(bar.getByLabel('缩放比例')).not.toHaveText(zoom)
      if (format === 'PPT') await expect(bar.getByLabel('缩放比例')).toBeHidden()
      if (format === 'PPT') {
        await bar.locator('summary').click()
        await bar.getByRole('button', { name: '适合页面', exact: true }).click()
        const toggle = frame.getByRole('button', { name: '幻灯片预览', exact: true })
        await toggle.click()
        await expect(frame.locator('.viewer-thumbs canvas').first()).toBeVisible()
        await page.screenshot({ path: `${output}/PPT-thumbnails-${theme}-1440.png` })
        await page.setViewportSize({ width: 375, height: 820 })
        await page.waitForTimeout(180)
        await expect(frame.locator('.viewer-thumbs canvas').first()).toBeVisible()
        const strip = await frame
          .locator('.viewer-thumbs')
          .evaluate((panel) => ({ width: panel.clientWidth, scrollWidth: panel.scrollWidth }))
        assert.ok(strip.scrollWidth <= strip.width, 'Thumbnail panel scrolls horizontally')
        await page.screenshot({ path: `${output}/PPT-thumbnails-${theme}-375.png` })
        await page.setViewportSize({ width: 1440, height: 820 })
        await page.waitForTimeout(180)
        const main = await frame.locator('.viewer-slide').boundingBox()
        assert.ok(main.x < 2, 'Thumbnails push the content sideways')
        await frame.getByRole('button', { name: '第 2 页', exact: true }).click()
        await expect(frame.locator('.viewer-thumbs')).toHaveCount(0)
        await expect(frame.getByLabel('PPT 页码')).toHaveValue('2')
        await toggle.click()
        await page.keyboard.press('Escape')
        await expect(toggle).toBeFocused()
        await bar.getByRole('button', { name: '开始放映', exact: true }).click()
        const show = frame.getByRole('toolbar', { name: '放映控制栏' })
        await expect(show).toBeVisible()
        await expect(frame.locator('.slideshow canvas').first()).toBeVisible()
        await show.getByRole('button', { name: '下一步', exact: true }).click()
        await expect(show.getByLabel('放映 页码')).toHaveValue('3')
        await page.keyboard.press('ArrowRight')
        await expect(show.getByLabel('放映 页码')).toHaveValue('4')
        await show.getByLabel('放映 页码').selectOption('1')
        await expect(show.getByLabel('放映 页码')).toHaveValue('1')
        await expect(show.getByRole('button', { name: '黑屏', exact: true })).toHaveCount(0)
        for (const key of ['b', 'B', '.']) {
          await page.keyboard.press(key)
          await expect(frame.locator('.ss-black')).toHaveCount(0)
        }
        await frame.locator('.slideshow').click({ button: 'right', position: { x: 100, y: 100 } })
        await frame.locator('.ctx-sub-host > button').hover()
        const blackItem = frame
          .locator('.ctx-item')
          .filter({ has: frame.getByText('B', { exact: true }) })
        await expect(blackItem).toHaveCount(1)
        await expect(blackItem).toBeHidden()
        await page.keyboard.press('Escape')
        await expect(show).toBeVisible()
        await page.screenshot({ path: `${output}/presentation-${theme}.png` })
        await show.getByRole('button', { name: '退出放映', exact: true }).click()
        await expect(frame.locator('.slideshow')).toHaveCount(0)
        await expect(frame.getByLabel('PPT 页码')).toHaveValue('1')
        await bar.getByRole('button', { name: '开始放映', exact: true }).click()
        await expect(show).toBeVisible()
        await show.getByLabel('放映 页码').focus()
        await page.keyboard.press('Escape')
        await expect(frame.locator('.slideshow')).toHaveCount(0)
      } else if (format === 'PDF') {
        await bar.locator('summary').click()
        await bar.getByRole('button', { name: '文档信息', exact: true }).click()
        await expect(frame.getByRole('region', { name: '文档信息' })).toBeVisible()
        await frame.getByRole('button', { name: '关闭文档信息' }).click()
        await bar.locator('summary').click()
        await bar.getByRole('button', { name: '旋转', exact: true }).click()
        await expect(bar).toBeVisible()
      } else {
        await bar.locator('summary').click()
        await bar.getByLabel('修订显示').selectOption('final')
        await expect(frame.locator('.viewer-doc')).toHaveClass(/rev-display-none/)
      }
      console.log(`${format} ${theme}: responsive overlay, controls and navigation passed`)
      await context.close()
    }
  }
  for (const format of Object.keys(fixtures).filter(
    (format) => !process.env.VIEWER_UI_FORMAT || process.env.VIEWER_UI_FORMAT === format,
  )) {
    const context = await browser.newContext({ viewport: { width: 375, height: 657 } })
    const page = await context.newPage()
    const frame = await load(page, format, '?embed=1&showToolbar=1')
    await expect(frame.getByRole('toolbar', { name: `${format} 控制栏` })).toBeVisible()
    await expect(frame.getByRole('button', { name: '幻灯片预览', exact: true })).toHaveCount(0)
    await layout(frame)
    await context.close()
  }
  assert.deepEqual(faults, [], 'Browser errors')
  console.log(
    `All three formats passed light/dark, 320/375/768/1440px, short viewport and embed checks. Screenshots: ${output}`,
  )
} finally {
  await browser.close()
  await new Promise((done) => server.close(done))
}
