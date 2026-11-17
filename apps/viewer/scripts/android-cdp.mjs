/** Minimal CDP transport for Android WebView, which does not support browser context management. */
export async function connectAndroidWebView(cdpPort = 19224) {
  const pages = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()
  const page = pages.find((p) => p.type === 'page')
  if (!page) throw Error('No WebView page')
  const ws = new WebSocket(page.webSocketDebuggerUrl),
    pending = new Map(),
    contexts = new Map(),
    events = []
  let id = 0
  await new Promise((r, j) => {
    ws.onopen = r
    ws.onerror = j
  })
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id) {
      const p = pending.get(m.id)
      pending.delete(m.id)
      if (p) clearTimeout(p.timer)
      if (m.error) p?.reject(Error(JSON.stringify(m.error)))
      else p?.resolve(m.result)
    } else {
      if (m.method === 'Runtime.executionContextCreated')
        contexts.set(m.params.context.id, m.params.context)
      if (m.method === 'Runtime.executionContextDestroyed')
        contexts.delete(m.params.executionContextId)
      if (m.method === 'Runtime.executionContextsCleared') contexts.clear()
      events.push(m)
    }
  }
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mid = ++id
      const timer = setTimeout(() => {
        pending.delete(mid)
        reject(Error(`CDP timeout: ${method}`))
      }, 60_000)
      pending.set(mid, { resolve, reject, timer })
      ws.send(JSON.stringify({ id: mid, method, params }))
    })
  ws.onclose = () => {
    for (const p of pending.values()) {
      clearTimeout(p.timer)
      p.reject(Error('WebView disconnected'))
    }
    pending.clear()
  }
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Network.enable')
  const evaluate = async (expression, contextId) => {
    const r = await send('Runtime.evaluate', {
      expression,
      contextId,
      returnByValue: true,
      awaitPromise: true,
    })
    if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails))
    return r.result.value
  }
  return { send, evaluate, contexts, events, close: () => ws.close() }
}
