import { mkdtemp, readdir, rm, readFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, expect, it } from 'vitest'
import { ContentStore } from '../src/storage'
import { StorageBudget } from '../src/storage-budget'
import { FileLifecycle } from '../src/file-lifecycle'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})
async function setup(free = 1000) {
  const directory = await mkdtemp(join(tmpdir(), 'upload-reservation-'))
  directories.push(directory)
  const store = new ContentStore(directory)
  await store.init()
  const lock = new FileLifecycle()
  const budget = new StorageBudget(
    1,
    async () => 0,
    (work) => lock.withFile('storage', work),
    async () => free,
  )
  return { store, budget, directory }
}
it('reserves each temporary chunk before writing and removes partial data on exhaustion', async () => {
  const { store, budget, directory } = await setup(10)
  const reservation = budget.reservation({ temporary: true })
  try {
    await expect(
      store.writeTemp(Readable.from([Buffer.alloc(8), Buffer.alloc(8)]), 100, reservation.reserve),
    ).rejects.toMatchObject({ code: 'storage_full' })
    expect(reservation.bytes).toBe(8)
    expect(await readdir(join(directory, 'tmp'))).toEqual([])
  } finally {
    await reservation.release()
  }
  expect(budget.reservedBytes).toBe(0)
})
it('upload interruption cleans partial data and permits a new upload after release', async () => {
  const { store, budget, directory } = await setup()
  const reservation = budget.reservation({ temporary: true })
  const input = Readable.from(
    (async function* () {
      yield Buffer.alloc(8)
      throw new Error('client disconnected')
    })(),
  )
  try {
    await expect(store.writeTemp(input, 100, reservation.reserve)).rejects.toThrow(
      'client disconnected',
    )
  } finally {
    await reservation.release()
  }
  expect(await readdir(join(directory, 'tmp'))).toEqual([])
  expect(budget.reservedBytes).toBe(0)
  const next = budget.reservation({ temporary: true })
  try {
    const upload = await store.writeTemp(Readable.from([Buffer.from('retry')]), 100, next.reserve)
    expect(upload.size).toBe(5)
    expect(next.bytes).toBe(5)
    await store.abort(upload)
  } finally {
    await next.release()
  }
  expect(budget.reservedBytes).toBe(0)
})

it('age-based cleanup cannot remove an active upload awaiting validation and commit', async () => {
  const { store } = await setup()
  const upload = await store.writeTemp(Readable.from([Buffer.from('still owned')]), 100)
  await utimes(upload.tempPath, new Date(0), new Date(0))
  await store.cleanupTemp(1)
  expect(await readFile(upload.tempPath, 'utf8')).toBe('still owned')
  await store.abort(upload)
})
