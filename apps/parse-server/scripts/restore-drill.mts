/**
 * Cross-machine-style recovery drill (plan §9/§10/P4):
 *   1. build source files, library entries and ready artifacts on machine A dir
 *   2. snapshot a backup manifest (filesystem catalog)
 *   3. copy the whole data dir to a second, independent directory (machine B)
 *   4. verify the manifest against B (read-only) and boot a server with the
 *      restore gate; cached reads must work with zero new parses
 *   5. tamper with B's copy and prove the same verification fails closed
 *
 * The second "machine" is another directory on the same host: it exercises
 * copy/restore semantics, not physical disk/OS portability.
 *
 * Run: node --import tsx scripts/restore-drill.mts [--out /tmp/restore-drill.json]
 */
import { appendFile, cp, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import JSZip from 'jszip'
import { createBlankPptx } from '@genoffice/pptx-engine'
import { createParseServer, type ParseServer } from '../src/server'
import { createBackupManifest, verifyRestore } from '../src/backup-manifest'

const token = 'restore-drill'
const outIndex = process.argv.indexOf('--out')
const output =
  outIndex >= 0 ? process.argv[outIndex + 1] : join(tmpdir(), 'genoffice-restore-drill.json')
const headers = { Authorization: `Bearer ${token}` }
const jsonHeaders = { ...headers, 'Content-Type': 'application/json' }

async function multiSlidePptx(count: number, marker: string): Promise<Buffer> {
  const zip = await JSZip.loadAsync(await createBlankPptx())
  const presentation = await zip.file('ppt/presentation.xml')!.async('string')
  const rels = await zip.file('ppt/_rels/presentation.xml.rels')!.async('string')
  const types = await zip.file('[Content_Types].xml')!.async('string')
  const slide = await zip.file('ppt/slides/slide1.xml')!.async('string')
  const slideRels = await zip.file('ppt/slides/_rels/slide1.xml.rels')!.async('string')
  let ids = ''
  let relationships = ''
  let overrides = ''
  for (let index = 2; index <= count; index++) {
    ids += `<p:sldId id="${255 + index}" r:id="rId${index + 1}"/>`
    relationships += `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index}.xml"/>`
    overrides += `<Override PartName="/ppt/slides/slide${index}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`
    zip.file(`ppt/slides/slide${index}.xml`, slide)
    zip.file(`ppt/slides/_rels/slide${index}.xml.rels`, slideRels)
  }
  zip.file('ppt/presentation.xml', presentation.replace('</p:sldIdLst>', `${ids}</p:sldIdLst>`))
  zip.file(
    'ppt/_rels/presentation.xml.rels',
    rels.replace('</Relationships>', `${relationships}</Relationships>`),
  )
  zip.file('[Content_Types].xml', types.replace('</Types>', `${overrides}</Types>`))
  zip.file('restore-marker.txt', marker)
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

async function upload(server: ParseServer, deck: Buffer): Promise<string> {
  const response = await fetch(server.url + '/v1/files', { method: 'POST', headers, body: deck })
  if (response.status !== 201) throw new Error(`upload failed: ${response.status}`)
  return ((await response.json()) as { fileId: string }).fileId
}

async function openReady(
  server: ParseServer,
  fileId: string,
): Promise<{ sessionId: string; sourceParses: number }> {
  const opened = await fetch(server.url + '/v1/sessions', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ fileId }),
  })
  if (opened.status !== 202 && opened.status !== 201)
    throw new Error(`open failed: ${opened.status} ${await opened.text()}`)
  const { sessionId } = (await opened.json()) as { sessionId: string }
  const deadline = Date.now() + 60_000
  while (true) {
    const status = (await (
      await fetch(`${server.url}/v1/sessions/${sessionId}`, { headers })
    ).json()) as {
      state: string
    }
    if (status.state === 'ready') break
    if (status.state === 'failed' || status.state === 'cancelled')
      throw new Error(`session ended as ${status.state}`)
    if (Date.now() > deadline) throw new Error('session did not become ready')
    await delay(50)
  }
  const health = (await (await fetch(server.url + '/v1/health', { headers })).json()) as any
  return { sessionId, sourceParses: Number(health.artifacts?.sourceParsesStarted ?? 0) }
}

const root = await mkdtemp(join(tmpdir(), 'restore-drill-'))
const dataA = join(root, 'machine-a')
const dataB = join(root, 'machine-b')
const dataC = join(root, 'machine-c')
let serverA: ParseServer | undefined
let serverB: ParseServer | undefined
try {
  serverA = await createParseServer({
    dataDir: dataA,
    token,
    parserVersion: '0.1.0',
    parserFingerprint: 'restore-drill',
  })
  const deckA = await multiSlidePptx(30, 'restore-a')
  const deckB = await multiSlidePptx(12, 'restore-b')
  const fileA = await upload(serverA, deckA)
  const fileB = await upload(serverA, deckB)
  const builtA = await openReady(serverA, fileA)
  const builtB = await openReady(serverA, fileB)
  // Save history so the restore also has to preserve library rows and pins.
  for (const fileId of [fileA, fileB]) {
    const saved = await fetch(serverA.url + '/v1/library', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ fileId }),
    })
    if (saved.status !== 201) throw new Error(`library save failed: ${saved.status}`)
  }
  const unitA = await fetch(
    `${serverA.url}/v1/sessions/${builtA.sessionId}/units/0?representation=model`,
    { headers },
  )
  const unitBefore = (await unitA.json()) as unknown
  await serverA.close()
  serverA = undefined

  const manifest = await createBackupManifest({ dataDir: dataA })
  await cp(dataA, dataB, { recursive: true })

  const readOnlyVerify = await verifyRestore({ dataDir: dataB, manifest, invalidate: false })
  if (!readOnlyVerify.ok || !readOnlyVerify.readyAllowed)
    throw new Error(`restore verification failed: ${JSON.stringify(readOnlyVerify.errors)}`)

  serverB = await createParseServer({
    dataDir: dataB,
    token,
    parserVersion: '0.1.0',
    parserFingerprint: 'restore-drill',
    restoreCheck: { manifest, deep: true },
  })
  const healthB = (await (await fetch(serverB.url + '/v1/health', { headers })).json()) as any
  if (!healthB.restore?.ok || !healthB.restore?.readyAllowed)
    throw new Error('restore gate did not report a verified target')
  const parsesBefore = Number(healthB.artifacts?.sourceParsesStarted ?? 0)
  const reopened = await fetch(serverB.url + '/v1/sessions', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ fileId: fileA }),
  })
  if (reopened.status !== 201 && reopened.status !== 202)
    throw new Error(`reopen failed: ${reopened.status} ${await reopened.text()}`)
  const reopenedBody = (await reopened.json()) as { sessionId: string; state?: string }
  const deadline = Date.now() + 30_000
  while (true) {
    const status = (await (
      await fetch(`${serverB.url}/v1/sessions/${reopenedBody.sessionId}`, { headers })
    ).json()) as {
      state: string
    }
    if (status.state === 'ready') break
    if (Date.now() > deadline) throw new Error('reopened session did not become ready')
    await delay(50)
  }
  const unitAfterResponse = await fetch(
    `${serverB.url}/v1/sessions/${reopenedBody.sessionId}/units/0?representation=model`,
    { headers },
  )
  const unitAfter = (await unitAfterResponse.json()) as unknown
  const healthAfter = (await (await fetch(serverB.url + '/v1/health', { headers })).json()) as any
  const library = (await (await fetch(serverB.url + '/v1/library', { headers })).json()) as {
    items?: unknown[]
  }
  await serverB.close()
  serverB = undefined

  // Machine C: a damaged source file must fail the drill closed.
  await cp(dataB, dataC, { recursive: true })
  const sourceEntry = manifest.entries.find((entry) => entry.kind === 'source')
  if (!sourceEntry) throw new Error('manifest has no source bytes to tamper with')
  await appendFile(join(dataC, sourceEntry.path), Buffer.from('tampered'))
  const tamperedSource = await verifyRestore({ dataDir: dataC, manifest, invalidate: false })

  // Machine D: derived artifact bytes are rebuildable, so a bad generation is a
  // warning (plus ready-pointer withdrawal on catalog backends), not a fatal
  // source loss. On the filesystem backend there are no SQL ready pointers.
  const dataD = join(root, 'machine-d')
  await cp(dataB, dataD, { recursive: true })
  const artifactEntry = manifest.entries.find((entry) => entry.kind === 'artifact')
  if (!artifactEntry) throw new Error('manifest has no artifact bytes to tamper with')
  await appendFile(join(dataD, artifactEntry.path), Buffer.from('tampered'))
  const tamperedArtifact = await verifyRestore({ dataDir: dataD, manifest, invalidate: false })

  const report = {
    host: { platform: process.platform, arch: process.arch, node: process.version },
    machineA: {
      dataDir: dataA,
      files: [fileA, fileB],
      sessions: [builtA.sessionId, builtB.sessionId],
    },
    manifest: {
      digest: manifest.digest,
      entries: manifest.entries.length,
      sourceFiles: manifest.entries.filter((entry) => entry.kind === 'source').length,
      artifactFiles: manifest.entries.filter((entry) => entry.kind === 'artifact').length,
      libraryRows: manifest.catalog.library.length,
      artifactRows: manifest.catalog.artifacts.length,
    },
    restore: {
      readOnly: {
        ok: readOnlyVerify.ok,
        readyAllowed: readOnlyVerify.readyAllowed,
        verifiedBytes: readOnlyVerify.counts.verifiedBytes,
        readyPointers: readOnlyVerify.counts.readyPointers,
      },
      gate: {
        ok: healthB.restore.ok,
        readyAllowed: healthB.restore.readyAllowed,
        digest: healthB.restore.digest,
      },
      cachedReopen: {
        state: 'ready',
        sourceParsesDelta: Number(healthAfter.artifacts?.sourceParsesStarted ?? 0) - parsesBefore,
        unitMatches: JSON.stringify(unitAfter) === JSON.stringify(unitBefore),
        libraryEntries: library.items?.length ?? 0,
      },
    },
    tamperedSource: {
      ok: tamperedSource.ok,
      readyAllowed: tamperedSource.readyAllowed,
      errorCodes: tamperedSource.errors.map((issue) => issue.code).slice(0, 5),
    },
    tamperedArtifact: {
      ok: tamperedArtifact.ok,
      readyAllowed: tamperedArtifact.readyAllowed,
      warnings: tamperedArtifact.warnings.map((issue) => issue.code).slice(0, 5),
      blockedReady: tamperedArtifact.blockedReady.length,
    },
  }
  await writeFile(output, JSON.stringify(report, null, 2))
  if (report.restore.cachedReopen.sourceParsesDelta !== 0)
    throw new Error('cached reopen parsed the source again after restore')
  if (report.restore.cachedReopen.unitMatches !== true)
    throw new Error('restored unit differs from the source read')
  if (report.tamperedSource.ok || report.tamperedSource.readyAllowed)
    throw new Error('tampered source was not rejected')
  if (!report.tamperedArtifact.ok || report.tamperedArtifact.warnings.length === 0)
    throw new Error('rebuildable artifact damage was not reported as a warning')
  console.log(JSON.stringify(report, null, 2))
} finally {
  await serverA?.close().catch(() => undefined)
  await serverB?.close().catch(() => undefined)
  await rm(root, { recursive: true, force: true }).catch(() => undefined)
}
