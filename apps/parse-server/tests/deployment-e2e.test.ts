import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import mysql, { type Connection } from 'mysql2/promise'
import { createBlankPptx } from '@genoffice/pptx-engine'
import { afterEach, describe, expect, it } from 'vitest'

const socketPath = process.env.PARSE_TEST_MYSQL_SOCKET
const serverDir = fileURLToPath(new URL('..', import.meta.url))
const children = new Set<ChildProcess>()
const databases: string[] = []
const dirs: string[] = []
let admin: Connection | undefined

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null) child.kill('SIGKILL')
  }
  children.clear()
  for (const database of databases.splice(0)) {
    await admin?.query(`DROP DATABASE ${database}`).catch(() => undefined)
  }
  await admin?.end().catch(() => undefined)
  admin = undefined
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

interface Started {
  url: string
  child: ChildProcess
  output: () => string
}

function isolatedEnv(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  // Build the child environment from scratch so ambient PARSE_SERVER_* settings
  // (or a developer's real database) can never leak into the deployment test.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    LANG: process.env.LANG,
  }
  for (const [name, value] of Object.entries(overrides))
    if (value !== undefined) env[name] = value
  return env
}

async function startServer(env: NodeJS.ProcessEnv, timeoutMs = 30_000): Promise<Started> {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/bin.ts'], {
    cwd: serverDir, env, stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.add(child)
  let output = ''
  const url = await new Promise<string>((resolve, reject) => {
    let settled = false
    const finish = (error?: Error, value?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(value!)
    }
    const timer = setTimeout(
      () => finish(new Error(`server did not start in time:\n${output}`)), timeoutMs)
    const onData = (chunk: Buffer) => {
      output += chunk.toString()
      const match = /\[parse-server\] listening on (http:\/\/\S+)/.exec(output)
      if (match) finish(undefined, match[1])
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString() })
    child.once('exit', (code) => finish(new Error(`server exited early (code=${code}):\n${output}`)))
  })
  return { url, child, output: () => output }
}

async function stopServer(started: Started, timeoutMs = 15_000): Promise<void> {
  if (started.child.exitCode !== null) return
  const exited = new Promise<number | null>((resolve) => started.child.once('exit', resolve))
  started.child.kill('SIGTERM')
  const result = await Promise.race([
    exited,
    new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), timeoutMs)),
  ])
  if (result === 'timeout') {
    started.child.kill('SIGKILL')
    throw new Error(`server ignored SIGTERM:\n${started.output()}`)
  }
  expect(result).toBe(0)
}

async function runFailing(
  env: NodeJS.ProcessEnv, timeoutMs = 20_000,
): Promise<{ code: number | null; output: string }> {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/bin.ts'], {
    cwd: serverDir, env, stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.add(child)
  let output = ''
  child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString() })
  child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString() })
  const code = await Promise.race([
    new Promise<number | null>((resolve) => child.once('exit', resolve)),
    new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), timeoutMs)),
  ])
  if (code === 'timeout') {
    child.kill('SIGKILL')
    throw new Error(`failing server did not exit in time:\n${output}`)
  }
  return { code, output }
}

describe.skipIf(!socketPath)('catalog deployment through environment variables only', () => {
  it('starts from env, parses once, reuses the artifact after restart and shuts down cleanly', async () => {
    const database = `genoffice_e2e_${randomUUID().replaceAll('-', '')}`
    databases.push(database)
    admin = await mysql.createConnection({ socketPath, user: 'root' })
    await admin.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4`)
    const dataDir = await mkdtemp(join(tmpdir(), 'deployment-e2e-'))
    dirs.push(dataDir)
    const baseEnv = isolatedEnv({
      PARSE_SERVER_DATA_DIR: dataDir,
      PARSE_SERVER_PORT: '0',
      PARSE_SERVER_HOST: '127.0.0.1',
      PARSE_SERVER_TOKEN: 'secret',
      PARSE_SERVER_PARSER_VERSION: '0.1.0',
      PARSE_SERVER_ARTIFACT_BACKEND: 'catalog',
      MYSQL_SOCKET: socketPath,
      MYSQL_DATABASE: database,
      MYSQL_HOST: '127.0.0.1',
      MYSQL_PORT: '3306',
      MYSQL_USER: 'root',
      MYSQL_PASSWORD: '',
    })
    const request = (url: string) => (path: string, init?: RequestInit) =>
      fetch(url + path, {
        ...init,
        headers: { Authorization: 'Bearer secret', ...init?.headers },
      })
    const first = await startServer(baseEnv)
    let sessionId: string | undefined
    try {
      const call = request(first.url)
      const uploaded = await call('/v1/files', {
        method: 'POST', body: Buffer.from(await createBlankPptx()),
      })
      expect(uploaded.status, await uploaded.clone().text()).toBe(201)
      const { fileId } = await uploaded.json() as { fileId: string }
      const opened = await call('/v2/sessions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileId }),
      })
      expect([201, 202]).toContain(opened.status)
      sessionId = ((await opened.json()) as { sessionId: string }).sessionId
      const deadline = Date.now() + 25_000
      for (;;) {
        const status = await call(`/v2/sessions/${sessionId}`)
        expect(status.status).toBe(200)
        const body = await status.json() as { state: string }
        if (body.state === 'ready') break
        if (body.state === 'failed') throw new Error('cold catalog build failed')
        if (Date.now() > deadline) throw new Error('cold catalog build did not become ready')
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      const unit = await call(`/v2/sessions/${sessionId}/units/0`)
      expect(unit.status).toBe(200)
      const health = await (await call('/v1/health')).json() as {
        storage: string; artifacts: { buildsStarted: number }
      }
      expect(health.storage).toBe('mysql')
      expect(health.artifacts.buildsStarted).toBe(1)
    } finally {
      await stopServer(first)
    }

    if (sessionId === undefined) throw new Error('sessionId was not created')
    // Second process, same data dir and database, env-only deployment again.
    const second = await startServer(baseEnv)
    try {
      const call = request(second.url)
      const restored = await call(`/v2/sessions/${sessionId}`)
      expect(restored.status).toBe(200)
      expect(await restored.json()).toMatchObject({ state: 'ready', sessionId })
      const health = await (await call('/v1/health')).json() as {
        artifacts: { buildsStarted: number; sourceParsesStarted: number }
      }
      expect(health.artifacts.buildsStarted).toBe(0)
      expect(health.artifacts.sourceParsesStarted).toBe(0)
      const unit = await call(`/v2/sessions/${sessionId}/units/0`)
      expect(unit.status).toBe(200)
    } finally {
      await stopServer(second)
    }
  }, 90_000)

  it('refuses a restore toggle without a manifest and catalog without MySQL before listening', async () => {
    const missing = join(tmpdir(), `missing-manifest-${randomUUID()}.json`)
    const restore = await runFailing(isolatedEnv({
      PARSE_SERVER_DATA_DIR: join(tmpdir(), `no-data-${randomUUID()}`),
      PARSE_SERVER_PORT: '0',
      PARSE_SERVER_RESTORE_MANIFEST: missing,
    }))
    expect(restore.code).not.toBe(0)
    expect(restore.output).toMatch(/invalid restore manifest/)

    const catalog = await runFailing(isolatedEnv({
      PARSE_SERVER_DATA_DIR: join(tmpdir(), `no-data-${randomUUID()}`),
      PARSE_SERVER_PORT: '0',
      PARSE_SERVER_ARTIFACT_BACKEND: 'catalog',
    }))
    expect(catalog.code).not.toBe(0)
    expect(catalog.output).toMatch(/catalog artifact backend requires MySQL/)
  }, 60_000)
})
