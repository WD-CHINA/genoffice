import { logEvent } from './telemetry'
import { fork, execFile, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { readFile, writeFile, mkdir, rmdir, statfs } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'

const exec = promisify(execFile)
export interface ProcessLimits {
  signal?: AbortSignal
  heapMb: number
  rssMb?: number
  sampleMs?: number
  cgroupRoot?: string
  lifetimeMs?: number
  taskId?: string
  groupId?: string
}
export class ProcessBudgetError extends Error {
  readonly code = 'parse_memory_limit'
}

/** Sample externally: a CPU-bound parser cannot prevent its own memory check. */
export async function processRss(pid: number): Promise<number | null> {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('invalid parser pid')
  try {
    if (process.platform === 'linux') {
      const status = await readFile(`/proc/${pid}/status`, 'utf8')
      const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status)
      return match ? Number(match[1]) * 1024 : null
    }
    const { stdout } =
      process.platform === 'win32'
        ? await exec(
            'powershell.exe',
            [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              `(Get-Process -Id ${pid} -ErrorAction Stop).WorkingSet64`,
            ],
            { timeout: 2000, maxBuffer: 8192 },
          )
        : await exec('ps', ['-o', 'rss=', '-p', String(pid)], { timeout: 2000, maxBuffer: 8192 })
    const text = stdout.trim()
    const value = Number(text)
    if (!/^\d+$/.test(text) || !Number.isFinite(value) || value < 0)
      throw new Error('invalid parser RSS sample')
    return process.platform === 'win32' ? value : value * 1024
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' && process.platform === 'linux') return null
    if ((error as { code?: unknown }).code === 1) {
      try {
        process.kill(pid, 0)
      } catch (probe) {
        if ((probe as NodeJS.ErrnoException).code === 'ESRCH') return null
      }
    }
    throw error
  }
}

const liveWorkers = new Set<IsolatedWorker>()
export function isolatedMemory(groupId: string): { processes: number; rssBytes: number } {
  const members = [...liveWorkers].filter((worker) => worker.groupId === groupId)
  return {
    processes: members.length,
    rssBytes: members.reduce((sum, worker) => sum + worker.rssBytes, 0),
  }
}

/** Forked parser with advanced IPC, V8 heap cap and an external RSS watchdog. */
export class IsolatedWorker extends EventEmitter {
  private readonly child: ChildProcess
  private readonly closed: Promise<number | null>
  private resolveClosed!: (code: number | null) => void
  private readonly pending: unknown[] = []
  private readonly limitBytes: number
  private timer?: NodeJS.Timeout
  private lifetime?: NodeJS.Timeout
  private preparation?: Promise<void>
  private sampling = false
  private loaded = false
  private stopping = false
  private finished = false
  private failure?: Error
  private stderr = ''
  private cgroup?: string
  rssBytes = 0
  peakRssBytes = 0
  get groupId(): string | undefined {
    return this.limits.groupId
  }
  get pid(): number | undefined {
    return this.child.pid
  }

  constructor(
    entry: URL,
    private readonly limits: ProcessLimits,
  ) {
    super()
    limits.signal?.throwIfAborted()
    const rssMb = limits.rssMb ?? 4096
    const sampleMs = limits.sampleMs ?? 250
    if (
      !Number.isSafeInteger(limits.heapMb) ||
      limits.heapMb < 8 ||
      !Number.isSafeInteger(rssMb) ||
      rssMb < 16 ||
      limits.heapMb >= rssMb ||
      !Number.isSafeInteger(sampleMs) ||
      sampleMs < 10 ||
      sampleMs > 5000 ||
      !Number.isSafeInteger(limits.lifetimeMs ?? 600_000) ||
      (limits.lifetimeMs ?? 600_000) < 1
    ) {
      throw new Error('invalid parser process memory limits')
    }
    if (limits.cgroupRoot && process.platform !== 'linux')
      throw new Error('parser cgroups require Linux')
    this.limitBytes = rssMb * 1024 ** 2
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve
    })
    this.child = fork(
      fileURLToPath(new URL('./process-bootstrap.mjs', import.meta.url)),
      [entry.href],
      {
        execArgv: [`--max-old-space-size=${limits.heapMb}`],
        serialization: 'advanced',
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      },
    )
    liveWorkers.add(this)
    this.child.stderr?.on('data', (bytes: Buffer) => {
      this.stderr = (this.stderr + bytes.toString()).slice(-8192)
    })
    this.child.on('error', (error) => this.fail(error))
    this.child.on('message', (message: any) => {
      if (message?.type === 'bootstrap_ready') {
        this.preparation = this.prepare().catch(() => {
          const error = new Error('cannot enforce parser memory monitoring') as Error & {
            code: string
          }
          error.code = 'parse_memory_monitor_failed'
          this.fail(error)
        })
      } else if (message?.type === 'bootstrap_loaded') {
        this.loaded = true
        for (const value of this.pending.splice(0)) this.send(value)
      } else if (message?.type === 'bootstrap_failed') {
        const error = new Error('isolated parser bootstrap failed') as Error & { code: string }
        error.code = 'parse_worker_crashed'
        this.fail(error)
      } else this.emit('message', message)
    })
    this.child.once('close', (code, signal) => {
      void this.finish(code, signal)
    })
    this.lifetime = setTimeout(() => {
      this.fail(
        Object.assign(new Error('parser process exceeded its total lifetime'), {
          code: 'parse_timeout',
        }),
      )
    }, limits.lifetimeMs ?? 600_000)
    this.lifetime.unref()
    limits.signal?.addEventListener('abort', this.abort, { once: true })
  }

  private readonly abort = (): void => {
    const reason = this.limits.signal?.reason
    this.fail(reason instanceof Error ? reason : new DOMException('Parser build cancelled', 'AbortError'))
  }

  private async prepare(): Promise<void> {
    if (this.stopping || !this.child.pid) return
    if (this.limits.cgroupRoot) {
      if ((await statfs(this.limits.cgroupRoot)).type !== 0x63677270)
        throw new Error('parser memory root is not cgroup v2')
      this.cgroup = join(this.limits.cgroupRoot, `genoffice-${randomUUID()}`)
      await mkdir(this.cgroup)
      await writeFile(join(this.cgroup, 'memory.max'), String(this.limitBytes))
      await writeFile(join(this.cgroup, 'memory.swap.max'), '0')
      await writeFile(join(this.cgroup, 'memory.oom.group'), '1')
      await writeFile(join(this.cgroup, 'cgroup.procs'), String(this.child.pid))
    }
    if (this.stopping) return
    await this.sample()
    if (this.stopping) return
    this.timer = setInterval(() => {
      void this.sample()
    }, this.limits.sampleMs ?? 250)
    this.timer.unref()
    this.send({ type: 'bootstrap_start' })
  }

  private async sample(): Promise<void> {
    if (this.sampling || this.stopping || !this.child.pid) return
    this.sampling = true
    try {
      const rss = await processRss(this.child.pid)
      if (this.stopping || this.finished) return
      if (rss !== null) {
        this.rssBytes = rss
        this.peakRssBytes = Math.max(this.peakRssBytes, rss)
        if (rss > this.limitBytes)
          this.fail(new ProcessBudgetError('parser process exceeded its RSS budget'))
      }
    } catch {
      if (!this.stopping && !this.finished) {
        const error = new Error('parser memory monitoring failed') as Error & { code: string }
        error.code = 'parse_memory_monitor_failed'
        this.fail(error)
      }
    } finally {
      this.sampling = false
    }
  }

  private send(message: unknown): void {
    if (this.stopping) return
    if (!this.child.connected) {
      this.fail(new Error('parser IPC disconnected'))
      return
    }
    this.child.send(message as object, (error) => {
      if (error && !this.stopping) this.fail(error)
    })
  }

  postMessage(message: unknown): void {
    if (this.stopping) throw new Error('parser process is closed')
    if (!this.loaded) this.pending.push(message)
    else this.send(message)
  }

  private logFailure(error: Error): void {
    logEvent('warn', 'parser_process_failed', {
      taskId: this.limits.taskId,
      pid: this.child.pid,
      code: (error as { code?: string }).code ?? 'parse_worker_crashed',
      rssBytes: this.rssBytes,
      peakRssBytes: this.peakRssBytes,
      rssLimitBytes: this.limitBytes,
      enforcement: this.limits.cgroupRoot ? 'cgroup-v2-and-watchdog' : 'sampled-rss-watchdog',
    })
  }

  private fail(error: Error): void {
    if (this.stopping) return
    this.failure = error
    this.logFailure(error)
    this.emit('error', error)
    void this.terminate()
  }

  async terminate(): Promise<number | null> {
    if (!this.stopping) {
      this.stopping = true
      this.limits.signal?.removeEventListener('abort', this.abort)
      if (this.timer) clearInterval(this.timer)
      if (this.lifetime) clearTimeout(this.lifetime)
      this.pending.length = 0
      if (this.cgroup) await writeFile(join(this.cgroup, 'cgroup.kill'), '1').catch(() => undefined)
      if (!this.finished) this.child.kill('SIGKILL')
    }
    return this.closed
  }

  private async finish(code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    if (this.finished) return
    this.finished = true
    this.limits.signal?.removeEventListener('abort', this.abort)
    liveWorkers.delete(this)
    if (this.timer) clearInterval(this.timer)
    if (this.lifetime) clearTimeout(this.lifetime)
    await this.preparation
    let cgroupOom = false
    if (this.cgroup) {
      const events = await readFile(join(this.cgroup, 'memory.events'), 'utf8').catch(() => '')
      cgroupOom = /^oom_kill\s+[1-9]\d*/m.test(events)
      await writeFile(join(this.cgroup, 'cgroup.kill'), '1').catch(() => undefined)
      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          await rmdir(this.cgroup)
          break
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') break
          if (attempt === 9)
            logEvent('warn', 'parser_cgroup_cleanup_failed', {
              taskId: this.limits.taskId,
              pid: this.child.pid,
            })
          else await new Promise((resolve) => setTimeout(resolve, 20))
        }
      }
    }
    if (!this.stopping && !this.failure) {
      const error =
        cgroupOom || /heap out of memory|Reached heap limit|Allocation failed/i.test(this.stderr)
          ? new ProcessBudgetError('parser process exceeded its memory budget')
          : Object.assign(new Error(`isolated parser exited unexpectedly (${signal ?? code})`), {
              code: 'parse_worker_crashed',
            })
      this.failure = error
      this.logFailure(error)
      this.emit('error', error)
    }
    this.stopping = true
    this.emit('exit', code)
    this.resolveClosed(code)
  }
}
