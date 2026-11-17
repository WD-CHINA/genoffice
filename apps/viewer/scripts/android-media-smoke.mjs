/** Real Android WebView + offline cache drill. Requires an installed debug APK and uploaded PPTX file IDs.
 * ANDROID_SERIAL, PARSE_SERVER_TOKEN, ANDROID_MEDIA_INPUTS=<JSON [{name,fileId}]>.
 * Uses USB reverse isolation; preserves app data and restores the prior reverse mappings.
 * Media playback is muted; this does not certify audible quality or Office animation fidelity.
 */
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createAndroidTestDevice, wait } from './android-test-device.mjs'

const serial = process.env.ANDROID_SERIAL
if (!serial) throw Error('ANDROID_SERIAL required')
const output = resolve(process.env.ANDROID_MEDIA_EVIDENCE_DIR || '/tmp/genoffice-android-media')
await mkdir(output, { recursive: true })
const base = process.env.PARSE_SERVER_URL || 'http://127.0.0.1:18787'
const viewer = process.env.ANDROID_VIEWER_URL || 'http://127.0.0.1:11019/'
const token = process.env.PARSE_SERVER_TOKEN || ''
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
const device = createAndroidTestDevice([base, viewer], cdpPort)
const { adb, access: restoreAccess } = device
const chosen = inputs
const results = []
try {
  for (const x of chosen) {
    console.log('START', x.name)
    restoreAccess()
    // Start with fresh WebView/decoder state, as the PDF and offline-PPT drills do.
    adb('shell', 'am', 'force-stop', 'com.genoffice.viewerdemo')
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

        c = await device.connect(pid)
        for (const [id, ctx] of c.contexts)
          if (ctx.auxData?.isDefault) {
            const state = await c.evaluate(
              '({path:location.pathname,fileId:new URL(location.href).searchParams.get("fileId"),canvas:!!document.querySelector(".viewer-slide-stage canvas"),text:document.body.innerText,topLevel:window===top,query:location.search})',
              id,
            )
            if (state.path === '/viewer/preview.html' && state.fileId === x.fileId) {
              if (/失败|Error/.test(state.text)) throw Error(state.text)
              if (state.canvas) {
                assert.ok(state.topLevel, 'offline preview must be a top-level document')
                assert.deepEqual([...new URLSearchParams(state.query).keys()].sort(), [
                  'fileId',
                  'theme',
                ])
                ctxId = id
              }
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
    device.disconnect()
    const unavailable = await c.evaluate(
      `(async()=>{try{await fetch(${JSON.stringify(base + '/v1/capabilities')},{signal:AbortSignal.timeout(2000)});return false}catch{return true}})()`,
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
   const probes=window.__viewerCodecProbes||(window.__viewerCodecProbes={}),v=probes[kind]||(probes[kind]=document.createElement(kind));v.muted=true;v.preload='auto';v.controls=true;v.style.cssText='position:fixed;left:0;top:0;width:320px;height:240px;z-index:999999';document.body.appendChild(v);
   try{
    const event=(name,start,ms)=>new Promise((resolve,reject)=>{
     const cleanup=()=>{clearTimeout(timer);v.removeEventListener(name,done);v.removeEventListener('error',failed)};
     const done=()=>{cleanup();resolve()};const failed=()=>{cleanup();reject(Error(v.error?.message||'media error'))};
     const timer=setTimeout(()=>{cleanup();reject(Error('media timeout: '+name))},ms);
     v.addEventListener(name,done);v.addEventListener('error',failed);try{start()}catch(e){cleanup();reject(e)}
    });
    const bounded=(promise,ms)=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('media timeout: play')),ms);promise.then(value=>{clearTimeout(timer);resolve(value)},error=>{clearTimeout(timer);reject(error)})});
    await event('loadedmetadata',()=>{v.src=url},20000);
    const duration=v.duration;
    await event('seeked',()=>{v.currentTime=duration*0.4},10000);
    const sought=v.currentTime;await bounded(v.play(),10000);await new Promise(r=>setTimeout(r,700));
    if(v.error||!(v.currentTime>sought+Math.min(.1,duration*.1)||v.ended))throw Error('Playback did not advance');
    return{pass:true,range:range.status,rangeBytes:count,duration,seek:sought,time:v.currentTime,width:v.videoWidth||null,height:v.videoHeight||null};
   }catch(error){return{pass:false,error:String(error),code:v.error?.code,ready:v.readyState}}
   finally{v.pause();v.removeAttribute('src');v.load()}
  })()`,
        ctxId,
      )
      media.push({ part: m.part, kind: m.kind, ...result })
      await writeFile(join(output, `${x.fileId}-media-probe.json`), JSON.stringify(media, null, 2))
      console.log('MEDIA', m.part, m.kind, result.pass ? 'PASS' : JSON.stringify(result))
      if (!result.pass) {
        await c.evaluate(
          'Object.values(window.__viewerCodecProbes||{}).forEach(v=>v.remove());delete window.__viewerCodecProbes',
          ctxId,
        )
        throw Error(`${x.name} ${m.part}: ${result.error}`)
      }
    }
    await c.evaluate(
      'Object.values(window.__viewerCodecProbes||{}).forEach(v=>v.remove());delete window.__viewerCodecProbes',
      ctxId,
    )
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
      codecProbeMode: 'one-player-per-kind',
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
  device.restore()
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
      await c.evaluate(
        "(()=>{const v=document.querySelector('video,audio');v.pause();v.currentTime=0;v.__touchTrace=[];v.addEventListener('click',event=>{v.__touchTrace.push({phase:'click',paused:v.paused,time:v.currentTime});setTimeout(()=>v.__touchTrace.push({phase:'afterClick',defaultPrevented:event.defaultPrevented,paused:v.paused,time:v.currentTime}),0)},{once:true})})()",
        id,
      )
      // Seeking and fullscreen transitions can move the player after a pause.
      // Resolve the touch position after these asynchronous changes have settled.
      await wait(500)
      let showTarget
      const seekDeadline = Date.now() + 10_000
      do {
        showTarget = await c.evaluate(
          `(()=>{const v=document.querySelector('video,audio'),node=v.tagName==='VIDEO'?v:v.parentElement,r=node.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y),fr=window.frameElement?.getBoundingClientRect();return{x:x+(fr?.x||0),y:y+(fr?.y||0),ready:v.readyState,seeking:v.seeking,paused:v.paused,pointerReachable:!!hit&&(node===hit||node.contains(hit))}})()`,
          id,
        )
        if (!showTarget.seeking && showTarget.ready >= 2 && showTarget.paused) break
        await wait(100)
      } while (Date.now() < seekDeadline)
      if (showTarget.seeking || showTarget.ready < 2 || !showTarget.paused)
        throw Error('Media did not settle before touch: ' + JSON.stringify(showTarget))
      if (showTarget.pointerReachable) {
        await c.send('Input.dispatchTouchEvent', {
          type: 'touchStart',
          touchPoints: [{ x: showTarget.x, y: showTarget.y }],
        })
        await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      } else
        await c.evaluate(
          "(()=>{const v=document.querySelector('video,audio');(v.tagName==='VIDEO'?v:v.parentElement).click()})()",
          id,
        )
      let showClick
      for (let retry = 0; retry < 60; retry++) {
        await wait(300)
        showClick = await c.evaluate(
          "(()=>{const v=document.querySelector('video,audio');return{time:v.currentTime,paused:v.paused,error:v.error?.message,events:v.__touchTrace}})()",
          id,
        )
        if (showClick.error) throw Error(showClick.error)
        if (showClick.time > 0.1 && !showClick.paused) break
      }
      if (!(showClick?.time > 0.1) || showClick.paused)
        throw Error(
          'Slideshow media touch did not keep playing: ' +
            JSON.stringify({ showTarget, showClick }),
        )
      return {
        slide: page + 1,
        pointerReachable: target.pointerReachable,
        preview,
        show,
        showClick: { ...showClick, pointerReachable: showTarget.pointerReachable },
      }
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
      try {
        c = await device.connect(pid)
      } catch {
        continue
      }
      for (const [id, ctx] of c.contexts)
        if (ctx.auxData?.isDefault) {
          const ready = await c.evaluate(
            "({origin:location.origin,fileId:new URL(location.href).searchParams.get('fileId'),preview:location.pathname.endsWith('/preview.html'),canvas:!!document.querySelector('.viewer-slide-stage canvas'),text:document.body.innerText,topLevel:window===top,query:location.search})",
            id,
          )
          if (
            ready.origin === new URL(viewer).origin &&
            ready.fileId === x.fileId &&
            ready.preview &&
            ready.canvas
          ) {
            assert.ok(ready.topLevel, 'online preview must be a top-level document')
            const query = new URLSearchParams(ready.query)
            for (const key of ['src', 'format', 'name', 'layout', 'parse', 'contentUrl'])
              assert.equal(query.has(key), false, `online preview must omit ${key}`)
            assert.equal(query.has('token'), Boolean(token))
            assert.equal(
              query.has('server'),
              new URL(base).origin !== new URL(viewer).origin ||
                !['', '/'].includes(new URL(base).pathname),
            )
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
  const png = device.readBytes(['exec-out', 'screencap', '-p'])
  await writeFile(join(output, `native-${name}`), png)
}
