import { serverRoot } from './helpers/paths'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'

const root = serverRoot

async function read(path: string): Promise<string> {
  return readFile(join(root, path), 'utf8')
}

/** Alert rules are validated without a YAML dependency: metric references must
 * exist in telemetry.ts, and every rule block must carry severity + runbook. */
it('alert rules only reference exposed metrics and carry severity/runbook', async () => {
  const [alerts, telemetry] = await Promise.all([
    read('deploy/observability/alerts.yml'),
    read('src/telemetry.ts'),
  ])
  const defined = new Set(telemetry.match(/genoffice_[a-z0-9_]+/g) ?? [])
  const referenced = new Set(alerts.match(/genoffice_[a-z0-9_]+/g) ?? [])
  expect(referenced.size).toBeGreaterThan(5)
  for (const name of referenced) expect(defined.has(name), name).toBe(true)
  for (const required of [
    'genoffice_parse_errors_total',
    'genoffice_parse_job_queue_age_seconds',
    'genoffice_parse_reserved_memory_bytes',
    'genoffice_parse_memory_budget_bytes',
    'genoffice_parse_storage_bytes',
    'genoffice_parse_artifact_corrupt_total',
    'genoffice_parse_bundle_failure_total',
    'genoffice_parse_unit_read_latency_seconds_bucket',
    'genoffice_cache_error_total',
    'genoffice_cache_timeout_total',
    'genoffice_cache_hit_rate',
    'genoffice_cache_breaker_open',
  ]) {
    expect(alerts, required).toContain(required)
  }
  const blocks = alerts.split(/- alert:/).slice(1)
  expect(blocks.length).toBeGreaterThanOrEqual(10)
  for (const block of blocks) {
    expect(block).toMatch(/severity: (warning|critical)/)
    expect(block).toMatch(/runbook_url:/)
    expect(block).toMatch(/expr:/)
  }
  for (const title of [
    'GenofficeParseErrorRateHigh',
    'GenofficeParseQueueAgeHigh',
    'GenofficeParseMemoryBudgetHigh',
    'GenofficeStorageRejections',
    'GenofficeArtifactCorruption',
    'GenofficeBundleFailures',
    'GenofficeUnitReadLatencyHigh',
    'GenofficeCacheErrorRateHigh',
    'GenofficeCacheHitRateLow',
    'GenofficeCacheBreakerOpen',
  ]) {
    expect(alerts).toContain(title)
  }
})

it('Grafana dashboard is valid JSON with panels for the core metrics', async () => {
  const dashboard = JSON.parse(await read('deploy/observability/dashboard.json')) as {
    title: string
    panels: Array<{ title: string; targets: Array<{ expr: string }> }>
  }
  expect(dashboard.title).toBeTruthy()
  expect(dashboard.panels.length).toBeGreaterThanOrEqual(10)
  const telemetry = await read('src/telemetry.ts')
  const defined = new Set(telemetry.match(/genoffice_[a-z0-9_]+/g) ?? [])
  for (const panel of dashboard.panels) {
    expect(panel.title).toBeTruthy()
    expect(panel.targets[0]?.expr).toBeTruthy()
    for (const name of panel.targets[0].expr.match(/genoffice_[a-z0-9_]+/g) ?? [])
      expect(defined.has(name), `${panel.title}: ${name}`).toBe(true)
  }
})

it('runbook documents cache rollback, backend rollback and the restore gate', async () => {
  const runbook = await read('deploy/observability/README.md')
  expect(runbook).toContain('PARSE_SERVER_CACHE_MODE=memory')
  expect(runbook).toContain('PARSE_SERVER_ARTIFACT_BACKEND=local')
  expect(runbook).toContain('PARSE_SERVER_RESTORE_MANIFEST')
  expect(runbook).toContain('storage_full')
  expect(runbook).toContain('degrade-only')
})

it('ships a reviewable Alertmanager routing template for the parse alerts', async () => {
  const [config, runbook] = await Promise.all([
    read('deploy/observability/alertmanager.yml.example'),
    read('deploy/observability/README.md'),
  ])
  for (const required of [
    'route:',
    'receiver: default-webhook',
    'group_by:',
    'inhibit_rules:',
    'severity="critical"',
    'oncall-webhook',
    'ParseStorageFull',
    'webhook_configs:',
  ]) {
    expect(config, required).toContain(required)
  }
  expect(runbook).toContain('alertmanager.yml.example')
})
