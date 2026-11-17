import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import {
  decryptDocx,
  DocxDecryptError,
  isEncryptedDocx,
  isCfbFile,
} from '@genoffice/viewer-services/docs/decrypt'
import { BrowserBuffer } from '@genoffice/viewer-services/browser-buffer'

const fixture = (name: string) =>
  readFile(new URL(`../../docs/tests/encrypted-fixtures/${name}`, import.meta.url))

for (const scheme of ['agile', 'standard']) {
  test(`main OOXML ${scheme} detection and decryption accept browser views without mutation`, async () => {
    const encrypted = await fixture(`office-${scheme}-password.docx`)
    const original = encrypted.slice()
    const padded = new Uint8Array(encrypted.length + 20)
    padded.set(encrypted, 10)
    for (const input of [
      encrypted,
      new Uint8Array(encrypted),
      padded.subarray(10, 10 + encrypted.length),
      BrowserBuffer.from(encrypted),
    ]) {
      assert.equal(isCfbFile(input), true)
      assert.equal(isEncryptedDocx(input), true)
      assert.deepEqual(
        Buffer.from(await decryptDocx(input, 'Password1234_')),
        await fixture(`office-${scheme}-plain.docx`),
      )
    }
    assert.deepEqual(encrypted, original)
    await assert.rejects(
      decryptDocx(new Uint8Array(encrypted), 'wrong'),
      (e: unknown) => e instanceof DocxDecryptError && e.reason === 'wrong-password',
    )
  })
}

test('plain ZIP, short inputs and legacy CFB do not trigger an OOXML password prompt', async () => {
  const legacy = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0])
  for (const input of [
    new Uint8Array(),
    new Uint8Array([0xd0]),
    new Uint8Array([80, 75, 3, 4]),
    legacy,
  ])
    assert.equal(isEncryptedDocx(input), false)
  await assert.rejects(
    decryptDocx(legacy, 'pw'),
    (e: unknown) => e instanceof DocxDecryptError && e.reason === 'unsupported',
  )
})
