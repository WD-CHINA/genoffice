import React, { useEffect, useRef, useState } from 'react'
import { Docs } from './docs'
import { DocsRemote } from './docs-remote'

/** Full-document local renderer is exact but needs the whole file in memory. */
const FULL_RENDER_LIMIT = 64 * 1024 * 1024

interface Props {
  server: string
  fileId: string
  token?: string
  name?: string
}

/**
 * Server-mode DOCX: render the server's original bytes with the same local
 * parser/pagination as local mode whenever the file is small enough. Large
 * documents fall back to the streaming remote renderer.
 */
export function DocsServer({ server, fileId, token, name }: Props) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const [remote, setRemote] = useState(false)
  const [error, setError] = useState('')
  const urlRef = useRef<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    setError('')
    setRemote(false)
    setBlobUrl(null)
    void (async () => {
      try {
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
  }, [server, fileId, token])

  if (error)
    return (
      <p className="viewer-status" role="alert">
        {error}
      </p>
    )
  if (remote) return <DocsRemote server={server} fileId={fileId} token={token} name={name} />
  if (blobUrl) return <Docs src={blobUrl} />
  return <p className="viewer-status">正在读取 DOCX…</p>
}
