import { afterEach, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import UTIF from 'utif2'
import { PNG } from 'pngjs'
import { createBlankPptx } from '@genoffice/pptx-engine'
import { createParseServer, type ParseServer } from '../src/server'

let server: ParseServer | undefined, dir: string
afterEach(async () => {
  await server?.close()
  if (dir) await rm(dir, { recursive: true, force: true })
})
async function setup() {
  dir = await mkdtemp(join(tmpdir(), 'office-compat-'))
  server = await createParseServer({ dataDir: dir, token: 'test' })
  return (path: string, init?: RequestInit) =>
    fetch(server!.url + path, {
      ...init,
      headers: { Authorization: 'Bearer test', ...init?.headers },
    })
}
for (const scheme of ['agile', 'standard'])
  it(`HTTP upload decrypts real ${scheme} Word, retries passwords, and cleans temporary plaintext`, async () => {
    const request = await setup()
    const bytes = await readFile(
      new URL(
        `../../docs/tests/encrypted-fixtures/office-${scheme}-password.docx`,
        import.meta.url,
      ),
    )
    let response = await request('/v1/files', { method: 'POST', body: bytes })
    expect(response.status).toBe(415)
    expect(((await response.json()) as { code: string }).code).toBe('encrypted_document')
    response = await request('/v1/files', {
      method: 'POST',
      body: bytes,
      headers: { 'X-Office-Password': Buffer.from('wrong').toString('base64') },
    })
    expect(response.status).toBe(422)
    expect(((await response.json()) as { code: string }).code).toBe('wrong_password')
    expect(await readdir(join(dir, 'tmp'))).toEqual([])
    response = await request('/v1/files', {
      method: 'POST',
      body: bytes,
      headers: { 'X-Office-Password': Buffer.from('Password1234_').toString('base64') },
    })
    expect(response.status).toBe(201)
    const stored = (await response.json()) as { fileId: string }
    const plain = await readFile(
      new URL(`../../docs/tests/encrypted-fixtures/office-${scheme}-plain.docx`, import.meta.url),
    )
    expect(
      Buffer.from(await (await request(`/v1/files/${stored.fileId}/content`)).arrayBuffer()),
    ).toEqual(plain)
    const session = await request('/v1/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId: stored.fileId }),
    })
    expect(session.status).toBe(201)
    const { sessionId } = (await session.json()) as { sessionId: string }
    expect((await request(`/v1/sessions/${sessionId}/units/0`)).status).toBe(200)
    expect(await readdir(join(dir, 'tmp'))).toEqual([])
    expect(
      JSON.stringify(await (await request(`/v1/files/${stored.fileId}`)).json()),
    ).not.toContain('Password1234_')
  })

it('rejects invalid password encoding and unsupported containers without leaving temporary files', async () => {
  const request = await setup()
  const bytes = await readFile(
    new URL('../../docs/tests/encrypted-fixtures/office-agile-password.docx', import.meta.url),
  )
  expect(
    (
      await request('/v1/files', {
        method: 'POST',
        body: bytes,
        headers: { 'X-Office-Password': 'invalid!' },
      })
    ).status,
  ).toBe(400)
  const bad = Buffer.concat([bytes.subarray(0, 8), Buffer.alloc(504)])
  expect(
    (
      await request('/v1/files', {
        method: 'POST',
        body: bad,
        headers: { 'X-Office-Password': 'eA==' },
      })
    ).status,
  ).toBe(415)
  expect(await readdir(join(dir, 'tmp'))).toEqual([])
})

const picture = (id: number, rid: string) =>
  `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="${rid}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="1000000" y="1000000"/><a:ext cx="2000000" cy="1000000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`
for (const hostile of [false, true])
  it(`HTTP layouts and offline models reuse Electron TIFF selection and SVG colors (hostile=${hostile})`, async () => {
    const request = await setup()
    const zip = await JSZip.loadAsync(await createBlankPptx())
    const rgba = new Uint8Array(6 * 4 * 4)
    for (let i = 0; i < rgba.length; i += 4) rgba.set([220, 30, 40, 255], i)
    // Two valid pages plus an illegal first header exercise largest-page selection.
    const ifds = [
      { t256: [40000], t257: [40000] },
      {
        t256: [6],
        t257: [4],
        t258: [8, 8, 8, 8],
        t259: [1],
        t262: [2],
        t273: [2048],
        t277: [4],
        t278: [4],
        t279: [96],
        t284: [1],
        t338: [1],
      },
      {
        t256: [1],
        t257: [1],
        t258: [8, 8, 8, 8],
        t259: [1],
        t262: [2],
        t273: [2200],
        t277: [4],
        t278: [1],
        t279: [4],
        t284: [1],
        t338: [1],
      },
    ]
    const tiff = new Uint8Array(
      hostile
        ? UTIF.encode([ifds[0]] as unknown as Parameters<typeof UTIF.encode>[0])
        : new ArrayBuffer(2204),
    )
    if (!hostile) {
      tiff.set(new Uint8Array(UTIF.encode(ifds as unknown as Parameters<typeof UTIF.encode>[0])))
      tiff.set(rgba, 2048)
      tiff.set([0, 255, 0, 255], 2200)
    }
    zip.file('ppt/media/test.tif', tiff)
    zip.file(
      'ppt/media/test.svg',
      '<svg xmlns="http://www.w3.org/2000/svg" width="6" height="4"><style>.MsftOfcThm_Accent1_Fill_v2{fill:#111111;}</style><rect class="MsftOfcThm_Accent1_Fill_v2" width="6" height="4"/></svg>',
    )
    for (const [path, ending, addition] of [
      ['ppt/slides/slide1.xml', '</p:spTree>', picture(20, 'rIdTiff') + picture(21, 'rIdSvg')],
      [
        'ppt/slides/_rels/slide1.xml.rels',
        '</Relationships>',
        '<Relationship Id="rIdTiff" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/test.tif"/><Relationship Id="rIdSvg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/test.svg"/>',
      ],
      [
        '[Content_Types].xml',
        '</Types>',
        '<Default Extension="tif" ContentType="image/tiff"/><Default Extension="svg" ContentType="image/svg+xml"/>',
      ],
    ])
      zip.file(
        path!,
        (await zip.file(path!)!.async('string')).replace(ending!, addition! + ending!),
      )
    zip.file(
      'ppt/theme/theme1.xml',
      (await zip.file('ppt/theme/theme1.xml')!.async('string')).replace(
        /<a:accent1>[\s\S]*?<\/a:accent1>/,
        '<a:accent1><a:srgbClr val="7C3AED"/></a:accent1>',
      ),
    )
    const uploaded = await request('/v1/files', {
      method: 'POST',
      body: await zip.generateAsync({ type: 'nodebuffer' }),
    })
    const { fileId } = (await uploaded.json()) as { fileId: string }
    const opened = await request('/v1/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId }),
    })
    expect(opened.status).toBe(201)
    const { sessionId } = (await opened.json()) as { sessionId: string }
    const layout = (await (await request(`/v1/sessions/${sessionId}/layout/slides/0`)).json()) as {
      media: Array<[string, string]>
    }
    const media = new Map<string, string>(layout.media)
    const png = media.get('ppt/media/test.tif')
    if (hostile) expect(png).toBeUndefined()
    else {
      expect(png).toMatch(/^data:image\/png;base64,/)
      const decoded = PNG.sync.read(Buffer.from(png!.split(',')[1]!, 'base64'))
      expect([decoded.width, decoded.height]).toEqual([6, 4])
      expect(decoded.data).toEqual(Buffer.from(rgba))
    }
    expect(
      Buffer.from(media.get('ppt/media/test.svg')!.split(',')[1]!, 'base64').toString(),
    ).toContain('fill:#7C3AED')
    const tree = await (await request(`/v1/sessions/${sessionId}/units/0`)).text()
    expect(tree).toContain('data:image/svg+xml;base64,')
    const bundle = await request(`/v1/sessions/${sessionId}/bundle`)
    expect(bundle.status).toBe(200)
    const manifest = (await bundle.json()) as { resources: Array<{ path: string; href: string }> }
    const resource = manifest.resources.find((item) => item.path === 'layout/0.json')!
    expect(resource).toBeDefined()
    const replay = (await (await request(new URL(resource.href, server!.url).pathname)).json()) as {
      media: Array<[string, string]>
    }
    expect(replay.media).toEqual(layout.media)
  })
