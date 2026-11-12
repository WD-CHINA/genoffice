import { registerHooks } from 'node:module'

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** Mirror Vite's font asset boundary without leaving a process-wide loader installed. */
export async function loadModelSession() {
  const assets = registerHooks({
    load(url, context, nextLoad) {
      if (/\.(ttf|woff2)(\?url)?$/.test(url))
        return {
          format: 'module',
          source: `export default ${JSON.stringify(url)}`,
          shortCircuit: true,
        }
      return nextLoad(url, context)
    },
  })
  try {
    return await import('../../src/web/pptx-model-session.ts')
  } finally {
    assets.deregister()
  }
}

type Message = { id: number; op: string; input: any }
/** Each call owns its current instance, event handlers and lifecycle state. */
export function workerProbe(
  handle: (worker: { reply(id: number, result: unknown): void }, message: Message) => void,
) {
  return class WorkerProbe {
    static current: WorkerProbe
    onmessage?: (event: { data: unknown }) => void
    onerror?: (event: unknown) => void
    terminated = false
    constructor() {
      WorkerProbe.current = this
    }
    postMessage(message: Message) {
      handle(this, message)
    }
    reply(id: number, result: unknown) {
      queueMicrotask(() => this.onmessage?.({ data: { id, ok: true, result } }))
    }
    terminate() {
      this.terminated = true
    }
  }
}
