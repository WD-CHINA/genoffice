import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID, randomBytes, createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { resolve, dirname, extname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import {
  decryptDocx,
  isEncryptedDocx,
  DocxDecryptError,
} from '@genoffice/viewer-services/docs/decrypt'
import { convertAltChunk } from './altchunk'
import { prepareDocMedia } from '@genoffice/viewer-services/docs/lazy'
import { findChrome } from '@genoffice/viewer-services/docs/driver'
import { HttpError } from './http-error'
import { downloadDocument, type UrlImportOptions } from './url-import'

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dataDir = resolve(process.env.VIEWER_DATA_DIR || resolve(runtimeRoot, '.viewer-data'))
const limit = Number(process.env.VIEWER_MAX_UPLOAD_BYTES || 1024 * 1024 * 1024)
const ttl = Number(process.env.VIEWER_SESSION_TTL_MS || 30 * 60 * 1000)
type FileRecord = {
  owner: string
  id: string
  name: string
  format: string
  path: string
  hash: string
  touched: number
}
type Session = {
  owner: string
  id: string
  file: FileRecord
  revision: number
  batchId: string
  data: any
  touched: number
  rpc?: Rpc
  locked?: boolean
  docMedia?: Awaited<ReturnType<typeof prepareDocMedia>>
  docPreparing?: Promise<void>
  docPrepared?: boolean
  plain?: Buffer
  abort?: AbortController
  measuring?: boolean
  opening?: boolean
  closed?: boolean
}
class Rpc {
  worker = new Worker(new URL('./pptx-worker.mjs', import.meta.url))
  pending = new Map<
    string,
    { resolve: (data: any) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
  >()
  constructor() {
    this.worker.on('message', ({ id, result, error }) => {
      const task = this.pending.get(id)
      if (!task) return
      clearTimeout(task.timer)
      this.pending.delete(id)
      if (error) task.reject(new Error(error))
      else task.resolve(result)
    })
    this.worker.on('error', (err) => this.fail(err))
    this.worker.on('exit', () => this.fail(new Error('Preview worker closed')))
  }
  fail(err: Error) {
    for (const task of this.pending.values()) {
      clearTimeout(task.timer)
      task.reject(err)
    }
    this.pending.clear()
  }
  call(op: string, input: unknown) {
    return new Promise<any>((resolve, reject) => {
      const id = randomUUID()
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('Preview worker timeout'))
        void this.close()
      }, 60_000)
      this.pending.set(id, { resolve, reject, timer })
      this.worker.postMessage({ id, op, input })
    })
  }
  async close() {
    this.fail(new Error('Preview session closed'))
    await this.worker.terminate()
  }
}
function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(value))
}
async function inputJSON(req: IncomingMessage, cap: number) {
  try {
    const value = JSON.parse((await body(req, cap)).toString())
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new HttpError(400, 'JSON object required')
    return value
  } catch (error) {
    if (error instanceof SyntaxError) throw new HttpError(400, 'Invalid JSON')
    throw error
  }
}
async function body(req: IncomingMessage, cap = limit) {
  if (Number(req.headers['content-length']) > cap) {
    req.resume()
    throw new HttpError(413, 'Upload exceeds configured limit')
  }
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > cap) throw new HttpError(413, 'Upload exceeds configured limit')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}
export function rangeBounds(header: string | undefined, length: number): [number, number] | null {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header)
  if (!match || (!match[1] && !match[2]) || length === 0)
    throw new HttpError(416, 'Invalid byte range')
  const start = match[1] ? Number(match[1]) : Math.max(0, length - Number(match[2]))
  const end = match[1] && match[2] ? Math.min(Number(match[2]), length - 1) : length - 1
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start > end ||
    start >= length
  )
    throw new HttpError(416, 'Invalid byte range')
  return [start, end]
}
function bytes(req: IncomingMessage, res: ServerResponse, buffer: Buffer, mime: string) {
  let range: [number, number] | null
  try {
    range = rangeBounds(req.headers.range, buffer.length)
  } catch (error) {
    res.setHeader('Content-Range', `bytes */${buffer.length}`)
    throw error
  }
  const headers: Record<string, string | number> = {
    'Content-Type': mime,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  }
  if (range) {
    headers['Content-Range'] = `bytes ${range[0]}-${range[1]}/${buffer.length}`
    headers['Content-Length'] = range[1] - range[0] + 1
    res.writeHead(206, headers)
    res.end(buffer.subarray(range[0], range[1] + 1))
  } else {
    headers['Content-Length'] = buffer.length
    res.writeHead(200, headers)
    res.end(buffer)
  }
}

export async function createViewerServer(
  options: { sessionTtlMs?: number; urlImport?: UrlImportOptions } = {},
) {
  const sessionTtl = options.sessionTtlMs ?? ttl
  const heartbeatMs = Math.max(50, Math.min(60_000, Math.floor(sessionTtl / 3)))
  await mkdir(dataDir, { recursive: true })
  const files = new Map<string, FileRecord>(),
    sessions = new Map<string, Session>()
  const owners = new Set<string>()
  let pendingFiles = 0
  const imports = new Set<AbortController>()
  const urlImport = {
    allowPrivateNetwork: process.env.VIEWER_URL_ALLOW_PRIVATE_NETWORK === 'true',
    timeoutMs: Number(process.env.VIEWER_URL_TIMEOUT_MS || 45_000),
    ...options.urlImport,
  }
  const reserveFile = () => {
    if (files.size + pendingFiles >= 64) throw new HttpError(429, 'File limit reached')
    pendingFiles++
    return () => {
      pendingFiles--
    }
  }
  const close = async (session: Session) => {
    session.closed = true
    sessions.delete(session.id)
    session.abort?.abort()
    await session.docPreparing?.catch(() => {})
    await session.docMedia?.close()
    session.plain?.fill(0)
    await session.rpc?.close()
  }
  const timer = setInterval(
    async () => {
      for (const session of sessions.values())
        if (
          Date.now() - session.touched > sessionTtl &&
          !session.abort &&
          !session.measuring &&
          !session.opening &&
          !session.docPreparing
        )
          await close(session)
      for (const file of files.values())
        if (
          ![...sessions.values()].some((s) => s.file.id === file.id) &&
          Date.now() - file.touched > sessionTtl
        ) {
          files.delete(file.id)
          await rm(file.path, { force: true })
        }
    },
    Math.min(sessionTtl, 30_000),
  )
  timer.unref()
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost')
      const route = url.pathname.split('/').filter(Boolean)
      const allowedOrigins = new Set([
        `http://${req.headers.host}`,
        ...(
          process.env.VIEWER_ALLOWED_ORIGINS || 'http://127.0.0.1:5180,http://localhost:5180'
        ).split(','),
      ])
      if (req.headers.origin && !allowedOrigins.has(req.headers.origin))
        throw new HttpError(403, 'Origin not allowed')
      let owner = /(?:^|;\s*)viewer=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1]
      if (url.pathname === '/api/health') {
        if (!owner || !owners.has(owner)) {
          owner = randomBytes(32).toString('hex')
          owners.add(owner)
          res.setHeader('Set-Cookie', `viewer=${owner}; Path=/; HttpOnly; SameSite=Strict`)
        }
        let altChunkAvailable = false
        try {
          findChrome()
          altChunkAvailable = true
        } catch {}
        return json(res, 200, {
          ok: true,
          formats: ['pptx', 'pdf', 'docx'],
          electron: false,
          altChunkAvailable,
          heartbeatMs,
        })
      }
      if (route[0] === 'api') {
        if (!owner || !owners.has(owner)) throw new HttpError(401, 'Initialize the Viewer first')
        if (req.method === 'POST' && url.pathname === '/api/files') {
          const name = basename(decodeURIComponent(String(req.headers['x-file-name'] || '')))
          const format = extname(name).slice(1).toLowerCase()
          if (!['pptx', 'pdf', 'docx'].includes(format))
            throw new HttpError(415, 'Supported files: .pptx, .pdf, .docx')
          const release = reserveFile()
          try {
            const buffer = await body(req)
            if (!buffer.length) throw new HttpError(400, 'File is empty')
            if (
              format === 'pdf'
                ? !buffer.subarray(0, 1024).includes(Buffer.from('%PDF-'))
                : !['504b0304', 'd0cf11e0'].includes(buffer.subarray(0, 4).toString('hex'))
            )
              throw new HttpError(415, 'File content does not match its format')
            const id = randomUUID(),
              path = resolve(dataDir, id)
            const file = {
              id,
              owner,
              name,
              format,
              path,
              hash: createHash('sha256').update(buffer).digest('hex'),
              touched: Date.now(),
            }
            await writeFile(path, buffer)
            files.set(id, file)
            return json(res, 201, { id, name, format, hash: file.hash })
          } finally {
            release()
          }
        }
        if (req.method === 'POST' && url.pathname === '/api/files/import-url') {
          const input = await inputJSON(req, 16 * 1024)
          if (typeof input.url !== 'string' || !input.url.trim() || input.url.length > 8192)
            throw new HttpError(400, '请输入有效的文件链接（最多 8192 字符）')
          if (imports.size >= 4) throw new HttpError(429, 'URL 导入任务已满，请稍后重试')
          const release = reserveFile(),
            controller = new AbortController()
          const id = randomUUID(),
            path = resolve(dataDir, id)
          imports.add(controller)
          const cancel = () => {
            if (!res.writableEnded) controller.abort()
          }
          res.on('close', cancel)
          try {
            const imported = await downloadDocument(
              input.url.trim(),
              path,
              limit,
              controller.signal,
              urlImport,
            )
            controller.signal.throwIfAborted()
            const file: FileRecord = {
              id,
              owner,
              path,
              name: imported.name,
              format: imported.format,
              hash: imported.hash,
              touched: Date.now(),
            }
            files.set(id, file)
            return json(res, 201, { id, name: file.name, format: file.format, hash: file.hash })
          } catch (error) {
            await rm(path, { force: true })
            throw error
          } finally {
            res.off('close', cancel)
            imports.delete(controller)
            release()
          }
        }
        if (req.method === 'POST' && url.pathname === '/api/view-sessions') {
          const input = await inputJSON(req, 8192)
          const file = files.get(input.fileId)
          if (!file || file.owner !== owner) throw new HttpError(404, 'File not found')
          if (sessions.size >= 12) throw new HttpError(429, 'Preview capacity reached')
          const width = input.width ?? 960
          if (!Number.isFinite(width) || width < 100 || width > 4096)
            throw new HttpError(400, 'Invalid layout width')
          const session: Session = {
            owner,
            id: randomUUID(),
            file,
            revision: 1,
            batchId: randomUUID(),
            data: null,
            touched: Date.now(),
            opening: true,
          }
          if (file.format === 'docx') session.locked = isEncryptedDocx(await readFile(file.path))
          sessions.set(session.id, session)
          try {
            if (file.format === 'pptx') {
              session.rpc = new Rpc()
              session.data = await session.rpc.call('open', { path: file.path, width })
            }
          } catch (e) {
            await close(session)
            throw e
          } finally {
            session.opening = false
            session.touched = Date.now()
          }
          return json(res, 201, { id: session.id, format: file.format, name: file.name })
        }
        if (route[1] === 'view-sessions') {
          const session = sessions.get(route[2])
          if (!session || session.owner !== owner) throw new HttpError(404, 'Session not found')
          session.touched = Date.now()
          session.file.touched = Date.now()
          if (req.method === 'DELETE' && route.length === 3) {
            await close(session)
            return json(res, 200, { closed: true })
          }
          if (req.method === 'GET' && route.length === 3)
            return json(res, 200, {
              id: session.id,
              format: session.file.format,
              name: session.file.name,
              heartbeatMs,
              locked: session.locked,
            })
          if (req.method === 'POST' && route[3] === 'unlock') {
            if (session.file.format !== 'docx' || !session.locked)
              throw new HttpError(400, 'Document is not locked')
            const input = await inputJSON(req, 8192)
            if (typeof input.password !== 'string' || !input.password)
              throw new HttpError(400, 'Password required')
            try {
              const plain = await decryptDocx(await readFile(session.file.path), input.password)
              if (session.closed) {
                plain.fill(0)
                throw new HttpError(410, 'Preview session closed')
              }
              session.plain?.fill(0)
              session.plain = plain
            } catch (error) {
              if (error instanceof DocxDecryptError && error.reason === 'wrong-password')
                throw new HttpError(422, 'Password incorrect')
              throw error
            }
            session.locked = false
            return json(res, 200, { unlocked: true })
          }
          if (req.method === 'GET' && route[3] === 'doc-media') {
            const media = await session.docMedia?.media(
              route[4],
              url.searchParams.get('part') || '',
            )
            if (!media) throw new HttpError(404, 'Media not found')
            return bytes(req, res, media.bytes, media.mime)
          }
          if (req.method === 'GET' && route[3] === 'content') {
            if (session.locked) throw new HttpError(423, 'Password required')
            if (session.file.format === 'docx' && !session.docPrepared && !session.docPreparing)
              session.docPreparing = (async () => {
                const media = await prepareDocMedia(session.file.path, session.plain)
                if (session.closed) {
                  await media?.close()
                  throw new HttpError(410, 'Preview session closed')
                }
                session.docMedia = media
                session.docPrepared = true
              })().finally(() => {
                session.docPreparing = undefined
              })
            await session.docPreparing
            if (session.closed) throw new HttpError(410, 'Preview session closed')
            return bytes(
              req,
              res,
              session.docMedia?.bytes || session.plain || (await readFile(session.file.path)),
              session.file.format === 'pdf' ? 'application/pdf' : 'application/octet-stream',
            )
          }
          if (req.method === 'POST' && route[3] === 'altchunks') {
            if (session.file.format !== 'docx' || session.locked)
              throw new HttpError(400, 'DOCX session required')
            const input = await inputJSON(req, 24 * 1024 * 1024)
            if (typeof input.html !== 'string') throw new HttpError(400, 'HTML required')
            if (session.abort) throw new HttpError(409, 'Conversion in progress')
            const controller = new AbortController()
            session.abort = controller
            res.on('close', () => {
              if (!res.writableEnded) controller.abort()
            })
            try {
              const data = await convertAltChunk(input.html, controller.signal)
              return bytes(
                req,
                res,
                data,
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
              )
            } finally {
              session.abort = undefined
            }
          }
          if (req.method === 'GET' && route[3] === 'slides') {
            if (!session.rpc) throw new HttpError(400, 'PPTX session required')
            return json(res, 200, {
              ...session.data,
              revision: session.revision,
              batchId: session.batchId,
            })
          }
          if (req.method === 'POST' && route[3] === 'text-widths') {
            const input = await inputJSON(req, 2 * 1024 * 1024)
            if (
              session.measuring ||
              !session.rpc ||
              input.revision !== session.revision ||
              input.batchId !== session.batchId
            )
              throw new HttpError(409, 'Measurement batch expired')
            const allowed = new Set(session.data.measurements.map((item: any) => item.key))
            if (!input.widths || typeof input.widths !== 'object' || Array.isArray(input.widths))
              throw new HttpError(400, 'Invalid measurements')
            if (
              Object.entries(input.widths).some(
                ([key, width]) =>
                  !allowed.has(key) ||
                  typeof width !== 'number' ||
                  !Number.isFinite(width) ||
                  width < 0,
              )
            )
              throw new HttpError(400, 'Invalid measurements')
            session.measuring = true
            try {
              const next = await session.rpc.call('measure', input.widths)
              if (session.closed) throw new HttpError(410, 'Preview session closed')
              session.data = next
              session.revision++
              session.batchId = randomUUID()
              return json(res, 200, {
                ...session.data,
                revision: session.revision,
                batchId: session.batchId,
              })
            } finally {
              session.measuring = false
            }
          }
          if (req.method === 'GET' && route[3] === 'fonts') {
            const data = await session.rpc?.call('font', decodeURIComponent(route[4]))
            if (!data) throw new HttpError(404, 'Font not found')
            return bytes(req, res, Buffer.from(data), 'font/ttf')
          }
          if (req.method === 'GET' && route[3] === 'media') {
            const media = await session.rpc?.call('media', {
              index: Number(route[4]),
              sourceId: decodeURIComponent(route[5] || ''),
            })
            if (media?.url && url.searchParams.has('metadata'))
              return json(res, 200, { kind: media.kind, dataUrl: media.url })
            if (media?.bytes && url.searchParams.has('metadata'))
              return json(res, 200, { kind: media.kind, dataUrl: url.pathname })
            if (!media?.bytes) throw new HttpError(404, 'Media not found')
            const mimes: Record<string, string> = {
              mp4: 'video/mp4',
              m4v: 'video/mp4',
              mov: 'video/quicktime',
              avi: 'video/x-msvideo',
              webm: 'video/webm',
              mp3: 'audio/mpeg',
              wav: 'audio/wav',
              m4a: 'audio/mp4',
              aac: 'audio/aac',
              ogg: 'audio/ogg',
            }
            return bytes(
              req,
              res,
              Buffer.from(media.bytes),
              mimes[media.ext] || 'application/octet-stream',
            )
          }
        }
        throw new HttpError(404, 'API not found')
      }
      const webRoot = resolve(runtimeRoot, 'web')
      const path = resolve(webRoot, '.' + (url.pathname === '/' ? '/index.html' : url.pathname))
      if (!path.startsWith(webRoot + '/')) throw new HttpError(403, 'Path not allowed')
      const mime: Record<string, string> = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.mjs': 'text/javascript',
        '.css': 'text/css',
        '.wasm': 'application/wasm',
        '.ttf': 'font/ttf',
        '.woff': 'font/woff',
        '.woff2': 'font/woff2',
        '.svg': 'image/svg+xml',
      }
      return bytes(
        req,
        res,
        await readFile(path),
        mime[extname(path)] || 'application/octet-stream',
      )
    } catch (e) {
      if (!res.headersSent)
        json(
          res,
          e instanceof HttpError
            ? e.status
            : (e as NodeJS.ErrnoException)?.code === 'ENOENT'
              ? 404
              : e instanceof URIError
                ? 400
                : 500,
          { error: e instanceof Error ? e.message : String(e) },
        )
      else res.destroy()
    }
  })
  server.on('close', () => {
    clearInterval(timer)
    for (const controller of imports) controller.abort()
    for (const session of sessions.values()) void close(session)
  })
  return server
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = await createViewerServer()
  server.listen(
    Number(process.env.VIEWER_PORT || 3001),
    process.env.VIEWER_HOST || '127.0.0.1',
    () =>
      console.log(
        `Viewer ready: http://${process.env.VIEWER_HOST || '127.0.0.1'}:${process.env.VIEWER_PORT || 3001}`,
      ),
  )
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close())
}
