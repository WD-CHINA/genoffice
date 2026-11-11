import { expect, it } from 'vitest'
import { isRecoverableInfrastructureError, retryDelayMs } from '../src/retry-policy'

it('classifies transient filesystem and SQL failures as recoverable', () => {
  for (const code of ['EAGAIN', 'EBUSY', 'ECONNRESET', 'ETIMEDOUT', 'ER_LOCK_DEADLOCK',
    'ER_LOCK_WAIT_TIMEOUT', 'PROTOCOL_CONNECTION_LOST']) {
    expect(isRecoverableInfrastructureError(Object.assign(new Error('x'), { code }))).toBe(true)
  }
  // mysql2/fs commonly wrap the actionable code one level down.
  expect(isRecoverableInfrastructureError(Object.assign(new Error('outer'), {
    cause: Object.assign(new Error('inner'), { code: 'ECONNRESET' }),
  }))).toBe(true)
})

it('does not retry parse, corruption, lease or storage failures', () => {
  for (const code of ['ENOSPC', 'EDQUOT', 'artifact_lease_lost', 'artifact_corrupt',
    'EACCES', 'ENOENT']) {
    expect(isRecoverableInfrastructureError(Object.assign(new Error('x'), { code }))).toBe(false)
  }
  expect(isRecoverableInfrastructureError(new Error('plain error'))).toBe(false)
  expect(isRecoverableInfrastructureError(undefined)).toBe(false)
})

it('backs off exponentially up to the cap and rejects invalid attempts', () => {
  expect(retryDelayMs(1, 50, 2000)).toBe(50)
  expect(retryDelayMs(2, 50, 2000)).toBe(100)
  expect(retryDelayMs(6, 50, 2000)).toBe(1600)
  expect(retryDelayMs(20, 50, 2000)).toBe(2000)
  expect(() => retryDelayMs(0)).toThrow('invalid retry attempt')
})
