import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { parseDocx, readSections } from '@genoffice/docx-engine'
import { buildDocx } from '../../../packages/docx-engine/tests/helpers/build-docx'
import { createParseServer } from '../src/server'

it('persists streamed note numbers, section ranges and rich header/footer parts across chunks and restart', async () => {
  const headerXml =
    '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Section header</w:t></w:r></w:p></w:hdr>'
  const footerXml =
    '<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Page </w:t></w:r><w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple></w:p></w:ftr>'
  const notes =
    '<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    [1, 9]
      .map(
        (id) =>
          `<w:footnote w:id="${id}"><w:p><w:r><w:footnoteRef/></w:r><w:r><w:t>Note ${id}</w:t></w:r></w:p></w:footnote>`,
      )
      .join('') +
    '</w:footnotes>'
  const reference = (id: number) =>
    `<w:p><w:r><w:t>Body</w:t></w:r><w:r><w:footnoteReference w:id="${id}"/></w:r></w:p>`
  const extraRels = ['header', 'footer', 'footnotes']
    .map(
      (kind, index) =>
        `<Relationship Id="context${index}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${kind}" Target="${kind === 'footnotes' ? 'footnotes' : kind + '1'}.xml"/>`,
    )
    .join('')
  const bytes = Buffer.from(
    await buildDocx({
      bodyXml:
        reference(9) +
        '<w:p><w:pPr><w:sectPr><w:headerReference w:type="default" r:id="context0"/><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:pPr></w:p>' +
        Array.from({ length: 201 }, () => '<w:p><w:r><w:t>cross chunk</w:t></w:r></w:p>').join('') +
        reference(1),
      sectPrExtra:
        '<w:footerReference w:type="default" r:id="context1"/><w:footnotePr><w:numFmt w:val="upperRoman"/><w:numRestart w:val="eachSect"/></w:footnotePr>',
      extraRels,
      extraParts: [
        {
          path: 'word/header1.xml',
          xml: headerXml,
          contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml',
        },
        {
          path: 'word/footer1.xml',
          xml: footerXml,
          contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml',
        },
        {
          path: 'word/footnotes.xml',
          xml: notes,
          contentType:
            'application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml',
        },
      ],
    }),
  )
  const expected = await parseDocx(bytes)
  const dataDir = await mkdtemp(join(tmpdir(), 'docx-context-'))
  let server = await createParseServer({ dataDir, parserFingerprint: 'reading-context-regression' })
  const request = (path: string, init?: RequestInit) => fetch(server.url + path, init)
  const open = async (fileId: string) => {
    const response = await request('/v1/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId }),
    })
    expect(response.status).toBe(201)
    return response.json() as Promise<any>
  }
  try {
    const file = (await (await request('/v1/files', { method: 'POST', body: bytes })).json()) as any
    const first = await open(file.fileId)
    expect(first.model.unitCount).toBe(2)
    expect(first.model.docx.sections).toEqual(readSections(expected))
    expect(first.model.docx.noteNumbers).toEqual(expected.noteNumbers)
    expect(first.model.docx.footnoteProps).toEqual(expected.footnoteProps)
    expect(first.model.docx.footnoteProps.numFmt).toBe('upperRoman')
    expect(first.model.docx.hfParts.context0.text).toBe('Section header')
    expect(first.model.docx.hfParts.context1.hasPageNumber).toBe(true)
    const blocks = []
    for (let index = 0; index < first.model.unitCount; index++) {
      const unit = (await (
        await request(`/v1/sessions/${first.sessionId}/units/${index}`)
      ).json()) as any
      blocks.push(...unit.blocks)
    }
    const noteRuns = (values: any[]) =>
      values
        .flatMap((block) => block.runs ?? [])
        .filter((run) => run.noteRef)
        .map((run) => [run.noteRef.id, run.text])
    expect(noteRuns(blocks)).toEqual(noteRuns(expected.blocks))
    expect(noteRuns(blocks)).toEqual([
      ['9', '1'],
      ['1', '1'],
    ])
    await server.close()
    server = await createParseServer({ dataDir, parserFingerprint: 'reading-context-regression' })
    const second = await open(file.fileId)
    expect(second.model.docx).toEqual(first.model.docx)
    const health = (await (await request('/v1/health')).json()) as any
    expect(health.artifacts.sourceParsesStarted).toBe(0)
  } finally {
    await server.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

it('rebases and signs nested header images on a v1 warm-cache open and after restart', async () => {
  const bytes = await readFile(
    new URL(
      '../../../packages/docx-engine/tests/fixtures/truths/render-hf-inline-picture/probe.docx',
      import.meta.url,
    ),
  )
  const dataDir = await mkdtemp(join(tmpdir(), 'docx-header-url-'))
  let server = await createParseServer({
    dataDir,
    token: 'header-test',
    parserFingerprint: 'header-regression',
  })
  const headers = { Authorization: 'Bearer header-test', 'Content-Type': 'application/json' }
  const request = (path: string, init?: RequestInit) =>
    fetch(server.url + path, { ...init, headers })
  const urls = (value: unknown): string[] =>
    typeof value === 'string' && value.includes('/parts/')
      ? [value]
      : value && typeof value === 'object'
        ? Object.values(value).flatMap(urls)
        : []
  try {
    const file = (await (await request('/v1/files', { method: 'POST', body: bytes })).json()) as any
    await request('/v1/sessions', { method: 'POST', body: JSON.stringify({ fileId: file.fileId }) })
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await request('/v1/sessions', {
        headers: { Prefer: 'respond-async' },
        method: 'POST',
        body: JSON.stringify({ fileId: file.fileId }),
      })
      expect(response.status).toBe(201)
      const opened = (await response.json()) as any
      const resources = [...new Set(urls(opened.model.docx))]
      expect(resources.length).toBeGreaterThan(0)
      for (const resource of resources) {
        const url = new URL(resource)
        expect(url.origin).toBe(server.url)
        expect(url.searchParams.has('sig')).toBe(true)
        const image = await fetch(url)
        expect(image.status).toBe(200)
        expect((await image.arrayBuffer()).byteLength).toBeGreaterThan(0)
      }
      if (attempt === 0) {
        await server.close()
        server = await createParseServer({
          dataDir,
          token: 'header-test',
          parserFingerprint: 'header-regression',
        })
      }
    }
  } finally {
    await server.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})
