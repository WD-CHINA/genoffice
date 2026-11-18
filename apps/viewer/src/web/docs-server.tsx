import React, { useEffect, useRef, useState } from 'react'
import { Docs } from './docs'
import { DocsRemote } from './docs-remote'
import { fetchCapabilities } from './capabilities'
import { chooseDocxServerRoute, FORMAT_POLICY, thresholdsOf } from './format-policy'

/** Full-document local renderer is exact but needs the whole file in memory. */
const FULL_RENDER_LIMIT = FORMAT_POLICY.docxServerFullRenderBytes

interface Props {
  server: string
  fileId: string
  token?: string
  name?: string
  /** Explicit fidelity fallback for small DOCX; default is the remote model. */
  localFallback?: boolean
}

/** HTTP models and the explicit local-byte fallback share the same read-only page renderer. */
export function DocsServer({ server, fileId, token, name, localFallback = false }: Props) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const [remote, setRemote] = useState(false)
  const [error, setError] = useState('')
  const urlRef = useRef<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    setError('')
    setRemote(false)
    setBlobUrl(null)
    if (!localFallback) {
      // Manual server mode uses the streaming remote model. The exact local
      // renderer is only a fidelity fallback that must be requested explicitly.
      setRemote(true)
      return () => controller.abort()
    }
    void (async () => {
      try {
        // Only reached with the explicit local fallback; thresholds may still be
        // advertised by the deployment capabilities.
        const capabilities = await fetchCapabilities({
          baseUrl: server,
          signal: controller.signal,
        })
        const metadata = await fetch(
          `${server.replace(/\/+$/, '')}/v1/files/${encodeURIComponent(fileId)}`,
          { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: controller.signal },
        )
        if (!metadata.ok) throw new Error(`读取 DOCX 信息失败（HTTP ${metadata.status}）`)
        const info = (await metadata.json()) as { size: number }
        if (!Number.isSafeInteger(info.size) || info.size < 0) throw new Error('DOCX 文件大小无效')
        if (
          chooseDocxServerRoute({
            size: info.size,
            allowLocalFallback: localFallback,
            thresholds: thresholdsOf(capabilities),
          }) === 'remote'
        ) {
          setRemote(true)
          return
        }
        const response = await fetch(
          `${server.replace(/\/+$/, '')}/v1/files/${encodeURIComponent(fileId)}/content`,
          {
            headers: token ? { Authorization: `Bearer ${token}` } : {},
            signal: controller.signal,
          },
        )
        if (!response.ok) throw new Error(`读取 DOCX 失败（HTTP ${response.status}）`)
        const blob = await response.blob()
        if (blob.size > FULL_RENDER_LIMIT) {
          setRemote(true)
          return
        }
        const url = URL.createObjectURL(blob)
        if (urlRef.current) URL.revokeObjectURL(urlRef.current)
        urlRef.current = url
        setBlobUrl(url)
      } catch (caught) {
        if ((caught as Error)?.name !== 'AbortError') {
          setError(caught instanceof Error ? caught.message : String(caught))
        }
      }
    })()
    return () => {
      controller.abort()
      if (urlRef.current) {
        URL.revokeObjectURL(urlRef.current)
        urlRef.current = null
      }
    }
  }, [server, fileId, token, localFallback])

  if (error)
    return (
      <p className="viewer-status" role="alert">
        {error}
      </p>
    )
  if (remote) return <DocsRemote server={server} fileId={fileId} token={token} name={name} />
  if (blobUrl) return <Docs src={blobUrl} name={name} />
  return <p className="viewer-status">正在读取 DOCX…</p>
}
