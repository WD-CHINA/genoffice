import { PARSE_DTO_VERSION } from '@genoffice/parse-contract'
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

it('marks v2 DTO envelopes/headers with an independent version', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dto-version-'))
  dirs.push(dataDir)
  const server = await createParseServer({ dataDir })
  servers.push(server)
  const request = (path: string, init?: RequestInit) => fetch(server.url + path, init)
  const capabilities = await request('/v2/capabilities')
  expect(capabilities.headers.get('x-genoffice-dto-version')).toBe(String(PARSE_DTO_VERSION))
  expect((await capabilities.json() as { dtoVersion: number }).dtoVersion)
    .toBe(PARSE_DTO_VERSION)

  const uploaded = await request('/v1/files', {
    method: 'POST', body: Buffer.from(await createBlankPptx()),
  })
  const { fileId } = await uploaded.json() as { fileId: string }
  const opened = await request('/v2/sessions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileId }),
  })
  expect(opened.headers.get('x-genoffice-dto-version')).toBe(String(PARSE_DTO_VERSION))
  const created = await opened.json() as { sessionId: string; dtoVersion: number }
  expect(created.dtoVersion).toBe(PARSE_DTO_VERSION)
  const status = await request(`/v2/sessions/${created.sessionId}`)
  expect((await status.json() as { dtoVersion: number }).dtoVersion).toBe(PARSE_DTO_VERSION)

  const deadline = Date.now() + 20_000
  for (;;) {
    const body = await (await request(`/v2/sessions/${created.sessionId}`)).json() as {
      state: string; dtoVersion: number
    }
    if (body.state === 'ready') {
      expect(body.dtoVersion).toBe(PARSE_DTO_VERSION)
      break
    }
    if (body.state === 'failed') throw new Error('session failed')
    if (Date.now() > deadline) throw new Error('session did not become ready')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  const document = await request(`/v2/sessions/${created.sessionId}/document`)
  expect(document.headers.get('x-genoffice-dto-version')).toBe(String(PARSE_DTO_VERSION))
  expect((await document.json() as { dtoVersion: number }).dtoVersion).toBe(PARSE_DTO_VERSION)

  // v1 keeps its envelope: no dtoVersion field and no v2 header.
  const v1 = await request('/v1/sessions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileId }),
  })
  expect(v1.headers.get('x-genoffice-dto-version')).toBeNull()
  expect((await v1.json() as { dtoVersion?: number }).dtoVersion).toBeUndefined()
})
