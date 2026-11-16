import assert from 'node:assert/strict'
import test from 'node:test'
import { previewUrl, resolvePreview } from '../src/web/preview-target.ts'
import { defaultViewerUi, readViewerUi, viewerUiParams } from '../src/web/ui-options.ts'

const origin = 'https://viewer.example'
test('one preview entry omits derived values and preserves distinct backend/auth/base/UI settings', () => {
  assert.equal(
    previewUrl(
      '/viewer/',
      {
        fileId: 'file',
        src: 'bundle',
        server: origin + '/',
        name: 'file',
        layout: 'client',
        token: '',
        ui: viewerUiParams(defaultViewerUi),
      },
      origin,
    ),
    '/viewer/preview.html?fileId=file',
  )
  assert.equal(
    previewUrl('/viewer', { fileId: 'file' }, origin),
    '/viewer/preview.html?fileId=file',
  )
  const url = new URL(
    previewUrl(
      '/viewer/index.html?old=1#old',
      {
        fileId: 'a b',
        server: 'https://api.example/prefix/',
        token: 'a+b&c',
        name: '课时计划.docx',
        layout: 'server',
        theme: 'dark',
      },
      origin,
    ),
    origin,
  )
  assert.equal(url.pathname, '/viewer/preview.html')
  assert.equal(url.searchParams.get('server'), 'https://api.example/prefix')
  assert.equal(url.searchParams.get('token'), 'a+b&c')
  assert.equal(url.searchParams.get('fileId'), 'a b')
  assert.equal(url.searchParams.get('layout'), 'server')
  assert.equal(url.hash, '')
  for (let mask = 0; mask < 64; mask++) {
    const ui = Object.fromEntries(
      Object.keys(defaultViewerUi).map((key, i) => [key, !!(mask & (1 << i))]),
    ) as typeof defaultViewerUi
    assert.deepEqual(readViewerUi(new URLSearchParams(viewerUiParams(ui))), ui)
  }
})
test('minimal file links resolve all three formats using one same-origin metadata request', async () => {
  for (const format of ['pptx', 'docx', 'pdf']) {
    const calls: string[] = []
    const result = await resolvePreview(
      new URLSearchParams({ fileId: 'id' }),
      origin,
      undefined,
      async (url) => {
        calls.push(String(url))
        return Response.json({ format })
      },
    )
    assert.equal(result.format, format)
    assert.equal(result.server, origin)
    assert.equal(result.src, origin + '/v1/files/id/content')
    assert.deepEqual(calls, [origin + '/v1/files/id'])
  }
})
test('authenticated PDF signs content once at the preview boundary', async () => {
  const calls: { url: string; auth: string | null }[] = []
  const result = await resolvePreview(
    new URLSearchParams({ fileId: 'id', server: 'https://api.example/', token: 'secret' }),
    origin,
    undefined,
    async (url, init) => {
      calls.push({ url: String(url), auth: new Headers(init?.headers).get('Authorization') })
      return Response.json(
        String(url).endsWith('/content-url')
          ? { url: 'https://api.example/signed.pdf' }
          : { format: 'pdf' },
      )
    },
  )
  assert.equal(result.src, 'https://api.example/signed.pdf')
  assert.equal(calls.length, 2)
  assert.ok(calls.every((call) => call.auth === 'Bearer secret'))
})
test('local URLs retain their source and opening failures remain explicit and cancellable', async () => {
  const src = 'https://files.example/lesson.docx?signature=a%2Bb'
  assert.equal(
    (await resolvePreview(new URLSearchParams({ src, format: 'docx' }), origin)).src,
    src,
  )
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    resolvePreview(
      new URLSearchParams({ fileId: 'id' }),
      origin,
      controller.signal,
      async (_url, init) => {
        assert.equal(init?.signal, controller.signal)
        throw new DOMException('cancelled', 'AbortError')
      },
    ),
    { name: 'AbortError' },
  )
  for (const status of [401, 404, 500])
    await assert.rejects(
      resolvePreview(
        new URLSearchParams({ fileId: 'id' }),
        origin,
        undefined,
        async () => new Response(null, { status }),
      ),
      new RegExp(`HTTP ${status}`),
    )
  await assert.rejects(resolvePreview(new URLSearchParams(), origin), /没有可预览/)
  await assert.rejects(
    resolvePreview(new URLSearchParams({ fileId: 'id' }), origin, undefined, async () =>
      Response.json({ format: 'exe' }),
    ),
    /只能预览/,
  )
})

test('retired preview parameters are rejected before any request', async () => {
  for (const input of [
    { fileId: 'id', src: 'bundle', format: 'pptx' },
    { fileId: 'id', format: 'pdf' },
    { fileId: 'id', contentUrl: 'https://files.example/signed.pdf' },
    { fileId: 'id', parse: 'server' },
    { fileId: 'id', layout: 'client' },
    { url: 'https://files.example/file.docx' },
    { src: 'bundle', format: 'pptx' },
  ] as Record<string, string>[]) {
    await assert.rejects(
      resolvePreview(new URLSearchParams(input), origin, undefined, async () => {
        assert.fail('retired links must not contact a server')
      }),
      /不再支持旧预览链接/,
    )
  }
  const url = new URL(previewUrl('/viewer/', { fileId: 'id', format: 'pptx' }, origin), origin)
  assert.deepEqual([...url.searchParams.keys()], ['fileId'])
})
