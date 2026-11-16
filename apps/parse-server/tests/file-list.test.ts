import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createParseServer, type ParseServer } from '../src/server'
const dirs: string[] = [],
  servers: ParseServer[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})
it('lists saved and unsaved uploads with stable same-timestamp paging and current library names', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'file-list-'))
  dirs.push(dataDir)
  let server = await createParseServer({ dataDir, token: 'secret' })
  servers.push(server)
  const request = (path: string, init?: RequestInit) =>
    fetch(server.url + path, {
      ...init,
      headers: { Authorization: 'Bearer secret', ...init?.headers },
    })
  expect((await request('/v1/files')).status).toBe(200)
  expect(await (await request('/v1/files')).json()).toEqual({ items: [] })
  const files: string[] = []
  const createdAt = new Date().toISOString()
  for (let i = 0; i < 4; i++) {
    const uploaded = await request('/v1/files', {
      method: 'POST',
      body: Buffer.from(`%PDF-1.7\nlist-${i}\n%%EOF\n`),
    })
    expect(uploaded.status).toBe(201)
    const { fileId } = (await uploaded.json()) as { fileId: string }
    files.push(fileId)
    const path = join(dataDir, 'meta', fileId + '.json')
    const meta = JSON.parse(await readFile(path, 'utf8'))
    meta.createdAt = createdAt
    await writeFile(path, JSON.stringify(meta))
  }
  await request('/v1/library', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileId: files[0], displayName: '课时计划.pdf' }),
  })
  const sorted = [...files].sort(),
    seen: any[] = []
  let cursor: string | undefined
  do {
    const response = await request(
      '/v1/files?' + new URLSearchParams({ limit: '1', ...(cursor ? { cursor } : {}) }),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    const page = (await response.json()) as { items: any[]; next?: string }
    expect(page.items).toHaveLength(1)
    seen.push(...page.items)
    cursor = page.next
  } while (cursor)
  expect(seen.map((item) => item.fileId)).toEqual(sorted)
  expect(seen.find((item) => item.fileId === files[0]).displayName).toBe('课时计划.pdf')
  expect(seen.every((item) => item.format === 'pdf' && item.size > 0)).toBe(true)
  const first = (await (await request('/v1/files?limit=1')).json()) as { next: string }
  const removed = sorted.find((id) => id !== files[0] && id !== sorted[0])!
  await request('/v1/files/' + removed, { method: 'DELETE' })
  const next = (await (
    await request('/v1/files?' + new URLSearchParams({ limit: '100', cursor: first.next }))
  ).json()) as { items: any[] }
  expect(next.items.map((item) => item.fileId)).toEqual(
    sorted.slice(1).filter((id) => id !== removed),
  )
  const port = server.port
  await server.close()
  server = await createParseServer({ dataDir, port, token: 'secret' })
  servers.push(server)
  const restarted = (await (await request('/v1/files')).json()) as { items: any[] }
  expect(restarted.items).toHaveLength(3)
})
it('requires bearer auth and rejects invalid pagination without falling back to an unbounded list', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'file-list-auth-'))
  dirs.push(dataDir)
  const server = await createParseServer({ dataDir, token: 'secret' })
  servers.push(server)
  expect((await fetch(server.url + '/v1/files')).status).toBe(401)
  for (const query of [
    'limit=0',
    'limit=101',
    'limit=-1',
    'limit=1.5',
    'cursor=',
    'cursor=bad',
    'cursor=' + Buffer.from('["bad-date","x"]').toString('base64url'),
  ]) {
    expect(
      (
        await fetch(server.url + '/v1/files?' + query, {
          headers: { Authorization: 'Bearer secret' },
        })
      ).status,
    ).toBe(400)
  }
})
