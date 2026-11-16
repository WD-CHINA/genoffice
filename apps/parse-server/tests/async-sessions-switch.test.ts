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

async function start(
  options: { asyncSessions?: boolean; asyncSessionsV2?: boolean } = {},
): Promise<ParseServer> {
  const dataDir = await mkdtemp(join(tmpdir(), 'async-switch-'))
  dirs.push(dataDir)
  const server = await createParseServer({ dataDir, ...options })
  servers.push(server)
  return server
}

it('disabling async mode falls back to synchronous creation like an older server', async () => {
  const server = await start({ asyncSessions: false })
  const capabilities = (await (await fetch(server.url + '/v1/capabilities')).json()) as {
    features: { asyncSessions: boolean }
  }
  expect(capabilities.features.asyncSessions).toBe(false)
  const uploaded = await fetch(server.url + '/v1/files', {
    method: 'POST',
    body: Buffer.from(await createBlankPptx()),
  })
  expect(uploaded.status).toBe(201)
  const { fileId } = (await uploaded.json()) as { fileId: string }
  const disabled = await fetch(server.url + '/v1/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Prefer: 'respond-async' },
    body: JSON.stringify({ fileId }),
  })
  expect(disabled.status).toBe(404)
  expect(await disabled.json()).toMatchObject({ code: 'not_found' })
  const missing = await fetch(server.url + '/v1/sessions/00000000-0000-4000-8000-000000000000')
  expect(missing.status).toBe(404)
  // v1 remains fully functional during the rollback window.
  const opened = await fetch(server.url + '/v1/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileId }),
  })
  expect(opened.status, await opened.clone().text()).toBe(201)
  const { sessionId } = (await opened.json()) as { sessionId: string }
  const unit = await fetch(server.url + `/v1/sessions/${sessionId}/units/0`)
  expect(unit.status).toBe(200)
  const deleted = await fetch(server.url + `/v1/sessions/${sessionId}`, { method: 'DELETE' })
  expect(deleted.status).toBe(204)
})

it('keeps async mode enabled by default and rejects a non-boolean switch value', async () => {
  const server = await start()
  const capabilities = (await (await fetch(server.url + '/v1/capabilities')).json()) as {
    features: { asyncSessions: boolean }
  }
  expect(capabilities.features.asyncSessions).toBe(true)
  expect(() =>
    validateRuntimeOptions({
      dataDir: '/unused',
      asyncSessions: 'yes' as unknown as boolean,
    }),
  ).toThrow(/asyncSessions/)
})

it('normalizes deprecated programmatic switches before validation and preserves rollback', async () => {
  const server = await start({ asyncSessionsV2: false })
  const caps = (await (await fetch(server.url + '/v1/capabilities')).json()) as {
    features: { asyncSessions: boolean }
  }
  expect(caps.features.asyncSessions).toBe(false)
  for (const path of ['/v1/sessions', '/v2/sessions']) {
    const response = await fetch(server.url + path, {
      method: 'POST',
      headers: { Prefer: 'respond-async' },
      body: '{}',
    })
    expect(response.status).toBe(404)
  }
  await expect(
    createParseServer({ dataDir: '/unused', asyncSessions: true, asyncSessionsV2: false }),
  ).rejects.toThrow(/conflicting/)
})
