import { drainCleanups } from './helpers/cleanup'
import { randomUUID } from 'node:crypto'
import { mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import mysql, { type Connection, type RowDataPacket } from 'mysql2/promise'
import { afterEach, describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { createBlankPptx } from '@genoffice/pptx-engine'
import type { OfflineBundleManifest } from '@genoffice/parse-contract'
import { createParseServer, type ParseServer } from '../src/server'
import { MODEL_SCHEMA_VERSION } from '../src/artifact-session'
import {
  ArtifactReader,
  ArtifactStore,
  artifactKey,
  type ArtifactIdentity,
} from '../src/artifact-store'
import { writeOfflineBundle } from '../src/offline-bundle'
import { DEFAULT_LIMITS } from '../src/limits'

// Explicit opt-in socket must refer to an isolated test instance, never a production server.
const socketPath = process.env.PARSE_TEST_MYSQL_SOCKET
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  await drainCleanups(cleanups)
})

interface ArtifactRow extends RowDataPacket {
  artifact_key: string
  identity: string | Record<string, unknown>
  storage_path: string
  ready_generation: number | null
}

function options(row: ArtifactRow): Record<string, unknown> {
  const identity = typeof row.identity === 'string' ? JSON.parse(row.identity) : row.identity
  return (identity?.options ?? {}) as Record<string, unknown>
}

describe.skipIf(!socketPath)('catalog-backed offline bundle over HTTP', () => {
  async function setup() {
    const database = `genoffice_bundle_${randomUUID().replaceAll('-', '')}`
    const admin: Connection = await mysql.createConnection({ socketPath, user: 'root' })
    await admin.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4`)
    const dataDir = await mkdtemp(join(tmpdir(), 'bundle-mysql-'))
    const config = {
      host: '127.0.0.1',
      port: 3306,
      user: 'root',
      password: '',
      database,
      socketPath,
    }
    const servers: ParseServer[] = []
    cleanups.push(async () => {
      await Promise.all(servers.map((server) => server.close().catch(() => undefined)))
      await admin.query(`DROP DATABASE ${database}`).catch(() => undefined)
      await admin.end()
      await rm(dataDir, { recursive: true, force: true })
    })
    const server = await createParseServer({
      dataDir,
      mysql: config,
      artifactBackend: 'catalog',
      token: 'secret',
      parserFingerprint: 'bundle-catalog-test',
    })
    servers.push(server)
    const request = (path: string, init?: RequestInit) =>
      fetch(server.url + path, {
        ...init,
        headers: { Authorization: 'Bearer secret', ...init?.headers },
      })
    const uploaded = await request('/v1/files', {
      method: 'POST',
      body: Buffer.from(await createBlankPptx()),
    })
    expect(uploaded.status).toBe(201)
    const { fileId } = (await uploaded.json()) as { fileId: string }
    const opened = await request('/v1/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId }),
    })
    expect(opened.status, await opened.clone().text()).toBe(201)
    const { sessionId } = (await opened.json()) as { sessionId: string }
    const rows = async (): Promise<ArtifactRow[]> => {
      const [result] = await server.db!.pool.query<ArtifactRow[]>(
        'SELECT artifact_key, identity, storage_path, ready_generation FROM parse_artifacts WHERE file_id = ?',
        [fileId],
      )
      return result
    }
    return { server, dataDir, config, request, fileId, sessionId, rows }
  }

  it('serves a bundle from its own SQL generation and pins it independently', async () => {
    const h = await setup()
    const response = await h.request(`/v2/sessions/${h.sessionId}/bundle`)
    expect(response.status, await response.clone().text()).toBe(200)
    const manifest = (await response.json()) as OfflineBundleManifest

    const rows = await h.rows()
    expect(rows).toHaveLength(2)
    const bundle = rows.find((row) => options(row).purpose === 'offline-bundle')!
    const model = rows.find((row) => row.artifact_key !== bundle.artifact_key)!
    expect(bundle.artifact_key).toBe(manifest.artifactKey)
    expect(Number(bundle.ready_generation)).toBe(1)
    expect(bundle.storage_path).toMatch(/\/g-1$/)
    expect(Number(model.ready_generation)).toBe(1)
    expect(await stat(join(h.dataDir, bundle.storage_path, 'manifest.json'))).toBeDefined()

    const layout = manifest.resources.find((resource) => resource.path === 'layout.json')!
    const resource = await h.request(`/v2/sessions/${h.sessionId}/bundle/resources/layout.json`)
    expect(resource.status).toBe(200)
    expect(resource.headers.get('etag')).toBe(`"${layout.sha256}"`)
    const [leases] = await h.server.db!.pool.query<RowDataPacket[]>(
      `SELECT artifact_key, COUNT(*) AS n FROM parse_artifact_read_leases
       WHERE artifact_key IN (?, ?) GROUP BY artifact_key`,
      [bundle.artifact_key, model.artifact_key],
    )
    expect(leases).toHaveLength(2)
    expect(leases.every((row) => Number(row.n) >= 1)).toBe(true)
    // Dependency graph (plan §5): both ready artifacts depend on the source
    // file, and the derived bundle additionally depends on the model generation.
    const [deps] = await h.server.db!.pool.query<RowDataPacket[]>(
      `SELECT artifact_key, dependency_type, dependency_id FROM parse_artifact_dependencies
       WHERE artifact_key IN (?, ?)`,
      [bundle.artifact_key, model.artifact_key],
    )
    const fileDeps = deps.filter((row) => row.dependency_type === 'file')
    expect(fileDeps).toHaveLength(2)
    expect(fileDeps.every((row) => row.dependency_id === h.fileId)).toBe(true)
    expect(
      deps.some(
        (row) =>
          row.artifact_key === bundle.artifact_key &&
          row.dependency_type === 'artifact' &&
          row.dependency_id === model.artifact_key,
      ),
    ).toBe(true)
  }, 20_000)

  it('rebuilds only a damaged bundle generation through the HTTP route', async () => {
    const h = await setup()
    const first = await h.request(`/v2/sessions/${h.sessionId}/bundle`)
    expect(first.status).toBe(200)
    const manifest = (await first.json()) as OfflineBundleManifest
    const broken = (await h.rows()).find((row) => options(row).purpose === 'offline-bundle')!
    const oldPath = join(h.dataDir, broken.storage_path)
    const index = JSON.parse(await readFile(join(oldPath, 'manifest.json'), 'utf8')) as {
      records: Array<{ id: string; offset: number; length: number }>
    }
    const entry = index.records.find((record) => record.id === 'bundle')!
    const position = entry.offset + Math.floor(entry.length / 2)
    const file = await open(join(oldPath, 'units.bin'), 'r+')
    try {
      const byte = Buffer.alloc(1)
      await file.read(byte, 0, 1, position)
      byte[0] ^= 0xff
      await file.write(byte, 0, 1, position)
    } finally {
      await file.close()
    }

    const repaired = await h.request(`/v2/sessions/${h.sessionId}/bundle`)
    expect(repaired.status, await repaired.clone().text()).toBe(200)
    expect(((await repaired.json()) as OfflineBundleManifest).artifactKey).toBe(
      manifest.artifactKey,
    )
    const rows = await h.rows()
    const bundle = rows.find((row) => options(row).purpose === 'offline-bundle')!
    const model = rows.find((row) => row.artifact_key !== bundle.artifact_key)!
    expect(Number(bundle.ready_generation)).toBe(2)
    expect(bundle.storage_path).toMatch(/\/g-2$/)
    expect(Number(model.ready_generation)).toBe(1)
    // Immutable old generations are left for the retirement/sweeper path.
    await expect(stat(join(oldPath, 'manifest.json'))).resolves.toBeDefined()
    const resource = await h.request(`/v2/sessions/${h.sessionId}/bundle/resources/layout.json`)
    expect(resource.status).toBe(200)
    const health = (await (await h.request('/v1/health')).json()) as { errors: number }
    expect(health.errors).toBe(0)
  }, 20_000)

  it('reuses the repaired bundle generation after the server restarts', async () => {
    const h = await setup()
    expect((await h.request(`/v2/sessions/${h.sessionId}/bundle`)).status).toBe(200)
    const generation = Number(
      (await h.rows()).find((row) => options(row).purpose === 'offline-bundle')!.ready_generation,
    )
    await h.server.close()
    // A fresh server with the same dataDir/database must attach to the ready generation.
    const restarted = await createParseServer({
      dataDir: h.dataDir,
      mysql: h.config,
      artifactBackend: 'catalog',
      token: 'secret',
      parserFingerprint: 'bundle-catalog-test',
    })
    cleanups.push(async () => {
      await restarted.close().catch(() => undefined)
    })
    const response = await fetch(restarted.url + `/v2/sessions/${h.sessionId}/bundle`, {
      headers: { Authorization: 'Bearer secret' },
    })
    expect(response.status, await response.clone().text()).toBe(200)
    const [rows] = await restarted.db!.pool.query<ArtifactRow[]>(
      'SELECT artifact_key, identity, storage_path, ready_generation FROM parse_artifacts WHERE file_id = ?',
      [h.fileId],
    )
    expect(
      Number(rows.find((row) => options(row).purpose === 'offline-bundle')!.ready_generation),
    ).toBe(generation)
  }, 20_000)

  it('imports a pre-generation flat offline bundle as SQL generation 1', async () => {
    const h = await setup()
    // Only the model generation exists; the derived bundle has not been requested yet.
    const before = await h.rows()
    expect(before).toHaveLength(1)
    const model = before[0]
    expect(Number(model.ready_generation)).toBe(1)

    const modelReader = await ArtifactReader.openDirectory(
      join(h.dataDir, model.storage_path),
      model.artifact_key,
    )
    const modelIdentity = (
      typeof model.identity === 'string' ? JSON.parse(model.identity) : model.identity
    ) as ArtifactIdentity
    const document = (await modelReader.read('document')) as unknown as {
      layout: Parameters<typeof writeOfflineBundle>[2]
    }
    const external = (await modelReader.read('external-media')) as string[]
    const bundleIdentity: ArtifactIdentity = {
      ...modelIdentity,
      options: {
        purpose: 'offline-bundle',
        modelArtifactKey: model.artifact_key,
        modelContentDigest: modelReader.contentDigest,
      },
    }
    const bundleKey = artifactKey(bundleIdentity)

    // Seed a genuinely historical flat bundle written by the real writer.
    const legacySource = join(h.dataDir, 'legacy-source.pptx')
    const zip = await JSZip.loadAsync(await createBlankPptx())
    zip.file('ppt/media/legacy.bin', Buffer.from('legacy media'), { compression: 'STORE' })
    await writeFile(legacySource, await zip.generateAsync({ type: 'nodebuffer' }))
    const legacyStore = new ArtifactStore(h.dataDir)
    await legacyStore.getOrBuild(bundleIdentity, (writer) =>
      writeOfflineBundle(
        writer,
        {
          path: legacySource,
          fileId: h.fileId,
          artifactKey: bundleKey,
          modelArtifactKey: model.artifact_key,
          modelSchemaVersion: MODEL_SCHEMA_VERSION,
          parserVersion: document.layout.parserVersion,
          parserFingerprint: 'bundle-catalog-test',
          limits: DEFAULT_LIMITS,
        },
        document.layout,
        new Set(external),
        (id) => modelReader.describe(id),
      ),
    )

    const response = await h.request(`/v2/sessions/${h.sessionId}/bundle`)
    expect(response.status, await response.clone().text()).toBe(200)
    const manifest = (await response.json()) as OfflineBundleManifest
    expect(manifest.artifactKey).toBe(bundleKey)
    expect(manifest.resources.map((resource) => resource.path)).toContain(
      'parts/ppt/media/legacy.bin',
    )

    const rows = await h.rows()
    expect(rows).toHaveLength(2)
    const bundle = rows.find((row) => options(row).purpose === 'offline-bundle')!
    expect(bundle.artifact_key).toBe(bundleKey)
    expect(Number(bundle.ready_generation)).toBe(1)
    expect(bundle.storage_path).toMatch(/\/g-1$/)

    const health = (await (await h.request('/v1/health')).json()) as {
      errors: number
      artifacts: { legacyBundleImports: number }
    }
    expect(health.artifacts.legacyBundleImports).toBe(1)
    expect(health.errors).toBe(0)

    const layout = manifest.resources.find((resource) => resource.path === 'layout.json')!
    const layoutResponse = await h.request(
      `/v2/sessions/${h.sessionId}/bundle/resources/layout.json`,
    )
    expect(layoutResponse.status).toBe(200)
    // The imported frame keeps the exact hash declared by the authoritative inventory.
    expect(layoutResponse.headers.get('etag')).toBe(`"${layout.sha256}"`)

    // The import does not delete the old flat files; retirement/GC owns them.
    await expect(
      stat(join(h.dataDir, 'artifacts', bundleKey.slice(0, 2), bundleKey, 'manifest.json')),
    ).resolves.toBeDefined()
  }, 20_000)
})
