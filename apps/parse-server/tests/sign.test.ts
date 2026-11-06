import { expect, it } from 'vitest'
import { signResource, verifyResource } from '../src/sign'

it('media signatures remain valid after a 125-minute show and still expire', () => {
  const issued = signResource('secret', 'file', 'ppt/media/video.mp4')
  const now = Math.floor(Date.now() / 1000)
  expect(issued.exp - now).toBeGreaterThan(125 * 60)
  expect(verifyResource('secret', 'file', 'ppt/media/video.mp4', issued.exp, issued.sig)).toBe(true)
  expect(verifyResource('wrong', 'file', 'ppt/media/video.mp4', issued.exp, issued.sig)).toBe(false)
  const expired = signResource('secret', 'file', 'part', -1)
  expect(verifyResource('secret', 'file', 'part', expired.exp, expired.sig)).toBe(false)
})
