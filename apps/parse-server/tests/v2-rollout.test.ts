import { createBlankPptx } from '@genoffice/pptx-engine'
import { createHash } from 'node:crypto'
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
  v2RolloutPercent?: number,
  v2RolloutHeader?: string,
  v2RolloutRampPerHour?: number,
): Promise<ParseServer> {
  const dataDir = await mkdtemp(join(tmpdir(), 'v2-rollout-'))
  dirs.push(dataDir)
  const server = await createParseServer({
    dataDir,
    ...(v2RolloutPercent !== undefined ? { v2RolloutPercent } : {}),
    ...(v2RolloutHeader ? { v2RolloutHeader } : {}),
    ...(v2RolloutRampPerHour !== undefined ? { v2RolloutRampPerHour } : {}),
  })
  servers.push(server)
  return server
}
const fakeFileId = (seed: number): string =>
  createHash('sha256').update(String(seed)).digest('hex')
function bucket(fileId: string): number {
  return Number.parseInt(fileId.slice(0, 4), 16) % 100
}
async function create(server: ParseServer, fileId: string): Promise<{
  status: number
  body: { code?: string; message?: string }
}> {
  const response = await fetch(server.url + '/v2/sessions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileId }),
  })
  return {
    status: response.status,
    body: await response.json() as { code?: string; message?: string },
  }
}

it('rolls the v2 contract out deterministically per file and can be disabled entirely', async () => {
  const off = await start(0)
  for (let seed = 0; seed < 5; seed++) {
    const result = await create(off, fakeFileId(seed))
    expect(result.status).toBe(404)
    expect(result.body.code).toBe('not_found')
  }
  const half = await start(50)
  const messages = new Set<string>()
  for (let seed = 0; seed < 40; seed++) {
    const fileId = fakeFileId(seed)
    const result = await create(half, fileId)
    expect(result.status).toBe(404)
    expect(result.body.code).toBe('not_found')
    // Accepted files reach the missing-content check; rolled-out files do not.
    const expected = bucket(fileId) < 50
      ? 'file content is missing'
      : 'v2 sessions are not enabled for this file'
    expect(result.body.message, fileId).toBe(expected)
    messages.add(expected)
  }
  expect(messages.size).toBe(2)

  const all = await start(100)
  const uploaded = await fetch(all.url + '/v1/files', {
    method: 'POST', body: Buffer.from(await createBlankPptx()),
  })
  const { fileId } = await uploaded.json() as { fileId: string }
  const opened = await create(all, fileId)
  expect([201, 202]).toContain(opened.status)
})

it('rejects out-of-range rollout values before startup', () => {
  for (const value of [-1, 101, 1.5, Number.NaN]) {
    expect(() => validateRuntimeOptions({
      dataDir: '/unused', v2RolloutPercent: value,
    })).toThrow(/v2RolloutPercent/)
  }
})

it('buckets by a configured tenant header while keeping file fallback', async () => {
  const server = await start(50, 'x-tenant-id')
  const fileId = fakeFileId(999)
  const createAs = async (tenant: string) => {
    const response = await fetch(server.url + '/v2/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-tenant-id': tenant },
      body: JSON.stringify({ fileId }),
    })
    return { status: response.status, body: await response.json() as { message?: string } }
  }
  const outcomes = new Set<string>()
  for (let index = 0; index < 60; index++) {
    const tenant = `tenant-${index}`
    const first = await createAs(tenant)
    const second = await createAs(tenant)
    expect(second.status).toBe(first.status)
    expect(second.body.message).toBe(first.body.message)
    outcomes.add(String(first.body.message))
  }
  expect(outcomes.size).toBe(2)
  // Without the header the file bucket decides, just like the file canary.
  const withoutHeader = await create(server, fileId)
  expect(withoutHeader.body.message).toBe(bucket(fileId) < 50
    ? 'file content is missing'
    : 'v2 sessions are not enabled for this file')
  // Header name is validated before startup.
  expect(() => validateRuntimeOptions({
    dataDir: '/unused', v2RolloutHeader: 'Bad Header',
  })).toThrow(/v2RolloutHeader/)
})

it('time-based auto ramp starts from zero and rejects invalid ramp values', async () => {
  const ramped = await start(100, undefined, 100)
  const fileId = fakeFileId(7)
  const early = await create(ramped, fileId)
  expect(early.status).toBe(404)
  expect(early.body.message).toBe('v2 sessions are not enabled for this file')
  for (const value of [-1, 101, 1.5]) {
    expect(() => validateRuntimeOptions({
      dataDir: '/unused', v2RolloutRampPerHour: value,
    })).toThrow(/v2RolloutRampPerHour/)
  }
})
