export interface PptxDeck {
  slides: any[]
  playback: any[]
  measurements: Array<{ key: string; family: string; text: string; bold: boolean; italic: boolean }>
  fonts: Array<{ id: string; family: string; bold: boolean; italic: boolean; url?: string; also?: string[] }>
  fallbacks: string[]
}

export function createPptxSession() {
  const worker = new Worker(new URL('./pptx-browser-worker.ts', import.meta.url), { type: 'module' })
  let next = 0
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()
  worker.onmessage = (event: MessageEvent<{ id: number; result?: unknown; error?: string }>) => {
    const task = pending.get(event.data.id)
    if (!task) return
    pending.delete(event.data.id)
    if (event.data.error) task.reject(new Error(event.data.error))
    else task.resolve(event.data.result)
  }
  worker.onerror = (event) => {
    for (const task of pending.values()) task.reject(new Error(event.message || 'PPTX worker failed'))
    pending.clear()
  }
  const call = (op: string, input: unknown, transfer?: Transferable[]) =>
    new Promise((resolve, reject) => {
      const id = ++next
      pending.set(id, { resolve, reject })
      worker.postMessage({ id, op, input }, transfer || [])
    })
  return {
    open: (bytes: ArrayBuffer, width = 960) =>
      call('open', { bytes, width }, [bytes]) as Promise<PptxDeck>,
    measure: (widths: Record<string, number>) => call('measure', widths) as Promise<PptxDeck>,
    font: (id: string) => call('font', id) as Promise<ArrayBuffer | null>,
    media: (index: number, sourceId: string) =>
      call('media', { index, sourceId }) as Promise<{ kind: string; dataUrl: string } | null>,
    close() {
      worker.terminate()
    },
  }
}
