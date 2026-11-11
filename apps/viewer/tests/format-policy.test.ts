import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  chooseDocxServerRoute, FORMAT_POLICY, FormatPolicyError, decideRoute,
  precheckLocalFile, thresholdsOf,
} from '../src/web/format-policy.ts'

const MiB = 1024 * 1024

test('manual modes fail explicitly instead of guessing', () => {
  assert.throws(
    () => decideRoute({ mode: 'server', format: 'pptx', size: 10 }),
    /没有配置解析服务地址/,
  )
  assert.throws(
    () => decideRoute({
      mode: 'server', serverUrl: 'http://parse', format: 'docx', size: 10,
      capabilities: { formats: ['pptx'] },
    }),
    /不支持该格式/,
  )
  assert.deepEqual(
    decideRoute({ mode: 'server', serverUrl: 'http://parse', format: 'docx', size: 10 }),
    { mode: 'server', reason: 'manual server mode' },
  )
  assert.throws(
    () => decideRoute({ mode: 'local', format: 'docx', size: FORMAT_POLICY.docxAutoRemoteBytes + 1 }),
    FormatPolicyError,
  )
  assert.equal(decideRoute({ mode: 'local', format: 'docx', size: MiB }).mode, 'local')
})

test('auto routing applies the DOCX 32 MiB and PPTX/PDF 64 MiB thresholds', () => {
  const route = (format: 'pptx' | 'pdf' | 'docx', size: number, serverUrl = 'http://parse') =>
    decideRoute({ mode: 'auto', serverUrl, format, size }).mode
  assert.equal(route('docx', FORMAT_POLICY.docxAutoRemoteBytes), 'local')
  assert.equal(route('docx', FORMAT_POLICY.docxAutoRemoteBytes + 1), 'server')
  assert.equal(route('pptx', FORMAT_POLICY.pptxAutoRemoteBytes), 'local')
  assert.equal(route('pptx', FORMAT_POLICY.pptxAutoRemoteBytes + 1), 'server')
  assert.equal(route('pdf', FORMAT_POLICY.pptxAutoRemoteBytes + 1), 'server')
  // Large DOCX without a server cannot silently fall back to local rendering.
  assert.throws(
    () => decideRoute({ mode: 'auto', format: 'docx', size: FORMAT_POLICY.docxAutoRemoteBytes + 1 }),
    /请配置解析服务/,
  )
  // Large PPTX/PDF can still start locally without a server (existing behaviour).
  assert.equal(
    decideRoute({ mode: 'auto', format: 'pptx', size: FORMAT_POLICY.pptxAutoRemoteBytes + 1 }).mode,
    'local',
  )
})

test('advertised capabilities gate the server route', () => {
  const capabilities = { formats: ['pptx', 'pdf'] }
  assert.equal(
    decideRoute({ mode: 'auto', serverUrl: 'http://parse', format: 'docx', size: 10, capabilities }).mode,
    'local',
  )
  assert.throws(
    () => decideRoute({
      mode: 'server', serverUrl: 'http://parse', format: 'docx', size: 10, capabilities,
    }),
    /不支持该格式/,
  )
  // A server that omits formats keeps legacy trust.
  assert.equal(
    decideRoute({ mode: 'auto', serverUrl: 'http://parse', format: 'docx', size: 10 }).mode,
    'local',
  )
  assert.throws(
    () => decideRoute({ mode: 'auto', serverUrl: 'http://parse', format: 'docx', size: -1 }),
    /文件大小无效/,
  )
})

test('manual server DOCX uses the remote model unless the local fallback is explicit', () => {
  assert.equal(chooseDocxServerRoute({ size: 1024, allowLocalFallback: false }), 'remote')
  assert.equal(chooseDocxServerRoute({ size: 1024, allowLocalFallback: true }), 'local-full')
  assert.equal(chooseDocxServerRoute({
    size: FORMAT_POLICY.docxServerFullRenderBytes + 1, allowLocalFallback: true,
  }), 'remote')
  assert.equal(chooseDocxServerRoute({ size: -1, allowLocalFallback: true }), 'remote')
})

test('deployment-advertised thresholds override the centralized defaults', () => {
  const thresholds = { docxAutoRemoteBytes: 1024, pptxAutoRemoteBytes: 2048, docxFullRenderBytes: 4096 }
  assert.equal(decideRoute({
    mode: 'auto', serverUrl: 'http://parse', format: 'docx', size: 2048,
    capabilities: { formats: ['docx'], thresholds },
  }).mode, 'server')
  assert.equal(decideRoute({
    mode: 'auto', serverUrl: 'http://parse', format: 'pptx', size: 2049,
    capabilities: { formats: ['pptx'], thresholds },
  }).mode, 'server')
  assert.equal(chooseDocxServerRoute({
    size: 4096, allowLocalFallback: true, thresholds,
  }), 'local-full')
  assert.equal(chooseDocxServerRoute({
    size: 4097, allowLocalFallback: true, thresholds,
  }), 'remote')
  assert.deepEqual(thresholdsOf(undefined), {
    docxAutoRemoteBytes: FORMAT_POLICY.docxAutoRemoteBytes,
    pptxAutoRemoteBytes: FORMAT_POLICY.pptxAutoRemoteBytes,
    docxFullRenderBytes: FORMAT_POLICY.docxServerFullRenderBytes,
  })
})

test('precheck rejects oversized or impossible local routes before reading', () => {
  assert.doesNotThrow(() => precheckLocalFile({ name: 'a.pptx', size: 10 }))
  assert.throws(() => precheckLocalFile({ name: 'a.docx', size: 40 * 1024 * 1024 }), /大 DOCX/)
  assert.doesNotThrow(() =>
    precheckLocalFile({ name: 'a.docx', size: 40 * 1024 * 1024, serverUrl: 'http://parse' }))
  assert.throws(() =>
    precheckLocalFile({ name: 'a.pptx', size: FORMAT_POLICY.maxFileBytes + 1 }), /1 GiB/)
  assert.throws(() =>
    precheckLocalFile({
      name: 'a.docx', size: 2048,
      capabilities: { thresholds: { docxAutoRemoteBytes: 1024 } },
    }), /大 DOCX/)
})
