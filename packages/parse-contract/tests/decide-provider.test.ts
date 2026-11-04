import { describe, expect, it } from 'vitest'
import {
  assertDocModel,
  decideProvider,
  isCompatible,
  type Capabilities,
  type DocModel,
  type SwitchPolicy,
} from '../src/index'

function caps(formats: Capabilities['formats']): Capabilities {
  return {
    contractVersion: 1,
    parserVersion: 'test',
    formats,
    stages: {},
    maxBytes: 2 * 1024 * 1024 * 1024,
    fontSetHash: 'fonts',
    features: {
      lazyAssets: true,
      rangeRequests: true,
      fontWidthFeedback: true,
      streamingUnits: true,
    },
  }
}

const local = caps(['pptx', 'pdf', 'docx'])
const remote = caps(['pptx', 'pdf'])

function policy(overrides: Partial<SwitchPolicy> = {}): SwitchPolicy {
  return {
    mode: 'auto',
    localMaxBytes: { pptx: 64 * 1024 * 1024, pdf: 1024 * 1024 * 1024, docx: 32 * 1024 * 1024 },
    allowUploadWithoutConsent: false,
    privacyLocalOnly: false,
    ...overrides,
  }
}

describe('decideProvider', () => {
  it('keeps a small file local', () => {
    expect(
      decideProvider({
        policy: policy(),
        size: 1024,
        format: 'pptx',
        localCaps: local,
        remoteCaps: remote,
        online: true,
      }),
    ).toEqual({ provider: 'local', reason: 'small-file' })
  })

  it('sends a large supported file to the server', () => {
    expect(
      decideProvider({
        policy: policy(),
        size: 512 * 1024 * 1024,
        format: 'pptx',
        localCaps: local,
        remoteCaps: remote,
        online: true,
      }),
    ).toEqual({ provider: 'remote', reason: 'large-file' })
  })

  it('blocks a large DOCX because the server does not parse DOCX', () => {
    expect(
      decideProvider({
        policy: policy(),
        size: 512 * 1024 * 1024,
        format: 'docx',
        localCaps: local,
        remoteCaps: remote,
        online: true,
      }),
    ).toEqual({ provider: 'blocked', reason: 'too-large-or-unsupported' })
  })

  it('keeps a small DOCX local', () => {
    expect(
      decideProvider({
        policy: policy(),
        size: 1024,
        format: 'docx',
        localCaps: local,
        remoteCaps: remote,
        online: true,
      }),
    ).toEqual({ provider: 'local', reason: 'small-file' })
  })

  it('blocks a forced-local file that is too large', () => {
    expect(
      decideProvider({
        policy: policy({ mode: 'local' }),
        size: 512 * 1024 * 1024,
        format: 'pptx',
        localCaps: local,
        remoteCaps: remote,
        online: true,
      }),
    ).toEqual({ provider: 'blocked', reason: 'user-forced-local-too-large' })
  })

  it('blocks a forced-server DOCX', () => {
    expect(
      decideProvider({
        policy: policy({ mode: 'server' }),
        size: 1024,
        format: 'docx',
        localCaps: local,
        remoteCaps: remote,
        online: true,
      }),
    ).toEqual({ provider: 'blocked', reason: 'server-unsupported-format' })
  })

  it('blocks a large file while offline instead of falling back to local', () => {
    expect(
      decideProvider({
        policy: policy(),
        size: 512 * 1024 * 1024,
        format: 'pptx',
        localCaps: local,
        remoteCaps: remote,
        online: false,
      }),
    ).toEqual({ provider: 'blocked', reason: 'too-large-or-unsupported' })
  })

  it('honours the privacy policy over the file size', () => {
    expect(
      decideProvider({
        policy: policy({ privacyLocalOnly: true }),
        size: 512 * 1024 * 1024,
        format: 'pptx',
        localCaps: local,
        remoteCaps: remote,
        online: true,
      }),
    ).toEqual({ provider: 'blocked', reason: 'privacy-policy-too-large' })
  })
})

describe('isCompatible', () => {
  it('requires both the contract and parser version to match', () => {
    expect(
      isCompatible(
        { contractVersion: 1, parserVersion: 'a' },
        { contractVersion: 1, parserVersion: 'a' },
      ),
    ).toBe(true)
    expect(
      isCompatible(
        { contractVersion: 1, parserVersion: 'a' },
        { contractVersion: 2, parserVersion: 'a' },
      ),
    ).toBe(false)
    expect(
      isCompatible(
        { contractVersion: 1, parserVersion: 'a' },
        { contractVersion: 1, parserVersion: 'b' },
      ),
    ).toBe(false)
  })
})

describe('assertDocModel', () => {
  const model: DocModel = {
    format: 'pptx',
    parserVersion: 'test',
    unitKind: 'slide',
    unitCount: 3,
    stagesDone: ['index', 'model', 'layout'],
    stagesPending: ['measure'],
    assetCount: 2,
    warnings: [],
  }

  it('accepts a valid model', () => {
    expect(() => assertDocModel(model)).not.toThrow()
  })

  it('rejects an unknown format', () => {
    expect(() => assertDocModel({ ...model, format: 'xlsx' })).toThrow(/unknown format/)
  })

  it('rejects a negative unit count', () => {
    expect(() => assertDocModel({ ...model, unitCount: -1 })).toThrow(/unitCount/)
  })

  it('rejects unknown stages', () => {
    expect(() => assertDocModel({ ...model, stagesDone: ['index', 'nope'] })).toThrow(/stagesDone/)
  })
})
