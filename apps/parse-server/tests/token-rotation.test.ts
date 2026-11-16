import { createBlankPptx } from '@genoffice/pptx-engine'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { validateRuntimeOptions } from '../src/runtime-options'
import { createParseServer, type ParseServer } from '../src/server'

const dirs: string[] = []
const servers: ParseServer[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close().catch(() => undefined)))
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

it('accepts the previous bearer token only during an explicit rotation window', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'token-rotation-'))
  dirs.push(dataDir)
  const server = await createParseServer({
    dataDir,
    token: 'new-secret',
    previousToken: 'old-secret',
  })
  servers.push(server)
  const request = (path: string, init?: RequestInit) => fetch(server.url + path, init)
  const uploaded = await request('/v1/files', {
    method: 'POST',
    headers: { Authorization: 'Bearer old-secret' },
    body: Buffer.from(await createBlankPptx()),
  })
  expect(uploaded.status, await uploaded.clone().text()).toBe(201)
  const { fileId } = (await uploaded.json()) as { fileId: string }
  const opened = await request('/v1/sessions', {
    method: 'POST',
    headers: { Authorization: 'Bearer old-secret', 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileId }),
  })
  expect(opened.status, await opened.clone().text()).toBe(201)
  const { sessionId } = (await opened.json()) as { sessionId: string }
  expect(
    (
      await request(`/v1/sessions/${sessionId}/units/0`, {
        headers: { Authorization: 'Bearer old-secret' },
      })
    ).status,
  ).toBe(200)
  expect(
    (
      await request('/v1/sessions', {
        method: 'POST',
        headers: { Authorization: 'Bearer wrong', 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileId }),
      })
    ).status,
  ).toBe(401)
  // Rotated-token clients can still mint fresh signed content URLs.
  const refreshed = await request(`/v1/files/${fileId}/content-url`, {
    headers: { Authorization: 'Bearer old-secret' },
  })
  expect(refreshed.status).toBe(200)
  const { url } = (await refreshed.json()) as { url: string }
  expect((await request(new URL(url).pathname + new URL(url).search)).status).toBe(200)

  expect((await request('/v1/capabilities')).status).toBe(200)
  expect(() =>
    validateRuntimeOptions({
      dataDir: '/unused',
      token: 'same',
      previousToken: 'same',
    }),
  ).toThrow(/previousToken/)
  expect(() =>
    validateRuntimeOptions({
      dataDir: '/unused',
      previousToken: 'old',
    }),
  ).toThrow(/previousToken/)
})
