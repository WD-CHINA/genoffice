import { expect, it } from 'vitest'
import { CanaryGuard } from '../src/canary-guard'

it('pauses only after the minimum sample and threshold are met', () => {
  let now = 1_000_000
  const guard = new CanaryGuard({
    errorRatePercent: 50,
    minRequests: 4,
    windowMs: 60_000,
    cooldownMs: 10_000,
    now: () => now,
  })
  guard.record(true)
  guard.record(false)
  guard.record(false)
  expect(guard.paused()).toBe(false)
  guard.record(false) // 3/4 failures = 75%
  expect(guard.paused()).toBe(true)
  expect(guard.snapshot().tripped).toBe(1)
  now += 9_999
  expect(guard.paused()).toBe(true)
  now += 1
  expect(guard.paused()).toBe(false)
})

it('ignores client successes and expires old samples', () => {
  let now = 5_000_000
  const guard = new CanaryGuard({
    errorRatePercent: 10,
    minRequests: 3,
    windowMs: 5_000,
    cooldownMs: 1_000,
    now: () => now,
  })
  guard.record(false)
  guard.record(false)
  now += 6_000
  guard.record(true)
  expect(guard.snapshot().samples).toBe(1)
  expect(guard.paused()).toBe(false)
})

it('is disabled by default and rejects invalid options', () => {
  const disabled = new CanaryGuard({ now: () => 0 })
  disabled.record(false)
  disabled.record(false)
  expect(disabled.paused()).toBe(false)
  expect(disabled.snapshot().enabled).toBe(false)
  for (const options of [
    { errorRatePercent: -1 },
    { errorRatePercent: 101 },
    { minRequests: 0 },
    { windowMs: 10 },
    { cooldownMs: 10 },
  ]) {
    expect(() => new CanaryGuard(options)).toThrow(/invalid canary/)
  }
})

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createParseServer, type ParseServer } from '../src/server'

it('exposes the guard in health and rejects invalid thresholds at startup', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'canary-guard-'))
  let server: ParseServer | undefined
  try {
    server = await createParseServer({ dataDir, asyncAutoPauseErrorRate: 25 })
    const health = (await (await fetch(server.url + '/v1/health')).json()) as {
      canaryGuard: { enabled: boolean; paused: boolean; thresholdPercent: number }
    }
    expect(health.canaryGuard).toMatchObject({
      enabled: true,
      paused: false,
      thresholdPercent: 25,
    })
    for (const value of [-1, 101, 1.5]) {
      await expect(createParseServer({ dataDir, asyncAutoPauseErrorRate: value })).rejects.toThrow(
        /asyncAutoPauseErrorRate/,
      )
    }
  } finally {
    await server?.close().catch(() => undefined)
    await rm(dataDir, { recursive: true, force: true })
  }
})
