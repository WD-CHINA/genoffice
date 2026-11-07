import { expect, it } from 'vitest'
import { refreshDocxResourceUrls } from '../src/resource-urls'
import { verifyResource } from '../src/sign'

it('signs nested persisted resources at read time without changing stored data', () => {
  const original = {
    blocks: [
      { children: [{ imageDataUrl: 'http://old/v1/files/abc/parts/word/media/a%20b.png' }] },
    ],
  }
  const updated = refreshDocxResourceUrls(
    original,
    'abc',
    'http://new',
    'secret',
  ) as typeof original
  const url = new URL(updated.blocks[0].children[0].imageDataUrl)
  expect(url.origin).toBe('http://new')
  expect(
    verifyResource(
      'secret',
      'abc',
      'word/media/a b.png',
      Number(url.searchParams.get('exp')),
      url.searchParams.get('sig')!,
    ),
  ).toBe(true)
  expect(original.blocks[0].children[0].imageDataUrl).toBe(
    'http://old/v1/files/abc/parts/word/media/a%20b.png',
  )
  expect(refreshDocxResourceUrls('https://external/image.png', 'abc', 'http://new', 'secret')).toBe(
    'https://external/image.png',
  )
})
