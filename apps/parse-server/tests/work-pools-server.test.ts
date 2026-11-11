import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createBlankPptx } from '@genoffice/pptx-engine'
import { createParseServer, type ParseServer, type ParseServerOptions } from '../src/server'

const directories: string[] = []
const servers: ParseServer[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close().catch(() => undefined)))
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function createDataDir(): Promise<string> {
  const dataDir = await mkdtemp(join(tmpdir(), 'parse-pools-'))
  directories.push(dataDir)
  return dataDir
}

async function setup(options: Partial<ParseServerOptions> = {}) {
  const dataDir = await createDataDir()
  const server = await createParseServer({ dataDir, token: 'secret', ...options })
  servers.push(server)
  const request = (path: string, init?: RequestInit) =>
    fetch(server.url + path, {
      ...init,
      headers: { Authorization: 'Bearer secret', ...init?.headers },
    })
  return { server, request }
}

it('serves parallel reads through a one-slot disk/inflate pool and reports occupancy', async () => {
  const { request } = await setup({ diskIoConcurrency: 1, inflateConcurrency: 1 })
  const uploaded = await request('/v1/files', {
    method: 'POST', body: Buffer.from(await createBlankPptx()),
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
  const reads = await Promise.all(Array.from({ length: 4 }, () =>
    request(`/v1/sessions/${sessionId}/layout/slides/0`)))
  for (const read of reads) {
    expect(read.status, await read.clone().text()).toBe(200)
    await read.json()
  }
  const health = (await (await request('/v1/health')).json()) as any
  expect(health.pools.disk.limit).toBe(1)
  expect(health.pools.inflate.limit).toBe(1)
  expect(health.pools.disk.peak).toBeLessThanOrEqual(1)
  expect(health.pools.inflate.peak).toBeLessThanOrEqual(1)
  expect(health.pools.disk.peak).toBeGreaterThanOrEqual(1)
  const metrics = await (await request('/metrics')).text()
  expect(metrics).toContain('genoffice_parse_work_pool_limit{pool="disk"} 1')
  expect(metrics).toContain('genoffice_parse_work_pool_limit{pool="inflate"} 1')
})

it('rejects invalid pool limits before listening', async () => {
  const dataDir = await createDataDir()
  await expect(createParseServer({ dataDir, diskIoConcurrency: 0 })).rejects.toThrow(
    'invalid diskIoConcurrency',
  )
  await expect(createParseServer({ dataDir, inflateConcurrency: 0 })).rejects.toThrow(
    'invalid inflateConcurrency',
  )
})
