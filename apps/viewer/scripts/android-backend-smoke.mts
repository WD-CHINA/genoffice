import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import JSZip from 'jszip'
import { createBlankPptx } from '@genoffice/pptx-engine'
import { createParseServer } from '../../parse-server/src/server'

const serial = process.env.ANDROID_SERIAL
if (!serial) throw new Error('Set ANDROID_SERIAL to the intended isolated test device')
const adbPath =
  process.env.ADB ??
  join(
    process.env.ANDROID_HOME ?? join(homedir(), 'Library/Android/sdk'),
    'platform-tools',
    process.platform === 'win32' ? 'adb.exe' : 'adb',
  )
const execute = promisify(execFile)
const adb = async (...args: string[]) =>
  (await execute(adbPath, ['-s', serial, ...args], { maxBuffer: 1024 * 1024, timeout: 180_000 }))
    .stdout
assert.equal(
  (await adb('shell', 'getprop', 'sys.boot_completed')).trim(),
  '1',
  'test device must be booted',
)
const directory = await mkdtemp(join(tmpdir(), 'genoffice-android-backend-'))
const token = 'isolated-android-backend-token'
const parser = await createParseServer({ dataDir: directory, token })
const port = new URL(parser.url).port
let reversed = false
try {
  const zip = await JSZip.loadAsync(await createBlankPptx())
  const font = await readFile(
    resolve(import.meta.dirname, '../../../packages/ui/src/fonts/Carlito-Regular.ttf'),
  )
  zip.file(
    'ppt/presentation.xml',
    (await zip.file('ppt/presentation.xml')!.async('string')).replace(
      '</p:presentation>',
      '<p:embeddedFontLst><p:embeddedFont><p:font typeface="Carlito"/><p:regular r:id="rIdBundleFont"/></p:embeddedFont></p:embeddedFontLst></p:presentation>',
    ),
  )
  zip.file(
    'ppt/_rels/presentation.xml.rels',
    (await zip.file('ppt/_rels/presentation.xml.rels')!.async('string')).replace(
      '</Relationships>',
      '<Relationship Id="rIdBundleFont" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/font" Target="fonts/bundle.fntdata"/></Relationships>',
    ),
  )
  zip.file('ppt/fonts/bundle.fntdata', font)
  zip.file('ppt/media/inventory-only.bin', Buffer.alloc(256 * 1024, 90), { compression: 'STORE' })
  zip.file('ppt/media/deflated.bin', Buffer.alloc(64 * 1024, 80), { compression: 'DEFLATE' })
  const response = await fetch(parser.url + '/v1/files', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: await zip.generateAsync({ type: 'nodebuffer' }),
  })
  assert.equal(response.status, 201)
  const { fileId } = (await response.json()) as { fileId: string }
  await adb('reverse', `tcp:${port}`, `tcp:${port}`)
  reversed = true
  const androidRoot = resolve(import.meta.dirname, '../android-demo/app/build/outputs/apk')
  await adb('install', '-r', join(androidRoot, 'debug/app-debug.apk'))
  await adb('install', '-r', join(androidRoot, 'androidTest/debug/app-debug-androidTest.apk'))
  const output = await adb(
    'shell',
    'am',
    'instrument',
    '-w',
    '-e',
    'backendProbe',
    'true',
    '-e',
    'server',
    parser.url,
    '-e',
    'fileId',
    fileId,
    '-e',
    'token',
    token,
    'com.genoffice.viewerdemo.test/com.genoffice.viewerdemo.BundleTestRunner',
  )
  const report = join(tmpdir(), 'genoffice-android-backend-report.txt')
  await writeFile(report, output)
  assert.match(output, /INSTRUMENTATION_RESULT: result=ok/)
  assert.match(output, /INSTRUMENTATION_RESULT: sourceVerified=true/)
  assert.match(output, /INSTRUMENTATION_RESULT: versionedCache=true/)
  assert.match(output, /INSTRUMENTATION_RESULT: cleanupBytes=[1-9]/)
  assert.match(output, /INSTRUMENTATION_RESULT: resumeVerified=true/)
  assert.match(output, /INSTRUMENTATION_RESULT: rangeResponses=[1-9]/)
  const health = (await (
    await fetch(parser.url + '/v1/health', { headers: { Authorization: `Bearer ${token}` } })
  ).json()) as {
    artifacts: { buildsStarted: number; sourceParsesStarted: number }
    sessions: number
    activeWorkers: number
  }
  assert.equal(health.artifacts.buildsStarted, 2)
  assert.equal(health.artifacts.sourceParsesStarted, 1)
  assert.equal(health.sessions, 0)
  assert.equal(health.activeWorkers, 0)
  console.log(
    JSON.stringify({
      ok: true,
      realBackend: true,
      sourceHashesVerified: true,
      cachedSecondDownload: true,
      versionedCacheAndCleanup: true,
      realBackendRangeResume: true,
      sourceParses: health.artifacts.sourceParsesStarted,
      report,
    }),
  )
} finally {
  if (reversed) await adb('reverse', '--remove', `tcp:${port}`).catch(() => undefined)
  await parser.close()
  await rm(directory, { recursive: true, force: true })
}
