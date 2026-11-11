import { createBlankPptx } from '@genoffice/pptx-engine'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createParseServer, type ParseServer } from '../src/server'

const dirs: string[] = []
const servers: ParseServer[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close().catch(() => undefined)))
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

it('mints fresh signed part URLs for authenticated viewers', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'part-url-'))
  dirs.push(dataDir)
  const server = await createParseServer({ dataDir, token: 'secret' })
  servers.push(server)
  const request = (path: string, init?: RequestInit) => fetch(server.url + path, init)
  const uploaded = await request('/v1/files', {
    method: 'POST', headers: { Authorization: 'Bearer secret' },
    body: Buffer.from(await createBlankPptx()),
  })
  const { fileId } = await uploaded.json() as { fileId: string }
  const refreshed = await request(`/v1/files/${fileId}/part-url`, {
    method: 'POST',
    headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'ppt/presentation.xml' }),
  })
  expect(refreshed.status).toBe(200)
  const { url } = await refreshed.json() as { url: string }
  expect(url).toContain('/parts/ppt/presentation.xml?exp=')
  expect((await request(new URL(url).pathname + new URL(url).search)).status).toBe(200)
  // Auth is still required and traversal is rejected.
  expect((await request(`/v1/files/${fileId}/part-url`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'ppt/presentation.xml' }),
  })).status).toBe(401)
  expect((await request(`/v1/files/${fileId}/part-url`, {
    method: 'POST',
    headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: '../etc/passwd' }),
  })).status).toBe(400)
})
