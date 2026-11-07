import { expect, it } from 'vitest'
import { DEFAULT_LIMITS, resolveLimits } from '../src/limits'

it('preserves defaults when CLI overrides are unset', () => {
  expect(resolveLimits({ maxUploadBytes: undefined, maxParseBytes: undefined })).toEqual(
    DEFAULT_LIMITS,
  )
  expect(resolveLimits({ maxParseBytes: 123 }).maxParseBytes).toBe(123)
})
it('rejects invalid budgets instead of disabling limits', () => {
  for (const maxParseBytes of [0, -1, NaN, Infinity, 1.5]) {
    expect(() => resolveLimits({ maxParseBytes })).toThrow('invalid server limit')
  }
})
