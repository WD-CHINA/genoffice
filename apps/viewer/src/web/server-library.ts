export interface SavedResource {
  id: string
  fileId: string
  displayName: string
  retention: 'saved'
  createdAt: number
  updatedAt: number
}
export interface LibraryPage {
  items: SavedResource[]
  next?: string
}

export function createLibraryClient(base: string, token: string) {
  const root = base.replace(/\/+$/, '')
  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers)
    if (token) headers.set('Authorization', `Bearer ${token}`)
    const response = await fetch(`${root}/v2/library${path}`, { ...init, headers })
    if (!response.ok) {
      let detail = `HTTP ${response.status}`
      try {
        detail = ((await response.json()) as { message?: string }).message || detail
      } catch {
        /* non-JSON response */
      }
      throw new Error(detail)
    }
    if (response.status === 204) return undefined as T
    return response.json() as Promise<T>
  }
  return {
    list(cursor?: string, signal?: AbortSignal): Promise<LibraryPage> {
      const query = new URLSearchParams({ limit: '50' })
      if (cursor) query.set('cursor', cursor)
      return request(`?${query}`, { signal })
    },
    save(fileId: string, displayName: string): Promise<SavedResource> {
      return request('', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileId, displayName }),
      })
    },
    remove(id: string): Promise<void> {
      return request(`/${encodeURIComponent(id)}`, { method: 'DELETE' })
    },
  }
}
