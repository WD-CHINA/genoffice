/** Exercise actual Android native password dialogs over the server upload path. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, basename } from 'node:path'
import { createAndroidTestDevice, wait } from './android-test-device.mjs'
const state = JSON.parse(await readFile(process.env.ANDROID_OFFICE_INPUTS, 'utf8'))
const demoRoot = process.env.ANDROID_OFFICE_DEMO_ROOT
if (!demoRoot) throw Error('Set ANDROID_OFFICE_DEMO_ROOT')
const output = resolve(
  process.env.ANDROID_PASSWORD_OUTPUT || '/tmp/genoffice-office-fixed/android-password',
)
await mkdir(output, { recursive: true })
const device = createAndroidTestDevice([state.server, state.viewer], 19229)
const uploadPage = process.env.ANDROID_UPLOAD_PAGE === '1'
let client
async function ready(expression) {
  for (let attempt = 0; attempt < 140; attempt++) {
    if (!client)
      try {
        client = await device.connect(
          device.adb('shell', 'pidof', 'com.genoffice.viewerdemo').trim(),
        )
      } catch {
        /* starting */
      }
    if (client)
      for (const [id, context] of client.contexts)
        if (context.auxData?.isDefault) {
          try {
            if (await client.evaluate(expression, id)) return id
          } catch {
            /* navigation */
          }
        }
    await wait(300)
  }
  throw Error('WebView did not reach ' + expression)
}
function layout() {
  const tree = JSON.parse(
    execFileSync('android', ['layout', '--device=' + device.serial, '--no-idle'], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    }),
  )
  const all = []
  function walk(value) {
    if (Array.isArray(value)) value.forEach(walk)
    else if (value && typeof value === 'object') {
      all.push(value)
      for (const v of Object.values(value)) if (typeof v === 'object') walk(v)
    }
  }
  walk(tree)
  return all
}
function tap(node) {
  assert(node, 'native control missing')
  const p = String(node.center).match(/\d+/g)
  device.adb('shell', 'input', 'tap', p[0], p[1])
}
async function answer(value) {
  let nodes
  for (let i = 0; i < 30; i++) {
    nodes = layout()
    if (nodes.some((n) => n.class === 'android.widget.EditText')) break
    await wait(300)
  }
  const field = nodes.find((n) => n.class === 'android.widget.EditText')
  assert(field, 'native Word password input must exist')
  if (value === null) {
    tap(nodes.find((n) => n.text === '取消' && n.interactions?.includes('CLICKABLE')))
    return
  }
  tap(field)
  for (let attempt = 0; attempt < 15; attempt++) {
    nodes = layout()
    if (nodes.some((n) => n.class === 'android.widget.EditText' && n.state?.includes('FOCUSED')))
      break
    await wait(200)
  }
  assert(
    nodes.some((n) => n.class === 'android.widget.EditText' && n.state?.includes('FOCUSED')),
    'password field must be focused',
  )
  device.adb('shell', 'input', 'text', value)

  nodes = layout()
  tap(nodes.find((n) => n.text === '打开' && n.interactions?.includes('CLICKABLE')))
}
async function openHome() {
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
    '',
    '--ez',
    'online',
    'true',
  )
  await ready(`!!document.querySelector('input[type="file"]')`)
  await client.send('Page.navigate', {
    url:
      state.viewer +
      (uploadPage ? 'upload.html' : '') +
      '?' +
      new URLSearchParams({ parse: 'server', server: state.server, token: state.token }),
  })
  return ready(
    `(new URL(location.href).searchParams.get('parse')==='server' && (!${uploadPage} || location.pathname.endsWith('/upload.html'))) && !!document.querySelector('input[type="file"]')`,
  )
}
async function choose(file, id) {
  const bytes = await readFile(resolve(demoRoot, file))
  await client.evaluate(
    `(()=>{const d=new DataTransfer();d.items.add(new File([Uint8Array.from(atob(${JSON.stringify(bytes.toString('base64'))}),c=>c.charCodeAt(0))],${JSON.stringify(basename(file))}));const input=document.querySelector('input[type="file"]');input.files=d.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`,
    id,
  )
}
const report = []
try {
  device.access()
  for (const input of state.inputs.filter((item) => item.file.includes('加密.docx'))) {
    const host = await openHome()
    await choose(input.file, host)
    await answer('wrong')
    // Standard WebView alert, followed by the native masked retry prompt.
    for (let i = 0; i < 30; i++) {
      const nodes = layout(),
        ok = nodes.find(
          (n) => /^(确定|OK)$/.test(n.text || '') && n.interactions?.includes('CLICKABLE'),
        )
      if (ok) {
        tap(ok)
        break
      }
      await wait(300)
    }
    await answer('Demo1234!')
    await ready(
      uploadPage
        ? `!!document.querySelector('.upload-result')?.textContent.includes('上传成功')`
        : `document.querySelector('[role=document]')?.textContent.includes('GENOFFICE_WORD_DEMO_OK')`,
    )
    await writeFile(
      resolve(output, basename(input.file) + '-retry.png'),
      device.readBytes(['exec-out', 'screencap', '-p']),
    )
    const next = await openHome()
    await choose(input.file, next)
    await answer(null)
    await ready(`document.querySelector('[role=alert]')?.textContent.includes('已取消密码输入')`)
    await choose('01_Word_明文对照.docx', next)
    await ready(
      uploadPage
        ? `!!document.querySelector('.upload-result')?.textContent.includes('上传成功')`
        : `document.querySelector('[role=document]')?.textContent.includes('GENOFFICE_WORD_DEMO_OK')`,
    )
    report.push({
      file: input.file,
      nativePasswordPrompt: true,
      entry: uploadPage ? 'upload.html' : 'viewer-host',
      wrongPasswordRetry: true,
      cancelThenPlain: true,
      status: 'passed',
    })
    await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2))
    console.log(input.file, 'native password retry/cancel passed')
  }
} finally {
  client?.close()
  device.restore()
}
