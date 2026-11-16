import { drainCleanups } from './helpers/cleanup'
import { createBlankPptx } from '@genoffice/pptx-engine'
import JSZip from 'jszip'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import mysql, { type Connection, type RowDataPacket } from 'mysql2/promise'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MODEL_SCHEMA_VERSION } from '../src/artifact-session'
import { MysqlArtifactCatalog } from '../src/artifact-catalog'
import {
  ArtifactWriter,
  artifactKey,
  type ArtifactIdentity,
  type JsonValue,
} from '../src/artifact-store'
import { cacheKeyPrefix, previewCacheKey } from '../src/cache-contract'
import { createRedisCacheStore } from '../src/redis-cache-client'
import { createParseServer, type ParseServer, type ParseServerOptions } from '../src/server'

const mysqlSocket = process.env.PARSE_TEST_MYSQL_SOCKET
const redisSocket = process.env.PARSE_TEST_REDIS_SOCKET
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  await drainCleanups(cleanups)
})

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/** Two identical slides so a build can be paused after its first committed unit. */
async function twoSlidePptx(): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(await createBlankPptx())
  zip.file('cache-marker.txt', randomUUID())
  const presentation = await zip.file('ppt/presentation.xml')!.async('string')
  const rels = await zip.file('ppt/_rels/presentation.xml.rels')!.async('string')
  const types = await zip.file('[Content_Types].xml')!.async('string')
  const slide = await zip.file('ppt/slides/slide1.xml')!.async('string')
  const slideRels = await zip.file('ppt/slides/_rels/slide1.xml.rels')!.async('string')
  zip.file('ppt/slides/slide2.xml', slide)
  zip.file('ppt/slides/_rels/slide2.xml.rels', slideRels)
  zip.file(
    'ppt/presentation.xml',
    presentation.replace('</p:sldIdLst>', '<p:sldId id="256" r:id="rId3"/></p:sldIdLst>'),
  )
  zip.file(
    'ppt/_rels/presentation.xml.rels',
    rels.replace(
      '</Relationships>',
      '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/></Relationships>',
    ),
  )
  zip.file(
    '[Content_Types].xml',
    types.replace(
      '</Types>',
      '<Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>',
    ),
  )
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}

/** Pause immediately before the SECOND unit frame: exactly one unit is committed. */
function pauseAfterFirstUnit() {
  const entered = gate()
  const blocked = gate()
  const original = ArtifactWriter.prototype.append
  let paused = false
  vi.spyOn(ArtifactWriter.prototype, 'append').mockImplementation(async function (
    this: ArtifactWriter,
    id: string,
    value: JsonValue | Uint8Array,
  ) {
    if (id === 'unit:1' && !paused) {
      paused = true
      entered.resolve()
      await blocked.promise
    }
    return original.call(this, id, value)
  })
  return { entered, blocked }
}

interface Environment {
  admin: Connection
  query: Connection
  database: string
  store: ReturnType<typeof createRedisCacheStore>
  servers: ParseServer[]
  requestOf: (server: ParseServer) => (path: string, init?: RequestInit) => Promise<Response>
  open: (server: ParseServer, fileId: string) => Promise<{ status: number; sessionId: string }>
  upload: (server: ParseServer, bytes: Uint8Array) => Promise<string>
}

async function createEnvironment(redisOverride?: { socketPath: string }): Promise<Environment> {
  const database = `genoffice_cache_${randomUUID().replaceAll('-', '')}`
  const admin: Connection = await mysql.createConnection({ socketPath: mysqlSocket, user: 'root' })
  await admin.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4`)
  const query: Connection = await mysql.createConnection({
    socketPath: mysqlSocket,
    user: 'root',
    database,
  })
  const queryConnection = query
  const dirs: string[] = []
  const servers: ParseServer[] = []
  const store = createRedisCacheStore(redisOverride ?? { socketPath: redisSocket }, {
    timeoutMs: 1000,
    breakerMs: 200,
  })
  cleanups.push(async () => {
    await Promise.all(servers.map((server) => server.close().catch(() => undefined)))
    await store.close().catch(() => undefined)
    await queryConnection.end().catch(() => undefined)
    await admin.query(`DROP DATABASE ${database}`).catch(() => undefined)
    await admin.end()
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  })
  const requestOf = (server: ParseServer) => (path: string, init?: RequestInit) =>
    fetch(server.url + path, init)
  const upload = async (server: ParseServer, bytes: Uint8Array): Promise<string> => {
    const response = await requestOf(server)('/v1/files', {
      method: 'POST',
      body: Buffer.from(bytes),
    })
    expect(response.status, await response.clone().text()).toBe(201)
    return ((await response.json()) as { fileId: string }).fileId
  }
  const open = async (server: ParseServer, fileId: string) => {
    const response = await requestOf(server)('/v1/sessions', {
      method: 'POST',
      headers: { ...{ 'Content-Type': 'application/json' }, Prefer: 'respond-async' },
      body: JSON.stringify({ fileId }),
    })
    const body = (await response.json()) as { sessionId: string }
    return { status: response.status, sessionId: body.sessionId }
  }
  return { admin, query, database, store, servers, requestOf, open, upload }
}

async function addServer(
  env: Environment,
  options: Partial<ParseServerOptions> = {},
): Promise<ParseServer> {
  const dataDir = await mkdtemp(join(tmpdir(), 'cache-redis-'))
  const server = await createParseServer({
    dataDir,
    mysql: {
      host: '127.0.0.1',
      port: 3306,
      user: 'root',
      password: '',
      database: env.database,
      socketPath: mysqlSocket,
    },
    artifactBackend: 'catalog',
    parserVersion: '0.1.0',
    parserFingerprint: 'cache-redis-test',
    cacheMode: 'redis',
    redis: { socketPath: redisSocket },
    cacheCommandTimeoutMs: 200,
    ...options,
  })
  env.servers.push(server)
  return server
}

const identityOf = (fileId: string): ArtifactIdentity => ({
  fileId,
  format: 'pptx',
  parserFingerprint: '0.1.0:cache-redis-test',
  schemaVersion: MODEL_SCHEMA_VERSION,
  options: {},
})

describe.skipIf(!mysqlSocket || !redisSocket)('shared hot cache over real MySQL and Redis', () => {
  it("serves another instance's committed preview frames and progress while the build is leased", async () => {
    const env = await createEnvironment()
    const server = await addServer(env)
    const fileId = await env.upload(server, await createBlankPptx())
    const identity = identityOf(fileId)
    const key = artifactKey(identity)
    const catalog = new MysqlArtifactCatalog(server.db!)
    const claim = await catalog.claim(identity, 'preview-build-owner')
    if (claim.kind !== 'acquired') throw new Error('expected to own the shared build')
    const prefix = cacheKeyPrefix(env.database)
    const pvKey = previewCacheKey(prefix, key, claim.lease.jobId)
    const progressKey = prefix + 'job:' + claim.lease.jobId
    cleanups.push(() => env.store.del([pvKey, progressKey]).catch(() => undefined))
    const document = {
      model: { format: 'pptx', unitCount: 3, unitKind: 'slide' },
      fonts: [],
      layout: { width: 960, height: 540, slides: [] },
    }
    await env.store.hset(
      pvKey,
      {
        format: 'pptx',
        document: JSON.stringify(document),
        unitCount: '3',
        unitsProduced: '1',
        count: '1',
        updatedAt: String(Date.now()),
        'unit:0': JSON.stringify({ id: '0', index: 0, type: 'slide' }),
      },
      60,
    )
    await env.store.hset(
      progressKey,
      {
        unitsProduced: '1',
        unitCount: '3',
        updatedAt: String(Date.now()),
      },
      300,
    )

    const opened = await env.open(server, fileId)
    expect(opened.status).toBe(202)
    const deadline = Date.now() + 10_000
    let body: Record<string, any> | undefined
    for (;;) {
      const response = await env.requestOf(server)(`/v1/sessions/${opened.sessionId}`)
      expect(response.status).toBe(200)
      body = (await response.json()) as Record<string, any>
      if (body.previewable || body.state === 'ready' || body.state === 'failed') break
      if (Date.now() > deadline) throw new Error('building preview never became visible')
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    if (!body) throw new Error('no session body')
    expect(['queued', 'building']).toContain(body.state)
    expect(body.previewable).toBe(true)
    expect(body.complete).toBe(false)
    expect(body.progress).toMatchObject({ unitsProduced: 1, unitCount: 3 })
    expect(body.availableUnits).toEqual({ from: 0, to: 1 })
    const first = await env.requestOf(server)(
      `/v1/sessions/${opened.sessionId}/units/0?representation=model`,
    )
    expect(first.status).toBe(200)
    expect(await first.json()).toMatchObject({ index: 0 })
    const pending = await env.requestOf(server)(
      `/v1/sessions/${opened.sessionId}/units/1?representation=model`,
    )
    expect(pending.status).toBe(202)
    expect(await pending.json()).toMatchObject({ code: 'unit_pending' })
    const documentResponse = await env.requestOf(server)(
      `/v1/sessions/${opened.sessionId}/document`,
    )
    expect(documentResponse.status).toBe(200)
    expect(await documentResponse.json()).toMatchObject({
      state: 'building',
      complete: false,
      model: { format: 'pptx' },
    })
    const health = (await (await env.requestOf(server)('/v1/health')).json()) as {
      cache: { mode: string; enabled: boolean; hits: number; misses: number; errors: number }
    }
    expect(health.cache).toMatchObject({ mode: 'redis', enabled: true })
    expect(health.cache.hits).toBeGreaterThan(0)
    expect(health.cache.errors).toBe(0)

    // A cleared/evicted cache is a miss: the session stays pending with a 200,
    // never a 5xx and never a false ready.
    await env.store.del([pvKey, progressKey])
    const cleared = await env.requestOf(server)(`/v1/sessions/${opened.sessionId}`)
    expect(cleared.status).toBe(200)
    const clearedBody = (await cleared.json()) as Record<string, any>
    expect(clearedBody.state).not.toBe('ready')
    expect(clearedBody.previewable ?? false).toBe(false)
  })

  it('serves the first screen of a build running on another instance', async () => {
    const env = await createEnvironment()
    const builder = await addServer(env)
    const reader = await addServer(env)
    const bytes = await twoSlidePptx()
    const fileId = await env.upload(builder, bytes)
    const key = artifactKey(identityOf(fileId))
    const prefix = cacheKeyPrefix(env.database)
    const pause = pauseAfterFirstUnit()
    const builderSession = await env.open(builder, fileId)
    expect(builderSession.status).toBe(202)
    // Wait for the paused build to commit its first unit and mirror the frame.
    let jobId: string | undefined
    let pvKey: string | undefined
    const frameDeadline = Date.now() + 15_000
    try {
      await Promise.race([
        pause.entered.promise,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('build never reached unit:1')), 15_000),
        ),
      ])
      for (;;) {
        const [rows] = await env.query.query<RowDataPacket[]>(
          "SELECT job_id FROM parse_jobs WHERE artifact_key = ? AND state = 'building'",
          [key],
        )
        jobId = rows[0]?.job_id as string | undefined
        if (jobId) {
          pvKey = previewCacheKey(prefix, key, jobId)
          const hash = await env.store.hgetall(pvKey)
          if (hash?.document && hash['unit:0']) break
        }
        if (Date.now() > frameDeadline) throw new Error('the first frame was never mirrored')
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      // The reader instance never created this session: it resolves the durable
      // waiter from MySQL and attaches read-only. Each instance keeps its own
      // content store (shared local directories are not supported yet), so the
      // reader uploads the same bytes for the unit path.
      expect(await env.upload(reader, bytes)).toBe(fileId)
      const remoteId = builderSession.sessionId
      let body: Record<string, any> = {}
      const deadline = Date.now() + 10_000
      for (;;) {
        const response = await env.requestOf(reader)(`/v1/sessions/${remoteId}`)
        expect(response.status).toBe(200)
        body = (await response.json()) as Record<string, any>
        if (body.previewable || body.state === 'failed') break
        if (Date.now() > deadline) throw new Error('the reader never saw the cross-node preview')
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      expect(body.previewable).toBe(true)
      expect(body.complete).toBe(false)
      expect(body.progress).toMatchObject({ unitsProduced: 1, unitCount: 2 })
      const first = await env.requestOf(reader)(
        `/v1/sessions/${remoteId}/units/0?representation=model`,
      )
      expect(first.status).toBe(200)
      const second = await env.requestOf(reader)(
        `/v1/sessions/${remoteId}/units/1?representation=model`,
      )
      expect(second.status).toBe(202)
      expect(await second.json()).toMatchObject({ code: 'unit_pending' })
      // Attaching must never start a second build on this instance.
      const remoteHealth = (await (await env.requestOf(reader)('/v1/health')).json()) as {
        artifacts: { buildsStarted: number; sourceParsesStarted: number }
      }
      expect(remoteHealth.artifacts.buildsStarted).toBe(0)
      expect(remoteHealth.artifacts.sourceParsesStarted).toBe(0)
      const beat = await env.requestOf(reader)(`/v1/sessions/${remoteId}/heartbeat`, {
        headers: { Prefer: 'respond-async' },
        method: 'POST',
      })
      expect(beat.status).toBe(200)
      // Closing the remote reading view must not delete the builder's waiter row.
      const closed = await env.requestOf(reader)(`/v1/sessions/${remoteId}`, { method: 'DELETE' })
      expect(closed.status).toBe(204)
      const stillThere = await env.requestOf(builder)(`/v1/sessions/${remoteId}`)
      expect(stillThere.status).toBe(200)
    } finally {
      pause.blocked.resolve()
    }
    // Releasing the builder must finish the shared build; readiness always comes
    // from the catalog ready pointer, never from the projection.
    const readyDeadline = Date.now() + 20_000
    for (;;) {
      const response = await env.requestOf(builder)(`/v1/sessions/${builderSession.sessionId}`)
      expect(response.status).toBe(200)
      const body = (await response.json()) as { state: string }
      if (body.state === 'ready') break
      if (body.state === 'failed') throw new Error('shared build failed after release')
      if (Date.now() > readyDeadline) throw new Error('shared build never became ready')
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  })

  it('degrades to pending without 5xx when the shared cache is unreachable', async () => {
    const env = await createEnvironment({
      socketPath: '/tmp/genoffice-missing-redis-' + randomUUID() + '.sock',
    })
    const server = await addServer(env, {
      redis: { socketPath: '/tmp/genoffice-missing-redis-' + randomUUID() + '.sock' },
    })
    const fileId = await env.upload(server, await createBlankPptx())
    const opened = await env.open(server, fileId)
    expect(opened.status).toBe(202)
    const deadline = Date.now() + 20_000
    for (;;) {
      const response = await env.requestOf(server)(`/v1/sessions/${opened.sessionId}`)
      expect(response.status).toBe(200)
      const body = (await response.json()) as { state: string }
      if (body.state === 'ready') break
      if (body.state === 'failed') throw new Error(JSON.stringify(body))
      if (Date.now() > deadline) throw new Error('session never became ready without the cache')
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    const health = (await (await env.requestOf(server)('/v1/health')).json()) as {
      cache: { mode: string; enabled: boolean; errors: number; breaker: string }
    }
    expect(health.cache.mode).toBe('redis')
    expect(health.cache.enabled).toBe(true)
    expect(health.cache.errors).toBeGreaterThan(0)
    const unit = await env.requestOf(server)(
      `/v1/sessions/${opened.sessionId}/units/0?representation=model`,
    )
    expect(unit.status).toBe(200)
  })
})
