/** Real Android WebView + offline cache drill. Requires an installed debug APK and uploaded PPTX file IDs.
 * ANDROID_SERIAL, PARSE_SERVER_TOKEN, ANDROID_MEDIA_INPUTS=<JSON [{name,fileId}]>.
 * Uses USB reverse isolation; preserves app data and restores the prior reverse mappings.
 * Media playback is muted; this does not certify audible quality or Office animation fidelity.
 */
import { execFileSync } from 'node:child_process'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
async function connect() {
  const pages = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()
  const page = pages.find((p) => p.type === 'page')
  if (!page) throw Error('No WebView page')
  const ws = new WebSocket(page.webSocketDebuggerUrl),
    pending = new Map(),
    contexts = new Map(),
    events = []
  let id = 0
  await new Promise((r, j) => {
    ws.onopen = r
    ws.onerror = j
  })
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id) {
      const p = pending.get(m.id)
      pending.delete(m.id)
      if (p) clearTimeout(p.timer)
      if (m.error) p?.reject(Error(JSON.stringify(m.error)))
      else p?.resolve(m.result)
    } else {
      if (m.method === 'Runtime.executionContextCreated')
        contexts.set(m.params.context.id, m.params.context)
      if (m.method === 'Runtime.executionContextDestroyed')
        contexts.delete(m.params.executionContextId)
      events.push(m)
    }
  }
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mid = ++id
      const timer = setTimeout(() => {
        pending.delete(mid)
        reject(Error(`CDP timeout: ${method}`))
      }, 60_000)
      pending.set(mid, { resolve, reject, timer })
      ws.send(JSON.stringify({ id: mid, method, params }))
    })
  ws.onclose = () => {
    for (const p of pending.values()) {
      clearTimeout(p.timer)
      p.reject(Error('WebView disconnected'))
    }
    pending.clear()
  }
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Network.enable')
  const evaluate = async (expression, contextId) => {
    const r = await send('Runtime.evaluate', {
      expression,
      contextId,
      returnByValue: true,
      awaitPromise: true,
    })
    if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails))
    return r.result.value
  }
  return { send, evaluate, contexts, events, close: () => ws.close() }
}

const serial = process.env.ANDROID_SERIAL
if (!serial) throw Error('ANDROID_SERIAL required')
const adb = (...args) =>
  execFileSync('adb', ['-s', serial, ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const output = resolve(process.env.ANDROID_MEDIA_EVIDENCE_DIR || '/tmp/genoffice-android-media')
await mkdir(output, { recursive: true })
const base = process.env.PARSE_SERVER_URL || 'http://127.0.0.1:18787'
const viewer = process.env.ANDROID_VIEWER_URL || 'http://127.0.0.1:11019/'
const token = process.env.PARSE_SERVER_TOKEN || ''
const backendPort = new URL(base).port,
  viewerPort = new URL(viewer).port
if (
  [base, viewer].some((url) => {
    const u = new URL(url)
    return u.hostname !== '127.0.0.1' || u.protocol !== 'http:' || !u.port
  })
)
  throw Error('This USB-disconnection drill requires loopback HTTP services with explicit ports')
const cdpPort = Number(process.env.ANDROID_MEDIA_CDP_PORT || 19224)
const inputs = JSON.parse(
  await readFile(process.env.ANDROID_MEDIA_INPUTS || join(output, 'inputs.json'), 'utf8'),
)
if (
  !Array.isArray(inputs) ||
  inputs.length > 100 ||
  inputs.some((x) => !/^[a-f0-9]{64}$/.test(x.fileId))
)
  throw Error('Invalid input file IDs')
const savedReverses = new Map(
  adb('reverse', '--list')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => line.trim().split(/\s+/).slice(-2)),
)
const chosen = inputs
const results = []
try {
  for (const x of chosen) {
    console.log('START', x.name)
    restoreAccess()
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
      base,
      '--es',
      'token',
      token,
      '--es',
      'fileId',
      x.fileId,
      '--ez',
      'download',
      'true',
    )
    let c, ctxId, manifest
    const deadline = Date.now() + 600000
    while (Date.now() < deadline) {
      await wait(1500)
      try {
        const pid = adb('shell', 'pidof', 'com.genoffice.viewerdemo').trim()
        if (!pid) throw Error('App exited')
        adb('forward', `tcp:${cdpPort}`, `localabstract:webview_devtools_remote_${pid}`)
        c = await connect()
        for (const [id, ctx] of c.contexts)
          if (ctx.auxData?.isDefault) {
            const state = await c.evaluate(
              '({path:location.pathname,fileId:new URL(location.href).searchParams.get("fileId"),canvas:!!document.querySelector(".viewer-slide-stage canvas"),text:document.body.innerText})',
              id,
            )
            if (state.path === '/viewer/preview.html' && state.fileId === x.fileId) {
              if (/失败|Error/.test(state.text)) throw Error(state.text)
              if (state.canvas) ctxId = id
            }
          }
        if (ctxId) break
        c.close()
        c = null
      } catch (e) {
        if (c) c.close()
        c = null
      }
    }
    if (!c || !ctxId) throw Error('Download/open timeout: ' + x.name)
    const pointer = JSON.parse(
      adb(
        'exec-out',
        'run-as',
        'com.genoffice.viewerdemo',
        'cat',
        `files/bundle-cache/${x.fileId}/current.json`,
      ),
    )
    manifest = JSON.parse(
      adb(
        'exec-out',
        'run-as',
        'com.genoffice.viewerdemo',
        'cat',
        `files/bundle-cache/${x.fileId}/versions/${pointer.artifactKey}/manifest.json`,
      ),
    )
    if (!manifest.sourceVerified || !['complete', 'not-needed'].includes(manifest.mediaPreparation))
      throw Error('Missing verified prepared media')
    await writeFile(join(output, `${x.fileId}-manifest.json`), JSON.stringify(manifest, null, 2))
    adb('reverse', '--remove', `tcp:${backendPort}`)
    adb('reverse', '--remove', `tcp:${viewerPort}`)
    const unavailable = await c.evaluate(
      `(async()=>{try{await fetch(${JSON.stringify(base + '/v2/capabilities')},{signal:AbortSignal.timeout(2000)});return false}catch{return true}})()`,
      ctxId,
    )
    if (!unavailable) throw Error('Backend is reachable during offline test')
    const media = []
    for (const m of manifest.preparedMedia || []) {
      const local = `/v1/files/${x.fileId}/prepared/${m.path.split('/').pop()}`
      const result = await c.evaluate(
        `(async()=>{
   const url=${JSON.stringify(local)}, kind=${JSON.stringify(m.kind)};
   const range=await fetch(url,{headers:{Range:'bytes=0-31'}});const count=(await range.arrayBuffer()).byteLength;
   const v=document.createElement(kind);v.muted=true;v.preload='auto';v.controls=true;v.style.cssText='position:fixed;left:0;top:0;width:320px;height:240px;z-index:999999';document.body.appendChild(v);
   try{
    const timeout=ms=>new Promise((_,j)=>setTimeout(()=>j(Error('media timeout')),ms));
    await Promise.race([new Promise((r,j)=>{v.onloadedmetadata=r;v.onerror=()=>j(Error(v.error?.message||'media error'));v.src=url}),timeout(20000)]);
    const duration=v.duration;
    await Promise.race([new Promise(r=>{v.onseeked=r;v.currentTime=duration*0.4}),timeout(10000)]);
    const sought=v.currentTime;await Promise.race([v.play(),timeout(10000)]);await new Promise(r=>setTimeout(r,700));
    if(v.error||!(v.currentTime>sought+Math.min(.1,duration*.1)||v.ended))throw Error('Playback did not advance');
    return{pass:true,range:range.status,rangeBytes:count,duration,seek:sought,time:v.currentTime,width:v.videoWidth||null,height:v.videoHeight||null};
   }catch(error){return{pass:false,error:String(error),code:v.error?.code,ready:v.readyState}}
   finally{v.pause();v.removeAttribute('src');v.load();v.remove()}
  })()`,
        ctxId,
      )
      media.push({ part: m.part, kind: m.kind, ...result })
      console.log('MEDIA', m.part, m.kind, result.pass ? 'PASS' : result.error)
      if (!result.pass) throw Error(`${x.name} ${m.part}: ${result.error}`)
    }
    await screenshot(c, `${x.fileId}-offline-first.png`)
    const ui = await exerciseUI(c, ctxId)
    await screenshot(c, `${x.fileId}-offline-show.png`)
    const localOrigin = await c.evaluate('location.origin', ctxId)
    const externalRequests = c.events
      .filter((e) => e.method === 'Network.requestWillBeSent')
      .map((e) => e.params.request.url)
      .filter((u) => /^https?:/.test(u) && !u.startsWith(localOrigin) && !u.startsWith(base + '/'))
    results.push({
      name: x.name,
      fileId: x.fileId,
      scope: manifest.offlineScope,
      sourceVerified: manifest.sourceVerified,
      artifactKey: manifest.artifactKey,
      prepared: (manifest.preparedMedia || []).length,
      backendUnavailable: unavailable,
      media,
      ui,
      externalRequests,
    })
    await writeFile(join(output, 'device-results.json'), JSON.stringify(results, null, 2))
    c.close()
    results[results.length - 1].online = await onlineCheck(x)
    await writeFile(join(output, 'device-results.json'), JSON.stringify(results, null, 2))
    console.log('DONE', x.name, 'media', media.length, 'scope', manifest.offlineScope)
  }
} finally {
  for (const port of [backendPort, viewerPort]) {
    const from = `tcp:${port}`,
      previous = savedReverses.get(from)
    if (previous) adb('reverse', from, previous)
    else {
      try {
        adb('reverse', '--remove', from)
      } catch {}
    }
  }
}
function restoreAccess() {
  for (const port of [backendPort, viewerPort]) adb('reverse', `tcp:${port}`, `tcp:${port}`)
}

async function exerciseUI(c, id) {
  for (let page = 0; page < 30; page++) {
    const target = await c.evaluate(
      `(()=>{const b=document.querySelector('button[aria-label="播放视频"],button[aria-label="播放音频"]');if(!b)return null;const r=b.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y),fr=window.frameElement?.getBoundingClientRect();return {x:x+(fr?.x||0),y:y+(fr?.y||0),pointerReachable:!!hit&&(b===hit||b.contains(hit))}})()`,
      id,
    )
    if (target) {
      await c.evaluate(
        "document.addEventListener('play',e=>{if(e.target instanceof HTMLMediaElement)e.target.muted=true},true)",
        id,
      )
      if (target.pointerReachable) {
        await c.send('Input.dispatchTouchEvent', {
          type: 'touchStart',
          touchPoints: [{ x: target.x, y: target.y }],
        })
        await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      } else
        await c.evaluate(
          "document.querySelector('button[aria-label=播放视频],button[aria-label=播放音频]').click()",
          id,
        )
      let preview
      for (let retry = 0; retry < 60; retry++) {
        await wait(300)
        preview = await c.evaluate(
          "(()=>{const v=document.querySelector('video,audio');return v&&{time:v.currentTime,duration:v.duration,ready:v.readyState,error:v.error?.message,sourceLocal:v.currentSrc.includes('/prepared/'),sourcePrepared:v.currentSrc.includes('/media/'),kind:v.tagName}})()",
          id,
        )
        if (preview?.error) throw Error(preview.error)
        if (preview?.time > 0) break
      }
      if (!preview?.time) throw Error('Viewer media did not advance')
      await c.evaluate(
        "(()=>{const b=document.querySelector('button[aria-label=关闭媒体播放]');if(b)b.click();else document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))})()",
        id,
      )
      await wait(200)
      await c.evaluate("document.querySelector('button[aria-label=开始放映]').click()", id)
      let show
      for (let retry = 0; retry < 60; retry++) {
        await wait(300)
        show = await c.evaluate(
          "(async()=>{const v=document.querySelector('video,audio');if(!v)return null;v.muted=true;if(v.paused)await v.play();return{time:v.currentTime,ready:v.readyState,error:v.error?.message,sourceLocal:v.currentSrc.includes('/prepared/'),sourcePrepared:v.currentSrc.includes('/media/')}})()",
          id,
        )
        if (show?.error) throw Error(show.error)
        if (show?.time > 0) break
      }
      if (!show?.time) throw Error('Slideshow media did not advance')
      return { slide: page + 1, pointerReachable: target.pointerReachable, preview, show }
    }
    const moved = await c.evaluate(
      "(()=>{const b=document.querySelector('button[aria-label=下一页]');if(!b||b.disabled)return false;b.click();return true})()",
      id,
    )
    if (!moved) return { noMediaObject: true }
    await wait(400)
  }
  throw Error('No media object within 30 slides')
}
async function onlineCheck(x) {
  restoreAccess()
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
    'viewer',
    viewer,
    '--es',
    'server',
    base,
    '--es',
    'token',
    token,
    '--es',
    'fileId',
    x.fileId,
    '--ez',
    'online',
    'true',
  )
  let c
  try {
    for (let n = 0; n < 100; n++) {
      await wait(600)
      if (c) c.close()
      const pid = adb('shell', 'pidof', 'com.genoffice.viewerdemo').trim()
      adb('forward', `tcp:${cdpPort}`, `localabstract:webview_devtools_remote_${pid}`)
      try {
        c = await connect()
      } catch {
        continue
      }
      for (const [id, ctx] of c.contexts)
        if (ctx.auxData?.isDefault) {
          const ready = await c.evaluate(
            "({preview:location.pathname.endsWith('/preview.html'),canvas:!!document.querySelector('.viewer-slide-stage canvas'),text:document.body.innerText})",
            id,
          )
          if (ready.preview && ready.canvas) {
            const ui = await exerciseUI(c, id)
            await screenshot(c, `${x.fileId}-online.png`)
            return ui
          }
        }
    }
    throw Error('Online viewer timeout')
  } finally {
    if (c) c.close()
  }
}
async function screenshot(_c, name) {
  // CDP screenshots omit hardware canvas/video layers on this Android WebView.
  const png = execFileSync('adb', ['-s', serial, 'exec-out', 'screencap', '-p'], {
    maxBuffer: 32 * 1024 * 1024,
  })
  await writeFile(join(output, `native-${name}`), png)
}
