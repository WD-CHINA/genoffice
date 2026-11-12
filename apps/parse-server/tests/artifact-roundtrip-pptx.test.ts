import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { PptxSession } from '../src/pptx'
import { createParseServer, type ParseServer } from '../src/server'
import { roundtripFixtures } from './helpers/roundtrip-pptx-fixtures'

type Opened = { sessionId: string; fonts?: Array<{ id: string; family: string }> }
const cases: Array<{
  kind: keyof typeof roundtripFixtures
  name: string
  count: number
  check: (units: any[], opened: Opened) => void
}> = [
  {
    kind: 'multiple',
    name: 'round-trips every slide model of a multi-slide deck across a restart without re-parsing',
    count: 5,
    check: (units) => expect(units.every((unit) => unit && typeof unit === 'object')).toBe(true),
  },
  {
    kind: 'image',
    name: 'round-trips an embedded image slide model across a restart without re-parsing',
    count: 1,
    check: (units) => expect(JSON.stringify(units[0])).toContain('image1.png'),
  },
  {
    kind: 'link',
    name: 'round-trips an external hyperlink through the artifact without re-parsing',
    count: 1,
    check: (units) =>
      expect(JSON.stringify(units[0])).toContain('https://example.com/genoffice-roundtrip'),
  },
  {
    kind: 'chart',
    name: 'round-trips a bar-chart slide across a restart without re-parsing',
    count: 1,
    check: (units) => expect(JSON.stringify(units[0])).toContain('chart'),
  },
  {
    kind: 'chartex',
    name: 'round-trips a chartEx funnel slide across a restart without re-parsing',
    count: 1,
    check: (units) => expect(JSON.stringify(units[0])).toContain('Alpha'),
  },
  {
    kind: 'group',
    name: 'round-trips a group shape across a restart without re-parsing',
    count: 1,
    check: (units) => expect(JSON.stringify(units[0])).toContain('group'),
  },
  {
    kind: 'theme',
    name: 'round-trips a theme scheme color through the artifact without re-parsing',
    count: 1,
    check: (units) => expect(JSON.stringify(units[0]).toUpperCase()).toContain('FF00AA'),
  },
  {
    kind: 'animation',
    name: 'round-trips slide animation timing across a restart without re-parsing',
    count: 1,
    check: (units) => expect((units[0].playback?.animations ?? []).length).toBeGreaterThan(0),
  },
  {
    kind: 'font',
    name: 'round-trips an embedded PPTX font across a restart without re-parsing',
    count: 1,
    check: (_units, opened) =>
      expect(opened.fonts?.some((font) => font.family === 'RoundtripFont')).toBe(true),
  },
  {
    kind: 'twoThemes',
    name: 'resolves two different slide themes across the artifact round-trip',
    count: 2,
    check: (units) => {
      expect(JSON.stringify(units[0])).toContain('FF00AA')
      expect(JSON.stringify(units[1])).toContain('00AAFF')
    },
  },
]

/** Only transient URLs owned by this server are normalized; external links remain exact. */
function canonical(value: any, origin: string): any {
  if (Array.isArray(value)) return value.map((item) => canonical(item, origin))
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, canonical(item, origin)]),
    )
  if (typeof value === 'string' && value.startsWith(origin + '/v1/files/')) {
    const url = new URL(value)
    if (url.pathname.includes('/parts/')) {
      url.searchParams.delete('exp')
      url.searchParams.delete('sig')
      return url.pathname + url.search
    }
  }
  return value
}

it.each(cases)('$name', async ({ kind, count, check }) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'roundtrip-pptx-'))
  const servers: ParseServer[] = []
  const setup = async () => {
    const server = await createParseServer({
      dataDir,
      parserVersion: '0.1.0',
      parserFingerprint: 'roundtrip-matrix',
      maxParseJobs: 1,
    })
    servers.push(server)
    const json = async <T = any>(
      path: string,
      expected: number,
      init?: RequestInit,
    ): Promise<T> => {
      const response = await fetch(server.url + path, init)
      expect(response.status, await response.clone().text()).toBe(expected)
      return response.json() as Promise<T>
    }
    return {
      server,
      json,
      open: (fileId: string): Promise<Opened> =>
        json('/v1/sessions', 201, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fileId }),
        }),
      units: (id: string) =>
        Promise.all(
          Array.from({ length: count }, (_, index) =>
            json(`/v1/sessions/${id}/units/${index}`, 200),
          ),
        ),
    }
  }
  try {
    const first = await setup()
    const { fileId } = await first.json('/v1/files', 201, {
      method: 'POST',
      body: Buffer.from(await roundtripFixtures[kind]()),
    })
    const opened = await first.open(fileId)
    const original = await first.units(opened.sessionId)
    check(original, opened)
    const deleted = await fetch(`${first.server.url}/v1/sessions/${opened.sessionId}`, {
      method: 'DELETE',
    })
    expect(deleted.status).toBe(204)
    await first.server.close()
    const parse = vi.spyOn(PptxSession, 'open')
    const second = await setup()
    const reopened = await second.open(fileId)
    const restored = await second.units(reopened.sessionId)
    check(restored, reopened)
    expect(canonical(restored, second.server.url)).toEqual(canonical(original, first.server.url))
    expect(reopened.fonts).toEqual(opened.fonts)
    expect(parse).not.toHaveBeenCalled()
    expect((await second.json('/v1/health', 200)).artifacts.sourceParsesStarted).toBe(0)
  } finally {
    vi.restoreAllMocks()
    await Promise.all(servers.map((server) => server.close()))
    await rm(dataDir, { recursive: true, force: true })
  }
})
