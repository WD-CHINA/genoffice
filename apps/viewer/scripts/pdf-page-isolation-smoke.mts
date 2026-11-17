import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { expect } from '@playwright/test'
import { pdfPageFixture } from '../tests/fixtures/pdf-pages'

const url = process.env.VIEWER_PDF_ISOLATION_URL || 'http://127.0.0.1:11042/'
const output = process.env.VIEWER_PDF_ISOLATION_OUTPUT || '/tmp/genoffice-pdf-isolation'
await mkdir(output, { recursive: true })
await writeFile(resolve(output, 'damaged-middle-page.pdf'), pdfPageFixture(true))

// Fault injection lives only in the browser test transport. All cases still
// load and raster real PDF bytes through PDF.js and the actual Viewer UI.
function faultModule(specifier: string) {
  return `
    import { getDocument as nativeGetDocument } from ${JSON.stringify(specifier)};
    export * from ${JSON.stringify(specifier)};
    const fault = window.__pdfIsolationFault || {};
    const broken = (value, page) => value === page || Array.isArray(value) && value.includes(page);
    const bind = (target, key) => { const value = Reflect.get(target,key,target); return typeof value === 'function' ? value.bind(target) : value; };
    export function getDocument(options) {
      const task = nativeGetDocument(options);
      const promise = task.promise.then(document => new Proxy(document, { get(target,key) {
        if (key === 'getMetadata' && fault.metadata) return async () => { throw Error('injected metadata'); };
        if (key === 'getMetadata' && fault.stalledMetadata) return () => new Promise(() => {});
        if (key === 'getOutline' && fault.outline) return async () => { throw Error('injected outline'); };
        if (key !== 'getPage') return bind(target,key);
        return async number => {
          if (fault.slowProbe && number === 2 && !localStorage.getItem('pdf-isolation-delayed')) {
            localStorage.setItem('pdf-isolation-delayed','1'); window.__pdfSlowProbeStarted = true;
            await new Promise(resolve => setTimeout(resolve,1200));
          }
          if (broken(fault.geometry,number)) throw Error('injected geometry ' + number);
          const page = await target.getPage(number);
          return new Proxy(page, { get(native,method) {
            if (method === 'render' && broken(fault.render,number)) return () => ({ promise: Promise.reject(Error('injected raster ' + number)), cancel() {} });
            if (method === 'getAnnotations' && broken(fault.annotations,number)) return async () => { throw Error('injected annotations'); };
            if (method === 'getTextContent' && broken(fault.text,number)) return async () => { throw Error('injected text'); };
            if (method === 'streamTextContent' && broken(fault.textStream,number)) return () => { throw Error('injected text stream'); };
            return bind(native,method);
          }});
        };
      }}));
      return new Proxy(task, { get(target,key) { return key === 'promise' ? promise : bind(target,key); }, set(target,key,value) { return Reflect.set(target,key,value,target); } });
    }
  `
}

const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
})
const results: unknown[] = []
try {
  const scenarios = [
    { name: 'actual-damaged-tree', damaged: true },
    { name: 'healthy' },
    { name: 'raster-failure', fault: { render: 2 }, badPage: 2 },
    {
      name: 'auxiliary-failures',
      fault: { annotations: 2, text: 2, metadata: true, outline: true },
    },
    { name: 'metadata-does-not-block', fault: { stalledMetadata: true } },
    { name: 'text-layer-failure', fault: { textStream: 2 } },
    { name: 'all-pages-unreadable', fault: { geometry: [1, 2, 3] }, allBad: true },
    { name: 'switch-during-probe', fault: { slowProbe: true }, swap: true },
    { name: 'invalid-document', invalid: true },
  ]
  for (const scenario of scenarios) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } })
    const faults: string[] = []
    await context.addInitScript(
      `globalThis.__name = value => value; globalThis.__pdfIsolationFault = ${JSON.stringify(scenario.fault || {})}`,
    )
    if (scenario.fault) {
      let specifier = ''
      await context.route('**/__pdf_isolation_api.mjs', (route) =>
        route.fulfill({ contentType: 'text/javascript', body: faultModule(specifier) }),
      )
      await context.route(/\/pdf\.tsx(?:\?|$)/, async (route) => {
        const headers = { ...route.request().headers() }
        delete headers['if-none-match']
        delete headers['if-modified-since']
        const response = await route.fetch({ headers })
        const body = await response.text()
        const match =
          /import\s*\{\s*getDocument,\s*GlobalWorkerOptions\s*\}\s*from\s*"([^"]+)"/.exec(body)
        assert.ok(match, 'PDF.js boundary import must be located')
        specifier = match[1]!
        await route.fulfill({
          response,
          body: body.replace(
            match[0],
            'import { getDocument, GlobalWorkerOptions } from "/__pdf_isolation_api.mjs"',
          ),
        })
      })
    }
    const page = await context.newPage()
    page.on('pageerror', (error) => faults.push(error.message))
    await page.goto(url + '?parse=local')
    const file = {
      name: scenario.name + '.pdf',
      mimeType: 'application/pdf',
      buffer: scenario.invalid ? Buffer.from('not a PDF') : pdfPageFixture(scenario.damaged),
    }
    await page.getByLabel('打开文件').setInputFiles(file)
    const frame = page.frameLocator('iframe')
    if (scenario.swap) {
      const old = page.frames().find((frame) => frame.parentFrame())!
      await old.waitForFunction(() => (window as any).__pdfSlowProbeStarted, { timeout: 15000 })
      await page.getByLabel('打开文件').setInputFiles({
        ...file,
        name: 'replacement.pdf',
        buffer: pdfPageFixture(false, 'REPLACEMENT'),
      })
    }
    if (scenario.invalid) {
      await expect(frame.getByRole('alert')).toBeVisible({ timeout: 20000 })
      await expect(frame.locator('.viewer-pdf-page')).toHaveCount(0)
    } else {
      await expect(frame.getByLabel('PDF 页码').locator('option')).toHaveCount(3, {
        timeout: 20000,
      })
      await expect(frame.locator('.viewer-pdf-page')).toHaveCount(3)
      await expect(frame.getByRole('alert')).toHaveCount(0)
      const badPage = scenario.damaged ? 2 : scenario.badPage
      if (badPage) {
        await frame.getByLabel('PDF 页码').selectOption(String(badPage), { force: true })
        await expect(frame.getByLabel(`第 ${badPage} 页加载失败`)).toBeVisible()
        await expect(frame.locator('.viewer-warning')).toContainText('其余页面仍可阅读')
        const dimensions = await frame
          .locator('.viewer-pdf-page')
          .evaluateAll((nodes) => nodes.map((node) => [node.style.width, node.style.height]))
        if (scenario.damaged)
          assert.deepEqual(dimensions[1], dimensions[0], 'bad page keeps prior good geometry')
      }
      if (scenario.allBad) {
        // Unvisited pages are probed lazily; inspect the last page before
        // asserting the final whole-document failure count.
        await frame.getByLabel('PDF 页码').selectOption('3', { force: true })
        await expect(frame.locator('.viewer-pdf-failed-page')).toHaveCount(3)
        await expect(frame.locator('.viewer-warning')).toContainText('均无法加载')
        await expect(frame.locator('.pdf-page-content canvas')).toHaveCount(0)
      } else {
        await frame.getByLabel('PDF 页码').selectOption('3', { force: true })
        const last = frame.locator('.viewer-pdf-page[data-idx="2"]')
        await expect(last.locator('canvas')).toBeVisible()
        await expect(last.locator('.textLayer')).toContainText(
          scenario.swap ? 'REPLACEMENT_PAGE_THREE' : 'PDF_ISOLATION_PAGE_THREE',
        )
        await expect(frame.getByLabel('PDF 当前页')).toHaveText('3 / 3')
        const ink = await last.locator('canvas').evaluate((canvas: HTMLCanvasElement) => {
          const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
          let count = 0
          for (let i = 0; i < data.length; i += 4)
            if (data[i]! < 100 && data[i + 1]! < 100 && data[i + 2]! < 100 && data[i + 3]! > 100)
              count++
          return count
        })
        assert.ok(ink > 100, 'healthy page has real raster content')
        if (!badPage) await expect(frame.locator('.viewer-pdf-failed-page')).toHaveCount(0)
        if (scenario.name === 'auxiliary-failures') {
          await expect(frame.locator('.viewer-warning')).toContainText('文档信息暂不可用')
          await frame.locator('.viewer-search-controls').evaluate((element: HTMLElement) => {
            element.hidden = false
          })
          await frame.getByLabel('搜索 PDF').fill('PDF_ISOLATION_PAGE_THREE')
          await frame.getByRole('button', { name: '搜索', exact: true }).click()
          await expect(frame.locator('.viewer-search-controls [role="status"]')).toHaveText('1/1')
          await expect(frame.getByLabel('PDF 当前页')).toHaveText('3 / 3')
          await expect(frame.locator('.viewer-warning')).toContainText('搜索结果可能不完整')
        }
        if (badPage) {
          const ratio = await last.evaluate((element) => element.clientWidth / element.clientHeight)
          await frame.locator('summary').click()
          await frame.getByRole('button', { name: '旋转', exact: true }).click()
          await expect
            .poll(async () =>
              last.evaluate((element) => element.clientWidth / element.clientHeight),
            )
            .toBeCloseTo(1 / ratio, 1)
          await expect
            .poll(async () =>
              last.evaluate((element) => {
                const canvas = element.querySelector('canvas')
                return (
                  !!canvas && Math.abs(parseFloat(canvas.style.width) - element.clientWidth) < 2
                )
              }),
            )
            .toBe(true)
          await frame.getByLabel('PDF 页码').selectOption('1', { force: true })
          await expect(frame.locator('.viewer-pdf-page[data-idx="0"] .textLayer')).toContainText(
            'PDF_ISOLATION_PAGE_ONE',
          )
        }
      }
    }
    await page.screenshot({ path: resolve(output, scenario.name + '.png') })
    if (faults.length) console.error(scenario.name, faults)
    await expect.poll(() => faults.length).toBe(0)
    results.push({ name: scenario.name, faults, status: 'passed' })
    console.log(scenario.name + ': passed')
    await context.close()
  }
  await writeFile(resolve(output, 'report.json'), JSON.stringify(results, null, 2))
} finally {
  await browser.close()
}
