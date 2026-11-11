import mysql from 'mysql2/promise'
import JSZip from 'jszip'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { createBlankPptx } from '@genoffice/pptx-engine'
import { MysqlDatabase } from '../src/mysql'
import { MediaCatalog, type MediaResult } from '../src/media-catalog'
import { mediaProcess } from '../src/media-process'
import { createParseServer, type ParseServer } from '../src/server'

const socketPath = process.env.PARSE_TEST_MYSQL_SOCKET
const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()!() })
describe.skipIf(!socketPath)('persistent media jobs with real MySQL and FFmpeg', () => {
  async function database() {
    const name = `genoffice_media_${randomUUID().replaceAll('-', '')}`
    const admin = await mysql.createConnection({ socketPath, user: 'root' })
    await admin.query(`CREATE DATABASE ${name} CHARACTER SET utf8mb4`)
    const config = { host: '127.0.0.1', port: 3306, socketPath, user: 'root', password: '', database: name }
    cleanup.push(async () => { await admin.query(`DROP DATABASE ${name}`); await admin.end() })
    return config
  }
  it('bounds the shared queue, pins queued sources and fences expired publishers', async () => {
    const config = await database(), db = new MysqlDatabase(config), other = new MysqlDatabase(config)
    cleanup.push(async () => { await db.close(); await other.close() })
    await db.init()
    const a = new MediaCatalog(db, 3000), b = new MediaCatalog(other, 3000)
    await a.init(); await b.init()
    const fileId = 'a'.repeat(64), profile = 'b'.repeat(64), key = 'c'.repeat(64)
    await db.pool.query("INSERT INTO parse_files (file_id,sha256,size,format,created_at) VALUES (?,?,0,'pptx',?)", [fileId, fileId, new Date().toISOString()])
    const job = { id: 'd'.repeat(64), fileId, partPath: 'ppt/media/a.mp4', kind: 'video' as const, profile }
    await a.enqueue(job, 1)
    await expect(b.enqueue({ ...job, id: 'e'.repeat(64) }, 1)).rejects.toMatchObject({ code: 'media_queue_full' })
    await expect(db.pool.query('DELETE FROM parse_files WHERE file_id=?', [fileId])).rejects.toBeDefined()
    const [first, second] = await Promise.all([a.claim([profile, profile], randomUUID(), 1, 10000, 1), b.claim([profile, profile], randomUUID(), 1, 10000, 1)])
    const old = first ?? second
    expect(Boolean(first) !== Boolean(second)).toBe(true)
    const generation = await a.claimCache(key, old!.owner!)
    await db.pool.query('UPDATE parse_media_jobs SET lease_until=0 WHERE id=?', [job.id])
    await db.pool.query('UPDATE parse_media_cache SET lease_until=0 WHERE cache_key=?', [key])
    const next = (await b.claim([profile, profile], randomUUID(), 1, 10000, 1))!
    expect(next.generation).toBe(old!.generation + 1)
    const nextGeneration = await b.claimCache(key, next.owner!)
    expect(nextGeneration).toBe(generation! + 1)
    const result: MediaResult = { key, generation: generation!, sourceSha256: fileId,
      sha256: fileId, kind: 'video', mime: 'video/mp4', bytes: 10, duration: 2, strategy: 'reuse' }
    expect(await a.publish(old!, result)).toBe(false)
    expect(await b.publish(next, { ...result, generation: nextGeneration! })).toBe(true)
    expect((await a.get(job.id))!.state).toBe('ready')
    await a.enqueue({ ...job, id: 'f'.repeat(64) }, 2)
    expect(await b.claim([profile, profile], randomUUID(), 1, 10000, 1, 1)).toBeNull()
    await a.collect(60_000, 10000, 1, async () => undefined, 1)
    const afterPressure = await b.claim([profile, profile], randomUUID(), 1, 10000, 1, 1)
    expect(afterPressure).not.toBeNull()
    await b.release(afterPressure!, 'media_invalid')
    await db.pool.query('DELETE FROM parse_files WHERE file_id=?', [fileId])
  })
  it('retires jobs for an absent runtime and fences cache eviction before reuse', async () => {
    const config = await database(), db = new MysqlDatabase(config)
    cleanup.push(() => db.close())
    await db.init()
    const catalog = new MediaCatalog(db, 3000)
    await catalog.init()
    const fileId = '1'.repeat(64), profile = '2'.repeat(64), key = '3'.repeat(64)
    await db.pool.query("INSERT INTO parse_files (file_id,sha256,size,format,created_at) VALUES (?,?,0,'pptx',?)", [fileId, fileId, new Date().toISOString()])
    const job = { id: '4'.repeat(64), fileId, partPath: 'ppt/media/a.mp4', kind: 'video' as const, profile }
    await catalog.enqueue(job, 2)
    await catalog.maintain(randomUUID(), ['5'.repeat(64), '6'.repeat(64)])
    expect(await catalog.get(job.id)).toMatchObject({ state: 'failed', errorCode: 'media_runtime_changed' })
    expect(await catalog.protectedFiles()).toEqual([])
    const generation = await catalog.claimCache(key, randomUUID())
    expect(generation).toBe(1)
    await db.pool.query('UPDATE parse_media_cache SET lease_until=0 WHERE cache_key=?', [key])
    let removed = false
    await catalog.collect(1, 1000, 1, async (cacheKey) => {
      expect(cacheKey).toBe(key)
      expect(await catalog.claimCache(key, randomUUID())).toBeNull()
      removed = true
    })
    expect(removed).toBe(true)
    expect(await catalog.claimCache(key, randomUUID())).toBe(1)
  })
  it.skipIf(!hasFfmpeg)('prepares real original media, reuses content across files/restarts, and serves signed ranges', async () => {
    const config = await database(), root = await mkdtemp(join(tmpdir(), 'media-http-'))
    const servers: ParseServer[] = []
    cleanup.push(async () => { await Promise.all(servers.map((s) => s.close())); await rm(root, { recursive: true, force: true }) })
    const start = async (enabled = true) => {
      const server = await createParseServer({ dataDir: root, mysql: config, token: 'media-test',
        media: { enabled, maxInputBytes: 16 * 1024 ** 2, maxOutputBytes: 32 * 1024 ** 2,
          maxCacheBytes: 128 * 1024 ** 2, timeoutMs: 30_000 } })
      servers.push(server); return server
    }
    let a = await start(), b = await start()
    const request = async (server: ParseServer, path: string, init: RequestInit = {}) => {
      const response = await fetch(server.url + path, { ...init, headers: { Authorization: 'Bearer media-test', 'Content-Type': 'application/json', ...init.headers } })
      const text = await response.text(); return { response, body: text ? JSON.parse(text) : null }
    }
    const file = join(root, 'sample.mp4')
    await mediaProcess('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=10',
      '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '2', '-c:v', 'libx264', '-threads', '1', '-c:a', 'aac', '-movflags', '+faststart', file], { timeoutMs: 15000 })
    const zip = await JSZip.loadAsync(await createBlankPptx())
    zip.file('ppt/media/sample.mp4', await readFile(file))
    const upload = async (comment: string) => {
      const data = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', comment })
      const result = await request(a, '/v1/files', { method: 'POST', body: data }); expect(result.response.status).toBe(201)
      return result.body.fileId as string
    }
    const ready = async (server: ParseServer, fileId: string, kind = 'video', retry = false) => {
      const opened = await request(server, `/v1/files/${fileId}/media`, { method: 'POST', body: JSON.stringify({ partPath: 'ppt/media/sample.mp4', kind, retry }) })
      expect([200, 202]).toContain(opened.response.status)
      let state = opened.body
      for (let n = 0; n < 200 && ['queued', 'processing'].includes(state.state); n++) {
        await delay(50); state = (await request(b, `/v1/files/${fileId}/media/${state.jobId}`)).body
      }
      expect(state.state, JSON.stringify(state)).toBe('ready'); return state
    }
    const firstId = await upload('one'), secondId = await upload('two')
    const first = await ready(a, firstId)
    expect(first.strategy).toBe('reuse')
    expect(first.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(first.sourceSha256).toBe(first.sha256)
    expect(first.profile).toMatch(/^[a-f0-9]{64}$/)
    expect((await request(a, '/v2/capabilities')).body.features.mediaPreparationIntegrity).toBe(true)
    const shared = await ready(b, secondId)
    expect(shared.cacheHit).toBe(true)
    const range = await fetch(shared.url, { headers: { Range: 'bytes=0-31' } })
    expect(range.status).toBe(206); expect((await range.arrayBuffer()).byteLength).toBe(32)
    expect(range.headers.get('content-type')).toBe('video/mp4')
    const bad = new URL(shared.url); bad.searchParams.set('sig', 'wrong')
    expect((await fetch(bad)).status).toBe(401)
    const audio = await ready(a, firstId, 'audio')
    expect(audio.strategy).toBe('transcode'); expect(audio.mime).toBe('audio/mpeg')
    expect(audio.sourceSha256).toBe(first.sourceSha256)
    expect(audio.sha256).not.toBe(first.sha256)
    const forced = await ready(a, firstId, 'video', true)
    expect(forced.strategy).toBe('transcode')
    const health = (await request(a, '/v1/health')).body
    expect(health.media.counters.transcoded + (await request(b, '/v1/health')).body.media.counters.transcoded).toBe(2)
    await Promise.all([a.close(), b.close()]); a = await start(); b = a
    const warm = await ready(a, firstId)
    expect(warm.strategy).toBe('reuse')
    expect(warm.cacheHit).toBe(true)
    expect((await request(a, '/v1/health')).body.media.counters.probes).toBe(0)
    const [rows] = await a.db!.pool.query<any[]>(`SELECT result FROM parse_media_cache
      WHERE cache_key=(SELECT cache_key FROM parse_media_jobs WHERE id=?)`, [warm.jobId])
    const result = typeof rows[0].result === 'string' ? JSON.parse(rows[0].result) : rows[0].result
    await writeFile(join(root, 'media-cache', 'objects', result.key, `g-${result.generation}`, 'media.mp4'), 'damaged')
    const repaired = await ready(a, firstId)
    expect(repaired.strategy).toBe('reuse')
    expect((await request(a, '/v1/health')).body.media.counters.probes).toBeGreaterThan(0)
    const invalid = await request(a, `/v1/files/${firstId}/media`, { method: 'POST', body: JSON.stringify({ partPath: '../../etc/passwd', kind: 'video' }) })
    expect(invalid.response.status).toBe(400)
    await a.close(); a = await start(false)
    expect((await request(a, '/v2/capabilities')).body.features.mediaTranscoding).toBe(false)
    const oldUrl = new URL(repaired.url); oldUrl.host = new URL(a.url).host
    const afterRollback = await fetch(oldUrl, { headers: { Range: 'bytes=0-31' } })
    expect(afterRollback.status).toBe(206); await afterRollback.arrayBuffer()
    expect((await request(a, `/v1/files/${firstId}/media`, { method: 'POST', body: JSON.stringify({ partPath: 'ppt/media/sample.mp4', kind: 'video' }) })).response.status).toBe(404)
  }, 60_000)
})
