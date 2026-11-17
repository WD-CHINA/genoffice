/** Real-device DOCX online + verified offline replay. Keeps app data and restores USB reverse mappings. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createAndroidTestDevice, wait } from './android-test-device.mjs'
const serial = process.env.ANDROID_SERIAL
if (!serial || !process.env.ANDROID_WORD_INPUTS)
  throw Error('Set ANDROID_SERIAL and ANDROID_WORD_INPUTS')
const output = resolve(process.env.ANDROID_WORD_EVIDENCE_DIR || '/tmp/genoffice-word-fixes/android')
await mkdir(output, { recursive: true })
const inputs = JSON.parse(await readFile(process.env.ANDROID_WORD_INPUTS, 'utf8'))
const backend = process.env.PARSE_SERVER_URL || 'http://127.0.0.1:18787'
const viewer = process.env.ANDROID_VIEWER_URL || 'http://127.0.0.1:11019/'
const token = process.env.PARSE_SERVER_TOKEN || '',
  port = Number(process.env.ANDROID_MEDIA_CDP_PORT || 19224)
const device = createAndroidTestDevice([backend, viewer], port)
const { adb, access } = device
const results = []
async function open(input, mode) {
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
    token,
    '--es',
    'fileId',
    input.fileId,
    '--ez',
    mode,
    'true',
  )
  for (let attempt = 0; attempt < 180; attempt++) {
    await wait(700)
    let c
    try {
      const pid = adb('shell', 'pidof', 'com.genoffice.viewerdemo').trim()
      if (!pid) continue
      c = await device.connect(pid)
      for (const [id, context] of c.contexts)
        if (context.auxData?.isDefault) {
          const ready = await c.evaluate(
            `({origin:location.origin,fileId:new URL(location.href).searchParams.get('fileId'),preview:location.pathname.endsWith('/preview.html'),local:location.pathname.startsWith('/viewer/'),units:document.querySelectorAll('.viewer-doc-reading-unit .doc-page').length})`,
            id,
          )
          if (
            ready.fileId === input.fileId &&
            ready.preview &&
            ready.units &&
            (mode === 'online'
              ? ready.origin === new URL(viewer).origin
              : ready.local && ready.origin !== new URL(viewer).origin)
          )
            return { c, id }
        }
      c.close()
    } catch {
      c?.close()
    }
  }
  throw Error(`${input.name}: Word ${mode} did not open`)
}
async function settled(c, id) {
  let previous = '',
    stable = 0
  for (let attempt = 0; attempt < 60; attempt++) {
    const state = await c.evaluate(
      `({height:document.querySelector('.viewer-doc-reading-scroll')?.scrollHeight,
      measure:document.querySelectorAll('.viewer-doc-remote-measure').length,fonts:document.fonts.status,loading:!!document.querySelector('.viewer-doc-remote-loading'),
      images:[...document.images].filter(image=>image.getAttribute('src')).every(image=>image.complete)})`,
      id,
    )
    const value = JSON.stringify(state)
    stable =
      value === previous &&
      state.fonts === 'loaded' &&
      !state.loading &&
      !state.measure &&
      state.images
        ? stable + 1
        : 0
    if (stable >= 4) return
    previous = value
    await wait(250)
  }
  throw Error('Word layout did not settle')
}
async function inspect(c, id, input, disconnected) {
  await settled(c, id)
  await c.evaluate(`document.querySelector('.viewer-doc-reading-scroll').scrollTop=0`, id)
  await settled(c, id)
  const typography = await c.evaluate(
    `(()=>{const root=document.querySelector('.viewer-doc-reading'),editor=root.querySelector('.doc-page'),span=editor.querySelector('.doc-east-asian-font');return{sheets:document.querySelectorAll('[data-docx-style-context][data-doc-css]').length,fallback:root.dataset.docxThemeFallback,baseSize:getComputedStyle(editor).fontSize,chineseFont:span&&getComputedStyle(span).fontFamily,themeLoaded:[...document.fonts].some(face=>face.family.includes('GenOffice Theme Sans SC')&&face.status==='loaded')}})()`,
    id,
  )
  if (typography.sheets !== 1) throw Error('Word document style scope is missing or duplicated')
  if (
    typography.fallback === 'bundled' &&
    (!typography.themeLoaded || !typography.chineseFont?.includes('GenOffice Theme Sans SC'))
  )
    throw Error('Word bundled theme font did not load')
  const units = new Map(),
    notes = new Map(),
    external = new Set()
  let finished = false
  for (let step = 0; step < 1200; step++) {
    const state = await c.evaluate(
      `(()=>{const root=document.querySelector('.viewer-doc-reading'),scroll=root.querySelector('.viewer-doc-reading-scroll');return{
        paper:getComputedStyle(root.querySelector('.viewer-doc-reading-paper')).backgroundColor,
        pages:root.querySelectorAll('.pv-page,.viewer-doc-remote-page,[data-source-from]').length,
        editable:root.querySelectorAll('[contenteditable="true"],.doc-content-editing').length,
        counters:root.querySelectorAll('.viewer-page-controls').length,
        units:[...root.querySelectorAll('[data-unit-id]')].map(unit=>[unit.dataset.unitId,unit.textContent||'']),
        notes:[...root.querySelectorAll('[data-note-body]')].map(note=>[note.dataset.noteKind+':'+note.dataset.noteBody,note.textContent||'']),
        images:[...root.querySelectorAll('img[src]')].map(image=>({ready:image.complete,broken:image.complete&&!image.naturalWidth,local:image.src.startsWith('data:')||new URL(image.src).origin===location.origin})),
        external:performance.getEntriesByType('resource').map(entry=>entry.name).filter(url=>/^https?:/.test(url)&&new URL(url).origin!==location.origin),
        atEnd:scroll.scrollTop+scroll.clientHeight>=scroll.scrollHeight-2,
        busy:!!root.querySelector('[role="status"],.viewer-doc-remote-loading,.viewer-doc-remote-more'),
        alerts:[...root.querySelectorAll('[role="alert"]')].map(node=>node.textContent),
      }})()`,
      id,
    )
    if (state.paper !== 'rgb(255, 255, 255)') throw Error('Word reading paper is not readable')
    if (state.pages || state.editable || state.counters)
      throw Error('Continuous reading acquired pages or editing controls')
    if (state.alerts.length || state.images.some((image) => image.broken))
      throw Error(JSON.stringify(state))
    if (disconnected && state.images.some((image) => !image.local))
      throw Error('Offline Word image is not local')
    for (const pair of state.units) units.set(...pair)
    for (const pair of state.notes) notes.set(...pair)
    for (const url of state.external) if (url !== backend + '/v1/capabilities') external.add(url)
    if (state.atEnd && !state.busy && state.images.every((image) => image.ready)) {
      finished = true
      break
    }
    await c.evaluate(
      `(()=>{const scroll=document.querySelector('.viewer-doc-reading-scroll');scroll.scrollBy(0,scroll.clientHeight*.75)})()`,
      id,
    )
    await wait(200)
  }
  if (!finished) throw Error('Continuous reading did not reach the final source unit')
  if (disconnected && external.size)
    throw Error('Offline Word requested remote assets: ' + JSON.stringify([...external]))
  const text = [...units.values(), ...notes.values()].join('')
  if (input.name === 'partial-pages' && !text.includes('CHUNK_PARAGRAPH_419'))
    throw Error('Last Word chunk not reached')
  if (input.name === 'long-and-merged')
    for (const marker of ['LONG_START', 'LONG_END', 'MERGE_START', 'MERGE_END', 'DOCUMENT_END'])
      if (!text.includes(marker)) throw Error('Missing Word marker ' + marker)
  if (input.name === 'long-notes' && !text.includes('ENDNOTE_BODY_LAST'))
    throw Error('Endnote tail not reached')
  if (input.name === '06-with-footnotes' && !notes.size) throw Error('Footnote bodies are missing')
  if (input.name === 'independent-cells') {
    for (const [prefix, count] of [
      ['FLOW_A', 75],
      ['FLOW_B', 61],
    ])
      for (let index = 0; index < count; index++) {
        const marker = prefix + '_' + String(index).padStart(3, '0')
        if (text.split(marker).length !== 2)
          throw Error('Lost or duplicated cell content ' + marker)
      }
    for (const marker of ['FLOW_MIDDLE', 'FLOW_BOTTOM'])
      if (text.split(marker).length !== 2) throw Error('Lost or duplicated aligned cell ' + marker)
  }
  const png = device.readBytes(['exec-out', 'screencap', '-p'])
  await writeFile(join(output, `${input.name}-${disconnected ? 'offline' : 'online'}.png`), png)
  return {
    typography,
    units: units.size,
    notes: notes.size,
    external: [...external],
    continuous: true,
    reachedTail: true,
  }
}

try {
  for (const input of inputs) {
    if (!/^[a-f0-9]{64}$/.test(input.fileId)) throw Error('Invalid Word file ID')
    access()
    const online = await open(input, 'online')
    let onlineResult
    try {
      onlineResult = await inspect(online.c, online.id, input, false)
    } finally {
      online.c.close()
    }
    const offline = await open(input, 'download')
    try {
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
      if (manifest.format !== 'docx' || !manifest.sourceVerified)
        throw Error('Word bundle was not verified')
      await writeFile(
        join(output, `${input.name}-manifest.json`),
        JSON.stringify(manifest, null, 2),
      )
      device.disconnect()
      const unavailable = await offline.c.evaluate(
        `(async()=>{try{await fetch(${JSON.stringify(backend + '/v1/capabilities')},{signal:AbortSignal.timeout(2000)});return false}catch{return true}})()`,
        offline.id,
      )
      if (!unavailable) throw Error('Remote backend is reachable')
      const offlineResult = await inspect(offline.c, offline.id, input, true)
      if (
        onlineResult.typography.baseSize !== offlineResult.typography.baseSize ||
        onlineResult.typography.chineseFont !== offlineResult.typography.chineseFont
      )
        throw Error('Word typography differs between online and offline reading')
      results.push({
        name: input.name,
        fileId: input.fileId,
        verified: true,
        backendUnavailable: unavailable,
        online: onlineResult,
        offline: offlineResult,
      })
      await writeFile(join(output, 'results.json'), JSON.stringify(results, null, 2))
      console.log(input.name, 'PASS', offlineResult.units, 'source units')
    } finally {
      offline.c.close()
    }
  }
} finally {
  device.restore()
}
