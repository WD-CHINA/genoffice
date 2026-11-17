/** Real WebView drill: server-parsed TIFF/SVG online and verified bundle replay. */
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, basename } from 'node:path'
import { PNG } from 'pngjs'
import { createAndroidTestDevice, wait } from './android-test-device.mjs'

if (!process.env.ANDROID_OFFICE_INPUTS)
  throw Error('Set ANDROID_OFFICE_INPUTS to the uploaded demo input JSON')
const state = JSON.parse(await readFile(process.env.ANDROID_OFFICE_INPUTS, 'utf8'))
const output = resolve(
  process.env.ANDROID_OFFICE_OUTPUT || '/tmp/genoffice-office-fixed/android-pptx',
)
await mkdir(output, { recursive: true })
const device = createAndroidTestDevice([state.server, state.viewer], 19228)
const results = []
let client
async function ready(predicate) {
  for (let attempt = 0; attempt < 160; attempt++) {
    if (!client) {
      try {
        client = await device.connect(
          device.adb('shell', 'pidof', 'com.genoffice.viewerdemo').trim(),
        )
      } catch {
        /* WebView starting */
      }
    }
    if (client)
      for (const [id, context] of client.contexts) {
        if (!context.auxData?.isDefault) continue
        try {
          if (await client.evaluate(predicate, id)) return id
        } catch {
          /* navigation */
        }
      }
    await wait(400)
  }
  throw Error('WebView did not reach: ' + predicate)
}
async function open(input, mode) {
  client?.close()
  client = undefined
  device.adb(
    'shell',
    'am',
    'start',
    '-W',
    '-f',
    '0x10008000',
    '-n',
    'com.genoffice.viewerdemo/.MainActivity',
    '--es',
    'server',
    state.server,
    '--es',
    'viewer',
    state.viewer,
    '--es',
    'token',
    state.token,
    '--es',
    'fileId',
    input.fileId,
    '--ez',
    mode,
    'true',
  )
  return ready(
    `location.pathname.endsWith('/preview.html') && new URL(location.href).searchParams.get('fileId')===${JSON.stringify(input.fileId)} && !!document.querySelector('.viewer-slide-stage canvas')`,
  )
}
async function pixels() {
  const bytes = device.readBytes(['exec-out', 'screencap', '-p']),
    image = PNG.sync.read(bytes)
  const counts = {
    redLeft: 0,
    redRight: 0,
    greenLeft: 0,
    greenRight: 0,
    purpleLeft: 0,
    purpleRight: 0,
  }
  for (let i = 0; i < image.data.length; i += 4) {
    const p = image.data,
      side = (i / 4) % image.width < image.width / 2 ? 'Left' : 'Right'
    if (p[i] > 180 && p[i + 1] < 80 && p[i + 2] < 110) counts['red' + side]++
    if (p[i] < 60 && p[i + 1] > 140 && p[i + 2] < 130) counts['green' + side]++
    if (p[i] > 95 && p[i] < 150 && p[i + 1] > 30 && p[i + 1] < 90 && p[i + 2] > 200)
      counts['purple' + side]++
  }
  return { bytes, counts }
}
try {
  for (const input of state.inputs.filter(
    (item) => item.format === 'pptx' && !item.file.startsWith('03'),
  )) {
    for (const mode of ['online', 'download']) {
      device.access()
      const id = await open(input, mode)
      let offlineVerified = false
      if (mode === 'download') {
        const pointer = JSON.parse(
          device.adb(
            'exec-out',
            'run-as',
            'com.genoffice.viewerdemo',
            'cat',
            `files/bundle-cache/${input.fileId}/current.json`,
          ),
        )
        const manifest = JSON.parse(
          device.adb(
            'exec-out',
            'run-as',
            'com.genoffice.viewerdemo',
            'cat',
            `files/bundle-cache/${input.fileId}/versions/${pointer.artifactKey}/manifest.json`,
          ),
        )
        assert.equal(manifest.sourceVerified, true)
        assert.equal(manifest.format, 'pptx')
        device.disconnect()
        offlineVerified = await client.evaluate(
          `(async()=>{try{await fetch(${JSON.stringify(state.server + '/v1/capabilities')},{signal:AbortSignal.timeout(1500)});return false}catch{return true}})()`,
          id,
        )
        assert.equal(offlineVerified, true, 'backend must be unreachable')
        assert(
          await client.evaluate(
            `location.pathname.startsWith('/viewer/') && location.origin!==${JSON.stringify(new URL(state.viewer).origin)}`,
            id,
          ),
        )
      }
      const pages = input.file.startsWith('02') ? 2 : 1
      for (let page = 1; page <= pages; page++) {
        if (page > 1)
          await client.evaluate(
            `(()=>{const s=document.querySelector('select[aria-label="PPT 页码"]');s.value=${JSON.stringify(String(page))};s.dispatchEvent(new Event('change',{bubbles:true}));})()`,
            id,
          )
        await ready(
          `document.querySelector('[aria-label="PPT 当前页"]')?.textContent===${JSON.stringify(`${page} / ${pages}`)}`,
        )
        let capture
        for (let attempt = 0; attempt < 50; attempt++) {
          await wait(300)
          capture = await pixels()
          const c = capture.counts,
            color = input.file.startsWith('04B')
              ? 'purple'
              : input.file.startsWith('02') && page === 1
                ? 'red'
                : 'green'
          if (
            c[color + 'Right'] > 1000 &&
            (input.file.includes('05_') ? c[color + 'Left'] < 1000 : c[color + 'Left'] > 1000)
          )
            break
          if (attempt === 49)
            throw Error(JSON.stringify({ file: input.file, mode, page, pixels: c }))
        }
        const alerts = await client.evaluate(
          `[...document.querySelectorAll('[role=alert]')].map(e=>e.textContent)`,
          id,
        )
        assert.deepEqual(alerts, [])
        await writeFile(
          resolve(output, `${basename(input.file)}-${mode}-${page}.png`),
          capture.bytes,
        )
        results.push({
          file: input.file,
          mode,
          page,
          pixels: capture.counts,
          offlineVerified,
          status: 'passed',
        })
      }
      console.log(input.file, mode, 'passed')
    }
    await writeFile(resolve(output, 'report.json'), JSON.stringify(results, null, 2))
  }
} finally {
  client?.close()
  device.restore()
}
