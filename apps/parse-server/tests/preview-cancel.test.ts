import { expect, it } from 'vitest'
import { cancelPendingBuild } from '../src/server'

function context() {
  const asyncAborts = new Map<string, { artifactKey: string; controller: AbortController }>()
  const pendingViews = new Map<string, { id: string; artifactKey: string }>()
  const add = (id: string, artifactKey: string) => {
    const controller = new AbortController()
    asyncAborts.set(id, { artifactKey, controller })
    pendingViews.set(id, { id, artifactKey })
    return controller
  }
  return { asyncAborts, pendingViews, add }
}

it('cancels queued preview builds for an artifact only after its last waiter leaves', () => {
  const ctx = context()
  const first = ctx.add('a', 'artifact-1')
  const second = ctx.add('b', 'artifact-1')
  const other = ctx.add('c', 'artifact-2')

  // Another pending viewer of the same artifact keeps the shared build alive.
  ctx.pendingViews.delete('a')
  cancelPendingBuild(ctx, 'a', 'artifact-1')
  expect(first.signal.aborted).toBe(false)
  expect(second.signal.aborted).toBe(false)
  expect(other.signal.aborted).toBe(false)

  ctx.pendingViews.delete('b')
  cancelPendingBuild(ctx, 'b', 'artifact-1')
  expect(first.signal.aborted).toBe(true)
  expect(second.signal.aborted).toBe(true)
  expect((first.signal.reason as { name?: string }).name).toBe('AbortError')
  // A different artifact is untouched.
  expect(other.signal.aborted).toBe(false)
})

it('is idempotent and tolerates unknown sessions', () => {
  const ctx = context()
  const controller = ctx.add('a', 'artifact-1')
  ctx.pendingViews.delete('a')
  cancelPendingBuild(ctx, 'a', 'artifact-1')
  const reason = controller.signal.reason
  cancelPendingBuild(ctx, 'a', 'artifact-1')
  expect(controller.signal.reason).toBe(reason)
  cancelPendingBuild(ctx, 'missing', 'artifact-1')
  expect(ctx.asyncAborts.size).toBe(1)
})
