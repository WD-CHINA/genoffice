import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'

export class MediaError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

/** No shell; bounded output, wall time and Linux RSS. Abort kills the encoder. */
export function mediaProcess(binary: string, args: string[], options: {
  signal?: AbortSignal; timeoutMs: number; rssMb?: number; onProgress?: (text: string) => void
}): Promise<string> {
  return new Promise((resolve, reject) => {
    options.signal?.throwIfAborted()
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', failure: Error | undefined
    let finished = false
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const stop = (error: Error) => {
      if (finished) return
      failure ??= error
      child.kill('SIGTERM')
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), 1000)
    }
    const abort = () => stop(new MediaError('media_interrupted', '媒体处理已中断，请稍后重试。'))
    options.signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => stop(new MediaError('media_timeout', '媒体处理超时。')), options.timeoutMs)
    const rss = process.platform === 'linux' && options.rssMb ? setInterval(() => {
      if (!child.pid) return
      void readFile(`/proc/${child.pid}/status`, 'utf8').then((text) => {
        if (Number(/VmRSS:\s+(\d+)/.exec(text)?.[1] ?? 0) > options.rssMb! * 1024)
          stop(new MediaError('media_memory_limit', '媒体处理超过内存限制。'))
      }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') stop(new MediaError('media_monitor_failed', '媒体资源监控不可用。'))
      })
    }, 250) : undefined
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length + chunk.length > 1024 * 1024)
        stop(new MediaError('media_probe_limit', '媒体探测信息超过限制。'))
      else stdout += chunk.toString('utf8')
      options.onProgress?.(chunk.toString('utf8'))
    })
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-16_384) })
    const cleanup = () => {
      finished = true
      clearTimeout(timer); if (rss) clearInterval(rss); if (killTimer) clearTimeout(killTimer)
      options.signal?.removeEventListener('abort', abort)
    }
    child.once('error', (error) => { cleanup(); reject(error) })
    child.once('close', (code) => {
      cleanup()
      // FFmpeg stderr can contain private source paths and embedded metadata.
      if (failure) reject(failure)
      else if (code !== 0) reject(new MediaError('media_decode_failed', '无法解码或转换该媒体。'))
      else resolve(stdout)
      void stderr
    })
  })
}

export const MEDIA_INPUT_OPTIONS = ['-protocol_whitelist', 'file,pipe', '-format_whitelist',
  'mov,matroska,webm,asf,avi,wav,mp3,flac,aac,ogg,mpeg,mpegts,flv']
