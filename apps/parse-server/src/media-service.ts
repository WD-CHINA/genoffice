import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, open, readdir, rename, rm, stat, statfs } from 'node:fs/promises'
import { join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { MediaPreparation } from '@genoffice/parse-contract'
import type { ContentStore } from './storage'
import type { ServerLimits } from './limits'
import type { MysqlDatabase } from './mysql'
import { openFilePart } from './parts'
import { MediaCatalog, type MediaJob, type MediaResult } from './media-catalog'
import {
  hasFaststart,
  MEDIA_PROFILE,
  mediaStrategy,
  mediaStreams,
  type MediaKind,
  type MediaProbe,
} from './media-policy'
import { MEDIA_INPUT_OPTIONS, MediaError, mediaProcess } from './media-process'
import { resolveMediaOptions, type MediaOptions } from './media-options'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const HASH = /^[a-f0-9]{64}$/
async function fileHash(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(path)) hash.update(bytes)
  return hash.digest('hex')
}
async function sync(path: string) {
  const file = await open(path, 'r')
  try {
    await file.sync()
  } finally {
    await file.close()
  }
}

export class MediaService {
  readonly options
  readonly catalog: MediaCatalog
  readonly root: string
  readonly stats = {
    probes: 0,
    reused: 0,
    remuxed: 0,
    transcoded: 0,
    cacheHits: 0,
    failed: 0,
    recovered: 0,
  }
  private profile = ''
  private forcedProfile = ''
  private timer?: ReturnType<typeof setInterval>
  private flights = new Set<Promise<void>>()
  private controllers = new Set<AbortController>()
  private ticking = false
  private closed = false
  private initialized = false
  private lastGc = 0
  private lastHeartbeat = 0
  private readonly instanceId = randomUUID()
  constructor(
    private readonly input: {
      dataDir: string
      store: ContentStore
      db: MysqlDatabase
      limits: ServerLimits
      options: MediaOptions
    },
  ) {
    this.options = resolveMediaOptions(input.options)
    this.root = join(input.dataDir, 'media-cache')
    this.catalog = new MediaCatalog(input.db, this.options.leaseMs)
  }
  async init(): Promise<void> {
    if (!this.options.enabled) {
      // Rollback stops new work but keeps already-issued signed media URLs valid.
      await this.catalog.init()
      this.initialized = true
      this.timer = setInterval(() => {
        void this.tick().catch(() => undefined)
      }, 1000)
      this.timer.unref?.()
      await this.tick()
      return
    }
    const processOptions = { timeoutMs: 15_000, rssMb: this.options.workerRssMb }
    const version = await mediaProcess(this.options.ffmpeg, ['-version'], processOptions)
    const probe = await mediaProcess(this.options.ffprobe, ['-version'], processOptions)
    const encoders = await mediaProcess(
      this.options.ffmpeg,
      ['-hide_banner', '-encoders'],
      processOptions,
    )
    if (!['libx264', 'libmp3lame', ' aac '].every((name) => encoders.includes(name)))
      throw new Error('media conversion requires FFmpeg libx264, AAC and libmp3lame encoders')
    this.profile = hash(MEDIA_PROFILE + '\n' + version + '\n' + probe)
    this.forcedProfile = hash(this.profile + ':force-transcode')
    await mkdir(join(this.root, 'staging'), { recursive: true })
    await mkdir(join(this.root, 'objects'), { recursive: true })
    await this.catalog.init()
    this.initialized = true
    this.timer = setInterval(() => {
      void this.tick().catch(() => undefined)
    }, 500)
    this.timer.unref?.()
    await this.tick()
  }
  async prepare(
    fileId: string,
    partPath: string,
    kind: MediaKind,
    retry = false,
  ): Promise<MediaJob> {
    if (this.closed) throw new MediaError('media_unavailable', '媒体服务正在关闭。')
    if (
      !HASH.test(fileId) ||
      !['audio', 'video'].includes(kind) ||
      typeof partPath !== 'string' ||
      partPath.length > 1024 ||
      !/^ppt\/media\/[^/\\\0]+$/.test(partPath) ||
      partPath.includes('..')
    )
      throw new MediaError('media_invalid_request', '无效的内嵌媒体引用。')
    const source = await this.input.store.stat(fileId)
    if (source?.format !== 'pptx')
      throw new MediaError('media_source_missing', 'PPT 原文档已不存在。')
    const profile = retry ? this.forcedProfile : this.profile
    const id = hash(JSON.stringify([fileId, partPath, kind, profile]))
    const old = await this.catalog.get(id)
    if (old?.state === 'ready') {
      const result = old.cacheKey ? await this.catalog.cache(old.cacheKey) : null
      if (
        result &&
        (await this.present(result)) &&
        (await fileHash(this.path(result))) === result.sha256
      ) {
        this.stats.cacheHits++
        await this.catalog.recordHit(id)
        return { ...old, cacheHit: true }
      }
      if (result) await this.catalog.invalidate(result)
    }
    const job = await this.catalog.enqueue(
      { id, fileId, partPath, kind, profile },
      this.options.maxQueued,
      old?.state === 'ready' || (retry && old?.state === 'failed'),
    )
    void this.tick().catch(() => undefined)
    return job
  }
  path(result: MediaResult): string {
    if (!HASH.test(result.key) || !Number.isSafeInteger(result.generation) || result.generation < 1)
      throw new MediaError('media_cache_invalid', '媒体缓存无效。')
    return join(
      this.root,
      'objects',
      result.key,
      `g-${result.generation}`,
      result.kind === 'video' ? 'media.mp4' : 'media.mp3',
    )
  }
  private async present(result: MediaResult): Promise<boolean> {
    try {
      const info = await stat(this.path(result))
      if (info.isFile() && info.size === result.bytes) return true
    } catch {
      /* Invalidate the exact generation only. */
    }
    await this.catalog.invalidate(result)
    return false
  }
  async status(
    fileId: string,
    id: string,
  ): Promise<{ dto: MediaPreparation; result?: MediaResult } | null> {
    if (!HASH.test(id)) return null
    const job = await this.catalog.get(id)
    if (!job || job.fileId !== fileId) return null
    const dto: MediaPreparation = {
      jobId: id,
      state: job.state,
      stage: job.stage as MediaPreparation['stage'],
      progress: job.progress,
      kind: job.kind,
      ...(job.errorCode ? { errorCode: job.errorCode } : {}),
    }
    if (job.state !== 'ready') return { dto }
    const result = job.cacheKey ? await this.catalog.cache(job.cacheKey) : null
    if (!result || !(await this.present(result))) {
      dto.state = 'failed'
      dto.stage = 'failed'
      dto.errorCode = 'media_cache_missing'
      return { dto }
    }
    return {
      dto: {
        ...dto,
        strategy: result.strategy,
        cacheHit: job.cacheHit,
        mime: result.mime,
        bytes: result.bytes,
        sha256: result.sha256,
        sourceSha256: result.sourceSha256,
        profile: job.profile,
      },
      result,
    }
  }
  private async tick(): Promise<void> {
    if (this.ticking || this.closed) return
    this.ticking = true
    try {
      if (!this.options.enabled) {
        if (Date.now() - this.lastHeartbeat > this.options.leaseMs / 3) {
          await this.catalog.retireUnsupported()
          this.lastHeartbeat = Date.now()
        }
        return
      }
      if (Date.now() - this.lastHeartbeat > this.options.leaseMs / 3) {
        await this.catalog.maintain(this.instanceId, [this.profile, this.forcedProfile])
        this.lastHeartbeat = Date.now()
      }
      if (Date.now() - this.lastGc > 60_000) {
        this.lastGc = Date.now()
        await this.collect()
      }
      while (!this.closed && this.flights.size < this.options.concurrency) {
        const free = await statfs(this.root)
        if (
          free.bavail * free.bsize <
          this.options.maxInputBytes + this.options.maxOutputBytes + 64 * 1024 ** 2
        )
          return
        const job = await this.catalog.claim(
          [this.profile, this.forcedProfile],
          randomUUID(),
          this.options.concurrency,
          this.options.maxCacheBytes,
          this.options.maxInputBytes + this.options.maxOutputBytes,
          this.options.maxCacheEntries,
        )
        if (job && this.closed) {
          await this.catalog.release(job)
          break
        }
        if (!job) {
          const snapshot = await this.catalog.snapshot()
          if (snapshot.jobs.queued && !snapshot.jobs.processing) await this.collectCache()
          break
        }
        const flight = this.work(job)
          .catch(() => undefined)
          .finally(() => this.flights.delete(flight))
        this.flights.add(flight)
      }
    } finally {
      this.ticking = false
    }
  }
  private async probe(path: string, signal: AbortSignal): Promise<MediaProbe> {
    this.stats.probes++
    return JSON.parse(
      await mediaProcess(
        this.options.ffprobe,
        [
          '-v',
          'error',
          ...MEDIA_INPUT_OPTIONS,
          '-show_format',
          '-show_streams',
          '-of',
          'json',
          path,
        ],
        { signal, timeoutMs: 30_000, rssMb: this.options.workerRssMb },
      ),
    ) as MediaProbe
  }
  private async work(job: MediaJob): Promise<void> {
    const controller = new AbortController()
    this.controllers.add(controller)
    const signal = controller.signal
    const deadline = setTimeout(
      () => controller.abort(new MediaError('media_timeout', '媒体处理超时。')),
      this.options.timeoutMs,
    )
    let cacheKey: string | undefined
    let claimedCache: string | undefined
    let destination: string | undefined
    let published = false
    let renewBusy = false
    const heartbeat = setInterval(
      () => {
        if (renewBusy) return
        renewBusy = true
        void this.catalog
          .renew(job, claimedCache)
          .then(
            (ok) => {
              if (!ok) controller.abort()
            },
            () => controller.abort(),
          )
          .finally(() => {
            renewBusy = false
          })
      },
      Math.floor(this.options.leaseMs / 3),
    )
    const staging = join(this.root, 'staging', `${job.id}-${job.owner}`)
    try {
      if (job.attempts > 1) this.stats.recovered++
      await mkdir(staging, { recursive: true })
      const source = await this.input.store.pathOf(job.fileId)
      if (!source) throw new MediaError('media_source_missing', '原文档已不存在。')
      const part = await openFilePart(source, job.partPath, this.input.limits)
      if (!part || 'invalidRange' in part)
        throw new MediaError('media_source_missing', '文档未嵌入该媒体。')
      if (part.size > this.options.maxInputBytes) {
        part.stream.destroy()
        throw new MediaError('media_input_limit', '媒体大小超过处理限制。')
      }
      const inputPath = join(staging, 'input')
      let bytes = 0
      const sourceHash = createHash('sha256')
      const meter = new Transform({
        transform: (chunk: Buffer, _encoding, done) => {
          bytes += chunk.length
          if (bytes > this.options.maxInputBytes || bytes > part.size)
            done(new MediaError('media_input_limit', '媒体大小超过处理限制。'))
          else {
            sourceHash.update(chunk)
            done(null, chunk)
          }
        },
      })
      await pipeline(part.stream, meter, createWriteStream(inputPath, { flags: 'wx' }), { signal })
      if (bytes !== part.size) throw new MediaError('media_invalid', '内嵌媒体数据不完整。')
      const sha = sourceHash.digest('hex')
      cacheKey = hash(JSON.stringify([sha, job.kind, job.profile]))
      const cached = await this.catalog.cache(cacheKey)
      if (
        cached &&
        (await this.present(cached)) &&
        (await fileHash(this.path(cached))) === cached.sha256
      ) {
        this.stats.cacheHits++
        await this.catalog.finish(job, cacheKey)
        return
      }
      if (cached) await this.catalog.invalidate(cached)
      const generation = await this.catalog.claimCache(cacheKey, job.owner!)
      if (generation === null) {
        await this.catalog.release(job)
        return
      }
      claimedCache = cacheKey
      const probe = await this.probe(inputPath, signal)
      const streams = mediaStreams(probe, job.kind)
      const strategy =
        job.profile === this.forcedProfile
          ? 'transcode'
          : mediaStrategy(probe, job.kind, await hasFaststart(inputPath))
      const name = job.kind === 'video' ? 'media.mp4' : 'media.mp3'
      const outputPath = join(staging, name)
      if (strategy === 'reuse') {
        if (bytes > this.options.maxOutputBytes)
          throw new MediaError('media_output_limit', '媒体大小超过输出限制。')
        await rename(inputPath, outputPath)
        this.stats.reused++
      } else {
        await this.catalog.progress(job, 'converting', 1)
        const args = [
          '-nostdin',
          '-v',
          'error',
          '-y',
          '-filter_threads',
          '1',
          '-threads',
          '2',
          ...MEDIA_INPUT_OPTIONS,
          '-i',
          inputPath,
        ]
        if (job.kind === 'video') {
          args.push('-map', '0:' + streams.video!.index)
          if (streams.audio) args.push('-map', '0:' + streams.audio.index)
          args.push('-sn', '-dn')
          if (strategy === 'remux') args.push('-c', 'copy')
          else {
            const [num, den] = (streams.video!.avg_frame_rate ?? '30/1').split('/').map(Number)
            const sourceFps = num! / den!
            const fps = Number.isFinite(sourceFps) && sourceFps > 0 ? Math.min(30, sourceFps) : 30
            // Pixel format alone does not reset full-range metadata inherited from the input.
            args.push(
              '-c:v',
              'libx264',
              '-preset',
              'fast',
              '-crf',
              '23',
              '-threads',
              '2',
              '-pix_fmt',
              'yuv420p',
              '-profile:v',
              'high',
              '-level:v',
              '4.1',
              '-vf',
              `scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2:out_range=tv,fps=${fps.toFixed(6)}`,
              '-color_range',
              'tv',
              '-c:a',
              'aac',
              '-profile:a',
              'aac_low',
              '-b:a',
              '128k',
              '-ac',
              '2',
            )
          }
          args.push('-movflags', '+faststart')
        } else {
          args.push(
            '-map',
            '0:' + streams.audio!.index,
            '-vn',
            '-sn',
            '-dn',
            '-c:a',
            strategy === 'remux' ? 'copy' : 'libmp3lame',
          )
          if (strategy === 'transcode') args.push('-b:a', '192k', '-ar', '44100', '-ac', '2')
        }
        args.push(
          '-fs',
          String(this.options.maxOutputBytes),
          '-progress',
          'pipe:1',
          '-nostats',
          outputPath,
        )
        let progress = '',
          last = 0
        await mediaProcess(this.options.ffmpeg, args, {
          signal,
          timeoutMs: this.options.timeoutMs,
          rssMb: this.options.workerRssMb,
          onProgress: (text) => {
            progress = (progress + text).slice(-8192)
            const matches = [...progress.matchAll(/out_time_us=(\d+)/g)]
            const value =
              Number(matches.at(-1)?.[1] ?? 0) / (Number(probe.format.duration) * 1_000_000)
            if (Date.now() - last > 1000) {
              last = Date.now()
              void this.catalog
                .progress(job, 'converting', Math.min(94, Math.floor(value * 94)))
                .catch(() => undefined)
            }
          },
        })
        const info = await stat(outputPath)
        if (
          info.size >=
          this.options.maxOutputBytes - Math.min(65536, this.options.maxOutputBytes / 100)
        )
          throw new MediaError('media_output_limit', '媒体大小超过输出限制。')
        await this.catalog.progress(job, 'verifying', 95)
        const output = await this.probe(outputPath, signal)
        const after = mediaStreams(output, job.kind)
        if (
          (job.kind === 'video' &&
            (!after.video ||
              after.video.codec_name !== 'h264' ||
              !(await hasFaststart(outputPath)) ||
              Boolean(streams.audio) !== Boolean(after.audio))) ||
          (job.kind === 'video' &&
            strategy === 'transcode' &&
            (after.video!.pix_fmt !== 'yuv420p' ||
              (after.video!.level ?? 999) > 41 ||
              (after.video!.width ?? 0) > 1920 ||
              (after.video!.height ?? 0) > 1080)) ||
          (after.audio && after.audio.codec_name !== (job.kind === 'video' ? 'aac' : 'mp3')) ||
          Math.abs(Number(probe.format.duration) - Number(output.format.duration)) >
            Math.max(0.15, Number(probe.format.duration) * 0.01)
        )
          throw new MediaError('media_output_invalid', '转换后的媒体校验失败。')
        await mediaProcess(
          this.options.ffmpeg,
          [
            '-nostdin',
            '-v',
            'error',
            '-xerror',
            '-threads',
            '2',
            ...MEDIA_INPUT_OPTIONS,
            '-i',
            outputPath,
            '-f',
            'null',
            '-',
          ],
          { signal, timeoutMs: this.options.timeoutMs, rssMb: this.options.workerRssMb },
        )
        if (strategy === 'remux') this.stats.remuxed++
        else this.stats.transcoded++
      }
      signal.throwIfAborted()
      const result: MediaResult = {
        key: cacheKey,
        generation,
        sourceSha256: sha,
        sha256: await fileHash(outputPath),
        kind: job.kind,
        mime: job.kind === 'video' ? 'video/mp4' : 'audio/mpeg',
        bytes: (await stat(outputPath)).size,
        duration: Number(probe.format.duration),
        strategy,
      }
      await sync(outputPath)
      destination = join(this.root, 'objects', cacheKey, `g-${generation}`)
      await mkdir(join(this.root, 'objects', cacheKey), { recursive: true })
      // Strip input scratch before atomically publishing the immutable generation.
      await rm(inputPath, { force: true })
      await rename(staging, destination)
      await sync(destination)
      await sync(join(this.root, 'objects', cacheKey))
      await sync(join(this.root, 'objects'))
      signal.throwIfAborted()
      published = await this.catalog.publish(job, result)
      if (!published) throw new MediaError('media_lease_lost', '媒体任务租约已失效。')
      for (const previous of await readdir(join(this.root, 'objects', cacheKey)))
        if (/^g-\d+$/.test(previous) && Number(previous.slice(2)) < generation)
          await rm(join(this.root, 'objects', cacheKey, previous), { recursive: true, force: true })
    } catch (error) {
      this.stats.failed++
      const code = signal.aborted
        ? signal.reason instanceof MediaError
          ? signal.reason.code
          : undefined
        : error instanceof MediaError
          ? error.code
          : (error as { code?: string }).code === 'media_invalid'
            ? 'media_invalid'
            : 'media_processing_failed'
      await this.catalog.release(job, code).catch(() => undefined)
    } finally {
      clearInterval(heartbeat)
      clearTimeout(deadline)
      this.controllers.delete(controller)
      await rm(staging, { recursive: true, force: true }).catch(() => undefined)
      if (destination && !published)
        await rm(destination, { recursive: true, force: true }).catch(() => undefined)
    }
  }
  private async collectCache(): Promise<void> {
    await this.catalog.collect(
      this.options.cacheTtlMs,
      this.options.maxCacheBytes,
      this.options.concurrency * (this.options.maxInputBytes + this.options.maxOutputBytes),
      (key) => rm(join(this.root, 'objects', key), { recursive: true, force: true }),
      this.options.maxCacheEntries,
    )
  }
  private async collect(): Promise<void> {
    await this.collectCache()
    // Recover scratch/output left by SIGKILL; fresh or live generations are protected.
    for (const entry of await readdir(join(this.root, 'staging'), { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-f0-9]{64}-[a-f0-9-]{36}$/.test(entry.name)) continue
      const path = join(this.root, 'staging', entry.name)
      if (
        (await stat(path)).mtimeMs < Date.now() - this.options.leaseMs * 3 &&
        !(await this.catalog.active(entry.name.slice(0, 64), entry.name.slice(65)))
      )
        await rm(path, { recursive: true, force: true })
    }
    const generations = await this.catalog.generations()
    for (const entry of await readdir(join(this.root, 'objects'), { withFileTypes: true })) {
      if (!entry.isDirectory() || !HASH.test(entry.name)) continue
      const current = generations.get(entry.name)
      const directory = join(this.root, 'objects', entry.name)
      for (const child of await readdir(directory, { withFileTypes: true })) {
        if (!child.isDirectory() || !/^g-\d+$/.test(child.name)) continue
        if (current !== undefined && Number(child.name.slice(2)) === current) continue
        const path = join(directory, child.name)
        if ((await stat(path)).mtimeMs < Date.now() - this.options.leaseMs * 3)
          await rm(path, { recursive: true, force: true })
      }
    }
  }
  async close(): Promise<void> {
    this.closed = true
    clearInterval(this.timer)
    for (const controller of this.controllers) controller.abort()
    while (this.ticking) await new Promise((resolve) => setTimeout(resolve, 10))
    await Promise.allSettled([...this.flights])
    if (this.initialized) await this.catalog.unregister(this.instanceId).catch(() => undefined)
  }
}
