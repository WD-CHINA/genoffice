import { expect, it } from 'vitest'
import { FileLifecycle } from '../src/file-lifecycle'

it('serializes per-file mutations, permits independent files and releases failed locks', async () => {
  const lifecycle = new FileLifecycle()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const order: number[] = []
  const first = lifecycle.withFile('a', async () => {
    order.push(1)
    await gate
    throw new Error('failed')
  })
  const rejected = expect(first).rejects.toThrow('failed')
  const second = lifecycle.withFile('a', async () => {
    order.push(2)
  })
  await lifecycle.withFile('b', async () => {
    order.push(3)
  })
  expect(order).toEqual([1, 3])
  release()
  await rejected
  await second
  expect(order).toEqual([1, 3, 2])
})
it('pins files until all readers release and ignores duplicate close notifications', async () => {
  const lifecycle = new FileLifecycle()
  const release1 = await lifecycle.acquire('file')
  const release2 = await lifecycle.acquire('file')
  release1()
  release1()
  expect(lifecycle.has('file')).toBe(true)
  release2()
  expect(lifecycle.activeFileIds.size).toBe(0)
})
