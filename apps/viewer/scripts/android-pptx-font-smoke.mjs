/** Verify packaged fonts in an existing offline WebView; never clear app/cache data. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createAndroidTestDevice, wait } from './android-test-device.mjs'

const fileId = process.env.ANDROID_FONT_BOOTSTRAP_FILE_ID
if (!process.env.ANDROID_SERIAL || !/^[a-f0-9]{64}$/.test(fileId || ''))
  throw Error('Set ANDROID_SERIAL and ANDROID_FONT_BOOTSTRAP_FILE_ID to an existing cached PPTX')
const output = process.env.VIEWER_FONT_OUTPUT || '/tmp/genoffice-pptx-fonts'
const matrix = await readFile(resolve(output, 'font-matrix.pptx'))
const desktop = JSON.parse(await readFile(resolve(output, 'report.json'), 'utf8'))
const device = createAndroidTestDevice([], Number(process.env.ANDROID_MEDIA_CDP_PORT || 19227))
let c
async function ready(predicate) {
  for (let attempt = 0; attempt < 160; attempt++) {
    for (const [id, context] of c.contexts) {
      if (!context.auxData?.isDefault) continue
      try {
        if (await c.evaluate(predicate, id)) return id
      } catch {
        /* navigating */
      }
    }
    await wait(300)
  }
  throw Error('WebView font layout did not become ready')
}
try {
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
    'fileId',
    fileId,
    '--ez',
    'open',
    'true',
  )
  const pid = device.adb('shell', 'pidof', 'com.genoffice.viewerdemo').trim()
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      c = await device.connect(pid)
      break
    } catch {
      await wait(300)
    }
  }
  assert.ok(c, 'WebView debugging is not available')
  const original = await ready(
    `location.pathname.endsWith('/preview.html') && new URL(location.href).searchParams.get('fileId')===${JSON.stringify(fileId)}`,
  )
  const url = await c.evaluate('location.href', original)
  const origin = new URL(url).origin
  await c.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
    window.__fontSlides=[]; window.__fontMeasurements=[];
    const NativeWorker=window.Worker;
    window.Worker=class extends NativeWorker {
      constructor(...args){super(...args);this.addEventListener('message',event=>{
        const result=event.data.result;
        if(result?.slides)window.__fontSlides=result.slides;
        if(result?.slideUpdates)for(const [index,slide] of result.slideUpdates)window.__fontSlides[index]=slide;
        if(result?.measurements)window.__fontMeasurements=result.measurements;
      });}
    };
  `,
  })
  await c.send('Page.navigate', { url: origin + '/viewer/?parse=local' })
  const host = await ready(`!!document.querySelector('input[aria-label="打开文件"]')`)
  await c.evaluate(
    `(()=>{const bytes=Uint8Array.from(atob(${JSON.stringify(matrix.toString('base64'))}),char=>char.charCodeAt(0));const data=new DataTransfer();data.items.add(new File([bytes],'font-matrix.pptx'));const input=document.querySelector('input[aria-label="打开文件"]');input.files=data.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`,
    host,
  )
  const frame = await ready(
    `document.querySelector('select[aria-label="PPT 页码"] option') && window.__genofficeDocFontsSynced === true`,
  )
  await ready(
    `[...document.querySelectorAll('.viewer-slide-stage canvas')].some(canvas=>{if(!canvas.width||!canvas.height)return false;const pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;let ink=0;for(let i=0;i<pixels.length;i+=16)if(pixels[i+3]>100&&pixels[i]<150&&pixels[i+1]<150&&pixels[i+2]<150)ink++;return ink>100;})`,
  )
  const result = await c.evaluate(
    `(()=>{const ctx=document.createElement('canvas').getContext('2d');return {userAgent:navigator.userAgent,fontFaces:document.fonts.size,pending:window.__fontMeasurements.length,applied:window.__fontSlides[0].nodes.flatMap(node=>node.text?.lines.flatMap(line=>line.runs)||[]).filter(run=>/^(AVMW|012)$/.test(run.text)).map(run=>{ctx.font=(run.italic?'italic ':'')+(run.bold?'bold ':'')+run.fontSizePx+'px "'+run.fontFamily+'"';ctx.fontKerning='normal';return {text:run.text,family:run.fontFamily,baked:run.widthPx,canvas:ctx.measureText(run.text).width};}),samples:${JSON.stringify(desktop.samples)}.map((item,index)=>{const bold=index%4===1||index%4===3,italic=index%4>=2;ctx.font=(italic?'italic ':'')+(bold?'bold ':'')+'100px "'+item.display+'"';ctx.fontKerning='none';return {family:item.family,ready:document.fonts.check(ctx.font),canvas:index<12?ctx.measureText('AVMW 012').width:null,predicted:item.predicted};}),external:performance.getEntriesByType('resource').map(item=>item.name).filter(url=>/^https?:/.test(url)&&new URL(url).origin!==location.origin)};})()`,
    frame,
  )
  assert.equal(result.external.length, 0)
  await writeFile(resolve(output, 'android-report.json'), JSON.stringify(result, null, 2))
  assert.equal(result.pending, 0)
  for (const item of result.samples) assert.ok(item.ready, item.family)
  assert.equal(result.applied.length, 24)
  // Synthetic bold differs between WebView generations. Validate the final
  // browser-refined render tree against actual drawing-size Canvas advances.
  for (const run of result.applied)
    assert.ok(
      Math.abs(run.baked - run.canvas) < 0.2,
      `${run.family}: ${run.baked} vs ${run.canvas}`,
    )
  const screen = await c.send('Page.captureScreenshot', { format: 'png' })
  await writeFile(resolve(output, 'android-font-matrix.png'), Buffer.from(screen.data, 'base64'))
  await writeFile(resolve(output, 'android-report.json'), JSON.stringify(result, null, 2))
  // The cached document only bootstraps the APK asset server; this local-file
  // drill is independent of its backend model format. Return to local import.
  await c.send('Page.navigate', { url: origin + '/viewer/?parse=local' })
  await ready(`!!document.querySelector('input[aria-label="打开文件"]')`)
  console.log(
    JSON.stringify({
      userAgent: result.userAgent,
      samples: result.samples.length,
      external: result.external,
      fontFaces: result.fontFaces,
      status: 'passed',
    }),
  )
} finally {
  device.restore()
}
