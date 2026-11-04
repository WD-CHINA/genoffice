#!/usr/bin/env node
/**
 * Upload pressure smoke test.
 *
 * Streams a large file (sparse temp file by default) to a running parse
 * server and reports throughput plus the server's peak RSS when its pid is
 * given. Not part of CI: the point is to prove the server does not buffer the
 * body in memory.
 *
 *   node scripts/upload-smoke.mjs --url http://127.0.0.1:8787 --size 1G
 *   node scripts/upload-smoke.mjs --url ... --size 1G --pid 12345
 */
import {
  createReadStream,
  readFileSync,
  statSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { pipeline } from 'node:stream/promises'

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : fallback
}

function parseSize(value) {
  const match = /^(\d+(?:\.\d+)?)\s*([kmgt]?b?)$/i.exec(String(value).trim())
  if (!match) throw new Error(`invalid size: ${value}`)
  const units = {
    '': 1,
    b: 1,
    k: 1024,
    kb: 1024,
    m: 1024 ** 2,
    mb: 1024 ** 2,
    g: 1024 ** 3,
    gb: 1024 ** 3,
    t: 1024 ** 4,
    tb: 1024 ** 4,
  }
  return Math.round(Number(match[1]) * (units[match[2].toLowerCase()] ?? 1))
}

function serverRssBytes(pid) {
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8')
    const match = /VmRSS:\s+(\d+)\s+kB/.exec(status)
    if (match) return Number(match[1]) * 1024
  } catch {
    // not Linux: fall through to ps
  }
  try {
    const out = execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const kb = Number(out.trim())
    return Number.isFinite(kb) ? kb * 1024 : 0
  } catch {
    return 0
  }
}

const url = new URL(arg('url', 'http://127.0.0.1:8787'))
const size = parseSize(arg('size', '1G'))
const pid = Number(arg('pid', '0')) || 0
const explicitFile = arg('file')
const file = explicitFile ?? join(tmpdir(), `parse-server-smoke-${randomUUID()}.bin`)
if (!explicitFile) {
  // A valid PDF header makes the payload pass the format sniffer; the rest is sparse zeros.
  writeFileSync(file, '%PDF-1.7\n')
  truncateSync(file, size)
  if (statSync(file).size !== size) throw new Error('failed to create sparse file')
}

let peakRss = 0
const poll = setInterval(() => {
  if (pid) peakRss = Math.max(peakRss, serverRssBytes(pid))
}, 250)
poll.unref?.()

const started = Date.now()
try {
  await new Promise((resolve, reject) => {
    const req = request(
      {
        method: 'POST',
        hostname: url.hostname,
        port: url.port || 80,
        path: '/v1/files',
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) },
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8')
          if (res.statusCode !== 201) reject(new Error(`HTTP ${res.statusCode}: ${body}`))
          else resolve(JSON.parse(body))
        })
      },
    )
    req.on('error', reject)
    pipeline(createReadStream(file), req).catch(reject)
  })
} finally {
  clearInterval(poll)
  if (!explicitFile) unlinkSync(file)
}
const seconds = (Date.now() - started) / 1000
const result = {
  size,
  seconds,
  megabytesPerSecond: Math.round((size / 1024 ** 2 / seconds) * 10) / 10,
  serverPeakRssBytes: peakRss || undefined,
}
console.log(JSON.stringify(result, null, 2))
