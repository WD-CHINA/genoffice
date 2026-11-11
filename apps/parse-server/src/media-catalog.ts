import type { PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise'
import type { MysqlDatabase } from './mysql'
import type { MediaKind, MediaStrategy } from './media-policy'
import { MediaError } from './media-process'

export interface MediaJob {
  id: string; fileId: string; partPath: string; kind: MediaKind; profile: string
  state: 'queued' | 'processing' | 'ready' | 'failed'; stage: string; progress: number
  owner: string | null; generation: number; attempts: number; cacheKey: string | null
  cacheHit: boolean; errorCode: string | null
}
export interface MediaResult {
  key: string; generation: number; sourceSha256: string; sha256: string
  kind: MediaKind; mime: string; bytes: number; duration: number; strategy: MediaStrategy
}
const json = (value: unknown) => typeof value === 'string' ? JSON.parse(value) : value
const jobOf = (row: RowDataPacket): MediaJob => ({
  id: row.id, fileId: row.file_id, partPath: row.part_path, kind: row.kind, profile: row.profile,
  state: row.state, stage: row.stage, progress: Number(row.progress), owner: row.owner,
  generation: Number(row.generation), attempts: Number(row.attempts), cacheKey: row.cache_key,
  cacheHit: Boolean(row.cache_hit), errorCode: row.error_code,
})

/** Durable queue and fenced cache publication, shared by all server instances. */
export class MediaCatalog {
  constructor(private readonly db: MysqlDatabase, readonly leaseMs: number) {}
  async init(): Promise<void> {
    await this.db.pool.query(`CREATE TABLE IF NOT EXISTS parse_media_control (
      id INT NOT NULL PRIMARY KEY
    ) ENGINE=InnoDB`)
    await this.db.pool.query('INSERT IGNORE INTO parse_media_control (id) VALUES (1)')
    await this.db.pool.query(`CREATE TABLE IF NOT EXISTS parse_media_instances (
      id CHAR(36) NOT NULL PRIMARY KEY, profile CHAR(64) NOT NULL,
      forced_profile CHAR(64) NOT NULL, lease_until BIGINT NOT NULL
    ) ENGINE=InnoDB`)
    await this.db.pool.query(`CREATE TABLE IF NOT EXISTS parse_media_jobs (
      id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
      file_id CHAR(64) NOT NULL, source_file_id VARCHAR(64) NULL,
      part_path VARCHAR(1024) NOT NULL, kind VARCHAR(8) NOT NULL,
      profile CHAR(64) NOT NULL, state VARCHAR(16) NOT NULL, stage VARCHAR(16) NOT NULL,
      progress INT NOT NULL DEFAULT 0, owner CHAR(36) NULL, lease_until BIGINT NOT NULL DEFAULT 0,
      generation INT NOT NULL DEFAULT 0, attempts INT NOT NULL DEFAULT 0,
      cache_key CHAR(64) NULL, cache_hit BOOLEAN NOT NULL DEFAULT FALSE,
      error_code VARCHAR(64) NULL, due_at BIGINT NOT NULL DEFAULT 0,
      created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL,
      KEY idx_media_queue (state, profile, due_at, created_at), KEY idx_media_file (file_id),
      CONSTRAINT fk_media_source FOREIGN KEY (source_file_id) REFERENCES parse_files(file_id) ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
    await this.db.pool.query(`CREATE TABLE IF NOT EXISTS parse_media_cache (
      cache_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
      state VARCHAR(16) NOT NULL, owner CHAR(36) NULL, lease_until BIGINT NOT NULL DEFAULT 0,
      generation INT NOT NULL DEFAULT 0, bytes BIGINT NOT NULL DEFAULT 0,
      result JSON NULL, updated_at BIGINT NOT NULL,
      KEY idx_media_cache_lru (state, updated_at)
    ) ENGINE=InnoDB`)
  }
  private async transaction<T>(work: (connection: PoolConnection, now: number) => Promise<T>): Promise<T> {
    const connection = await this.db.pool.getConnection()
    try {
      await connection.beginTransaction()
      await connection.query('SELECT id FROM parse_media_control WHERE id=1 FOR UPDATE')
      const [clock] = await connection.query<RowDataPacket[]>('SELECT ROUND(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3))*1000) AS now_ms')
      const result = await work(connection, Number(clock[0]!.now_ms))
      await connection.commit(); return result
    } catch (error) { await connection.rollback(); throw error }
    finally { connection.release() }
  }
  async get(id: string): Promise<MediaJob | null> {
    const [rows] = await this.db.pool.query<RowDataPacket[]>('SELECT * FROM parse_media_jobs WHERE id=?', [id])
    return rows[0] ? jobOf(rows[0]) : null
  }
  async maintain(id: string, profiles: [string, string]): Promise<void> {
    await this.transaction(async (c, now) => {
      await c.query(`INSERT INTO parse_media_instances (id,profile,forced_profile,lease_until) VALUES (?,?,?,?)
        ON DUPLICATE KEY UPDATE lease_until=VALUES(lease_until)`, [id, ...profiles, now + this.leaseMs])
      await this.retire(c, now)
    })
  }
  private async retire(c: PoolConnection, now: number): Promise<void> {
    await c.query('DELETE FROM parse_media_instances WHERE lease_until<?', [now])
    await c.query(`UPDATE parse_media_jobs SET state='failed',stage='failed',source_file_id=NULL,
      error_code='media_runtime_changed',updated_at=?
      WHERE (state='queued' OR (state='processing' AND lease_until<?)) AND profile NOT IN
      (SELECT profile FROM parse_media_instances WHERE lease_until>? UNION
       SELECT forced_profile FROM parse_media_instances WHERE lease_until>?)`, [now, now, now, now])
  }
  async retireUnsupported(): Promise<void> {
    await this.transaction((c, now) => this.retire(c, now))
  }
  async unregister(id: string): Promise<void> {
    await this.db.pool.query('DELETE FROM parse_media_instances WHERE id=?', [id])
  }
  async recordHit(id: string): Promise<void> {
    await this.db.pool.query("UPDATE parse_media_jobs SET cache_hit=TRUE WHERE id=? AND state='ready'", [id])
  }
  async active(id: string, owner: string): Promise<boolean> {
    const [rows] = await this.db.pool.query<RowDataPacket[]>(`SELECT id FROM parse_media_jobs
      WHERE id=? AND owner=? AND state='processing' AND lease_until>ROUND(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3))*1000)`, [id, owner])
    return rows.length > 0
  }
  async enqueue(input: Pick<MediaJob, 'id' | 'fileId' | 'partPath' | 'kind' | 'profile'>,
    maxQueued: number, retry = false): Promise<MediaJob> {
    return this.transaction(async (c, now) => {
      const [rows] = await c.query<RowDataPacket[]>('SELECT * FROM parse_media_jobs WHERE id=? FOR UPDATE', [input.id])
      if (rows[0] && !(retry && ['ready', 'failed'].includes(rows[0].state))) return jobOf(rows[0])
      const [count] = await c.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM parse_media_jobs WHERE state='queued'")
      if (Number(count[0]!.n) >= maxQueued) throw new MediaError('media_queue_full', '媒体处理队列已满，请稍后重试。')
      // Lock source metadata so a concurrent content deletion cannot leave a new dangling job.
      const [files] = await c.query<RowDataPacket[]>('SELECT file_id FROM parse_files WHERE file_id=? FOR UPDATE', [input.fileId])
      if (!files.length) throw new MediaError('media_source_missing', '原文档已不存在。')
      if (rows.length) await c.query(`UPDATE parse_media_jobs SET state='queued',stage='queued',progress=0,
        attempts=0,error_code=NULL,cache_key=NULL,cache_hit=FALSE,source_file_id=?,due_at=?,updated_at=? WHERE id=?`, [input.fileId, now, now, input.id])
      else await c.query(`INSERT INTO parse_media_jobs
        (id,file_id,source_file_id,part_path,kind,profile,state,stage,created_at,updated_at)
        VALUES (?,?,?,?,?,?,'queued','queued',?,?)`, [input.id, input.fileId, input.fileId, input.partPath, input.kind, input.profile, now, now])
      const [result] = await c.query<RowDataPacket[]>('SELECT * FROM parse_media_jobs WHERE id=?', [input.id])
      return jobOf(result[0]!)
    })
  }
  async claim(profiles: [string, string], owner: string, concurrency: number, maxBytes: number,
    reservationBytes: number, maxEntries = 10_000): Promise<MediaJob | null> {
    return this.transaction(async (c, now) => {
      await c.query(`UPDATE parse_media_jobs SET state=IF(attempts>=3,'failed','queued'),
        stage=IF(attempts>=3,'failed','queued'),error_code=IF(attempts>=3,'media_interrupted',NULL),
        owner=NULL,lease_until=0,source_file_id=IF(attempts>=3,NULL,source_file_id),updated_at=?
        WHERE state='processing' AND lease_until<?`, [now, now])
      const [active] = await c.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM parse_media_jobs WHERE state='processing'")
      const [bytes] = await c.query<RowDataPacket[]>('SELECT COALESCE(SUM(bytes),0) AS n,COUNT(*) AS entries FROM parse_media_cache')
      if (Number(active[0]!.n) >= concurrency || Number(bytes[0]!.n) +
          (Number(active[0]!.n) + 1) * reservationBytes > maxBytes ||
          Number(bytes[0]!.entries) + Number(active[0]!.n) + 1 > maxEntries) return null
      const [rows] = await c.query<RowDataPacket[]>(`SELECT * FROM parse_media_jobs
        WHERE state='queued' AND profile IN (?,?) AND due_at<=? ORDER BY created_at,id LIMIT 1 FOR UPDATE`, [...profiles, now])
      if (!rows[0]) return null
      await c.query(`UPDATE parse_media_jobs SET state='processing',stage='probing',progress=0,
        owner=?,lease_until=?,generation=generation+1,attempts=attempts+1,updated_at=? WHERE id=?`,
      [owner, now + this.leaseMs, now, rows[0].id])
      return { ...jobOf(rows[0]), state: 'processing', stage: 'probing', owner,
        generation: Number(rows[0].generation) + 1, attempts: Number(rows[0].attempts) + 1 }
    })
  }
  async renew(job: MediaJob, cacheKey?: string): Promise<boolean> {
    return this.transaction(async (c, now) => {
      const [changed] = await c.query<ResultSetHeader>(`UPDATE parse_media_jobs SET lease_until=?,updated_at=?
        WHERE id=? AND state='processing' AND owner=? AND generation=? AND lease_until>?`,
      [now + this.leaseMs, now, job.id, job.owner, job.generation, now])
      if (!changed.affectedRows) return false
      if (cacheKey) {
        const [cache] = await c.query<ResultSetHeader>(`UPDATE parse_media_cache SET lease_until=?,updated_at=?
          WHERE cache_key=? AND state='processing' AND owner=? AND lease_until>?`,
        [now + this.leaseMs, now, cacheKey, job.owner, now])
        if (!cache.affectedRows) return false
      }
      return true
    })
  }
  async progress(job: MediaJob, stage: string, progress: number): Promise<void> {
    await this.db.pool.query(`UPDATE parse_media_jobs SET stage=?,progress=?
      WHERE id=? AND owner=? AND generation=? AND state='processing'`,
    [stage, Math.min(99, Math.max(0, progress)), job.id, job.owner, job.generation])
  }
  async cache(key: string, touch = true): Promise<MediaResult | null> {
    if (touch) await this.db.pool.query(`UPDATE parse_media_cache SET updated_at=ROUND(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3))*1000)
      WHERE cache_key=? AND state='ready'`, [key])
    const [rows] = await this.db.pool.query<RowDataPacket[]>("SELECT result FROM parse_media_cache WHERE cache_key=? AND state='ready'", [key])
    return rows[0] ? json(rows[0].result) as MediaResult : null
  }
  async claimCache(key: string, owner: string): Promise<number | null> {
    return this.transaction(async (c, now) => {
      const [rows] = await c.query<RowDataPacket[]>('SELECT * FROM parse_media_cache WHERE cache_key=? FOR UPDATE', [key])
      const row = rows[0]
      if (row && (row.state === 'ready' || row.state === 'deleting' ||
          (row.state === 'processing' && Number(row.lease_until) > now))) return null
      const generation = Number(row?.generation ?? 0) + 1
      await c.query(`INSERT INTO parse_media_cache (cache_key,state,owner,lease_until,generation,updated_at)
        VALUES (?,'processing',?,?,?,?) ON DUPLICATE KEY UPDATE state='processing',
        owner=VALUES(owner),lease_until=VALUES(lease_until),generation=VALUES(generation),updated_at=VALUES(updated_at)`,
      [key, owner, now + this.leaseMs, generation, now])
      return generation
    })
  }
  async publish(job: MediaJob, result: MediaResult): Promise<boolean> {
    return this.transaction(async (c, now) => {
      const [cache] = await c.query<ResultSetHeader>(`UPDATE parse_media_cache SET state='ready',result=?,bytes=?,updated_at=?,owner=NULL
        WHERE cache_key=? AND state='processing' AND owner=? AND generation=? AND lease_until>?`,
      [JSON.stringify(result), result.bytes, now, result.key, job.owner, result.generation, now])
      if (!cache.affectedRows) return false
      const [changed] = await c.query<ResultSetHeader>(`UPDATE parse_media_jobs SET state='ready',stage='ready',progress=100,
        cache_key=?,cache_hit=FALSE,owner=NULL,source_file_id=NULL,updated_at=? WHERE id=? AND owner=? AND generation=? AND lease_until>?`,
      [result.key, now, job.id, job.owner, job.generation, now])
      if (!changed.affectedRows) throw new MediaError('media_lease_lost', '媒体处理任务已由其他实例接管。')
      return true
    })
  }
  async finish(job: MediaJob, key: string): Promise<void> {
    await this.db.pool.query(`UPDATE parse_media_jobs SET state='ready',stage='ready',progress=100,
      cache_key=?,cache_hit=TRUE,owner=NULL,source_file_id=NULL
      WHERE id=? AND owner=? AND generation=? AND state='processing'
      AND lease_until>ROUND(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3))*1000)`,
    [key, job.id, job.owner, job.generation])
  }
  async release(job: MediaJob, code?: string): Promise<void> {
    await this.transaction(async (c, now) => {
      await c.query(`UPDATE parse_media_jobs SET state=?,stage=?,error_code=?,owner=NULL,lease_until=0,
        due_at=?,updated_at=?,source_file_id=IF(?,NULL,source_file_id),attempts=IF(?,attempts,GREATEST(0,attempts-1))
        WHERE id=? AND owner=? AND generation=? AND state='processing'`,
      [code ? 'failed' : 'queued', code ? 'failed' : 'queued', code ?? null, now + 1000, now,
        Boolean(code), Boolean(code), job.id, job.owner, job.generation])
      await c.query(`UPDATE parse_media_cache SET state='failed',owner=NULL,lease_until=0
        WHERE owner=? AND state='processing'`, [job.owner])
    })
  }
  async invalidate(result: MediaResult): Promise<void> {
    await this.db.pool.query(`UPDATE parse_media_cache SET state='failed' WHERE cache_key=? AND generation=? AND state='ready'`, [result.key, result.generation])
  }
  async generation(key: string): Promise<{ generation: number; state: string } | null> {
    const [rows] = await this.db.pool.query<RowDataPacket[]>('SELECT generation,state FROM parse_media_cache WHERE cache_key=?', [key])
    return rows[0] ? { generation: Number(rows[0].generation), state: rows[0].state } : null
  }
  async generations(): Promise<Map<string, number>> {
    const [rows] = await this.db.pool.query<RowDataPacket[]>('SELECT cache_key,generation FROM parse_media_cache')
    return new Map(rows.map((row) => [row.cache_key, Number(row.generation)]))
  }
  async protectedFiles(): Promise<string[]> {
    const [rows] = await this.db.pool.query<RowDataPacket[]>("SELECT DISTINCT file_id FROM parse_media_jobs WHERE state IN ('queued','processing')")
    return rows.map((row) => row.file_id)
  }
  async snapshot() {
    const [jobs] = await this.db.pool.query<RowDataPacket[]>(`SELECT state,COUNT(*) AS n FROM parse_media_jobs GROUP BY state`)
    const [cache] = await this.db.pool.query<RowDataPacket[]>(`SELECT COUNT(*) AS entries,COALESCE(SUM(bytes),0) AS bytes FROM parse_media_cache`)
    return { jobs: Object.fromEntries(jobs.map((row) => [row.state, Number(row.n)])),
      cacheEntries: Number(cache[0]!.entries), cacheBytes: Number(cache[0]!.bytes) }
  }
  /** Fenced eviction: claimers cannot rebuild the same key while files are removed. */
  async collect(ttlMs: number, maxBytes: number, reserveBytes: number,
    remove: (key: string) => Promise<void>, maxEntries = 10_000): Promise<void> {
    const keys = await this.transaction(async (c, now) => {
      await c.query("UPDATE parse_media_cache SET state='failed' WHERE state='processing' AND lease_until<?", [now])
      const [total] = await c.query<RowDataPacket[]>('SELECT COALESCE(SUM(bytes),0) AS n,COUNT(*) AS entries FROM parse_media_cache')
      let bytes = Number(total[0]!.n)
      let entries = Number(total[0]!.entries)
      const [rows] = await c.query<RowDataPacket[]>(`SELECT cache_key,bytes,updated_at,state FROM parse_media_cache
        WHERE state IN ('ready','failed','deleting') ORDER BY updated_at LIMIT 32 FOR UPDATE`)
      const selected: string[] = []
      for (const row of rows) {
        if (row.state !== 'ready' || Number(row.updated_at) < now - ttlMs || bytes + reserveBytes > maxBytes || entries >= maxEntries) {
          await c.query("UPDATE parse_media_cache SET state='deleting' WHERE cache_key=?", [row.cache_key])
          bytes -= Number(row.bytes); entries--; selected.push(row.cache_key)
        }
      }
      await c.query("DELETE FROM parse_media_jobs WHERE state IN ('ready','failed') AND updated_at<?", [now - ttlMs])
      return selected
    })
    for (const key of keys) {
      await remove(key)
      await this.db.pool.query("DELETE FROM parse_media_cache WHERE cache_key=? AND state='deleting'", [key])
    }
  }
}
