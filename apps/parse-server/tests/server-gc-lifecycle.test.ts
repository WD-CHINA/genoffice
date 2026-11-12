import { drainCleanups } from './helpers/cleanup'
import { createBlankPptx } from '@genoffice/pptx-engine'
import { ArtifactSession } from '../src/artifact-session'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { createParseServer, type ParseServer } from '../src/server'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  await drainCleanups(cleanups)
  vi.restoreAllMocks()
})
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function setup(): Promise<ParseServer> {
  const root = await mkdtemp(join(tmpdir(), 'server-gc-close-'))
  const server = await createParseServer({ dataDir: root })
  cleanups.push(async () => {
    await server.close().catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  })
  return server
}

it('shutdown drains a running GC and rejects new work before metadata stores close', async () => {
  const server = await setup()
  const gate = deferred()
  const started = deferred()
  const list = vi.spyOn(server.store, 'list').mockImplementationOnce(async () => {
    started.resolve()
    await gate.promise
    return []
  })
  const work = server.gc()
  await started.promise
  const health = (await (await fetch(server.url + '/v1/health')).json()) as {
    maintenance: { gcTasks: number }
  }
  expect(health.maintenance.gcTasks).toBe(1)
  const previousCalls = list.mock.calls.length
  const closing = server.close()
  let closed = false
  void closing.then(() => {
    closed = true
  })
  try {
    await delay(20)
    expect(closed).toBe(false)
    await server.gc()
    expect(list.mock.calls.length).toBe(previousCalls)
  } finally {
    gate.resolve()
    await closing
  }
  await work
})

it('a GC scheduled before shutdown but not started performs no filesystem listing', async () => {
  const server = await setup()
  const list = vi.spyOn(server.store, 'list')
  const work = server.gc()
  await server.close()
  await work
  expect(list).not.toHaveBeenCalled()
})

it('shutdown finishes the current deletion but never starts deleting the next file', async () => {
  const server = await setup()
  const ids: string[] = []
  for (const name of ['first', 'second']) {
    const response = await fetch(server.url + '/v1/files', {
      method: 'POST',
      body: Buffer.from(`%PDF-1.7\n${name}\n%%EOF\n`),
    })
    expect(response.status).toBe(201)
    ids.push(((await response.json()) as { fileId: string }).fileId)
  }
  const files = await server.store.list()
  vi.spyOn(server.store, 'list').mockResolvedValueOnce(
    files.map((file) => ({ ...file, createdAt: '2000-01-01T00:00:00.000Z' })),
  )
  const gate = deferred()
  const started = deferred()
  const original = server.store.remove.bind(server.store)
  const remove = vi.spyOn(server.store, 'remove').mockImplementationOnce(async (id) => {
    started.resolve()
    await gate.promise
    await original(id)
  })
  const work = server.gc()
  await started.promise
  const closing = server.close()
  gate.resolve()
  await closing
  await work
  expect(remove).toHaveBeenCalledTimes(1)
  const removed = remove.mock.calls[0][0]
  expect(await server.store.stat(ids.find((id) => id !== removed)!)).not.toBeNull()
})

it('shutdown drains disposal of a view already deleted from the active session map', async () => {
  const server = await setup()
  const upload = await fetch(server.url + '/v1/files', {
    method: 'POST',
    body: Buffer.from(await createBlankPptx()),
  })
  expect(upload.status).toBe(201)
  const { fileId } = (await upload.json()) as { fileId: string }
  const opened = await fetch(server.url + '/v1/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileId }),
  })
  expect(opened.status).toBe(201)
  const { sessionId } = (await opened.json()) as { sessionId: string }
  const gate = deferred()
  const arrived = deferred()
  const original = ArtifactSession.prototype.dispose
  const dispose = vi
    .spyOn(ArtifactSession.prototype, 'dispose')
    .mockImplementationOnce(async function (this: ArtifactSession) {
      arrived.resolve()
      await gate.promise
      await original.call(this)
    })
  const removed = await fetch(server.url + '/v1/sessions/' + sessionId, { method: 'DELETE' })
  expect(removed.status).toBe(204)
  await removed.arrayBuffer()
  await arrived.promise
  const closing = server.close()
  expect(server.close()).toBe(closing)
  let closed = false
  void closing.then(() => {
    closed = true
  })
  try {
    await delay(20)
    expect(closed).toBe(false)
    expect(dispose).toHaveBeenCalledTimes(1)
  } finally {
    gate.resolve()
    await closing
  }
  expect(closed).toBe(true)
})
