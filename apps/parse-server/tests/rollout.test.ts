import { expect, it } from 'vitest'
import { effectiveRolloutPercent, rolloutBucket } from '../src/rollout'

it('ramps the canary percentage with uptime and caps at the target', () => {
  expect(effectiveRolloutPercent(100, 0, 99 * 3_600_000)).toBe(100)
  expect(effectiveRolloutPercent(100, 25, 0)).toBe(0)
  expect(effectiveRolloutPercent(100, 25, 2 * 3_600_000 - 1)).toBe(49)
  expect(effectiveRolloutPercent(100, 25, 2 * 3_600_000)).toBe(50)
  expect(effectiveRolloutPercent(40, 25, 10 * 3_600_000)).toBe(40)
  expect(effectiveRolloutPercent(100, 100, 30 * 60_000)).toBe(50)
  expect(effectiveRolloutPercent(100, 25, -1)).toBe(0)
  for (const [target, ramp] of [[-1, 1], [101, 1], [50, -1], [50, 101], [1.5, 1]]) {
    expect(() => effectiveRolloutPercent(target as number, ramp as number, 0))
      .toThrow(/invalid rollout/)
  }
})

it('buckets canary identities deterministically', () => {
  expect(rolloutBucket('tenant-a')).toBe(rolloutBucket('tenant-a'))
  expect(rolloutBucket('tenant-a')).toBeGreaterThanOrEqual(0)
  expect(rolloutBucket('tenant-a')).toBeLessThan(100)
  const values = new Set(Array.from({ length: 200 }, (_, index) => rolloutBucket(`t-${index}`)))
  expect(values.size).toBeGreaterThan(30)
  expect(rolloutBucket('')).toBe(0)
})
