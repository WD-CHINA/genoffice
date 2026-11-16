import type { DocFormat } from '@genoffice/parse-contract'

export interface PreviewTarget {
  src?: string
  fileId?: string
  server?: string
  format?: DocFormat
  name?: string
  token?: string
  layout?: string
  theme?: string
  docxLocalFallback?: boolean
  ui?: Record<string, string>
}
export interface ResolvedPreview extends PreviewTarget {
  src: string
  format: DocFormat
}

function formatOf(value: string | null | undefined): DocFormat | undefined {
  return value === 'pptx' || value === 'docx' || value === 'pdf' ? value : undefined
}
function baseOf(server: string | undefined, origin: string): string {
  const url = new URL(server?.trim() || origin, origin)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('解析服务地址必须是有效的 HTTP(S) 地址')
  url.search = ''
  url.hash = ''
  return url.href.replace(/\/+$/, '')
}

/** One static entry works under /, /viewer/ and Android's loopback origin. */
export function previewUrl(base: string, target: PreviewTarget, origin: string): string {
  const url = new URL(base, origin)
  if (!url.pathname.endsWith('/')) {
    url.pathname = /\.[a-z0-9]+$/i.test(url.pathname.split('/').pop() || '')
      ? url.pathname.replace(/[^/]*$/, '')
      : url.pathname + '/'
  }
  url.pathname += 'preview.html'
  url.search = ''
  url.hash = ''
  const query = url.searchParams
  if (target.fileId) {
    query.set('fileId', target.fileId)
    const server = baseOf(target.server, url.origin)
    if (server !== url.origin) query.set('server', server)
  } else if (target.src) query.set('src', target.src)
  if (!target.fileId && target.format) query.set('format', target.format)
  if (target.name && target.name !== target.fileId && target.name !== target.fileId?.slice(0, 8))
    query.set('name', target.name)
  if (target.token) query.set('token', target.token)
  if (target.layout === 'server') query.set('layout', 'server')
  if (target.theme === 'dark' || target.theme === 'light') query.set('theme', target.theme)
  if (target.docxLocalFallback) query.set('docxLocalFallback', '1')
  for (const [key, value] of Object.entries(target.ui ?? {})) query.set(key, value)
  return url.origin === origin ? url.pathname + url.search : url.href
}

/** Resolve only the canonical remote file ID or an explicit local source/format pair. */
export async function resolvePreview(
  params: URLSearchParams,
  origin: string,
  signal?: AbortSignal,
  request: typeof fetch = fetch,
): Promise<ResolvedPreview> {
  const fileId = params.get('fileId')?.trim() || undefined
  const token = params.get('token')?.trim() || undefined
  const name = params.get('name')?.trim() || undefined
  let src = params.get('src') || ''
  let format = formatOf(params.get('format'))
  if (
    params.has('url') ||
    params.has('contentUrl') ||
    params.has('parse') ||
    src === 'bundle' ||
    (fileId && (params.has('src') || params.has('format'))) ||
    params.get('layout') === 'client'
  )
    throw new Error('不再支持旧预览链接，请使用 preview.html?fileId=… 重新生成链接')
  let server: string | undefined
  if (fileId) {
    server = baseOf(params.get('server') || undefined, origin)
    const headers = token ? { Authorization: `Bearer ${token}` } : undefined
    const response = await request(`${server}/v1/files/${encodeURIComponent(fileId)}`, {
      headers,
      signal,
    })
    if (!response.ok) throw new Error(`读取文件信息失败（HTTP ${response.status}）`)
    format = formatOf(((await response.json()) as { format?: string }).format)
    if (!format) throw new Error('只能预览 PPTX、DOCX 或 PDF 文件')
    src = `${server}/v1/files/${encodeURIComponent(fileId)}/content`
    if (format === 'pdf') {
      if (token) {
        const response = await request(
          `${server}/v1/files/${encodeURIComponent(fileId)}/content-url`,
          {
            method: 'GET',
            headers,
            signal,
          },
        )
        if (!response.ok) throw new Error(`获取 PDF 访问 URL 失败（HTTP ${response.status}）`)
        const body = (await response.json()) as { url?: string }
        if (!body.url) throw new Error('解析服务未返回 PDF 访问地址')
        src = body.url
      }
    }
  } else {
    if (!src) throw new Error('没有可预览的文件')
  }
  if (!format) throw new Error('无法识别文件格式，请指定 format=pptx、docx 或 pdf')
  return {
    src,
    format,
    fileId,
    server,
    name,
    token,
    layout: params.get('layout') || undefined,
    docxLocalFallback: params.get('docxLocalFallback') === '1',
  }
}
