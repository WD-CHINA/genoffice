import { serverRoot } from './helpers/paths'
import { createBlankPptx } from '@genoffice/pptx-engine'
import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ArtifactSession } from '../src/artifact-session'
import { artifactKey } from '../src/artifact-store'
import { createParseServer, type ParseServer } from '../src/server'

const dirs: string[] = []
const servers: ParseServer[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close().catch(() => undefined)))
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function openFixture(
  dataDir: string,
  fixture: Uint8Array,
  format: 'pptx' | 'docx',
  canonicalArtifactExport: boolean,
) {
  const server = await createParseServer({
    dataDir,
    parserVersion: '0.1.0',
    parserFingerprint: 'canonical-layout-test',
    canonicalArtifactExport,
  })
  servers.push(server)
  const request = (path: string, init?: RequestInit) => fetch(server.url + path, init)
  const uploaded = await request('/v1/files', { method: 'POST', body: Buffer.from(fixture) })
  const { fileId } = (await uploaded.json()) as { fileId: string }
  const opened = await request('/v1/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileId }),
  })
  expect(opened.status, await opened.clone().text()).toBe(201)
  const key = artifactKey(
    ArtifactSession.identity({
      fileId,
      format,
      parserVersion: '0.1.0',
      parserFingerprint: 'canonical-layout-test',
    }),
  )
  const directory = join(dataDir, 'artifacts', key.slice(0, 2), key)
  return { server, directory }
}

it('opt-in canonical sidecars appear next to the packed generation', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'canonical-layout-'))
  dirs.push(dataDir)
  const { directory } = await openFixture(dataDir, await createBlankPptx(), 'pptx', true)
  const document = JSON.parse(await readFile(join(directory, 'document.json'), 'utf8')) as {
    model?: { unitCount?: number }
  }
  expect(document.model?.unitCount).toBe(1)
  expect(await readFile(join(directory, 'units', '0.json'), 'utf8')).toContain('"slide"')
  await access(join(directory, 'artifact-manifest.json'))
  await access(join(directory, 'units.bin'))
  // Fonts are materialized for a document that embeds them.
  const fontDir = await mkdtemp(join(tmpdir(), 'canonical-layout-font-'))
  dirs.push(fontDir)
  const fixture = await readFile(join(serverRoot, 'tests/fixtures/docx/font.docx'))
  const fontExport = await openFixture(fontDir, new Uint8Array(fixture), 'docx', true)
  expect(
    (await readdir(join(fontExport.directory, 'fonts'))).some((name) => name.endsWith('.sfnt')),
  ).toBe(true)
})

it('is off by default', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'canonical-layout-off-'))
  dirs.push(dataDir)
  const { directory } = await openFixture(dataDir, await createBlankPptx(), 'pptx', false)
  await expect(access(join(directory, 'document.json'))).rejects.toThrow()
})
