import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inspectSignedResource, needsResourceRefresh, originOf } from '../src/web/signed-url.ts'

const signed = (exp: number) =>
  `http://parse/v1/files/abc/parts/ppt/media/image1.png?exp=${exp}&sig=signature`

test('classifies signed resource URLs and their expiry', () => {
  assert.deepEqual(inspectSignedResource(signed(2000), 1000), {
    signed: true,
    exp: 2000,
    expired: false,
    origin: 'http://parse',
  })
  assert.equal(inspectSignedResource(signed(900), 1000).expired, true)
  // Refresh slightly early so a cached description does not 403 at the boundary.
  assert.equal(inspectSignedResource(signed(1030), 1000).expired, true)
  assert.equal(inspectSignedResource(signed(1030), 1000, 0).expired, false)
  assert.equal(inspectSignedResource('/v1/files/abc/parts/a.png', 1000).signed, false)
  assert.equal(inspectSignedResource('ordinary text', 1000).signed, false)
  assert.equal(inspectSignedResource(undefined, 1000).signed, false)
  const malformedExp = inspectSignedResource(
    'http://parse/v1/files/abc/parts/a.png?exp=soon&sig=x',
    1000,
  )
  assert.equal(malformedExp.signed, true)
  assert.equal(malformedExp.expired, true)
})

test('detects a stale signature anywhere in a nested unit and a moved origin', () => {
  assert.equal(needsResourceRefresh({ blocks: [{ text: 'hi' }] }, { nowSeconds: 1000 }), false)
  assert.equal(
    needsResourceRefresh({ blocks: [{ image: signed(2000) }] }, { nowSeconds: 1000 }),
    false,
  )
  assert.equal(
    needsResourceRefresh({ blocks: [{ image: signed(900) }] }, { nowSeconds: 1000 }),
    true,
  )
  assert.equal(
    needsResourceRefresh({ deep: [{ nested: signed(2000) }] }, { nowSeconds: 1000 }),
    false,
  )
  assert.equal(
    needsResourceRefresh(
      { deep: [{ nested: 'http://old.example/v1/files/abc/parts/a.png?exp=2000&sig=x' }] },
      { nowSeconds: 1000, baseOrigin: 'http://new.example' },
    ),
    true,
  )
  assert.equal(originOf('http://parse/'), 'http://parse')
  assert.equal(originOf('/relative'), undefined)
})
