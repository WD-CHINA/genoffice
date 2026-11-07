import { createParseServer } from '../src/server'
import { afterEach, expect, it, vi } from 'vitest'
import { numberEnv, validateRuntimeOptions } from '../src/runtime-options'

afterEach(() => vi.unstubAllEnvs())
it('accepts explicit zero only for settings that permit it and rejects malformed CLI values', () => {
  expect(numberEnv('GENOFFICE_TEST_NUMBER')).toBeUndefined()
  for (const raw of ['', 'NaN', '-1', '1.5', 'Infinity', '1e3', '0x10']) {
    vi.stubEnv('GENOFFICE_TEST_NUMBER', raw)
    expect(() => numberEnv('GENOFFICE_TEST_NUMBER')).toThrow('must be an integer')
  }
  vi.stubEnv('GENOFFICE_TEST_NUMBER', '0')
  expect(numberEnv('GENOFFICE_TEST_NUMBER', 0)).toBe(0)
  expect(() => numberEnv('GENOFFICE_TEST_NUMBER')).toThrow('must be an integer')
})
it('validates mutually consistent memory and timer budgets before starting a server', () => {
  const defaults = { dataDir: '/unused-test-directory' }
  expect(() => validateRuntimeOptions(defaults)).not.toThrow()
  expect(() => validateRuntimeOptions({ ...defaults, workerRssMb: 512 })).toThrow(
    'heap must be below',
  )
  expect(() => validateRuntimeOptions({ ...defaults, parseMemoryMb: 2048 })).toThrow(
    'total parse memory',
  )
  expect(() => validateRuntimeOptions({ ...defaults, unitTimeoutMs: 2 ** 32 })).toThrow(
    'unitTimeoutMs',
  )
  expect(() =>
    validateRuntimeOptions({ ...defaults, maxQueuedParseJobs: 0, maxStoreBytes: 0 }),
  ).not.toThrow()
  expect(() => validateRuntimeOptions({ ...defaults, maxParseJobs: NaN })).toThrow('maxParseJobs')
  expect(() => validateRuntimeOptions({ ...defaults, cgroupRoot: 'relative' })).toThrow(
    'absolute Linux',
  )
})

it('requires ordered integer storage watermarks before creating resources', () => {
  const base = { dataDir: '/unused-test-directory' }
  expect(() =>
    validateRuntimeOptions({ ...base, storageHighWaterPercent: 95, storageLowWaterPercent: 75 }),
  ).not.toThrow()
  for (const value of [0, NaN, 101, 90.5]) {
    expect(() => validateRuntimeOptions({ ...base, storageHighWaterPercent: value })).toThrow(
      'storageHighWaterPercent',
    )
  }
  expect(() =>
    validateRuntimeOptions({ ...base, storageHighWaterPercent: 80, storageLowWaterPercent: 80 }),
  ).toThrow('below high')
})

it('rejects invalid or unconfigured catalog storage before opening server resources', async () => {
  await expect(createParseServer({ dataDir: '/unused-test-directory', artifactBackend: 'catalog' }))
    .rejects.toThrow('requires MySQL')
  await expect(createParseServer({ dataDir: '/unused-test-directory', artifactBackend: 'unexpected' as 'local' }))
    .rejects.toThrow('invalid artifact backend')
})
