import { createBlankPptx } from '@genoffice/pptx-engine'
import { ArtifactSession, type ArtifactSessionInput } from '../src/artifact-session'
import { ParseQueue } from '../src/parse-queue'
import { DEFAULT_LIMITS } from '../src/limits'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import mysql, { type Connection } from 'mysql2/promise'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setTimeout as delay } from 'node:timers/promises'
import { MysqlDatabase } from '../src/mysql'
import { MysqlArtifactCatalog, artifactGenerationPath, type ArtifactClaim } from '../src/artifact-catalog'
import { artifactKey, type ArtifactIdentity } from '../src/artifact-store'
import { ArtifactGenerations } from '../src/artifact-generations'
import { ArtifactCoordinator } from '../src/artifact-coordinator'
import { ArtifactReadHandle } from '../src/artifact-read-handle'
import { ArtifactGenerationSweeper } from '../src/artifact-generation-sweeper'
import { ArtifactStore } from '../src/artifact-store'

const socketPath = process.env.PARSE_TEST_MYSQL_SOCKET
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()!() })
const identity: ArtifactIdentity = {
  fileId: 'a'.repeat(64), format: 'pptx', parserFingerprint: 'catalog-test', schemaVersion: 2, options: {},
}
const summary = { bytes: 100, unitCount: 2, manifestSha256: 'b'.repeat(64) }
function acquired(claim: ArtifactClaim) {
  expect(claim.kind).toBe('acquired')
  if (claim.kind !== 'acquired') throw new Error('expected lease')
  return claim.lease
}

describe.skipIf(!socketPath)('artifact catalog with isolated real MySQL', () => {
  async function setup() {
    const name = `genoffice_catalog_${randomUUID().replaceAll('-', '')}`
    const admin: Connection = await mysql.createConnection({ socketPath, user: 'root' })
    await admin.query(`CREATE DATABASE ${name} CHARACTER SET utf8mb4`)
    const config = { host: '127.0.0.1', port: 3306, user: 'root', password: '', database: name, socketPath }
    const first = new MysqlDatabase(config)
    const second = new MysqlDatabase(config)
    cleanups.push(async () => {
      await Promise.all([first.close(), second.close()])
      await admin.query(`DROP DATABASE ${name}`)
      await admin.end()
    })
    await first.init()
    await second.init()
    await first.pool.execute(`INSERT INTO parse_files VALUES (?, ?, 0, 'pptx', ?)`,
      [identity.fileId, identity.fileId, new Date().toISOString()])
    return { db: first, db2: second, a: new MysqlArtifactCatalog(first), b: new MysqlArtifactCatalog(second) }
  }

  it('retires expired shared staging before deletion and fences delayed completion across pools', async () => {
    const { db, a, b } = await setup()
    const root = await mkdtemp(join(tmpdir(), 'catalog-staging-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const lease = acquired(await a.claim(identity, 'staging-writer'))
    const staging = join(root, 'staging')
    const name = `gen-${lease.key}-g-${lease.generation}-${randomUUID()}`
    await mkdir(join(staging, name), { recursive: true })
    await writeFile(join(staging, name, 'units.bin'), 'partial')
    const old = new Date(Date.now() - 2 * 60 * 60_000)
    await utimes(join(staging, name), old, old)
    const sweeper = new ArtifactGenerationSweeper(new ArtifactGenerations(root), b)
    expect(await sweeper.sweep()).toMatchObject({ protected: 1, collected: 0 })
    expect(await readdir(staging)).toEqual([name])
    await db.pool.execute('UPDATE parse_jobs SET lease_until = 0 WHERE artifact_key = ?', [lease.key])
    expect(await sweeper.sweep()).toMatchObject({ collected: 1, failed: 0 })
    expect(await readdir(staging)).toEqual([])
    expect(await a.renew(lease)).toBe(false)
    expect(await a.complete(lease, summary)).toBe(false)
    const replacement = acquired(await a.claim(identity, 'replacement'))
    expect(replacement.generation).toBe(lease.generation + 1)
    expect(await a.complete(replacement, summary)).toBe(true)
    // An abandoned staging directory for the ready generation is conservatively retained.
    const readyName = `gen-${lease.key}-g-${replacement.generation}-${randomUUID()}`
    await mkdir(join(staging, readyName))
    await utimes(join(staging, readyName), old, old)
    expect(await sweeper.sweep()).toMatchObject({ protected: 1, collected: 0 })
    expect(await readdir(staging)).toEqual([readyName])
    await sweeper.close()
  })

  it('forks a live old-generation dependency independently of the initiating view and current ready pointer', async () => {
    const { db, a, b } = await setup()
    const first = acquired(await a.claim(identity, 'first'))
    expect(await a.complete(first, summary)).toBe(true)
    const view = (await a.pin(first.key, 'view'))!
    const next = acquired(await b.claim(identity, 'replacement', true))
    expect(await b.complete(next, summary)).toBe(true)
    const dependency = (await b.forkRead(view.lease, 'bundle'))!
    expect(dependency.generation).toBe(first.generation)
    expect(dependency.id).not.toBe(view.lease.id)
    await a.releaseRead(view.lease)
    expect(await a.retireGeneration(first.key, first.generation)).toBe(false)
    expect(await b.renewRead(dependency)).toBe(true)
    await b.releaseRead(dependency)
    expect(await a.retireGeneration(first.key, first.generation)).toBe(true)
    expect(await a.forkRead(view.lease, 'late')).toBeNull()
    const expired = (await a.pin(first.key, 'expired-view'))!
    await db.pool.execute('UPDATE parse_artifact_read_leases SET lease_until = 0 WHERE id = ?', [expired.lease.id])
    expect(await b.forkRead(expired.lease, 'invalid-dependency')).toBeNull()
    expect(await a.renewRead(expired.lease)).toBe(false)
  })

  it('shares real source parsing across SQL coordinators and renders through an independent view pin', async () => {
    const { a, b } = await setup()
    const root = await mkdtemp(join(tmpdir(), 'sql-source-build-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const input: ArtifactSessionInput = {
      id: randomUUID(), fileId: identity.fileId, path: join(root, 'source.pptx'), width: 960,
      parserVersion: 'sql', parserFingerprint: 'source-build', baseUrl: 'http://localhost',
      format: 'pptx', chunkRoot: join(root, 'chunks'), limits: DEFAULT_LIMITS,
      parseTimeoutMs: 10_000, unitTimeoutMs: 10_000, workerMemoryMb: 128, workerRssMb: 512,
    }
    await writeFile(input.path, Buffer.from(await createBlankPptx()))
    const disk = new ArtifactGenerations(root)
    const store = new ArtifactStore(root)
    const queue = new ParseQueue(1, 2, 512, 512)
    cleanups.push(() => queue.close())
    const first = new ArtifactCoordinator(a, disk, 5)
    const second = new ArtifactCoordinator(b, disk, 5)
    cleanups.push(() => Promise.all([first.close(), second.close()]).then(() => undefined))
    const modelIdentity = ArtifactSession.identity(input)
    const build = (coordinator: ArtifactCoordinator) => coordinator.getOrBuild(modelIdentity,
      (writer, signal) => ArtifactSession.build(store, input, writer, queue, signal))
    const results = await Promise.all([build(first), build(second)])
    expect(results[0].contentDigest).toBe(results[1].contentDigest)
    expect(store.stats.sourceParsesStarted).toBe(1)
    const handle = (await ArtifactReadHandle.open(b, disk, artifactKey(modelIdentity), 'view'))!
    const dependency = await handle.fork('bundle')
    cleanups.push(() => dependency.close())
    const session = await ArtifactSession.openPinned(handle, store, input, queue)
    try {
      await rm(input.path)
      expect((await session.unit('0') as { slide: unknown }).slide).toBeDefined()
    } finally { await session.dispose() }
    expect(await dependency.read('document')).toMatchObject({ model: { format: 'pptx' } })
    await dependency.close()
    expect(queue.memorySnapshot.reservedMb).toBe(0)
  })

  it('invalidates only the expected ready pointer while preserving live readers and replacement builds', async () => {
    const { a, b } = await setup()
    const first = acquired(await a.claim(identity, 'first'))
    await a.complete(first, summary)
    const view = (await a.pin(first.key, 'view'))!
    const replacement = acquired(await b.claim(identity, 'repair', true))
    expect(await a.invalidateReady(view.artifact)).toBe(true)
    expect(await a.pin(first.key, 'new-view')).toBeNull()
    expect(await a.renewRead(view.lease)).toBe(true)
    expect(await b.renew(replacement)).toBe(true)
    expect(await b.complete(replacement, summary)).toBe(true)
    expect(await a.invalidateReady(view.artifact)).toBe(false)
    const current = (await a.pin(first.key, 'current'))!
    expect(current.artifact.generation).toBe(replacement.generation)
    await a.releaseRead(view.lease)
    await a.releaseRead(current.lease)
  })

  it('deduplicates concurrent independent pools and protects source references', async () => {
    const { db, a, b } = await setup()
    const claims = await Promise.all(Array.from({ length: 12 }, (_, index) =>
      (index % 2 ? a : b).claim(identity, `owner-${index}`)))
    expect(claims.filter((claim) => claim.kind === 'acquired')).toHaveLength(1)
    expect(claims.filter((claim) => claim.kind === 'busy')).toHaveLength(11)
    const lease = acquired(claims.find((claim) => claim.kind === 'acquired')!)
    await expect(db.pool.execute('DELETE FROM parse_files WHERE file_id = ?', [identity.fileId]))
      .rejects.toMatchObject({ code: 'ER_ROW_IS_REFERENCED_2' })
    expect(await a.complete(lease, summary)).toBe(true)
    expect(await b.claim(identity, 'reader')).toMatchObject({ kind: 'ready', artifact: {
      generation: 1, storagePath: artifactGenerationPath(lease.key, 1), ...summary,
    } })
  })

  it('takes over expired leases and fences every stale mutation, even when the owner name repeats', async () => {
    const { db, a, b } = await setup()
    const old = acquired(await a.claim(identity, 'same-owner'))
    await db.pool.execute('UPDATE parse_jobs SET lease_until = 0 WHERE artifact_key = ?', [old.key])
    expect(await a.renew(old)).toBe(false)
    expect(await a.complete(old, summary)).toBe(false)
    expect(await a.fail(old, 'timeout')).toBe(false)
    const next = acquired(await b.claim(identity, 'same-owner'))
    expect(next.generation).toBe(old.generation + 1)
    expect(await a.renew(old)).toBe(false)
    expect(await a.complete(old, summary)).toBe(false)
    expect(await a.fail(old, 'late_failure')).toBe(false)
    expect(await b.renew(next)).toBe(true)
    expect(await b.complete(next, summary)).toBe(true)
    expect(await a.claim(identity, 'reader')).toMatchObject({ kind: 'ready', artifact: { generation: 2 } })
  })

  it('serves the previous ready generation while rebuilding and after rebuild failure', async () => {
    const { a, b } = await setup()
    const first = acquired(await a.claim(identity, 'first'))
    expect(await a.complete(first, summary)).toBe(true)
    const rebuild = acquired(await a.claim(identity, 'rebuild', true))
    expect(rebuild.generation).toBe(2)
    expect(await b.claim(identity, 'reader')).toMatchObject({ kind: 'ready', artifact: { generation: 1 } })
    expect(await b.claim(identity, 'other-builder', true)).toMatchObject({ kind: 'busy' })
    expect(await a.fail(rebuild, 'disk_full')).toBe(true)
    expect(await b.claim(identity, 'reader')).toMatchObject({ kind: 'ready', artifact: { generation: 1 } })
    const retry = acquired(await b.claim(identity, 'retry', true))
    expect(retry.generation).toBe(3)
    expect(await b.complete(retry, { ...summary, bytes: 200 })).toBe(true)
    expect(await a.claim(identity, 'reader')).toMatchObject({ kind: 'ready', artifact: { generation: 3, bytes: 200 } })
  })

  it('rolls readiness back if the job transition fails after artifact update', async () => {
    const { db, a } = await setup()
    const lease = acquired(await a.claim(identity, 'builder'))
    await db.pool.query(`CREATE TRIGGER catalog_fail_ready BEFORE UPDATE ON parse_jobs FOR EACH ROW
      BEGIN IF NEW.state = 'ready' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'injected'; END IF; END`)
    await expect(a.complete(lease, summary)).rejects.toMatchObject({ sqlState: '45000' })
    const [rows] = await db.pool.query<mysql.RowDataPacket[]>(
      'SELECT ready_generation, state FROM parse_artifacts WHERE artifact_key = ?', [artifactKey(identity)])
    expect(rows[0]).toMatchObject({ ready_generation: null, state: 'building' })
    expect(await a.renew(lease)).toBe(true)
    await db.pool.query('DROP TRIGGER catalog_fail_ready')
    expect(await a.complete(lease, summary)).toBe(true)
  })

  it('late old filesystem publication cannot replace the newer SQL ready generation', async () => {
    const { db, a, b } = await setup()
    const root = await mkdtemp(join(tmpdir(), 'catalog-generations-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const disk = new ArtifactGenerations(root)
    const old = acquired(await a.claim(identity, 'old'))
    let release!: () => void
    let arrived!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const observed = new Promise<void>((resolve) => { arrived = resolve })
    const oldPublication = disk.publish(identity, old.generation, async (writer) => {
      arrived()
      await gate
      await writer.append('unit:0', { text: 'obsolete' })
    })
    try {
      await observed
      await db.pool.execute('UPDATE parse_jobs SET lease_until = 0 WHERE artifact_key = ?', [old.key])
      const next = acquired(await b.claim(identity, 'new'))
      const published = await disk.publish(identity, next.generation, async (writer) => {
        await writer.append('unit:0', { text: 'current' })
      })
      expect(await b.complete(next, published)).toBe(true)
      release()
      const late = await oldPublication
      expect(await a.complete(old, late)).toBe(false)
      const claim = await a.claim(identity, 'reader')
      expect(claim.kind).toBe('ready')
      if (claim.kind !== 'ready') throw new Error('expected ready')
      expect(claim.artifact.generation).toBe(next.generation)
      expect(await (await disk.open(claim.artifact)).read('unit:0')).toEqual({ text: 'current' })
      expect(await (await disk.open(late)).read('unit:0')).toEqual({ text: 'obsolete' })
    } finally { release(); await oldPublication.catch(() => undefined) }
  })

  it('coordinates independent pools with heartbeat renewal and detached reader cancellation', async () => {
    const { db, db2 } = await setup()
    const root = await mkdtemp(join(tmpdir(), 'mysql-coordinator-'))
    const disk = new ArtifactGenerations(root)
    const catalog = new MysqlArtifactCatalog(db, 1500)
    const renew = vi.spyOn(catalog, 'renew')
    const first = new ArtifactCoordinator(catalog, disk, 40)
    const second = new ArtifactCoordinator(new MysqlArtifactCatalog(db2, 1500), disk, 40)
    cleanups.push(async () => {
      await Promise.all([first.close(), second.close()])
      await rm(root, { recursive: true, force: true })
    })
    let arrived!: () => void
    const started = new Promise<void>((resolve) => { arrived = resolve })
    const reader = new AbortController()
    const build = vi.fn(async (writer, signal) => {
      arrived()
      await delay(2000, undefined, { signal })
      await writer.append('unit:0', { text: 'shared across pools' })
    })
    const cancelled = first.getOrBuild(identity, build, reader.signal)
    const rejected = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
    await started
    const duplicate = vi.fn(async () => { throw new Error('duplicate source build') })
    const waiting = second.getOrBuild(identity, duplicate)
    reader.abort()
    await rejected
    expect(await (await waiting).read('unit:0')).toEqual({ text: 'shared across pools' })
    expect(build).toHaveBeenCalledTimes(1)
    expect(duplicate).not.toHaveBeenCalled()
    expect(renew.mock.calls.length).toBeGreaterThan(1)
    expect(await catalog.claim(identity, 'reader')).toMatchObject({ kind: 'ready', artifact: { generation: 1 } })
  }, 15_000)

  it('pins an immutable generation and renews old readers across a new publication', async () => {
    const { db, a, b } = await setup()
    const root = await mkdtemp(join(tmpdir(), 'catalog-readers-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const disk = new ArtifactGenerations(root)
    const first = acquired(await a.claim(identity, 'builder'))
    const old = await disk.publish(identity, first.generation, async (writer) => {
      await writer.append('unit:0', { text: 'old reader' })
    })
    expect(await a.complete(first, old)).toBe(true)
    const pinned = await b.pin(first.key, 'reader-a')
    expect(pinned?.lease.generation).toBe(1)
    const next = acquired(await a.claim(identity, 'rebuild', true))
    const fresh = await disk.publish(identity, next.generation, async (writer) => {
      await writer.append('unit:0', { text: 'new reader' })
    })
    expect(await a.complete(next, fresh)).toBe(true)
    expect(await b.renewRead(pinned!.lease)).toBe(true)
    expect(await (await disk.open(pinned!.artifact)).read('unit:0')).toEqual({ text: 'old reader' })
    const newer = await a.pin(first.key, 'reader-b')
    expect(newer?.lease.generation).toBe(2)
    expect(await (await disk.open(newer!.artifact)).read('unit:0')).toEqual({ text: 'new reader' })
    expect(await a.releaseRead({ ...pinned!.lease, owner: 'wrong-owner' })).toBe(false)
    expect(await a.renewRead({ ...pinned!.lease, generation: 2 })).toBe(false)
    await expect(db.pool.execute('DELETE FROM parse_artifacts WHERE artifact_key = ?', [first.key]))
      .rejects.toMatchObject({ code: 'ER_ROW_IS_REFERENCED_2' })
    expect(await b.releaseRead(pinned!.lease)).toBe(true)
    expect(await b.releaseRead(pinned!.lease)).toBe(false)
    expect(await a.releaseRead(newer!.lease)).toBe(true)
    await db.pool.execute('DELETE FROM parse_artifacts WHERE artifact_key = ?', [first.key])
  })

  it('expired reader tokens cannot revive or remove a new reader with the same owner', async () => {
    const { db, a, b } = await setup()
    const build = acquired(await a.claim(identity, 'builder'))
    await a.complete(build, summary)
    const old = (await a.pin(build.key, 'same-reader'))!
    await db.pool.execute('UPDATE parse_artifact_read_leases SET lease_until = 0 WHERE id = ?', [old.lease.id])
    expect(await b.renewRead(old.lease)).toBe(false)
    const [expired] = await db.pool.query<mysql.RowDataPacket[]>(
      'SELECT COUNT(*) AS count FROM parse_artifact_read_leases WHERE id = ?', [old.lease.id])
    expect(expired[0].count).toBe(0)
    const next = (await b.pin(build.key, 'same-reader'))!
    expect(next.lease.id).not.toBe(old.lease.id)
    expect(await a.releaseRead(old.lease)).toBe(false)
    expect(await b.renewRead(next.lease)).toBe(true)
    expect(await b.renewRead(old.lease)).toBe(false)
    expect(await b.releaseRead(next.lease)).toBe(true)
  })

  it('serializes reader selection against publication across independent pools', async () => {
    const { a, b } = await setup()
    const first = acquired(await a.claim(identity, 'first'))
    await a.complete(first, summary)
    const next = acquired(await a.claim(identity, 'next', true))
    const [pinned, completed] = await Promise.all([
      b.pin(first.key, 'racing-reader'),
      a.complete(next, { ...summary, bytes: 200 }),
    ])
    expect(completed).toBe(true)
    expect([1, 2]).toContain(pinned!.artifact.generation)
    expect(pinned!.lease.generation).toBe(pinned!.artifact.generation)
    expect(pinned!.artifact.bytes).toBe(pinned!.lease.generation === 1 ? 100 : 200)
    expect(await a.renewRead(pinned!.lease)).toBe(true)
    const readers = await Promise.all(Array.from({ length: 12 }, (_, index) =>
      (index % 2 ? a : b).pin(first.key, 'parallel-reader')))
    expect(new Set(readers.map((reader) => reader!.lease.id)).size).toBe(12)
    expect(readers.every((reader) => reader!.lease.generation === 2)).toBe(true)
    await Promise.all(readers.map((reader) => b.releaseRead(reader!.lease)))
    await a.releaseRead(pinned!.lease)
  })

  it('does not create a reader before readiness and rejects invalid durations', async () => {
    const { a } = await setup()
    expect(await a.pin('b'.repeat(64), 'reader')).toBeNull()
    const build = acquired(await a.claim(identity, 'builder'))
    expect(await a.pin(build.key, 'reader')).toBeNull()
    for (const duration of [0, -1, NaN, Infinity, 0.5, 600001])
      await expect(a.pin(build.key, 'reader', duration)).rejects.toThrow('read lease duration')
    await expect(a.pin(build.key, 'invalid owner')).rejects.toThrow('invalid artifact reader')
    await a.complete(build, summary)
    const pinned = (await a.pin(build.key, 'reader'))!
    expect(() => a.renewRead(pinned.lease, 0)).toThrow('read lease duration')
    await a.releaseRead(pinned.lease)
  })

  it('keeps leased readers alive across publication and fences only the reader whose renewal fails', async () => {
    const { db, a, b } = await setup()
    const root = await mkdtemp(join(tmpdir(), 'leased-generation-readers-'))
    const disk = new ArtifactGenerations(root)
    const handles: ArtifactReadHandle[] = []
    cleanups.push(async () => {
      await Promise.allSettled(handles.map((handle) => handle.close()))
      await rm(root, { recursive: true, force: true })
    })
    const first = acquired(await a.claim(identity, 'builder'))
    const old = await disk.publish(identity, first.generation, async (writer) => {
      await writer.append('unit:0', { text: 'old' })
    })
    await a.complete(first, old)
    const handle = (await ArtifactReadHandle.open(a, disk, first.key, 'old-reader', 1500))!
    handles.push(handle)
    const renew = vi.spyOn(a, 'renewRead')
    await delay(2000)
    expect(renew.mock.calls.length).toBeGreaterThan(1)
    expect(await handle.read('unit:0')).toEqual({ text: 'old' })
    const next = acquired(await b.claim(identity, 'rebuilder', true))
    const fresh = await disk.publish(identity, next.generation, async (writer) => {
      await writer.append('unit:0', { text: 'new' })
    })
    await b.complete(next, fresh)
    const newer = (await ArtifactReadHandle.open(b, disk, first.key, 'new-reader', 1500))!
    handles.push(newer)
    expect(await handle.read('unit:0')).toEqual({ text: 'old' })
    expect(await newer.read('unit:0')).toEqual({ text: 'new' })
    renew.mockResolvedValue(false)
    await expect.poll(() => handle.signal.aborted).toBe(true)
    await expect(handle.read('unit:0')).rejects.toMatchObject({ code: 'artifact_read_lease_lost' })
    await handle.close()
    expect(await newer.read('unit:0')).toEqual({ text: 'new' })
    await newer.close()
    const [rows] = await db.pool.query<mysql.RowDataPacket[]>(
      'SELECT COUNT(*) AS count FROM parse_artifact_read_leases WHERE artifact_key = ?', [first.key])
    expect(rows[0].count).toBe(0)
  }, 15_000)

  it('retires only unreferenced generations and preserves the monotonic generation history', async () => {
    const { db, a, b } = await setup()
    const root = await mkdtemp(join(tmpdir(), 'generation-collection-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const disk = new ArtifactGenerations(root)
    const first = acquired(await a.claim(identity, 'builder'))
    const old = await disk.publish(identity, 1, async (writer) => { await writer.append('unit:0', { text: 'old' }) })
    await a.complete(first, old)
    expect(await disk.collect(first.key, 1, b)).toBe(false) // Current ready cannot be retired.
    const reader = (await b.pin(first.key, 'old-reader'))!
    const next = acquired(await a.claim(identity, 'rebuild', true))
    expect(await a.retireGeneration(first.key, next.generation)).toBe(false) // Live builder.
    const fresh = await disk.publish(identity, next.generation, async (writer) => { await writer.append('unit:0', { text: 'new' }) })
    await a.complete(next, fresh)
    expect(await disk.collect(first.key, 1, a)).toBe(false) // Live old reader.
    expect(await b.renewRead(reader.lease)).toBe(true)
    await b.releaseRead(reader.lease)
    expect(await disk.collect(first.key, 1, a)).toBe(true)
    expect(await disk.collect(first.key, 1, b)).toBe(true)
    const newer = (await b.pin(first.key, 'new-reader'))!
    expect(newer.artifact.generation).toBe(2)
    expect(await (await disk.open(fresh)).read('unit:0')).toEqual({ text: 'new' })
    await expect(disk.open(old)).rejects.toThrow('generation missing')
    expect(await a.retireGeneration(first.key, 3)).toBe(false)
    await b.releaseRead(newer.lease)
    await expect(db.pool.execute('DELETE FROM parse_artifacts WHERE artifact_key = ?', [first.key]))
      .rejects.toMatchObject({ code: 'ER_ROW_IS_REFERENCED_2' }) // Retirement history fences counter reuse.
  })

  it('retirement prunes expired readers and rollback never permits physical deletion', async () => {
    const { db, a, b } = await setup()
    const root = await mkdtemp(join(tmpdir(), 'generation-retirement-failure-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const disk = new ArtifactGenerations(root)
    const first = acquired(await a.claim(identity, 'builder'))
    const old = await disk.publish(identity, 1, async (writer) => { await writer.append('unit:0', { text: 'keep on rollback' }) })
    await a.complete(first, old)
    const reader = (await b.pin(first.key, 'reader'))!
    const next = acquired(await a.claim(identity, 'next', true))
    await a.complete(next, summary)
    await db.pool.execute('UPDATE parse_artifact_read_leases SET lease_until = 0 WHERE id = ?', [reader.lease.id])
    await db.pool.query(`CREATE TRIGGER retirement_failure BEFORE INSERT ON parse_artifact_retirements
      FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'retirement failed'`)
    await expect(disk.collect(first.key, 1, a)).rejects.toMatchObject({ sqlState: '45000' })
    expect(await (await disk.open(old)).read('unit:0')).toEqual({ text: 'keep on rollback' })
    const [rows] = await db.pool.query<mysql.RowDataPacket[]>('SELECT id FROM parse_artifact_read_leases WHERE id = ?', [reader.lease.id])
    expect(rows).toHaveLength(1)
    await db.pool.query('DROP TRIGGER retirement_failure')
    expect(await disk.collect(first.key, 1, b)).toBe(true)
    expect(await a.renewRead(reader.lease)).toBe(false)
  })

  it('fences an expired builder before collection and reaps its late orphan publication again', async () => {
    const { db, a, b } = await setup()
    const root = await mkdtemp(join(tmpdir(), 'retired-late-writer-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const disk = new ArtifactGenerations(root)
    const old = acquired(await a.claim(identity, 'old'))
    let release!: () => void
    let arrived!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { arrived = resolve })
    const late = disk.publish(identity, 1, async (writer) => {
      arrived(); await gate
      await writer.append('unit:0', { text: 'late orphan' })
    })
    try {
      await started
      await db.pool.execute('UPDATE parse_jobs SET lease_until = 0 WHERE artifact_key = ?', [old.key])
      expect(await disk.collect(old.key, 1, b)).toBe(true)
      // Even restoring the old lease fields cannot bypass the irreversible retirement fence.
      await db.pool.execute(`UPDATE parse_jobs SET state = 'building', lease_owner = ?, lease_until = ?
        WHERE artifact_key = ?`, [old.owner, Date.now() + 60_000, old.key])
      expect(await a.renew(old)).toBe(false)
      expect(await a.complete(old, summary)).toBe(false)
      await db.pool.execute('UPDATE parse_jobs SET lease_until = 0 WHERE artifact_key = ?', [old.key])
      const next = acquired(await b.claim(identity, 'new'))
      expect(next.generation).toBe(2)
      const current = await disk.publish(identity, 2, async (writer) => { await writer.append('unit:0', { text: 'current' }) })
      await b.complete(next, current)
      release()
      await late
      expect(await a.complete(old, summary)).toBe(false)
      expect(await disk.collect(old.key, 1, a)).toBe(true)
      expect(await (await disk.open(current)).read('unit:0')).toEqual({ text: 'current' })
    } finally { release(); await late.catch(() => undefined) }
  })

  it('discovers and collects retired candidates in bounded passes without starving behind readers or ready data', async () => {
    const { db, a, b } = await setup()
    const root = await mkdtemp(join(tmpdir(), 'mysql-generation-sweep-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const disk = new ArtifactGenerations(root)
    const publish = async (generation: number) => {
      const ready = await disk.publish(identity, generation, async (writer) => {
        await writer.append('unit:0', { generation })
      })
      const age = new Date(Date.now() - 2 * 60 * 60_000)
      await utimes(join(root, ready.storagePath), age, age)
      return ready
    }
    const first = acquired(await a.claim(identity, 'builder'))
    const old = await publish(1)
    await a.complete(first, old)
    const reader = (await b.pin(first.key, 'old-reader'))!
    const next = acquired(await a.claim(identity, 'next', true))
    const current = await publish(2)
    await a.complete(next, current)
    const abandoned = acquired(await a.claim(identity, 'abandoned', true))
    await publish(3)
    await db.pool.execute('UPDATE parse_jobs SET lease_until = 0 WHERE artifact_key = ?', [first.key])
    const sweeper = new ArtifactGenerationSweeper(disk, a)
    expect(await sweeper.sweep(1)).toMatchObject({ examined: 1, protected: 1, collected: 0 })
    expect(await sweeper.sweep(1)).toMatchObject({ examined: 1, protected: 1, collected: 0 })
    expect(await sweeper.sweep(1)).toMatchObject({ examined: 1, protected: 0, collected: 1 })
    expect(await sweeper.sweep(1)).toMatchObject({ examined: 0, hasMore: false })
    expect(await a.complete(abandoned, summary)).toBe(false)
    await b.releaseRead(reader.lease)
    expect(await sweeper.sweep()).toMatchObject({ examined: 2, protected: 1, collected: 1, failed: 0 })
    expect(await (await disk.open(current)).read('unit:0')).toEqual({ generation: 2 })
    await expect(disk.open(old)).rejects.toThrow('generation missing')
    expect(await new ArtifactStore(root).totalBytes()).toBe(current.bytes)
  })
})

it('generation paths reject traversal and unsafe counters', () => {
  for (const generation of [0, -1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1])
    expect(() => artifactGenerationPath('a'.repeat(64), generation)).toThrow()
  expect(() => artifactGenerationPath('../x', 1)).toThrow()
})
