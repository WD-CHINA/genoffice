import assert from 'node:assert/strict'
import { mkdtemp, cp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { app, root } from './paths.mjs'
const dir = await mkdtemp(join(tmpdir(), 'genoffice-viewer-standalone-'))
const probe = createServer()
await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
const port = probe.address().port
await new Promise((resolve) => probe.close(resolve))
let child,
  output = ''
try {
  await cp(resolve(app, 'dist'), dir, { recursive: true })
  await new Promise((resolve, reject) => {
    const npm = spawn(
      'npm',
      ['ci', '--omit=dev', '--ignore-scripts', '--workspaces=false', '--no-audit', '--no-fund'],
      { cwd: dir, stdio: 'inherit' },
    )
    npm.on('exit', (code) =>
      code ? reject(new Error('Standalone npm ci failed: ' + code)) : resolve(),
    )
  })
  child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: dir,
    env: { ...process.env, VIEWER_PORT: String(port), VIEWER_DATA_DIR: join(dir, 'data') },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(output || 'Standalone startup timeout')),
      15000,
    )
    child.stdout.on('data', (data) => {
      output += data
      if (output.includes('Viewer ready:')) {
        clearTimeout(timeout)
        resolve()
      }
    })
    child.stderr.on('data', (data) => {
      output += data
    })
    child.on('exit', (code) => {
      clearTimeout(timeout)
      reject(new Error(`Standalone exit ${code}: ${output}`))
    })
  })
  const base = `http://127.0.0.1:${port}`
  const health = await fetch(base + '/api/health')
  assert.equal(health.status, 200)
  assert.equal((await health.json()).electron, false)
  const cookie = health.headers.get('set-cookie').split(';')[0]
  const index = await fetch(base)
  assert.equal(index.status, 200)
  assert.match(await index.text(), /assets\/host-/)
  const preview = await fetch(base + '/preview.html')
  assert.equal(preview.status, 200)
  const fixture = await readFile(
    resolve(root, 'packages/pptx-engine/tests/fixtures/01_standard_business.pptx'),
  )
  const file = await (
    await fetch(base + '/api/files', {
      method: 'POST',
      headers: { Cookie: cookie, 'X-File-Name': 'business.pptx' },
      body: fixture,
    })
  ).json()
  const sessionResponse = await fetch(base + '/api/view-sessions', {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileId: file.id }),
  })
  assert.equal(sessionResponse.status, 201, await sessionResponse.clone().text())
  const session = await sessionResponse.json()
  const slides = await (
    await fetch(base + `/api/view-sessions/${session.id}/slides`, { headers: { Cookie: cookie } })
  ).json()
  assert.equal(slides.slides.length, 5)
  await fetch(base + `/api/view-sessions/${session.id}`, {
    method: 'DELETE',
    headers: { Cookie: cookie },
  })
  await new Promise((resolve, reject) => {
    const smoke = spawn(
      process.execPath,
      [new URL('./browser-smoke.mjs', import.meta.url).pathname],
      {
        cwd: dir,
        env: { ...process.env, VIEWER_TEST_URL: base },
        stdio: 'inherit',
      },
    )
    smoke.on('exit', (code) =>
      code ? reject(new Error('Standalone browser smoke failed: ' + code)) : resolve(),
    )
  })
  console.log(
    'Standalone dist runs from a temporary directory outside the repository; PPT/PDF/Word and HTML altChunk browser checks passed',
  )
} finally {
  if (child && child.exitCode === null) {
    child.kill()
    await new Promise((resolve) => child.once('exit', resolve))
  }
  await rm(dir, { recursive: true, force: true })
}
