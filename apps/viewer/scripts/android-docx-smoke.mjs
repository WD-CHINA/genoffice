/** Real-device DOCX online + verified offline replay. Keeps app data and restores USB reverse mappings. */
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { inspectDocxTableFlow, summarizeDocxTableFlow } from './docx-flow-probe.mjs'
import { connectAndroidWebView } from './android-cdp.mjs'
const serial = process.env.ANDROID_SERIAL
if (!serial || !process.env.ANDROID_WORD_INPUTS)
  throw Error('Set ANDROID_SERIAL and ANDROID_WORD_INPUTS')
const output = resolve(process.env.ANDROID_WORD_EVIDENCE_DIR || '/tmp/genoffice-word-fixes/android')
await mkdir(output, { recursive: true })
const inputs = JSON.parse(await readFile(process.env.ANDROID_WORD_INPUTS, 'utf8'))
const backend = process.env.PARSE_SERVER_URL || 'http://127.0.0.1:18787'
const viewer = process.env.ANDROID_VIEWER_URL || 'http://127.0.0.1:11019/'
for (const url of [backend, viewer])
  if (new URL(url).hostname !== '127.0.0.1' || !new URL(url).port)
    throw Error('USB drill requires loopback services with explicit ports')
const token = process.env.PARSE_SERVER_TOKEN || '',
  port = Number(process.env.ANDROID_MEDIA_CDP_PORT || 19224)
const adb = (...args) =>
  execFileSync('adb', ['-s', serial, ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const ports = [...new Set([new URL(backend).port, new URL(viewer).port])]
const reverses = new Map(
  adb('reverse', '--list')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => line.trim().split(/\s+/).slice(-2)),
)
const results = []
const access = () => {
  for (const port of ports) adb('reverse', `tcp:${port}`, `tcp:${port}`)
}
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
      adb('forward', `tcp:${port}`, `localabstract:webview_devtools_remote_${pid}`)
      c = await connectAndroidWebView(port)
      for (const [id, context] of c.contexts)
        if (context.auxData?.isDefault) {
          const ready = await c.evaluate(
            `({preview:location.pathname.endsWith('/preview.html'),local:location.pathname.startsWith('/viewer/'),pages:document.querySelectorAll('.viewer-doc-remote-page').length})`,
            id,
          )
          if (ready.preview && ready.pages && (mode === 'online') !== ready.local) return { c, id }
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
      `({height:document.querySelector('.viewer-doc-remote-canvas')?.style.height,
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
  // Online origins persist the previous reading anchor; every drill must traverse from page one.
  await c.evaluate(`document.querySelector('.viewer-doc-remote-viewport').scrollTop=0`, id)
  await settled(c, id)
  const snapshot = await c.evaluate(
    `(async()=>{
    await document.fonts.ready;
    const images=await Promise.all([...document.images].filter(image=>image.getAttribute('src')).map(async image=>{try{await image.decode();return{width:image.naturalWidth,local:image.src.startsWith('data:')||new URL(image.src).origin===location.origin}}catch{return{error:true}}}));
    const external=performance.getEntriesByType('resource').map(entry=>entry.name).filter(url=>/^https?:/.test(url)&&new URL(url).origin!==location.origin);
    const height=[...document.querySelectorAll('.viewer-doc-remote-page')].map(page=>page.getBoundingClientRect().height);
    return{images,external,height,paper:getComputedStyle(document.querySelector('.viewer-doc-remote-page')).backgroundColor,notes:document.querySelectorAll('[data-note-body]').length,alerts:[...document.querySelectorAll('[role=alert]')].map(node=>node.textContent)}
  })()`,
    id,
  )
  if (snapshot.paper !== 'rgb(255, 255, 255)')
    throw Error('Word paper is not readable in the dark shell')
  if (snapshot.alerts.length || snapshot.images.some((image) => image.error))
    throw Error(JSON.stringify(snapshot))
  snapshot.typography = await c.evaluate(
    `(()=>{const root=document.querySelector('.viewer-doc-remote'),editor=root.querySelector('.doc-page'),span=editor.querySelector('.doc-east-asian-font');return{sheets:document.querySelectorAll('[data-docx-style-context][data-doc-css]').length,fallback:root.dataset.docxThemeFallback,baseSize:getComputedStyle(editor).fontSize,chineseFont:span&&getComputedStyle(span).fontFamily,themeLoaded:[...document.fonts].some(face=>face.family.includes('GenOffice Theme Sans SC')&&face.status==='loaded')}})()`,
    id,
  )
  if (snapshot.typography.sheets !== 1)
    throw Error('Word document style scope is missing or duplicated')
  if (
    input.name === 'business' &&
    (!snapshot.typography.themeLoaded ||
      !snapshot.typography.chineseFont?.includes('GenOffice Theme Sans SC'))
  )
    throw Error('Business Word bundled theme font did not load')
  if (input.name === 'business') {
    snapshot.pictureExtents = await c.evaluate(
      `([...document.querySelectorAll('.viewer-doc-remote-column .doc-inline-pic > img')].filter(image=>image.naturalWidth>0).map(image=>{const rect=image.getBoundingClientRect();return{ratio:rect.width/rect.height,authoredRatio:parseFloat(image.style.width)/parseFloat(image.style.height),clip:getComputedStyle(image.parentElement).clipPath}}))`,
      id,
    )
    if (
      !snapshot.pictureExtents.length ||
      snapshot.pictureExtents.some(
        (image) => Math.abs(image.ratio - image.authoredRatio) > 0.002 || image.clip === 'none',
      )
    )
      throw Error('Business Word picture ratio or cell clipping is incorrect')
    snapshot.rightEdge = await c.evaluate(
      `(()=>{const t=[...document.querySelectorAll('.viewer-doc-remote-column .doc-table')].find(node=>!node.closest('[data-docx-flow-source]')); const cell=t.rows[0].cells[t.rows[0].cells.length-1],r=cell.getBoundingClientRect();return{border:getComputedStyle(cell).borderRight,visible:document.elementsFromPoint(r.right-.25,r.top+r.height/2).some(n=>n===cell||cell.contains(n))}})()`,
      id,
    )
    if (!snapshot.rightEdge.visible)
      throw Error('Business Word outer right table border is clipped')
  }
  snapshot.external = snapshot.external.filter((url) => url !== backend + '/v2/capabilities')
  if (disconnected && snapshot.images.some((image) => !image.local))
    throw Error('Offline Word image is not local')
  if (disconnected && snapshot.external.length)
    throw Error('Offline Word requested remote assets: ' + JSON.stringify(snapshot.external))
  const visited = new Set()
  const frames = new Map()
  const flows = new Map()
  for (let step = 0; step < 160; step++) {
    if (['business', 'independent-cells'].includes(input.name)) {
      const entries = await c.evaluate(
        `(${inspectDocxTableFlow.toString()})(${JSON.stringify([...flows.keys()])})`,
        id,
      )
      for (const entry of entries) flows.set(entry.key, entry)
    }
    if (input.name === 'business') {
      const slices = await c.evaluate(
        `([...document.querySelectorAll('.viewer-doc-fragment')].map(fragment=>{const slice=[...fragment.querySelectorAll('.viewer-doc-fragment-slice')].at(-1),table=[...slice.querySelectorAll('table')].find(node=>!node.closest('[data-docx-flow-source]'));if(!table)return null;const r=slice.getBoundingClientRect(),t=table.getBoundingClientRect(),edges=[...slice.querySelectorAll('[data-docx-table-edge]')].filter(edge=>parseFloat(getComputedStyle(edge)[edge.dataset.docxTableEdge==='top'?'borderTopWidth':'borderBottomWidth'])>0);return{key:fragment.dataset.docxIndex+':'+fragment.dataset.sourceFrom,topNeeded:r.top>t.top+1,bottomNeeded:r.bottom<t.bottom-1,top:edges.some(edge=>edge.dataset.docxTableEdge==='top'),bottom:edges.some(edge=>edge.dataset.docxTableEdge==='bottom')}}).filter(Boolean))`,
        id,
      )
      for (const slice of slices) frames.set(slice.key, slice)
    }
    const status = await c.evaluate(
      `(()=>{const root=document.querySelector('.viewer-doc-remote-viewport');const pages=[...document.querySelectorAll('.viewer-doc-remote-page')].map(page=>page.dataset.pageIndex);const done=root.scrollTop+root.clientHeight>=root.scrollHeight-2&&!document.querySelector('.viewer-doc-remote-more,.viewer-doc-remote-loading');root.scrollTop=Math.min(root.scrollHeight,root.scrollTop+650);return{pages,done}})()`,
      id,
    )
    status.pages.forEach((page) => visited.add(page))
    if (status.done) {
      await settled(c, id)
      if (
        await c.evaluate(
          `(()=>{const root=document.querySelector('.viewer-doc-remote-viewport');return root.scrollTop+root.clientHeight>=root.scrollHeight-2})()`,
          id,
        )
      )
        break
    }
    await wait(80)
  }
  if (input.name === 'business') {
    snapshot.tableFrames = [...frames.values()]
    if (
      !snapshot.tableFrames.some((frame) => frame.bottomNeeded) ||
      snapshot.tableFrames.some(
        (frame) => frame.top !== frame.topNeeded || frame.bottom !== frame.bottomNeeded,
      )
    )
      throw Error('Business Word continuation table frames are incomplete')
  }
  if (['business', 'independent-cells'].includes(input.name)) {
    snapshot.cellFlow = summarizeDocxTableFlow([...flows.values()])
    if (
      snapshot.cellFlow.fragments < 2 ||
      snapshot.cellFlow.expected < 100 ||
      snapshot.cellFlow.missing.length ||
      snapshot.cellFlow.duplicates.length
    )
      throw Error(
        'Independent cell continuation lost or duplicated glyphs: ' +
          JSON.stringify(snapshot.cellFlow),
      )
    if (input.name === 'independent-cells') {
      const markers = snapshot.cellFlow.markers
      const middle = markers.find((marker) => marker.text === 'FLOW_MIDDLE')
      const bottom = markers.find((marker) => marker.text === 'FLOW_BOTTOM')
      if (
        markers.length !== 2 ||
        !middle ||
        Math.abs(middle.top - middle.bottom) >= 4 ||
        !bottom ||
        bottom.bottom < -0.1 ||
        bottom.bottom >= 15
      )
        throw Error('Independent cell vertical alignment failed: ' + JSON.stringify(markers))
    }
  }
  if (input.name === 'long-notes' && visited.size < 3) throw Error('Long footnote did not continue')
  const terminal = await c.evaluate(
    `({text:document.body.innerText.slice(-1400),alerts:[...document.querySelectorAll('[role=alert]')].map(node=>node.textContent)})`,
    id,
  )
  if (input.name === 'partial-pages' && !terminal.text.includes('CHUNK_PARAGRAPH_419'))
    throw Error('Last Word chunk not reached')
  if (terminal.alerts.length) throw Error(JSON.stringify(terminal.alerts))
  if (input.name === 'long-and-merged' && !terminal.text.includes('DOCUMENT_END'))
    throw Error('Word tail not reached')
  if (input.name === 'long-notes' && !terminal.text.includes('ENDNOTE_BODY_LAST'))
    throw Error('Endnote tail not reached')
  await c.evaluate(
    `(()=>{const root=document.querySelector('.viewer-doc-remote-viewport');const pages=[...document.querySelectorAll('.viewer-doc-remote-page')];const page=pages.at(-1);if(page)root.scrollTop+=page.getBoundingClientRect().top-root.getBoundingClientRect().top})()`,
    id,
  )
  await wait(200)
  const png = execFileSync('adb', ['-s', serial, 'exec-out', 'screencap', '-p'], {
    maxBuffer: 32 * 1024 * 1024,
  })
  await writeFile(join(output, `${input.name}-${disconnected ? 'offline' : 'online'}.png`), png)
  return { ...snapshot, visited: visited.size, reachedTail: true }
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
      for (const port of ports) adb('reverse', '--remove', `tcp:${port}`)
      const unavailable = await offline.c.evaluate(
        `(async()=>{try{await fetch(${JSON.stringify(backend + '/v2/capabilities')},{signal:AbortSignal.timeout(2000)});return false}catch{return true}})()`,
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
      console.log(input.name, 'PASS', offlineResult.visited, 'pages')
    } finally {
      offline.c.close()
    }
  }
} finally {
  for (const port of ports) {
    const previous = reverses.get(`tcp:${port}`)
    if (previous) adb('reverse', `tcp:${port}`, previous)
    else {
      try {
        adb('reverse', '--remove', `tcp:${port}`)
      } catch {}
    }
  }
}
