import { json } from './helpers/session-probes.ts'
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import {
  fetchCapabilities,
  featureEnabled,
  resetCapabilitiesCacheForTests,
  supports,
} from '../src/web/capabilities.ts'

afterEach(() => resetCapabilitiesCacheForTests())

test('parses a capabilities response and filters non-boolean features', async () => {
  let url = ''
  const capabilities = await fetchCapabilities({
    baseUrl: 'http://parse/',
    fetchImpl: (async (requested: string) => {
      url = requested
      return json({
        contractVersion: '1',
        parserVersion: '0.1.0',
        formats: ['pptx', 'docx', 7],
        maxBytes: 1024,
        features: { asyncSessions: true, incrementalPreview: false, weird: 'yes' },
      })
    }) as typeof fetch,
  })
  assert.equal(url, 'http://parse/v2/capabilities')
  assert.deepEqual(capabilities, {
    contractVersion: '1',
    parserVersion: '0.1.0',
    formats: ['pptx', 'docx'],
    maxBytes: 1024,
    features: { asyncSessions: true, incrementalPreview: false },
  })
  assert.equal(supports(capabilities, 'asyncSessions'), true)
  assert.equal(supports(capabilities, 'incrementalPreview'), false)
  assert.equal(supports(capabilities, 'unknown'), false)
  assert.equal(featureEnabled(capabilities, 'unknown'), undefined)
  assert.equal(supports(undefined, 'asyncSessions'), false)
})

test('failed, malformed or timed-out probes return undefined and are not cached', async () => {
  for (const fetchImpl of [
    (async () => json({ message: 'missing' }, 404)) as typeof fetch,
    (async () => json({ message: 'boom' }, 500)) as typeof fetch,
    (async () => new Response('not json', { status: 200 })) as typeof fetch,
    (async () => {
      throw new Error('network down')
    }) as typeof fetch,
    (async () => json([1, 2, 3])) as typeof fetch,
  ]) {
    assert.equal(await fetchCapabilities({ baseUrl: 'http://parse', fetchImpl }), undefined)
  }
  // A probe that never answers is aborted by the timeout budget.
  let aborted = false
  const started = Date.now()
  const capabilities = await fetchCapabilities({
    baseUrl: 'http://slow',
    timeoutMs: 20,
    fetchImpl: ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          aborted = true
          reject(new DOMException('aborted', 'AbortError'))
        })
      })) as typeof fetch,
  })
  assert.equal(capabilities, undefined)
  assert.equal(aborted, true)
  assert.ok(Date.now() - started < 1000)
})

test('caches successful probes per origin and refreshes after the TTL', async () => {
  let calls = 0
  let now = 1000
  const fetchImpl = (async () => {
    calls += 1
    return json({ features: { asyncSessions: true } })
  }) as typeof fetch
  const options = { baseUrl: 'http://parse', fetchImpl, ttlMs: 100, now: () => now }
  await fetchCapabilities(options)
  await fetchCapabilities(options)
  assert.equal(calls, 1)
  await fetchCapabilities({ ...options, baseUrl: 'http://other' })
  assert.equal(calls, 2)
  now += 101
  await fetchCapabilities(options)
  assert.equal(calls, 3)
})

test('accepts an externally abortable signal without throwing', async () => {
  const controller = new AbortController()
  controller.abort()
  const capabilities = await fetchCapabilities({
    baseUrl: 'http://parse',
    signal: controller.signal,
    fetchImpl: ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        if (init.signal?.aborted) reject(new DOMException('aborted', 'AbortError'))
      })) as typeof fetch,
  })
  assert.equal(capabilities, undefined)
})

test('keeps only valid advertised thresholds', async () => {
  const capabilities = await fetchCapabilities({
    baseUrl: 'http://parse',
    fetchImpl: (async () =>
      json({
        thresholds: {
          docxAutoRemoteBytes: 1024,
          pptxAutoRemoteBytes: -1,
          docxFullRenderBytes: 1.5,
        },
      })) as typeof fetch,
  })
  assert.deepEqual(capabilities?.thresholds, { docxAutoRemoteBytes: 1024 })
})
