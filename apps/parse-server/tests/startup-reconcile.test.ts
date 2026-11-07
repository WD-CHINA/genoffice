import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createParseServer, type ParseServer } from '../src/server'
import { PendingSessionStore } from '../src/pending-session-store'

it('startup removes aged orphan temp paths but retains fresh paths, unknown names and journal-owned chunks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'startup-reconcile-'))
  let server: ParseServer | undefined
  const old = new Date(0)
  const journal = new PendingSessionStore(dir)
  try {
    await journal.init(900_000)
    const ticket = await journal.create({
      id: randomUUID(),
      artifactKey: 'a'.repeat(64),
      fileId: 'b'.repeat(64),
      format: 'docx',
      width: 960,
      parserVersion: '0.1.0',
      parserFingerprint: 'test',
      createdAt: Date.now(),
      lastUsed: Date.now(),
      error: { status: 422, code: 'parse_failed', message: 'failed before crash' },
    })
    const oldUpload = join(dir, 'tmp', randomUUID() + '.part')
    const freshUpload = join(dir, 'tmp', randomUUID() + '.part')
    const unknownUpload = join(dir, 'tmp', 'operator-notes.txt')
    await mkdir(join(dir, 'tmp'), { recursive: true })
    for (const path of [oldUpload, freshUpload, unknownUpload])
      await writeFile(path, 'temporary bytes')
    await utimes(oldUpload, old, old)
    await utimes(unknownUpload, old, old)
    const orphanStage = join(dir, 'staging', randomUUID())
    const freshStage = join(dir, 'staging', randomUUID())
    const unknownStage = join(dir, 'staging', 'operator-notes')
    const orphanChunk = join(dir, 'chunks', randomUUID())
    const freshChunk = join(dir, 'chunks', randomUUID())
    const ownedChunk = join(dir, 'chunks', ticket.id)
    for (const path of [
      orphanStage,
      freshStage,
      unknownStage,
      orphanChunk,
      freshChunk,
      ownedChunk,
    ]) {
      await mkdir(path, { recursive: true })
      await writeFile(join(path, 'partial.bin'), 'partial data')
    }
    for (const path of [orphanStage, unknownStage, orphanChunk, ownedChunk])
      await utimes(path, old, old)
    server = await createParseServer({ dataDir: dir, parserFingerprint: 'test' })
    for (const path of [oldUpload, orphanStage, orphanChunk])
      await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
    for (const path of [
      freshUpload,
      unknownUpload,
      freshStage,
      unknownStage,
      freshChunk,
      ownedChunk,
    ])
      await expect(stat(path)).resolves.toBeDefined()
    expect((await fetch(`${server.url}/v2/sessions/${ticket.id}`)).status).toBe(200)
    await server.gc()
    await expect(stat(ownedChunk)).resolves.toBeDefined()
  } finally {
    await server?.close()
    await rm(dir, { recursive: true, force: true })
  }
})
