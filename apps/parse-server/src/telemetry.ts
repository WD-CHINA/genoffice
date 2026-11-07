const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const
type LogLevel = keyof typeof LEVELS

function configuredLevel(): LogLevel {
  const raw = process.env.PARSE_SERVER_LOG_LEVEL
  return raw === 'debug' || raw === 'warn' || raw === 'error' ? raw : 'info'
}

/** One JSON line per event; request paths are logged, bodies/tokens are not. */
export function logEvent(
  level: LogLevel,
  event: string,
  fields: Record<string, unknown> = {},
): void {
  if (process.env.VITEST) return
  if (LEVELS[level] < LEVELS[configuredLevel()]) return
  process.stdout.write(
    `${JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields })}\n`,
  )
}

export const DURATION_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60,
] as const

export interface ServerMetrics {
  startedAt: number
  requests: number
  errors: number
  uploads: number
  bytesUploaded: number
  sessionsCreated: number
  parseTimeouts: number
  tooManySessions: number
  requestsByMethod: Map<string, number>
  requestsByStatus: Map<string, number>
  errorsByCode: Map<string, number>
  durationBuckets: number[]
  durationSum: number
  durationCount: number
}

export function createMetrics(): ServerMetrics {
  return {
    startedAt: Date.now(),
    requests: 0,
    errors: 0,
    uploads: 0,
    bytesUploaded: 0,
    sessionsCreated: 0,
    parseTimeouts: 0,
    tooManySessions: 0,
    requestsByMethod: new Map(),
    requestsByStatus: new Map(),
    errorsByCode: new Map(),
    durationBuckets: DURATION_BUCKETS.map(() => 0),
    durationSum: 0,
    durationCount: 0,
  }
}

export function recordRequest(
  metrics: ServerMetrics,
  method: string,
  status: number,
  durationMs: number,
): void {
  metrics.requests++
  if (status >= 500) metrics.errors++
  metrics.requestsByMethod.set(method, (metrics.requestsByMethod.get(method) ?? 0) + 1)
  const statusKey = String(status)
  metrics.requestsByStatus.set(statusKey, (metrics.requestsByStatus.get(statusKey) ?? 0) + 1)
  const seconds = durationMs / 1000
  metrics.durationSum += seconds
  metrics.durationCount++
  for (let index = 0; index < DURATION_BUCKETS.length; index++) {
    if (seconds <= DURATION_BUCKETS[index]) metrics.durationBuckets[index]++
  }
}

export function recordError(metrics: ServerMetrics, code: string): void {
  metrics.errorsByCode.set(code, (metrics.errorsByCode.get(code) ?? 0) + 1)
}

export interface PrometheusSnapshot {
  metrics: ServerMetrics
  sessions: number
  workers: number
  storageBytes: number
  memory: { rss: number; heapUsed: number }
  parserVersion: string
  reservedParseMb?: number
  totalParseMb?: number
  queuedParseJobs?: number
  childProcessRssBytes?: number
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}

function metric(
  lines: string[],
  name: string,
  type: 'counter' | 'gauge' | 'histogram',
  help: string,
): void {
  lines.push(`# HELP ${name} ${help}`)
  lines.push(`# TYPE ${name} ${type}`)
}

/** Prometheus text exposition (v0.0.4). */
export function renderPrometheus(snapshot: PrometheusSnapshot): string {
  const { metrics } = snapshot
  const lines: string[] = []
  const uptime = Math.max(0, Math.floor((Date.now() - metrics.startedAt) / 1000))

  metric(lines, 'genoffice_parse_build_info', 'gauge', 'Build/parser version information.')
  lines.push(`genoffice_parse_build_info{version="${escapeLabel(snapshot.parserVersion)}"} 1`)

  metric(lines, 'genoffice_parse_requests_total', 'counter', 'HTTP requests by method.')
  for (const [method, count] of [...metrics.requestsByMethod].sort()) {
    for (const [status, statusCount] of [...metrics.requestsByStatus].sort()) {
      // Method/status are independent dimensions; emit the full cross product only
      // for methods that were seen with that status is not tracked, so use totals
      // per dimension below and keep the common combined counter at request level.
      void status
      void statusCount
    }
    lines.push(`genoffice_parse_requests_total{method="${escapeLabel(method)}"} ${count}`)
  }
  metric(lines, 'genoffice_parse_responses_total', 'counter', 'HTTP responses by status code.')
  for (const [status, count] of [...metrics.requestsByStatus].sort()) {
    lines.push(`genoffice_parse_responses_total{status="${escapeLabel(status)}"} ${count}`)
  }

  metric(
    lines,
    'genoffice_parse_request_duration_seconds',
    'histogram',
    'HTTP request duration histogram in seconds.',
  )
  for (let index = 0; index < DURATION_BUCKETS.length; index++) {
    lines.push(
      `genoffice_parse_request_duration_seconds_bucket{le="${DURATION_BUCKETS[index]}"} ${metrics.durationBuckets[index]}`,
    )
  }
  lines.push(`genoffice_parse_request_duration_seconds_bucket{le="+Inf"} ${metrics.durationCount}`)
  lines.push(`genoffice_parse_request_duration_seconds_sum ${metrics.durationSum}`)
  lines.push(`genoffice_parse_request_duration_seconds_count ${metrics.durationCount}`)

  metric(lines, 'genoffice_parse_errors_total', 'counter', 'Request errors by code.')
  for (const [code, count] of [...metrics.errorsByCode].sort()) {
    lines.push(`genoffice_parse_errors_total{code="${escapeLabel(code)}"} ${count}`)
  }

  metric(lines, 'genoffice_parse_uploads_total', 'counter', 'Uploaded files.')
  lines.push(`genoffice_parse_uploads_total ${metrics.uploads}`)
  metric(lines, 'genoffice_parse_upload_bytes_total', 'counter', 'Uploaded bytes.')
  lines.push(`genoffice_parse_upload_bytes_total ${metrics.bytesUploaded}`)
  metric(lines, 'genoffice_parse_sessions_created_total', 'counter', 'Created parse sessions.')
  lines.push(`genoffice_parse_sessions_created_total ${metrics.sessionsCreated}`)
  metric(lines, 'genoffice_parse_timeouts_total', 'counter', 'Parse timeouts.')
  lines.push(`genoffice_parse_timeouts_total ${metrics.parseTimeouts}`)
  metric(lines, 'genoffice_parse_too_many_sessions_total', 'counter', 'Rejected sessions.')
  lines.push(`genoffice_parse_too_many_sessions_total ${metrics.tooManySessions}`)

  metric(lines, 'genoffice_parse_sessions_active', 'gauge', 'Session records currently loaded.')
  lines.push(`genoffice_parse_sessions_active ${snapshot.sessions}`)
  metric(lines, 'genoffice_parse_workers_active', 'gauge', 'Open parse workers.')
  lines.push(`genoffice_parse_workers_active ${snapshot.workers}`)
  metric(
    lines,
    'genoffice_parse_reserved_memory_bytes',
    'gauge',
    'Memory reserved by running parse/layout jobs.',
  )
  lines.push(`genoffice_parse_reserved_memory_bytes ${(snapshot.reservedParseMb ?? 0) * 1024 ** 2}`)
  metric(
    lines,
    'genoffice_parse_memory_budget_bytes',
    'gauge',
    'Configured total parse/layout memory budget.',
  )
  lines.push(`genoffice_parse_memory_budget_bytes ${(snapshot.totalParseMb ?? 0) * 1024 ** 2}`)
  metric(
    lines,
    'genoffice_parse_jobs_queued',
    'gauge',
    'Unique jobs waiting for CPU or memory capacity.',
  )
  lines.push(`genoffice_parse_jobs_queued ${snapshot.queuedParseJobs ?? 0}`)
  metric(
    lines,
    'genoffice_parse_children_resident_memory_bytes',
    'gauge',
    "Latest externally sampled RSS of this server's parser/layout child processes.",
  )
  lines.push(`genoffice_parse_children_resident_memory_bytes ${snapshot.childProcessRssBytes ?? 0}`)
  metric(lines, 'genoffice_parse_storage_bytes', 'gauge', 'Committed content-store bytes.')
  lines.push(`genoffice_parse_storage_bytes ${snapshot.storageBytes}`)
  metric(lines, 'genoffice_parse_uptime_seconds', 'gauge', 'Process uptime in seconds.')
  lines.push(`genoffice_parse_uptime_seconds ${uptime}`)
  metric(
    lines,
    'genoffice_parse_process_resident_memory_bytes',
    'gauge',
    'Process resident memory.',
  )
  lines.push(`genoffice_parse_process_resident_memory_bytes ${snapshot.memory.rss}`)
  metric(lines, 'genoffice_parse_process_heap_used_bytes', 'gauge', 'V8 heap used.')
  lines.push(`genoffice_parse_process_heap_used_bytes ${snapshot.memory.heapUsed}`)

  return `${lines.join('\n')}\n`
}
