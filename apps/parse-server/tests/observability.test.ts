import { serverRoot } from './helpers/paths'
import { createBlankPptx } from '@genoffice/pptx-engine'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ParseQueue } from '../src/parse-queue'
import { createParseServer, type ParseServer } from '../src/server'

const dirs: string[] = []
const servers: ParseServer[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close().catch(() => undefined)))
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

type StartOptions = Omit<Parameters<typeof createParseServer>[0], 'dataDir'> & {
  dataDir?: string
}

async function start(options: StartOptions): Promise<ParseServer> {
  const dataDir = options.dataDir ?? (await mkdtemp(join(tmpdir(), 'observability-')))
  if (!options.dataDir) dirs.push(dataDir)
  const server = await createParseServer({ ...options, dataDir })
  servers.push(server)
  return server
}

const metrics = async (server: ParseServer): Promise<string> =>
  await (await fetch(server.url + '/metrics')).text()

it('exposes unit-read latency, queue age, signing, artifact and bundle counters', async () => {
  const server = await start({ token: 'secret' })
  const call = (path: string, init: RequestInit = {}) =>
    fetch(server.url + path, {
      ...init,
      headers: { Authorization: 'Bearer secret', ...init.headers },
    })
  const docx = await readFile(join(serverRoot, 'tests', 'fixtures', 'docx', 'table.docx'))
  const uploaded = await call('/v1/files', { method: 'POST', body: docx })
  expect(uploaded.status).toBe(201)
  const { fileId } = (await uploaded.json()) as { fileId: string }
  // v1 asynchronous cold open exercises the artifact-miss counter and the async path.
  const opened = await call('/v1/sessions', {
    method: 'POST',
    headers: { ...{ 'Content-Type': 'application/json' }, Prefer: 'respond-async' },
    body: JSON.stringify({ fileId }),
  })
  expect([201, 202]).toContain(opened.status)
  const { sessionId } = (await opened.json()) as { sessionId: string }
  const deadline = Date.now() + 20_000
  for (;;) {
    const status = await call(`/v1/sessions/${sessionId}`)
    const body = (await status.json()) as { state: string }
    if (body.state === 'ready') break
    if (body.state === 'failed') throw new Error('session failed')
    if (Date.now() > deadline) throw new Error('session did not become ready')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  const unit = await call(`/v1/sessions/${sessionId}/units/0?representation=model`)
  expect(unit.status).toBe(200)
  // DOCX export succeeds; an unknown bundle resource still records a failure.
  const bundle = await call(`/v1/sessions/${sessionId}/bundle`)
  expect(bundle.status).toBe(200)
  await bundle.arrayBuffer()
  const missing = await call(`/v1/sessions/${sessionId}/bundle/resources/missing.json`)
  expect(missing.status).toBe(404)

  const text = await metrics(server)
  expect(text).toContain('genoffice_parse_unit_read_latency_seconds_count')
  const unitCount = Number(/genoffice_parse_unit_read_latency_seconds_count (\d+)/.exec(text)![1])
  expect(unitCount).toBeGreaterThan(0)
  expect(text).toContain('genoffice_parse_unit_read_latency_seconds_bucket{le="0.005"}')
  expect(text).toMatch(/genoffice_parse_job_queue_age_seconds 0/)
  expect(text).toMatch(/genoffice_parse_bundle_failure_total 1/)
  expect(text).toMatch(/genoffice_parse_signature_refresh_total [1-9]\d*/)
  expect(text).toMatch(/genoffice_parse_artifact_miss_total [1-9]\d*/)
  expect(text).toMatch(/genoffice_parse_artifact_corrupt_total 0/)
  expect(text).toMatch(/genoffice_parse_gc_deleted_bytes_total 0/)
  expect(text).toMatch(/genoffice_parse_storage_source_bytes \d+/)
  expect(text).toMatch(/genoffice_parse_storage_artifact_bytes \d+/)
  expect(text).toMatch(/genoffice_parse_storage_staging_bytes \d+/)
  // The same counters are visible through health/artifacts.
  const health = (await (await call('/v1/health')).json()) as {
    artifacts: { misses: number; corruptions: number }
  }
  expect(health.artifacts.misses).toBeGreaterThan(0)
  expect(health.artifacts.corruptions).toBe(0)
})

it('counts bytes removed by content GC', async () => {
  const server = await start({ contentTtlMs: 0 })
  const uploaded = await fetch(server.url + '/v1/files', {
    method: 'POST',
    body: Buffer.from(await createBlankPptx()),
  })
  const { fileId } = (await await uploaded.json()) as { fileId: string }
  const opened = await fetch(server.url + '/v1/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileId }),
  })
  const { sessionId } = (await opened.json()) as { sessionId: string }
  await fetch(server.url + `/v1/sessions/${sessionId}`, { method: 'DELETE' })
  await new Promise((resolve) => setTimeout(resolve, 5))
  await server.gc()
  const text = await (await fetch(server.url + '/metrics')).text()
  const bytes = Number(/genoffice_parse_gc_deleted_bytes_total (\d+)/.exec(text)![1])
  expect(bytes).toBeGreaterThan(0)
})

it('reports the oldest waiting build age', async () => {
  const queue = new ParseQueue(1, 4, 8192, 1)
  let release!: () => void
  const first = queue.run(
    () =>
      new Promise<void>((resolve) => {
        release = resolve
      }),
  )
  const second = queue.run(async () => undefined)
  await new Promise((resolve) => setTimeout(resolve, 25))
  expect(queue.snapshot.queued).toBe(1)
  expect(queue.oldestWaitMs).toBeGreaterThanOrEqual(10)
  release()
  await Promise.all([first, second])
  expect(queue.oldestWaitMs).toBe(0)
  await queue.close()
})
