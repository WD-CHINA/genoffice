/** Real-device read-only Word page layout, online and verified backend-disconnected replay. */
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createAndroidTestDevice, wait } from './android-test-device.mjs'
if (!process.env.ANDROID_SERIAL || !process.env.ANDROID_WORD_INPUTS)
  throw Error('Set ANDROID_SERIAL and ANDROID_WORD_INPUTS')
const output = resolve(process.env.ANDROID_WORD_EVIDENCE_DIR || '/tmp/genoffice-word-pages/android')
await mkdir(output, { recursive: true })
const inputs = JSON.parse(await readFile(process.env.ANDROID_WORD_INPUTS, 'utf8'))
const backend = process.env.PARSE_SERVER_URL || 'http://127.0.0.1:18787'
const viewer = process.env.ANDROID_VIEWER_URL || 'http://127.0.0.1:11019/viewer/'
const device = createAndroidTestDevice(
    [backend, viewer],
    Number(process.env.ANDROID_MEDIA_CDP_PORT || 19224),
  ),
  { adb } = device
const results = []
let client
async function open(input, mode) {
  client?.close()
  adb(
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
    backend,
    '--es',
    'viewer',
    viewer,
    '--es',
    'token',
    process.env.PARSE_SERVER_TOKEN || '',
    '--es',
    'fileId',
    input.fileId,
    '--ez',
    mode,
    'true',
  )
  for (let i = 0; i < 180; i++) {
    await wait(400)
    try {
      client?.close()
      client = await device.connect(adb('shell', 'pidof', 'com.genoffice.viewerdemo').trim())
      const s = await client.evaluate(
        `({origin:location.origin,file:new URL(location.href).searchParams.get('fileId'),ready:!!document.querySelector('.pv-page .pv-content'),fonts:document.fonts.status})`,
      )
      if (
        s.file === input.fileId &&
        s.ready &&
        s.fonts === 'loaded' &&
        (mode === 'online'
          ? s.origin === new URL(viewer).origin
          : s.origin !== new URL(viewer).origin)
      )
        return
    } catch {}
  }
  throw Error(input.name + ' ' + mode + ' did not open')
}
async function inspect(input, offline) {
  await client.evaluate(`document.querySelector('.pv-scroll').scrollTop=0`)
  await wait(1400)
  const state = await client.evaluate(
    `(()=>{const source=document.querySelector('.viewer-doc-electron-source .ProseMirror'),clone=document.querySelector('.pv-page .pv-content');return{url:location.href,ua:navigator.userAgent,viewport:[innerWidth,innerHeight],dpr:devicePixelRatio,fonts:document.fonts.status,pages:document.querySelectorAll('.pv-page').length,blocks:source.children.length,pitch:[source,clone].map(e=>getComputedStyle(e).getPropertyValue('--doc-grid-pitch')),first:[source,clone].map(e=>[...e.children].filter(n=>n.dataset.idx!=null).slice(0,12).map(n=>({idx:n.dataset.idx,h:n.getBoundingClientRect().height}))),paper:document.querySelector('.pv-page').getBoundingClientRect().toJSON(),editable:document.querySelectorAll('[contenteditable=true]').length,modeSwitch:!!document.querySelector('[aria-label="Word 显示模式"]'),continuous:!!document.querySelector('.viewer-doc-reading-paper'),alerts:[...document.querySelectorAll('[role=alert]')].map(e=>e.textContent),external:performance.getEntriesByType('resource').map(r=>r.name).filter(n=>/^https?:/.test(n)&&new URL(n).origin!==location.origin),broken:[...document.images].filter(i=>i.getAttribute('src')&&i.complete&&!i.naturalWidth).map(i=>i.src.slice(0,100))}})()`,
  )
  assert.ok(state.pages > 0)
  assert.equal(state.editable, 0)
  assert.equal(state.modeSwitch, false)
  assert.equal(state.continuous, false)
  assert.deepEqual(state.alerts, [])
  assert.deepEqual(state.broken, [])
  assert.equal(state.pitch[0], state.pitch[1])
  if (input.name === 'business') assert.deepEqual(state.first[0], state.first[1])
  if (offline)
    assert.deepEqual(
      state.external.filter((url) => url !== backend + '/v1/capabilities'),
      [],
      'Offline Word requested external assets beyond the deliberate backend-unavailable probe',
    )
  const prefix = input.name + '-' + (offline ? 'offline' : 'online')
  const first = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  await writeFile(join(output, prefix + '-first.png'), Buffer.from(first.data, 'base64'))
  // Exercise each actual sheet, including virtualized pages and the final footer.
  const pages = []
  for (let i = 0; i < state.pages; i++) {
    await client.evaluate(
      `(()=>{const e=document.querySelector('[data-pv-page="${i}"]'),s=document.querySelector('.pv-scroll');s.scrollTop+=e.getBoundingClientRect().top-s.getBoundingClientRect().top})()`,
    )
    await wait(180)
    pages.push(
      await client.evaluate(
        `(()=>{const e=document.querySelector('[data-pv-page="${i}"]');return{page:${i + 1},mounted:e.children.length,textLength:e.textContent.length,footer:e.querySelector('.page-hf-footer')?.textContent}})()`,
      ),
    )
    assert.ok(pages.at(-1).mounted, 'Page not mounted ' + i)
  }
  assert.ok(pages.at(-1).textLength, 'Last page blank')
  await client.evaluate(
    `document.querySelector('.pv-scroll').scrollTop=document.querySelector('.pv-scroll').scrollHeight`,
  )
  await wait(300)
  const png = device.readBytes(['exec-out', 'screencap', '-p'])
  await writeFile(join(output, prefix + '-native-last.png'), png)
  return { state, pages }
}
try {
  for (const input of inputs) {
    assert.match(input.fileId, /^[a-f0-9]{64}$/)
    device.access()
    await open(input, 'online')
    const online = await inspect(input, false)
    await open(input, 'download')
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
    assert.equal(manifest.format, 'docx')
    assert.equal(manifest.sourceVerified, true)
    await writeFile(join(output, input.name + '-manifest.json'), JSON.stringify(manifest, null, 2))
    client?.close()
    device.disconnect()
    await open(input, 'open')
    const unavailable = await client.evaluate(
      `(async()=>{try{await fetch(${JSON.stringify(backend + '/v1/capabilities')},{signal:AbortSignal.timeout(2000)});return false}catch{return true}})()`,
    )
    assert.equal(unavailable, true, 'Backend is reachable during offline test')
    const offline = await inspect(input, true)
    assert.equal(online.state.pages, offline.state.pages)
    assert.equal(online.state.blocks, offline.state.blocks)
    assert.deepEqual(online.state.first, offline.state.first)
    results.push({
      name: input.name,
      fileId: input.fileId,
      verified: true,
      backendUnavailable: unavailable,
      online,
      offline,
    })
    await writeFile(join(output, 'results.json'), JSON.stringify(results, null, 2))
    console.log(input.name, 'online/offline', offline.state.pages, 'pages PASS')
  }
} finally {
  client?.close()
  device.restore()
}
