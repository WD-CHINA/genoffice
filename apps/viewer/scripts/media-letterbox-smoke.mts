/** Pixel regression: a mismatched video aspect ratio must not expose its canvas poster. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { chromium } from 'playwright-core'
import { PNG } from 'pngjs'
import { createServer } from 'vite'

const out = resolve(process.env.MEDIA_LETTERBOX_EVIDENCE || '/tmp/genoffice-media-letterbox')
await mkdir(out, { recursive: true })
const mediaPath = join(out, 'blue.mp4')
execFileSync(process.env.FFMPEG || 'ffmpeg', [
  '-nostdin',
  '-v',
  'error',
  '-y',
  '-f',
  'lavfi',
  '-i',
  'color=c=blue:s=320x180:r=10',
  '-t',
  '2',
  '-c:v',
  'libx264',
  '-threads',
  '1',
  '-pix_fmt',
  'yuv420p',
  '-movflags',
  '+faststart',
  mediaPath,
])
const entry = join(out, 'entry.ts')
await writeFile(
  entry,
  `
import React from 'react'
import {createRoot} from 'react-dom/client'
import {ShowMediaLayer} from '/@fs/${resolve(import.meta.dirname, '../../../packages/viewer-renderers/src/slides/renderer/components/ShowMediaLayer.tsx')}'
const tall = new URLSearchParams(location.search).has('tall')
const box={x:20,y:20,w:360,h:tall?240:140}
const slide={widthPx:400,heightPx:280,nodes:[{type:'picture',sourceId:'video',media:'video',box}]}
const dataSource={getMediaData:async()=>({kind:'video',dataUrl:'/@fs/${mediaPath}'})}
createRoot(document.getElementById('root')).render(React.createElement('div',
 {id:'scene',style:{position:'relative',width:400,height:280}},
 React.createElement('canvas',{width:400,height:280,ref:canvas=>{if(!canvas)return;const c=canvas.getContext('2d');c.fillStyle='white';c.fillRect(0,0,400,280);c.fillStyle='#ec00b6';c.fillRect(box.x,box.y,box.w,box.h)}}),
 React.createElement(ShowMediaLayer,{slide,dataSource,slideIndex:0,width:400,commands:[],epoch:0,mediaBase:0,muted:true})))
`,
)
const frontend = await createServer({
  configFile: resolve(import.meta.dirname, '../vite.config.ts'),
  server: {
    host: '127.0.0.1',
    port: 0,
    fs: { allow: [resolve(import.meta.dirname, '../../..'), out] },
  },
  plugins: [
    {
      name: 'media-letterbox-fixture',
      configureServer(server) {
        server.middlewares.use('/__letterbox', async (req, res, next) => {
          try {
            const html = await server.transformIndexHtml(
              req.url || '/',
              `<!doctype html><html><body style="margin:0"><div id="root"></div><script type="module" src="/@fs/${entry}"></script></body></html>`,
            )
            res.setHeader('Content-Type', 'text/html')
            res.end(html)
          } catch (error) {
            next(error)
          }
        })
      },
    },
  ],
})
await frontend.listen()
const origin = `http://127.0.0.1:${(frontend.httpServer!.address() as { port: number }).port}`
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.CHROME_PATH ||
    (process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : undefined),
})
const report: any = { status: 'running', browser: browser.version(), cases: [] }
try {
  for (const tall of [false, true]) {
    const name = tall ? 'top-bottom-bars' : 'left-right-bars'
    const page = await browser.newPage({ viewport: { width: 420, height: 300 } })
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.addInitScript('globalThis.__name = (fn) => fn')
    await page.goto(origin + '/__letterbox' + (tall ? '?tall=1' : ''))
    const video = page.locator('video')
    await video.waitFor()
    await video.evaluate(async (element: HTMLVideoElement) => {
      element.controls = false
      await element.play()
    })
    await page.waitForFunction(() => {
      const v = document.querySelector('video')
      return v && v.currentTime > 0.2 && v.videoWidth === 320
    })
    await video.evaluate((element: HTMLVideoElement) => element.pause())
    const points = tall
      ? [
          [200, 29],
          [200, 251],
        ]
      : [
          [47, 90],
          [353, 90],
        ]
    const sample = async (suffix: string) => {
      const bytes = await page
        .locator('#scene')
        .screenshot({ path: join(out, `${name}-${suffix}.png`) })
      const png = PNG.sync.read(bytes)
      const pixel = (x: number, y: number) => [
        ...png.data.subarray((y * png.width + x) * 4, (y * png.width + x) * 4 + 4),
      ]
      return {
        bars: points.map(([x, y]) => pixel(x!, y!)),
        center: pixel(200, tall ? 140 : 90),
        outside: pixel(10, 10),
      }
    }
    const fixed = await sample('fixed')
    for (const rgba of fixed.bars)
      assert.ok(
        rgba[3] === 255 && rgba.slice(0, 3).every((c) => c <= 6),
        JSON.stringify({ name, rgba }),
      )
    assert.ok(
      fixed.center[2]! > 150 && fixed.center[0]! < 40 && fixed.center[1]! < 40,
      'video frame is not visible',
    )
    assert.deepEqual(fixed.outside, [255, 255, 255, 255])
    // Negative control reproduces the old transparent letterbox without changing source files.
    await video.evaluate((element: HTMLVideoElement) => {
      element.style.background = 'transparent'
    })
    const transparent = await sample('old-transparent')
    for (const rgba of transparent.bars)
      assert.ok(
        rgba[0]! > 200 && rgba[1]! < 20 && rgba[2]! > 150,
        'negative control did not reveal the poster',
      )
    assert.deepEqual(errors, [])
    report.cases.push({
      name,
      status: 'passed',
      fixed,
      transparent,
      videoCount: await video.count(),
    })
    await page.close()
  }
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.error = String(error)
  throw error
} finally {
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2))
  await browser.close()
  await frontend.close()
}
console.log(JSON.stringify({ status: report.status, cases: report.cases.length }))
