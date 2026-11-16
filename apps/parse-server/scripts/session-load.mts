import { createBlankPptx } from '@genoffice/pptx-engine'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import mysql, { type Connection } from 'mysql2/promise'
import { createParseServer } from '../src/server'

/**
 * Local lightweight-session load drill (plan §2/§9: 500 active reading sessions
 * must keep per-session state small and stay responsive). It builds one shared
 * artifact once, opens N v2 reading sessions against it, waits for every ready
 * view and samples status reads while measuring RSS growth.
 *
 * This is a local synthetic baseline, not the target-hardware acceptance.
 *
 * Usage:
 *   node --import tsx scripts/session-load.mts --sessions 500 [--out /tmp/...] [--strict]
 */

function argument(name: string, fallback: number): number {
  const index = process.argv.indexOf('--' + name)
  if (index < 0) return fallback
  const value = Number(process.argv[index + 1])
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`invalid --${name}`)
  return value
}
const sessions = argument('sessions', 500)
const outIndex = process.argv.indexOf('--out')
const output =
  outIndex >= 0 && process.argv[outIndex + 1]
    ? process.argv[outIndex + 1]
    : join(tmpdir(), 'genoffice-session-load.json')
const strict = process.argv.includes('--strict')
const instances = Math.min(4, argument('instances', 1))
const useMysql = process.argv.includes('--mysql')
const useCatalog = process.argv.includes('--catalog')
const mysqlSocket = process.env.PARSE_TEST_MYSQL_SOCKET

function percentile(values: number[], ratio: number): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(ratio * sorted.length))]
}
function rssMb(): number {
  return Math.round((process.memoryUsage().rss / 1024 / 1024) * 10) / 10
}

const dataDir = await mkdtemp(join(tmpdir(), 'session-load-'))
let admin: Connection | undefined
let database: string | undefined
let mysqlConfig:
  | {
      host: string
      port: number
      user: string
      password: string
      database: string
      socketPath: string
    }
  | undefined
if (useMysql) {
  if (!mysqlSocket) {
    console.error('--mysql requires PARSE_TEST_MYSQL_SOCKET')
    process.exit(2)
  }
  database = `genoffice_load_${randomUUID().replaceAll('-', '')}`
  admin = await mysql.createConnection({ socketPath: mysqlSocket, user: 'root' })
  await admin.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4`)
  mysqlConfig = {
    host: '127.0.0.1',
    port: 3306,
    user: 'root',
    password: '',
    database,
    socketPath: mysqlSocket,
  }
}
const servers = [] as Awaited<ReturnType<typeof createParseServer>>[]
for (let index = 0; index < instances; index++) {
  servers.push(
    await createParseServer({
      dataDir,
      maxSessions: sessions + 200,
      maxParseJobs: 2,
      sessionTtlMs: 15 * 60_000,
      parserVersion: '0.1.0',
      parserFingerprint: 'session-load-drill',
      ...(mysqlConfig ? { mysql: mysqlConfig } : {}),
      ...(mysqlConfig && useCatalog ? { artifactBackend: 'catalog' as const } : {}),
    }),
  )
}
const requestOf = (server: (typeof servers)[number]) => (path: string, init?: RequestInit) =>
  fetch(server.url + path, init)
const request = requestOf(servers[0]!)
const report: Record<string, unknown> = {
  sessions,
  instances,
  strict,
  backend: useMysql ? (useCatalog ? 'mysql+catalog' : 'mysql') : 'filesystem',
  startedAt: new Date().toISOString(),
}
try {
  const uploaded = await request('/v1/files', {
    method: 'POST',
    body: Buffer.from(await createBlankPptx()),
  })
  if (uploaded.status !== 201) throw new Error(`upload failed: HTTP ${uploaded.status}`)
  const { fileId } = (await uploaded.json()) as { fileId: string }
  // Warm the shared artifact with one ready session so all later sessions attach.
  const warm = await request('/v1/sessions', {
    method: 'POST',
    headers: { ...{ 'Content-Type': 'application/json' }, Prefer: 'respond-async' },
    body: JSON.stringify({ fileId }),
  })
  const warmId = ((await warm.json()) as { sessionId: string }).sessionId
  const deadline = Date.now() + 60_000
  for (;;) {
    const body = (await (await request(`/v1/sessions/${warmId}`)).json()) as { state: string }
    if (body.state === 'ready') break
    if (body.state === 'failed') throw new Error('warm build failed')
    if (Date.now() > deadline) throw new Error('warm build timed out')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  const rssBefore = rssMb()
  const createLatencies: number[] = []
  const ids: Array<{ id: string; server: (typeof servers)[number] }> = []
  const concurrency = 16
  for (let offset = 0; offset < sessions; offset += concurrency) {
    const batch = Array.from(
      { length: Math.min(concurrency, sessions - offset) },
      async (_, inBatch) => {
        const server = servers[(offset + inBatch) % servers.length]!
        const started = performance.now()
        const opened = await requestOf(server)('/v1/sessions', {
          method: 'POST',
          headers: { ...{ 'Content-Type': 'application/json' }, Prefer: 'respond-async' },
          body: JSON.stringify({ fileId }),
        })
        if (opened.status !== 201 && opened.status !== 202)
          throw new Error(`session create failed: HTTP ${opened.status}`)
        const body = (await opened.json()) as { sessionId: string }
        createLatencies.push(performance.now() - started)
        ids.push({ id: body.sessionId, server })
      },
    )
    await Promise.all(batch)
  }
  const readyDeadline = Date.now() + 120_000
  let ready = 0
  let failed = 0
  const artifactKeys = new Set<string>()
  for (const { id, server } of ids) {
    for (;;) {
      const response = await requestOf(server)(`/v1/sessions/${id}`)
      if (response.status === 404) {
        failed++
        break
      }
      const body = (await response.json()) as {
        state: string
        artifactKey?: string
        error?: unknown
      }
      if (body.state === 'ready') {
        ready++
        if (body.artifactKey) artifactKeys.add(body.artifactKey)
        break
      }
      if (body.state === 'failed' || body.error) {
        failed++
        break
      }
      if (Date.now() > readyDeadline) {
        failed++
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  const getLatencies: number[] = []
  for (let index = 0; index < Math.min(100, ids.length); index++) {
    const sampled = ids[(index * 7) % ids.length]!
    const started = performance.now()
    const response = await requestOf(sampled.server)(`/v1/sessions/${sampled.id}`)
    await response.arrayBuffer()
    getLatencies.push(performance.now() - started)
  }
  const healths = await Promise.all(
    servers.map(
      async (server) =>
        (await (await requestOf(server)('/v1/health')).json()) as {
          sessions: number
          artifacts: { buildsStarted: number }
        },
    ),
  )
  const rssAfter = rssMb()
  const metrics = {
    ready,
    failed,
    buildsStarted: healths.reduce((sum, health) => sum + health.artifacts.buildsStarted, 0),
    serverSessions: healths.reduce((sum, health) => sum + health.sessions, 0),
    perInstanceSessions: healths.map((health) => health.sessions),
    sharedArtifactKeys: artifactKeys.size,
    createP50Ms: Math.round(percentile(createLatencies, 0.5) * 10) / 10,
    createP95Ms: Math.round(percentile(createLatencies, 0.95) * 10) / 10,
    getP95Ms: Math.round(percentile(getLatencies, 0.95) * 10) / 10,
    rssBeforeMb: rssBefore,
    rssAfterMb: rssAfter,
    rssDeltaMb: Math.round((rssAfter - rssBefore) * 10) / 10,
    rssPerSessionKb: Math.round(((rssAfter - rssBefore) * 1024) / Math.max(1, ready)),
  }
  Object.assign(report, { ok: failed === 0 && ready === sessions, ...metrics })
  const problems: string[] = []
  if (ready !== sessions) problems.push(`ready=${ready}/${sessions}`)
  if (failed > 0) problems.push(`failed=${failed}`)
  if (metrics.buildsStarted > 1)
    problems.push(`shared artifact rebuilt: buildsStarted=${metrics.buildsStarted}`)
  if (metrics.sharedArtifactKeys === 0) problems.push('no shared artifactKey reported')
  if (metrics.createP95Ms > 2000) problems.push(`create p95 ${metrics.createP95Ms} ms > 2000`)
  if (metrics.getP95Ms > 500) problems.push(`status p95 ${metrics.getP95Ms} ms > 500`)
  if (metrics.rssDeltaMb > 512) problems.push(`RSS delta ${metrics.rssDeltaMb} MiB > 512`)
  report.problems = problems
  report.finishedAt = new Date().toISOString()
  await writeFile(output, JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  if (strict && problems.length) process.exitCode = 1
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error)
  report.finishedAt = new Date().toISOString()
  await writeFile(output, JSON.stringify(report, null, 2)).catch(() => undefined)
  console.error(report.error)
  process.exitCode = 1
} finally {
  await Promise.all(servers.map((server) => server.close().catch(() => undefined)))
  if (admin && database) {
    await admin.query(`DROP DATABASE IF EXISTS ${database}`).catch(() => undefined)
    await admin.end().catch(() => undefined)
  }
  await rm(dataDir, { recursive: true, force: true }).catch(() => undefined)
}
