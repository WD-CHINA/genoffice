import { expect, it } from 'vitest'
import { parserFingerprint } from '../src/parser-fingerprint'

it('produces a deterministic source fingerprint that changes with the version', async () => {
  const first = await parserFingerprint('0.1.0')
  const second = await parserFingerprint('0.1.0')
  expect(first).toMatch(/^[a-f0-9]{64}$/)
  expect(second).toBe(first)
  expect(await parserFingerprint('0.2.0')).not.toBe(first)
}, 30_000)
