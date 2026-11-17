/** Original-PDF download, cold offline replay and real WebView page rendering. */
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { createAndroidTestDevice, wait } from './android-test-device.mjs'

const serial = process.env.ANDROID_SERIAL
assert.ok(serial && process.env.ANDROID_PDF_INPUTS, 'Set ANDROID_SERIAL and ANDROID_PDF_INPUTS')
const inputs = JSON.parse(await readFile(process.env.ANDROID_PDF_INPUTS, 'utf8'))
assert.ok(Array.isArray(inputs) && inputs.length > 0 && inputs.length <= 50)
assert.ok(inputs.every((item) => /^[a-f0-9]{64}$/.test(item.fileId) && /^[\w.-]+$/.test(item.name)))
const output = resolve(process.env.ANDROID_PDF_EVIDENCE_DIR || '/tmp/genoffice-pdf-offline/device')
await mkdir(output, { recursive: true })
const backend = process.env.PARSE_SERVER_URL || 'http://127.0.0.1:18787'
const viewer = process.env.ANDROID_VIEWER_URL || 'http://127.0.0.1:11019/'
const token = process.env.PARSE_SERVER_TOKEN || ''
const cdpPort = Number(process.env.ANDROID_MEDIA_CDP_PORT || 19224)
const device = createAndroidTestDevice([backend, viewer], cdpPort)
const { adb, access } = device
const results = []

async function open(input, mode) {
  // A cold process proves that neither the previous HTTP server nor a warm PDF.js cache is required.
  adb('shell', 'am', 'force-stop', 'com.genoffice.viewerdemo')
  adb(
    'shell',
    'am',
    'start',
    '-W',
    '-n',
    'com.genoffice.viewerdemo/.MainActivity',
    '--es',
    'server',
    backend,
    '--es',
    'viewer',
    viewer,
    '--es',
    'token',
    token,
    '--es',
    'fileId',
    input.fileId,
    '--ez',
    mode,
    'true',
  )
  for (let attempt = 0; attempt < 160; attempt++) {
    await wait(500)
    let c
    try {
      const pid = adb('shell', 'pidof', 'com.genoffice.viewerdemo').trim()
      if (!pid) continue
      c = await device.connect(pid)
      for (const [id, context] of c.contexts)
        if (context.auxData?.isDefault) {
          const state = await c.evaluate(
            `({origin:location.origin,fileId:new URL(location.href).searchParams.get('fileId'),local:location.pathname.startsWith('/viewer/'),pages:document.querySelectorAll('.viewer-pdf-page').length,ready:!!document.querySelector('.pdf-page-content canvas'),error:document.querySelector('[role=alert]')?.textContent})`,
            id,
          )
          if (state.error) throw Error(state.error)
          if (
            state.fileId === input.fileId &&
            state.pages &&
            state.ready &&
            (mode === 'online'
              ? state.origin === new URL(viewer).origin
              : state.local && state.origin !== new URL(viewer).origin)
          )
            return { c, id }
        }
      c.close()
    } catch (error) {
      c?.close()
      if (!/ECONNREFUSED|fetch failed|No WebView|disconnected|Cannot find context with specified id/.test(String(error))) throw error
    }
  }
  throw Error(`PDF ${input.name} ${mode} did not render`)
}

async function inspect(c, id, input, offline) {
  const count = await c.evaluate(`document.querySelectorAll('.viewer-pdf-page').length`, id)
  const pages = []
  for (let page = 0; page < count; page++) {
    await c.evaluate(
      `document.querySelector('.viewer-pdf-page[data-idx="${page}"]').scrollIntoView({block:'start'})`,
      id,
    )
    let state
    for (let attempt = 0; attempt < 100; attempt++) {
      state = await c.evaluate(
        `(()=>{const root=document.querySelector('.viewer-pdf-page[data-idx="${page}"]');const canvas=root?.querySelector('canvas');return{width:canvas?.width,height:canvas?.height,text:root?.querySelector('.textLayer')?.textContent,alerts:[...document.querySelectorAll('[role=alert]')].map(n=>n.textContent)}})()`,
        id,
      )
      assert.equal(state.alerts.length, 0)
      if (state.width > 0 && state.height > 0 && state.text?.trim()) break
      await wait(150)
    }
    assert.ok(
      state.width > 0 && state.height > 0 && state.text?.trim(),
      `PDF page ${page + 1} is blank`,
    )
    pages.push({
      page: page + 1,
      width: state.width,
      height: state.height,
      text: state.text.slice(0, 120),
    })
    if (page === 0)
      await writeFile(
        join(output, `${input.name}-${offline ? 'offline' : 'online'}.png`),
        device.readBytes(['exec-out', 'screencap', '-p']),
      )
  }
  if (input.expectedPages) assert.equal(count, input.expectedPages)
  const resources = await c.evaluate(
    `performance.getEntriesByType('resource').map(item=>({url:item.name,size:item.transferSize}))`,
    id,
  )
  const origin = await c.evaluate('location.origin', id)
  const external = resources.filter(
    (item) => /^https?:/.test(item.url) && new URL(item.url).origin !== origin,
  )
  if (offline) assert.deepEqual(external, [], 'Offline PDF requested external resources')
  const errors = c.events.filter((event) => event.method === 'Runtime.exceptionThrown')
  assert.deepEqual(errors, [], 'PDF threw a WebView exception')
  await c.evaluate(
    `document.querySelector('.viewer-pdf-page[data-idx="0"]').scrollIntoView({block:'start'})`,
    id,
  )
  return { count, pages, external, resources: resources.length }
}

try {
  for (const input of inputs) {
    access()
    const online = await open(input, 'online')
    let onlineResult
    try {
      onlineResult = await inspect(online.c, online.id, input, false)
    } finally {
      online.c.close()
    }
    const downloaded = await open(input, 'download')
    downloaded.c.close()
    const pointer = JSON.parse(
      adb(
        'exec-out',
        'run-as',
        'com.genoffice.viewerdemo',
        'cat',
        `files/bundle-cache/${input.fileId}/current.json`,
      ),
    )
    const manifest = JSON.parse(
      adb(
        'exec-out',
        'run-as',
        'com.genoffice.viewerdemo',
        'cat',
        `files/bundle-cache/${input.fileId}/versions/${pointer.artifactKey}/manifest.json`,
      ),
    )
    assert.equal(manifest.format, 'pdf')
    assert.equal(manifest.sourceSha256, input.fileId)
    assert.equal(manifest.sourceVerified, true)
    const original = device.readBytes(
      [
        'exec-out',
        'run-as',
        'com.genoffice.viewerdemo',
        'cat',
        `files/bundle-cache/${input.fileId}/versions/${pointer.artifactKey}/document.pdf`,
      ],
      256 * 1024 * 1024,
    )
    assert.equal(createHash('sha256').update(original).digest('hex'), input.fileId)
    assert.equal(original.length, manifest.sourceSize)
    await writeFile(join(output, `${input.name}-manifest.json`), JSON.stringify(manifest, null, 2))
    device.disconnect()
    const offline = await open(input, 'open')
    try {
      const range = await offline.c.evaluate(
        `(async()=>{const url=new URLSearchParams(location.search);const response=await fetch((url.get('server')||location.origin)+'/v1/files/'+url.get('fileId')+'/content',{headers:{Range:'bytes=0-31'}});return{status:response.status,etag:response.headers.get('ETag'),type:response.headers.get('Content-Type'),bytes:[...new Uint8Array(await response.arrayBuffer())]}})()`,
        offline.id,
      )
      assert.equal(range.status, 206)
      assert.equal(range.etag, `"${input.fileId}"`)
      assert.equal(range.type, 'application/pdf')
      assert.deepEqual(range.bytes, [...original.subarray(0, 32)])
      const offlineResult = await inspect(offline.c, offline.id, input, true)
      assert.equal(offlineResult.count, onlineResult.count)
      // Probe reachability after recording resources, so the deliberate failed request is excluded.
      const unavailable = await offline.c.evaluate(
        `(async()=>{try{await fetch(${JSON.stringify(backend + '/v1/capabilities')},{signal:AbortSignal.timeout(2000)});return false}catch{return true}})()`,
        offline.id,
      )
      assert.ok(unavailable, 'Remote backend remains reachable')
      results.push({
        name: input.name,
        fileId: input.fileId,
        sourceVerified: true,
        coldOfflineOpen: true,
        backendUnavailable: unavailable,
        rangeBytes: 32,
        online: onlineResult,
        offline: offlineResult,
      })
      await writeFile(join(output, 'results.json'), JSON.stringify(results, null, 2))
      console.log(input.name, 'PASS', offlineResult.count, 'pages')
    } finally {
      offline.c.close()
    }
  }
} finally {
  device.restore()
}
