import assert from 'node:assert/strict'
import { createHash as nodeHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { test } from 'node:test'
import { createCipheriv as shimCipher, createDecipheriv as shimDecipher, createHash } from '../src/web/shims/crypto.ts'

test('browser sha256 matches node', () => {
  const bytes = Buffer.from('genoffice-viewer')
  assert.equal(createHash('sha256').update(bytes).digest('hex'), nodeHash('sha256').update(bytes).digest('hex'))
  assert.equal(createHash('sha1').update(bytes).digest('hex'), nodeHash('sha1').update(bytes).digest('hex'))
})

test('browser aes-128-ecb matches node', () => {
  const key = randomBytes(16)
  const data = Buffer.alloc(32, 3)
  const enc = createCipheriv('aes-128-ecb', key, Buffer.alloc(0))
  enc.setAutoPadding(false)
  const expected = Buffer.concat([enc.update(data), enc.final()])
  const ours = shimCipher('aes-128-ecb', key, Buffer.alloc(0))
  ours.setAutoPadding(false)
  const got = Buffer.concat([ours.update(data), ours.final()])
  assert.equal(got.toString('hex'), expected.toString('hex'))
})

test('browser aes-256-cbc matches node', () => {
  const key = randomBytes(32)
  const iv = randomBytes(16)
  const data = Buffer.alloc(64, 7)
  const enc = createCipheriv('aes-256-cbc', key, iv)
  enc.setAutoPadding(false)
  const expected = Buffer.concat([enc.update(data), enc.final()])
  const ours = shimCipher('aes-256-cbc', key, iv)
  ours.setAutoPadding(false)
  const got = Buffer.concat([ours.update(data), ours.final()])
  assert.equal(got.toString('hex'), expected.toString('hex'))
  const dec = shimDecipher('aes-256-cbc', key, iv)
  dec.setAutoPadding(false)
  assert.equal(Buffer.concat([dec.update(got), dec.final()]).toString('hex'), data.toString('hex'))
  const nodeDec = createDecipheriv('aes-256-cbc', key, iv)
  nodeDec.setAutoPadding(false)
  assert.equal(Buffer.concat([nodeDec.update(got), nodeDec.final()]).toString('hex'), data.toString('hex'))
})
