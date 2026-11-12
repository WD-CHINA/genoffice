import { serverRoot } from './helpers/paths'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createBlankPptx } from '@genoffice/pptx-engine'
import { IsolatedWorker, processRss, isolatedMemory } from '../src/isolated-worker'
import { createParseServer, type ParseServer } from '../src/server'

const workers: IsolatedWorker[] = []
const servers: ParseServer[] = []
const directories: string[] = []
const fixture = new URL('./helpers/process-fixture.mjs', import.meta.url)
afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.terminate()))
  await Promise.all(servers.splice(0).map((server) => server.close().catch(() => undefined)))
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})
function worker(options: ConstructorParameters<typeof IsolatedWorker>[1]) {
  const value = new IsolatedWorker(fixture, options)
  workers.push(value)
  return value
}

it('runs in another PID, preserves binary IPC, and waits for exit before releasing resources', async () => {
  const child = worker({ heapMb: 64, rssMb: 512, groupId: 'echo-test' })
  const response = once(child, 'message')
  child.postMessage({ op: 'echo', data: Buffer.from([0, 1, 127, 255]) })
  const [message] = await response
  expect(message.pid).not.toBe(process.pid)
  expect(isolatedMemory('echo-test').processes).toBe(1)
  expect(message.data).toEqual(Buffer.from([0, 1, 127, 255]))
  await child.terminate()
  expect(await processRss(message.pid)).toBeNull()
  expect(isolatedMemory('echo-test')).toEqual({ processes: 0, rssBytes: 0 })
})

it('kills RSS overflow even while the child event loop is blocked', async () => {
  const child = worker({ heapMb: 64, rssMb: 192, sampleMs: 25 })
  const failed = new Promise<Error>((resolve) => child.once('error', resolve))
  child.postMessage({ op: 'allocate', bytes: 256 * 1024 ** 2 })
  expect(await failed).toMatchObject({ code: 'parse_memory_limit' })
  expect(child.peakRssBytes).toBeGreaterThan(192 * 1024 ** 2)
  const pid = child.pid!
  await child.terminate()
  expect(await processRss(pid)).toBeNull()
})

it('enforces the total process deadline independently of child callbacks', async () => {
  const child = worker({ heapMb: 64, rssMb: 512, lifetimeMs: 1500, sampleMs: 50 })
  const failed = new Promise<Error>((resolve) => child.once('error', resolve))
  child.postMessage({ op: 'spin' })
  expect(await failed).toMatchObject({ code: 'parse_timeout' })
  await child.terminate()
  expect(await processRss(child.pid!)).toBeNull()
})

it('reports unexpected child exits without crashing the parent', async () => {
  const child = worker({ heapMb: 64, rssMb: 512 })
  const failed = new Promise<Error>((resolve) => child.once('error', resolve))
  child.postMessage({ op: 'crash' })
  expect(await failed).toMatchObject({ code: 'parse_worker_crashed' })
  await child.terminate()
})

it('refuses invalid cgroup enforcement instead of executing without the configured guard', async () => {
  if (process.platform !== 'linux') {
    expect(() => worker({ heapMb: 64, rssMb: 512, cgroupRoot: '/not-a-cgroup' })).toThrow(
      'require Linux',
    )
  } else {
    const directory = await mkdtemp(join(tmpdir(), 'not-a-cgroup-'))
    directories.push(directory)
    const child = worker({ heapMb: 64, rssMb: 512, cgroupRoot: directory })
    const failed = new Promise<Error>((resolve) => child.once('error', resolve))
    child.postMessage({ op: 'echo' })
    expect(await failed).toMatchObject({ code: 'parse_memory_monitor_failed' })
    await child.terminate()
  }
})

for (const format of ['pptx', 'docx'] as const) {
  it(`${format} memory failure leaves HTTP healthy, returns queue memory and permits a later retry`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'parser-oom-'))
    directories.push(directory)
    const first = await createParseServer({
      dataDir: directory,
      workerMemoryMb: 16,
      workerRssMb: 64,
      rssSampleMs: 10,
    })
    servers.push(first)
    const bytes =
      format === 'pptx'
        ? Buffer.from(await createBlankPptx())
        : await readFile(join(serverRoot, 'tests/fixtures/docx/table.docx'))
    const upload = await fetch(`${first.url}/v1/files`, { method: 'POST', body: bytes })
    expect(upload.status).toBe(201)
    const { fileId } = (await upload.json()) as { fileId: string }
    const open = (url: string) =>
      fetch(`${url}/v1/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileId }),
      })
    const failed = await open(first.url)
    expect(failed.status).toBe(422)
    expect(await failed.json()).toMatchObject({ code: 'parse_memory_limit' })
    const health = await fetch(`${first.url}/v1/health`)
    expect(health.status).toBe(200)
    expect(await health.json()).toMatchObject({
      activeWorkers: 0,
      parseQueue: { running: 0, queued: 0 },
      parseMemory: { reservedMb: 0 },
      childProcesses: { processes: 0, rssBytes: 0 },
    })
    await first.close()
    const second = await createParseServer({ dataDir: directory })
    servers.push(second)
    expect((await open(second.url)).status).toBe(201)
  })
}

it('rejects pre-aborted ownership without spawning a parser process', () => {
  const controller = new AbortController()
  const reason = new Error('lease already lost')
  controller.abort(reason)
  expect(() =>
    worker({ heapMb: 64, rssMb: 512, groupId: 'pre-abort', signal: controller.signal }),
  ).toThrow(reason)
  expect(isolatedMemory('pre-abort').processes).toBe(0)
})

it('ownership cancellation kills a CPU-bound child and detaches its listener', async () => {
  const controller = new AbortController()
  const removed = vi.spyOn(controller.signal, 'removeEventListener')
  const child = worker({
    heapMb: 64,
    rssMb: 512,
    signal: controller.signal,
    groupId: 'lease-abort',
  })
  const failed = new Promise<Error>((resolve) => child.once('error', resolve))
  const started = once(child, 'message')
  child.postMessage({ op: 'spin' })
  expect((await started)[0]).toMatchObject({ started: true })
  const reason = Object.assign(new Error('artifact lease lost'), { code: 'artifact_lease_lost' })
  controller.abort(reason)
  expect(await failed).toBe(reason)
  await child.terminate()
  expect(await processRss(child.pid!)).toBeNull()
  expect(isolatedMemory('lease-abort').processes).toBe(0)
  expect(removed).toHaveBeenCalledWith('abort', expect.any(Function))
  removed.mockRestore()
})
