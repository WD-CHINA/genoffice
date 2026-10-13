import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { createWriteStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, extname } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib'
import { openZipFile } from '@genoffice/docx-engine/zip-splice'
import { HttpError } from './http-error'

export interface UrlImportOptions {
  allowPrivateNetwork?: boolean
  timeoutMs?: number
}
const MIME_FORMAT: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
}

/** Validate every DNS answer and pin the connection to the validated address. */
export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number)
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    )
  }
  if (isIP(address) !== 6) return false
  const [a, b] = address
    .toLowerCase()
    .split(':')
    .map((part) => parseInt(part || '0', 16))
  // IPv4-mapped, NAT64, local/link-local and multicast addresses are not public destinations.
  return (
    a >= 0x2000 &&
    a <= 0x3fff &&
    !(a === 0x2001 && (b < 0x200 || b === 0xdb8)) &&
    a !== 0x2002 &&
    !(a === 0x3fff && b < 0x1000)
  )
}
function parseUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new HttpError(400, '请输入有效的 HTTP/HTTPS 文件链接')
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new HttpError(400, '仅支持不含账号密码的 HTTP/HTTPS 文件链接')
  url.hash = ''
  return url
}
async function responseFor(
  url: URL,
  signal: AbortSignal,
  allowPrivate: boolean,
): Promise<IncomingMessage> {
  signal.throwIfAborted()
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  let abort: (() => void) | undefined
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await Promise.race([
        lookup(hostname, { all: true, verbatim: true }),
        new Promise<never>((_resolve, reject) => {
          abort = () => reject(signal.reason)
          signal.addEventListener('abort', abort, { once: true })
        }),
      ]).finally(() => { if (abort) signal.removeEventListener('abort', abort) })
  signal.throwIfAborted()
  if (
    !addresses.length ||
    (!allowPrivate && addresses.some((result) => !isPublicAddress(result.address)))
  )
    throw new HttpError(403, '该链接指向本机或内网地址，当前服务未启用内网 URL 导入')
  const chosen = addresses[0]
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      url,
      {
        method: 'GET',
        signal,
        agent: false,
        family: chosen.family,
        lookup: (_hostname, _options, callback) => callback(null, chosen.address, chosen.family),
        headers: {
          Accept:
            'application/pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/octet-stream',
          'Accept-Encoding': 'identity',
        },
      },
      resolve,
    )
    request.on('error', reject)
    request.end()
  })
}
function cleanName(value: string): string {
  return basename(value.replaceAll('\\', '/'))
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim()
    .slice(0, 200)
}
function fileName(response: IncomingMessage, url: URL): string {
  const disposition = response.headers['content-disposition'] || ''
  const encoded = /filename\*\s*=\s*(?:"?UTF-8'[^']*')([^;\r\n]+)/i.exec(disposition)
  if (encoded) {
    try {
      return cleanName(decodeURIComponent(encoded[1].trim().replace(/"$/, '')))
    } catch {
      /* Fall back to filename or path. */
    }
  }
  const plain = /filename\s*=\s*(?:"((?:\\.|[^"\\])*)"|([^;\r\n]+))/i.exec(disposition)
  if (plain) return cleanName((plain[1] ?? plain[2]).replace(/\\(["\\])/g, '$1'))
  try {
    return cleanName(decodeURIComponent(url.pathname))
  } catch {
    return cleanName(url.pathname)
  }
}
async function detectFormat(path: string, prefix: Buffer, encrypted: boolean): Promise<string> {
  if (prefix.includes(Buffer.from('%PDF-'))) return 'pdf'
  if (prefix.subarray(0, 8).toString('hex') === 'd0cf11e0a1b11ae1' && encrypted) return 'docx'
  if (prefix.subarray(0, 4).toString('hex') === '504b0304') {
    let zip: Awaited<ReturnType<typeof openZipFile>> | undefined
    try {
      zip = await openZipFile(path)
      const ppt = zip.entries.has('ppt/presentation.xml'),
        word = zip.entries.has('word/document.xml')
      if (zip.entries.has('[Content_Types].xml') && ppt !== word) return ppt ? 'pptx' : 'docx'
    } catch {
      /* Invalid archives are not imported. */
    } finally {
      await zip?.close()
    }
  }
  throw new HttpError(415, '链接返回的内容不是 PPTX、DOCX 或 PDF 文件，请使用文件下载直链')
}

/** Stream remote bytes to the same session-owned file store used by local uploads. */
export async function downloadDocument(
  value: string,
  path: string,
  limit: number,
  signal: AbortSignal,
  options: UrlImportOptions = {},
) {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 45_000)
  const combined = AbortSignal.any([signal, timeout])
  let response: IncomingMessage | undefined
  try {
    let url = parseUrl(value)
    for (let redirects = 0; ; redirects++) {
      response = await responseFor(url, combined, !!options.allowPrivateNetwork)
      if (![301, 302, 303, 307, 308].includes(response.statusCode || 0)) break
      const location = response.headers.location
      response.destroy()
      if (!location || redirects >= 5) throw new HttpError(502, '远程链接重定向次数过多或目标无效')
      try {
        url = parseUrl(new URL(location, url).href)
      } catch (error) {
        if (error instanceof HttpError) throw error
        throw new HttpError(502, '远程链接重定向目标无效')
      }
    }
    if (response.statusCode !== 200)
      throw new HttpError(
        502,
        `远程文件下载失败（HTTP ${response.statusCode}），请提供可直接下载的链接`,
      )
    if (Number(response.headers['content-length']) > limit)
      throw new HttpError(413, '远程文件超过配置的大小限制')
    const name = fileName(response, url),
      declared =
        MIME_FORMAT[
          String(response.headers['content-type'] || '')
            .split(';')[0]
            .trim()
            .toLowerCase()
        ]
    let prefix = Buffer.alloc(0),
      tail = Buffer.alloc(0),
      encrypted = false,
      size = 0,
      transferred = 0
    const marker = Buffer.from('EncryptedPackage', 'utf16le'),
      hash = createHash('sha256')
    const transportLimit = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        transferred += chunk.length
        callback(
          transferred > limit ? new HttpError(413, '远程文件超过配置的大小限制') : null,
          chunk,
        )
      },
    })
    const inspect = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length
        if (size > limit) return callback(new HttpError(413, '远程文件超过配置的大小限制'))
        if (prefix.length < 1024)
          prefix = Buffer.concat([prefix, chunk.subarray(0, 1024 - prefix.length)])
        const scan = Buffer.concat([tail, chunk])
        encrypted ||= scan.includes(marker)
        tail = scan.subarray(Math.max(0, scan.length - marker.length))
        hash.update(chunk)
        callback(null, chunk)
      },
    })
    const encoding = String(response.headers['content-encoding'] || 'identity').toLowerCase()
    const decoder =
      encoding === 'gzip'
        ? createGunzip()
        : encoding === 'deflate'
          ? createInflate()
          : encoding === 'br'
            ? createBrotliDecompress()
            : null
    if (!decoder && encoding !== 'identity')
      throw new HttpError(415, '远程文件使用了不支持的 HTTP 压缩格式')
    const sink = createWriteStream(path, { flags: 'wx' })
    if (decoder)
      await pipeline(response, transportLimit, decoder, inspect, sink, { signal: combined })
    else await pipeline(response, transportLimit, inspect, sink, { signal: combined })
    if (!size) throw new HttpError(400, '远程文件为空')
    const format = await detectFormat(path, prefix, encrypted)
    combined.throwIfAborted()
    const extension = extname(name).slice(1).toLowerCase()
    if (
      (['pptx', 'docx', 'pdf'].includes(extension) && extension !== format) ||
      (declared && declared !== format)
    )
      throw new HttpError(415, '远程文件的名称或类型与实际内容不一致')
    return {
      name: extension === format ? name : `${name || 'document'}.${format}`,
      format,
      hash: hash.digest('hex'),
      size,
    }
  } catch (error) {
    response?.destroy()
    if (timeout.aborted) throw new HttpError(504, '远程文件下载超时，请重试')
    if (signal.aborted) throw new HttpError(499, '已取消 URL 导入')
    if (error instanceof HttpError) throw error
    throw new HttpError(502, '无法下载远程文件，请检查链接是否可访问')
  }
}
