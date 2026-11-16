/**
 * Plan §6.1/§11 target-hardware load profile:
 *   2 concurrent cold parses + 20 queued unique tasks + 50 concurrent cached
 *   reads, then 500 lightweight reading sessions.
 *
 * Records cold-parse latency, queue admission wait, cached-read p50/p95, health
 * probe latency under load, parent+child RSS peak, CPU time and artifact/disk
 * throughput. This is a local profile on the current host (reported in the JSON),
 * not a production capacity promise.
 *
 * Run: node --import tsx scripts/load-profile.mts [--slides 60] [--out /tmp/...json]
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import JSZip from 'jszip'
import { createBlankPptx } from '@genoffice/pptx-engine'
import { createParseServer } from '../src/server'

function arg(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? Number(process.argv[index + 1]) : fallback
}
const slides = arg('slides', 60)
const outIndex = process.argv.indexOf('--out')
const output =
  outIndex >= 0 ? process.argv[outIndex + 1] : join(tmpdir(), 'genoffice-load-profile.json')
const token = 'load-profile'
const COLD = 22
const QUEUED = 20
const CACHE_READERS = 50
const LIGHT_SESSIONS = 500
const corpusIndex = process.argv.indexOf('--corpus-file')
const corpusPath = corpusIndex >= 0 ? process.argv[corpusIndex + 1] : undefined
const corpusBytes = corpusPath ? await readFile(corpusPath) : undefined
const sourceSlides = corpusBytes
  ? (
      (
        await (await JSZip.loadAsync(corpusBytes)).file('ppt/presentation.xml')!.async('string')
      ).match(/<p:sldId\b/g) ?? []
    ).length
  : slides

async function multiSlidePptx(count: number, marker: string): Promise<Buffer> {
  if (corpusBytes) {
    // Change only the ZIP archive comment, preserving every business part byte.
    // Distinct source identities are necessary to exercise the cold queue.
    const end = corpusBytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
    if (end < 0 || end + 22 + corpusBytes.readUInt16LE(end + 20) !== corpusBytes.length)
      throw new Error('corpus requires a normal ZIP end record')
    const comment = Buffer.from(`genoffice-load-${marker}`)
    const result = Buffer.concat([corpusBytes.subarray(0, end + 22), comment])
    result.writeUInt16LE(comment.length, end + 20)
    return result
  }
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
    zip.file(
      `ppt/slides/slide${index}.xml`,
      slide.replace(
        '</p:sld>',
        `<p:notes><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld></p:notes></p:sld>`,
      ),
    )
    zip.file(`ppt/slides/_rels/slide${index}.xml.rels`, slideRels)
  }
  zip.file('ppt/presentation.xml', presentation.replace('</p:sldIdLst>', `${ids}</p:sldIdLst>`))
  zip.file(
    'ppt/_rels/presentation.xml.rels',
    rels.replace('</Relationships>', `${relationships}</Relationships>`),
  )
  zip.file('[Content_Types].xml', types.replace('</Types>', `${overrides}</Types>`))
  zip.file('load-marker.txt', marker)
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

const dataDir = await mkdtemp(join(tmpdir(), 'load-profile-'))
const server = await createParseServer({
  dataDir,
  token,
  maxParseJobs: 2,
  maxQueuedParseJobs: QUEUED,
  maxSessions: 800,
  sessionTtlMs: 10 * 60_000,
})
const headers = { Authorization: `Bearer ${token}` }
const jsonHeaders = { ...headers, 'Content-Type': 'application/json' }
const request = (path: string, init?: RequestInit) =>
  fetch(server.url + path, { ...init, headers: { ...headers, ...(init?.headers ?? {}) } })

const rssSamples: Array<{ parent: number; child: number; total: number }> = []
const healthLatencies: number[] = []
let healthErrors = 0
let sampling = true
const sample = (async () => {
  while (sampling) {
    const started = performance.now()
    try {
      const health = (await (await request('/v1/health')).json()) as {
        memory: { rss: number }
        childProcesses?: { rssBytes?: number }
      }
      healthLatencies.push(performance.now() - started)
      const child = Number(health.childProcesses?.rssBytes ?? 0)
      const parent = Number(health.memory.rss)
      rssSamples.push({ parent, child, total: parent + child })
    } catch {
      healthErrors++
      healthLatencies.push(performance.now() - started)
    }
    await delay(100)
  }
})()

function percentile(values: number[], p: number): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))]
}

try {
  const warm = await multiSlidePptx(slides, 'warm')
  const uploadedWarm = (await (
    await request('/v1/files', { method: 'POST', body: warm })
  ).json()) as { fileId: string }
  const warmOpened = (await (
    await request('/v1/sessions', {
      method: 'POST',
      headers: { ...jsonHeaders, Prefer: 'respond-async' },
      body: JSON.stringify({ fileId: uploadedWarm.fileId }),
    })
  ).json()) as { sessionId: string }
  // Warm the artifact fully so later reads are cache hits.
  const warmReady = Date.now()
  while (true) {
    const status = (await (await request(`/v1/sessions/${warmOpened.sessionId}`)).json()) as {
      state: string
    }
    if (status.state === 'ready') break
    if (Date.now() - warmReady > 30_000) throw new Error('warm artifact did not become ready')
    await delay(50)
  }

  // Warm-cache reads in isolation: must not start any parse at all.
  const warmParseBefore = Number(
    ((await (await request('/v1/health')).json()) as any).artifacts?.sourceParsesStarted ?? 0,
  )
  const warmReadLatencies: number[] = []
  await Promise.all(
    Array.from({ length: CACHE_READERS }, async () => {
      const started = performance.now()
      const response = await request(`/v1/sessions/${warmOpened.sessionId}/layout/slides/0`)
      warmReadLatencies.push(performance.now() - started)
      if (response.status !== 200) throw new Error(`warm cache read failed: ${response.status}`)
      await response.arrayBuffer()
    }),
  )
  const warmParseAfter = Number(
    ((await (await request('/v1/health')).json()) as any).artifacts?.sourceParsesStarted ?? 0,
  )

  const coldFiles: string[] = []
  for (let index = 0; index < COLD; index++) {
    const deck = await multiSlidePptx(slides, `cold-${index}`)
    const uploaded = (await (
      await request('/v1/files', { method: 'POST', body: deck })
    ).json()) as { fileId: string }
    coldFiles.push(uploaded.fileId)
  }

  // 50 cached reads concurrently with the cold parse/queue phase.
  const parseBefore = Number(
    ((await (await request('/v1/health')).json()) as any).artifacts?.sourceParsesStarted ?? 0,
  )
  const coldStarted = performance.now()
  const coldRequests = coldFiles.map((fileId) =>
    request('/v1/sessions', {
      method: 'POST',
      headers: { ...jsonHeaders, Prefer: 'respond-async' },
      body: JSON.stringify({ fileId }),
    }),
  )
  const readLatencies: number[] = []
  const reads = Array.from({ length: CACHE_READERS }, async () => {
    const started = performance.now()
    const response = await request(`/v1/sessions/${warmOpened.sessionId}/layout/slides/0`)
    readLatencies.push(performance.now() - started)
    if (response.status !== 200) throw new Error(`cached read failed: ${response.status}`)
    await response.arrayBuffer()
  })
  const coldResponses = await Promise.all(coldRequests)
  const opened = await Promise.all(
    coldResponses.map(async (response) => {
      if (response.status !== 202 && response.status !== 201)
        throw new Error(`cold open failed: ${response.status} ${await response.text()}`)
      return (await response.json()) as { sessionId: string }
    }),
  )
  await Promise.all(reads)
  const readPhaseMs = performance.now() - coldStarted
  const parseAfterReads = Number(
    ((await (await request('/v1/health')).json()) as any).artifacts?.sourceParsesStarted ?? 0,
  )

  // Poll every cold session concurrently while queue depth is sampled, so the
  // per-session wait includes real queue admission rather than a post-drain probe.
  const coldReadyDeadline = Date.now() + 180_000
  let peakRunning = 0
  let peakQueued = 0
  let coldDone = false
  const queueSampler = (async () => {
    while (!coldDone) {
      try {
        const state = ((await (await request('/v1/health')).json()) as any).parseQueue as {
          running: number
          queued: number
        }
        peakRunning = Math.max(peakRunning, state.running)
        peakQueued = Math.max(peakQueued, state.queued)
      } catch {
        /* a failed probe is measured by the health sampler */
      }
      await delay(50)
    }
  })()
  const readyTimes = await Promise.all(
    opened.map(async (session) => {
      const started = performance.now()
      while (true) {
        const status = (await (await request(`/v1/sessions/${session.sessionId}`)).json()) as {
          state: string
          progress?: { units?: number }
        }
        if (status.state === 'ready') return performance.now() - started
        if (status.state === 'failed' || status.state === 'cancelled')
          throw new Error(`cold session ended as ${status.state}`)
        if (Date.now() > coldReadyDeadline) throw new Error('cold session did not become ready')
        await delay(50)
      }
    }),
  )
  coldDone = true
  await queueSampler
  const coldPhaseMs = performance.now() - coldStarted

  // 500 lightweight reading sessions on the already-ready artifact.
  const lightLatencies: number[] = []
  const lightIds: string[] = []
  for (let index = 0; index < LIGHT_SESSIONS; index++) {
    const started = performance.now()
    const response = await request('/v1/sessions', {
      method: 'POST',
      headers: { ...jsonHeaders, Prefer: 'respond-async' },
      body: JSON.stringify({ fileId: uploadedWarm.fileId }),
    })
    if (response.status !== 201) throw new Error(`light session failed: ${response.status}`)
    const body = (await response.json()) as { sessionId: string }
    lightIds.push(body.sessionId)
    lightLatencies.push(performance.now() - started)
  }
  const healthAfter = (await (await request('/v1/health')).json()) as any

  const report = {
    host: {
      platform: process.platform,
      arch: process.arch,
      cores: (await import('node:os')).cpus().length,
      totalMemoryGb: Number(((await import('node:os')).totalmem() / 1024 ** 3).toFixed(1)),
      node: process.version,
      cgroup:
        process.platform === 'linux'
          ? Object.fromEntries(
              await Promise.all(
                ['cpu.max', 'memory.max', 'memory.peak', 'memory.swap.max'].map(async (name) => [
                  name,
                  (
                    await readFile(`/sys/fs/cgroup/${name}`, 'utf8').catch(() => 'unavailable')
                  ).trim(),
                ]),
              ),
            )
          : undefined,
    },
    scenario: {
      slidesPerDeck: sourceSlides,
      source: corpusPath ? 'business-corpus' : 'synthetic',
      sourceBytes: corpusBytes?.length,
      coldTasks: COLD,
      queuedTasks: QUEUED,
      cacheReaders: CACHE_READERS,
      lightSessions: LIGHT_SESSIONS,
    },
    cold: {
      wallMs: Math.round(coldPhaseMs),
      medianReadyMs: Math.round(percentile(readyTimes, 0.5)),
      p95ReadyMs: Math.round(percentile(readyTimes, 0.95)),
      peak: { running: peakRunning, queued: peakQueued },
      sourceParsesDeltaDuringReads: parseAfterReads - parseBefore,
    },
    warmCachedReads: {
      count: warmReadLatencies.length,
      p50Ms: Number(percentile(warmReadLatencies, 0.5).toFixed(2)),
      p95Ms: Number(percentile(warmReadLatencies, 0.95).toFixed(2)),
      sourceParsesDelta: warmParseAfter - warmParseBefore,
    },
    cachedReads: {
      count: readLatencies.length,
      wallMs: Math.round(readPhaseMs),
      p50Ms: Number(percentile(readLatencies, 0.5).toFixed(2)),
      p95Ms: Number(percentile(readLatencies, 0.95).toFixed(2)),
    },
    health: {
      probes: healthLatencies.length,
      errors: healthErrors,
      p50Ms: Number(percentile(healthLatencies, 0.5).toFixed(2)),
      p95Ms: Number(percentile(healthLatencies, 0.95).toFixed(2)),
      maxMs: Number(Math.max(...healthLatencies).toFixed(2)),
    },
    lightSessions: {
      count: lightIds.length,
      p50Ms: Number(percentile(lightLatencies, 0.5).toFixed(2)),
      p95Ms: Number(percentile(lightLatencies, 0.95).toFixed(2)),
      active: healthAfter.sessions,
    },
    memory: {
      peakTotalGb: Number(
        (Math.max(...rssSamples.map((item) => item.total)) / 1024 ** 3).toFixed(3),
      ),
      peakParentGb: Number(
        (Math.max(...rssSamples.map((item) => item.parent)) / 1024 ** 3).toFixed(3),
      ),
      peakChildGb: Number(
        (Math.max(...rssSamples.map((item) => item.child)) / 1024 ** 3).toFixed(3),
      ),
      samples: rssSamples.length,
    },
    cpu: {
      userSeconds: process.cpuUsage().user / 1e6,
      systemSeconds: process.cpuUsage().system / 1e6,
    },
    storage: {
      sourceBytes: healthAfter.storageBytes,
      artifactBytes: healthAfter.artifacts?.bytes ?? null,
      parseWallMs: Math.round(coldPhaseMs),
    },
  }
  await writeFile(output, JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  if (healthErrors || warmParseAfter !== warmParseBefore) process.exitCode = 1
} finally {
  sampling = false
  await sample.catch(() => undefined)
  await server.close().catch(() => undefined)
  await rm(dataDir, { recursive: true, force: true }).catch(() => undefined)
}
