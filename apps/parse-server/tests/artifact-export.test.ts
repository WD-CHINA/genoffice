import { createBlankPptx } from '@genoffice/pptx-engine'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ArtifactStore, artifactKey } from '../src/artifact-store'
import { ArtifactSession } from '../src/artifact-session'
import { exportArtifactDirectory } from '../src/artifact-export'
import { createParseServer, type ParseServer } from '../src/server'

const dirs: string[] = []
const servers: ParseServer[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close().catch(() => undefined)))
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function build(dataDir: string, fixture: Uint8Array, format: 'pptx' | 'docx') {
  const server = await createParseServer({
    dataDir, parserVersion: '0.1.0', parserFingerprint: 'artifact-export-test', maxParseJobs: 1,
  })
  servers.push(server)
  const request = (path: string, init?: RequestInit) => fetch(server.url + path, init)
  const uploaded = await request('/v1/files', { method: 'POST', body: Buffer.from(fixture) })
  const { fileId } = await uploaded.json() as { fileId: string }
  const opened = await request('/v1/sessions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileId }),
  })
  expect(opened.status, await opened.clone().text()).toBe(201)
  const key = artifactKey(ArtifactSession.identity({
    fileId, format, parserVersion: '0.1.0', parserFingerprint: 'artifact-export-test',
  }))
  return { server, fileId, key }
}

it('materializes a packed generation into document.json/units/fonts', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'artifact-export-'))
  dirs.push(dataDir)
  const { key } = await build(dataDir, await createBlankPptx(), 'pptx')
  const out = join(dataDir, 'exported')
  const reader = await new ArtifactStore(dataDir).find(key)
  expect(reader).not.toBeNull()
  let reserved = 0
  const result = await exportArtifactDirectory(reader!, out, {
    reserve: async (bytes) => { reserved += bytes },
  })
  expect(result.units).toBe(1)
  expect(result.totalBytes).toBeGreaterThan(0)
  expect(reserved).toBe(result.totalBytes)
  const document = JSON.parse(await readFile(join(out, 'document.json'), 'utf8')) as {
    model?: { format?: string; unitCount?: number }
  }
  expect(document.model).toMatchObject({ format: 'pptx', unitCount: 1 })
  expect(await readFile(join(out, 'units', '0.json'), 'utf8')).toContain('"slide"')
  expect(await readFile(join(out, 'artifact-manifest.json'), 'utf8')).toContain(key)
  expect(await readdir(join(out, 'fonts'))).toEqual([])
})

it('exports embedded DOCX font bytes into the fonts directory', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'artifact-export-font-'))
  dirs.push(dataDir)
  const fixture = await readFile(join(process.cwd(), 'tests/fixtures/docx/font.docx'))
  const { key } = await build(dataDir, new Uint8Array(fixture), 'docx')
  const out = join(dataDir, 'exported')
  const reader = await new ArtifactStore(dataDir).find(key)
  expect(reader).not.toBeNull()
  const result = await exportArtifactDirectory(reader!, out)
  expect(result.fonts).toBeGreaterThan(0)
  const fonts = await readdir(join(out, 'fonts'))
  expect(fonts.some((name) => name.endsWith('.sfnt'))).toBe(true)
})
