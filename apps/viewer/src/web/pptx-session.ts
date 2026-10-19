export interface PptxDeck {
  slides: any[]
  playback: any[]
  measurements: Array<{ key: string; family: string; text: string; bold: boolean; italic: boolean }>
  fonts: Array<{
    id: string
    family: string
    bold: boolean
    italic: boolean
    url?: string
    also?: string[]
  }>
  fallbacks: string[]
  /** descriptor data url in a render tree → the media part it stands for */
  media: Array<[string, string]>
  timings?: Record<string, number>
}

export function createPptxSession() {
  const worker = new Worker(new URL('./pptx-browser-worker.ts', import.meta.url), {
    type: 'module',
  })
  let next = 0
  let closed = false
  let deck: PptxDeck | undefined
  const pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void }
  >()
  worker.onmessage = (event: MessageEvent<{ id: number; result?: unknown; error?: string }>) => {
    const task = pending.get(event.data.id)
    if (!task) return
    pending.delete(event.data.id)
    if (event.data.error) task.reject(new Error(event.data.error))
    else task.resolve(event.data.result)
  }
  worker.onerror = (event) => {
    for (const task of pending.values())
      task.reject(new Error(event.message || 'PPTX worker failed'))
    pending.clear()
  }
  const call = (op: string, input: unknown, transfer?: Transferable[]) =>
    new Promise((resolve, reject) => {
      if (closed) return reject(new Error('Presentation closed'))
      const id = ++next
      pending.set(id, { resolve, reject })
      worker.postMessage({ id, op, input }, transfer || [])
    })
  return {
    async open(bytes: ArrayBuffer, width = 960): Promise<PptxDeck> {
      deck = (await call('open', { bytes, width }, [bytes])) as PptxDeck
      return deck
    },
    async measure(widths: Record<string, number>): Promise<PptxDeck> {
      if (!deck) throw new Error('Presentation is not open')
      const { slideUpdates, ...rest } = (await call('measure', widths)) as Omit<
        PptxDeck,
        'slides'
      > & { slideUpdates: Array<[number, any]> }
      const updates = new Map(slideUpdates)
      deck = {
        ...deck,
        ...rest,
        slides: deck.slides.map((slide, index) => updates.get(index) ?? slide),
      }
      return deck
    },
    font: (id: string) => call('font', id) as Promise<ArrayBuffer | null>,
    /** raw bytes of a media part a descriptor stands for (the ArrayBuffer is transferred) */
    bytes: (ref: string) => call('bytes', { ref }) as Promise<ArrayBuffer | null>,
    media: (index: number, sourceId: string) =>
      call('media', { index, sourceId }) as Promise<{ kind: string; dataUrl: string } | null>,
    close() {
      closed = true
      for (const task of pending.values()) task.reject(new Error('Presentation closed'))
      pending.clear()
      deck = undefined
      worker.terminate()
    },
  }
}
