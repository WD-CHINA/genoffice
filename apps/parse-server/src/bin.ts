import { resolve } from 'node:path'
import { createParseServer } from './server'

const port = Number(process.env.PARSE_SERVER_PORT ?? 8787)
const host = process.env.PARSE_SERVER_HOST ?? '127.0.0.1'
const dataDir = resolve(process.env.PARSE_SERVER_DATA_DIR ?? '.parse-server-data')

const server = await createParseServer({
  dataDir,
  port: Number.isFinite(port) ? port : 8787,
  host,
  token: process.env.PARSE_SERVER_TOKEN || undefined,
  allowedOrigins: (process.env.PARSE_SERVER_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  parserVersion: process.env.PARSE_SERVER_PARSER_VERSION || undefined,
  fontSetHash: process.env.PARSE_SERVER_FONT_SET_HASH || undefined,
  limits: {
    maxUploadBytes: Number(process.env.PARSE_SERVER_MAX_UPLOAD_BYTES) || undefined,
  },
})

console.log(`[parse-server] listening on ${server.url} (data: ${dataDir})`)

const shutdown = async (signal: string): Promise<void> => {
  console.log(`[parse-server] ${signal}, shutting down`)
  await server.close().catch((error: unknown) => {
    console.error('[parse-server] close failed', error)
  })
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
