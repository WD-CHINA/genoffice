/** Local validation proxy: latency plus a bounded per-response download rate. */
import http from 'node:http'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'

const option = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`)
  return index < 0 ? fallback : process.argv[index + 1]
}
const target = new URL(option('target', 'http://127.0.0.1:18787'))
if (target.protocol !== 'http:') throw new Error('validation proxy requires an HTTP target')
const port = Number(option('port', '18789'))
const latencyMs = Number(option('latency-ms', '200'))
const bytesPerSecond = Number(option('bytes-per-second', '131072'))
if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || !Number.isSafeInteger(latencyMs) || latencyMs < 0 || !Number.isSafeInteger(bytesPerSecond) || bytesPerSecond <= 0)
  throw new Error('invalid network profile')
const server = http.createServer(async (request, response) => {
  await delay(latencyMs)
  if (response.destroyed) return
  const upstream = http.request({ hostname: target.hostname, port: target.port, path: request.url,
    method: request.method, headers: request.headers }, async (received) => {
    response.writeHead(received.statusCode ?? 502, received.headers)
    try {
      for await (const chunk of received) {
        for (let offset = 0; offset < chunk.length; offset += 16384) {
          const part = chunk.subarray(offset, offset + 16384)
          await delay(part.length / bytesPerSecond * 1000)
          if (response.destroyed) { received.destroy(); return }
          if (!response.write(part)) await once(response, 'drain')
        }
      }
      response.end()
    } catch { response.destroy() }
  })
  upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end() })
  response.on('close', () => upstream.destroy())
  request.on('aborted', () => upstream.destroy())
  request.pipe(upstream)
})
server.listen(port, '127.0.0.1', () => console.log(JSON.stringify({ port, target: target.origin, latencyMs, bytesPerSecond,
  scope: 'per-response download throttling, not an aggregate link or packet-loss emulator' })))
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.closeAllConnections(); server.close() })
