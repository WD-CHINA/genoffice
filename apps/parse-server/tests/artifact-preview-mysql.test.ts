import { drainCleanups } from './helpers/cleanup'
import { createBlankPptx } from '@genoffice/pptx-engine'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import mysql, { type Connection, type RowDataPacket } from 'mysql2/promise'
import JSZip from 'jszip'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createParseServer, type ParseServer, type ParseServerOptions } from '../src/server'
import { ArtifactWriter, type JsonValue } from '../src/artifact-store'

// Explicit opt-in socket must refer to an isolated test instance, never production.
const socketPath = process.env.PARSE_TEST_MYSQL_SOCKET
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  await drainCleanups(cleanups)
})

interface ArtifactRow extends RowDataPacket {
  artifact_key: string
  state: string
  generation: number
  ready_generation: number | null
  unit_count: number | null
}
interface JobRow extends RowDataPacket {
  job_id: string
  state: string
  progress: number
}

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function multiSlidePptx(count: number): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(await createBlankPptx())
  const presentation = await zip.file('ppt/presentation.xml')!.async('string')
  const rels = await zip.file('ppt/_rels/presentation.xml.rels')!.async('string')
  const types = await zip.file('[Content_Types].xml')!.async('string')
  const slide = await zip.file('ppt/slides/slide1.xml')!.async('string')
  const slideRels = await zip.file('ppt/slides/_rels/slide1.xml.rels')!.async('string')
  let ids = ''
  let relationships = ''
  let overrides = ''
  for (let index = 2; index <= count; index++) {
    ids += `<p:sldId id="${255 + index}" r:id="rId${index + 1}"/>`
    relationships += `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index}.xml"/>`
    overrides += `<Override PartName="/ppt/slides/slide${index}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`
    zip.file(`ppt/slides/slide${index}.xml`, slide)
    zip.file(`ppt/slides/_rels/slide${index}.xml.rels`, slideRels)
  }
  zip.file('ppt/presentation.xml', presentation.replace('</p:sldIdLst>', `${ids}</p:sldIdLst>`))
  zip.file(
    'ppt/_rels/presentation.xml.rels',
    rels.replace('</Relationships>', `${relationships}</Relationships>`),
  )
  zip.file('[Content_Types].xml', types.replace('</Types>', `${overrides}</Types>`))
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}

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

describe.skipIf(!socketPath)('incremental preview with the real MySQL catalog', () => {
  async function setup(options: Partial<ParseServerOptions> = {}) {
    const database = `genoffice_preview_${randomUUID().replaceAll('-', '')}`
    const admin: Connection = await mysql.createConnection({ socketPath, user: 'root' })
    await admin.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4`)
    const dataDir = await mkdtemp(join(tmpdir(), 'preview-mysql-'))
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
      parserFingerprint: 'preview-mysql-test',
      ...options,
    })
    servers.push(server)
    const request = (path: string, init?: RequestInit) =>
      fetch(server.url + path, {
        ...init,
        headers: { Authorization: 'Bearer secret', ...init?.headers },
      })
    const uploaded = await request('/v1/files', {
      method: 'POST',
      body: Buffer.from(await multiSlidePptx(3)),
    })
    expect(uploaded.status, await uploaded.clone().text()).toBe(201)
    const { fileId } = (await uploaded.json()) as { fileId: string }
    const open = () =>
      request('/v1/sessions', {
        method: 'POST',
        headers: { ...{ 'Content-Type': 'application/json' }, Prefer: 'respond-async' },
        body: JSON.stringify({ fileId }),
      })
    const ready = async (id: string) => {
      const deadline = Date.now() + 15_000
      while (Date.now() < deadline) {
        const status = (await (await request(`/v1/sessions/${id}`)).json()) as {
          state: string
          error?: unknown
        }
        if (status.state === 'ready') return status
        expect(status.state, JSON.stringify(status.error)).not.toBe('failed')
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      throw new Error('catalog session did not become ready')
    }
    return { server, dataDir, request, pool: server.db!.pool, fileId, open, ready }
  }

  it('exposes committed units but never completes the SQL job or ready pointer', async () => {
    const harness = await setup()
    const paused = pauseAfterFirstUnit()
    const created = await harness.open()
    expect(created.status).toBe(202)
    const opening = (await created.json()) as { sessionId: string; artifactKey: string }
    try {
      await paused.entered.promise
      const status = (await (
        await harness.request(`/v1/sessions/${opening.sessionId}`)
      ).json()) as Record<string, unknown>
      expect(status).toMatchObject({
        state: 'building',
        previewable: true,
        complete: false,
        availableUnits: { from: 0, to: 1 },
      })
      expect(
        (await harness.request(`/v1/sessions/${opening.sessionId}/units/0?representation=model`))
          .status,
      ).toBe(200)
      expect(
        (await harness.request(`/v1/sessions/${opening.sessionId}/units/1?representation=model`))
          .status,
      ).toBe(202)

      const [artifacts] = await harness.pool.query<ArtifactRow[]>(
        'SELECT * FROM parse_artifacts WHERE artifact_key = ?',
        [opening.artifactKey],
      )
      expect(artifacts).toHaveLength(1)
      expect(artifacts[0].state).not.toBe('ready')
      expect(artifacts[0].ready_generation).toBeNull()
      const [jobs] = await harness.pool.query<JobRow[]>(
        'SELECT job_id, state, progress FROM parse_jobs WHERE artifact_key = ?',
        [opening.artifactKey],
      )
      expect(jobs).toHaveLength(1)
      expect(jobs[0].state).toBe('building')
      // A preview must never masquerade as SQL build progress/completion.
      expect(Number(jobs[0].progress)).toBe(0)
    } finally {
      paused.blocked.resolve()
    }
    await harness.ready(opening.sessionId)
    const [after] = await harness.pool.query<ArtifactRow[]>(
      'SELECT * FROM parse_artifacts WHERE artifact_key = ?',
      [opening.artifactKey],
    )
    expect(Number(after[0].ready_generation)).toBe(1)
    expect(after[0].state).toBe('ready')
    expect(Number(after[0].unit_count)).toBe(3)
    expect(
      (await harness.request(`/v1/sessions/${opening.sessionId}/units/2?representation=model`))
        .status,
    ).toBe(200)
  })

  it('a failed catalog build leaves no ready generation, no preview and no partial unit', async () => {
    const harness = await setup()
    const original = ArtifactWriter.prototype.append
    vi.spyOn(ArtifactWriter.prototype, 'append').mockImplementation(async function (
      this: ArtifactWriter,
      id: string,
      value: JsonValue | Uint8Array,
    ) {
      if (id === 'unit:1') throw new Error('injected catalog build failure')
      return original.call(this, id, value)
    })
    const created = await harness.open()
    const opening = (await created.json()) as { sessionId: string; artifactKey: string }
    const deadline = Date.now() + 15_000
    let status: Record<string, unknown> = {}
    while (Date.now() < deadline) {
      status = (await (
        await harness.request(`/v1/sessions/${opening.sessionId}`)
      ).json()) as Record<string, unknown>
      if (status.state === 'failed') break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(status.state).toBe('failed')
    expect(status.previewable).toBeUndefined()
    expect(
      (await harness.request(`/v1/sessions/${opening.sessionId}/units/0?representation=model`))
        .status,
    ).toBe(409)
    const [artifacts] = await harness.pool.query<ArtifactRow[]>(
      'SELECT * FROM parse_artifacts WHERE artifact_key = ?',
      [opening.artifactKey],
    )
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0].ready_generation).toBeNull()
    expect(artifacts[0].state).not.toBe('ready')
  })
})
