# Parse service observability and rollback runbook (plan §11/P4)

This directory ships the Prometheus alert rules (`alerts.yml`) and a minimal
Grafana dashboard (`dashboard.json`) for the metrics exposed by
`GET /metrics`. `tests/observability-assets.test.ts` keeps them in sync with
`src/telemetry.ts` and validates the JSON/YAML structure.

## Scrape and wiring

`alertmanager.yml.example` is a routing template (critical → on-call webhook,
cache alerts → cache webhook, storage-full inhibits downstream warnings). Copy
it to the alertmanager config, replace the example webhook URLs, and reload.

- Scrape `/metrics` per parse-server instance; every metric is prefixed
  `genoffice_`.
- Load `alerts.yml` into the Prometheus rule files. The expressions use only
  series emitted by this server (including the `genoffice_cache_*` family when
  `PARSE_SERVER_CACHE_MODE=redis`).
- Import `dashboard.json` into Grafana and bind the `datasource` template to the
  Prometheus instance.
- `/v1/health` remains the low-cardinality readiness probe; alerts should use
  `/metrics`, never scrape health text.

## Alert response

### parse errors

Check `genoffice_parse_errors_total` by `code`. `storage_full` (507) means the
storage budget is exhausted: inspect `genoffice_parse_storage_*_bytes`,
high/low watermarks and the sweeper result in `/v1/health.maintenance`.

### queue

`genoffice_parse_job_queue_age_seconds` above 60 s with cached sessions still
serving means cold builds are bottlenecked on CPU/memory admission. Raise
`PARSE_SERVER_PARSE_MEMORY_MB` only together with real RSS headroom (plan §6.1).

### memory

Parse memory is reserved per job; a sustained 90 % budget means queue admission
will fail closed. Never raise `workerRssMb` above the total budget.

### storage

Any `storage_full` reaction: reclaim/GC first (temporary TTL, old versions,
pressure eviction) and only then add capacity. Saved library sources are never
deleted by pressure. Do not lower the hard cap to force reclaim.

### corruption

`genoffice_parse_artifact_corrupt_total` increments when an open view reported a
damaged frame and the ready pointer was compare-and-cleared for repair. Check
disk/SMART, then confirm the next access rebuilt the artifact (health
`artifacts.buildsStarted`). Source files are never deleted by repair.

### bundles

Bundle failures usually mean an external media file or catalog generation is
missing. Verify `/v1/health.artifacts` and the session's source parts before
re-running the client download.

### latency

`unit_read_latency` covers cache/artifact frames, not layout. Rising p95 with
normal CPU usually means disk IO or repeated eviction; check
`genoffice_parse_gc_deleted_bytes_total` and ready-eviction health counters.

### cache

The Redis hot cache is optional and degrade-only (plan §5.1):

- hit rate below 80 %: expected when most sessions are cold or TTLs are short;
  compare with the local drill `npm run cache:slo --strict`.
- errors/timeouts or an open breaker: requests still succeed from MySQL/disk.
  Inspect Redis availability, ACL/TLS and `maxmemory`.
- **Rollback = set `PARSE_SERVER_CACHE_MODE=memory` (or remove `REDIS_*`).**
  Keys expire by TTL; never delete persistent data during rollback.

## Rollback from catalog to local backend

Plan §10: rollback must not delete user files or new history.

0. If the issue is the new async contract, roll it back in two steps: set
   `PARSE_SERVER_ASYNC_ROLLOUT_PERCENT=0` for a canary rollback (or lower it to shed
   files/tenants deterministically; set `PARSE_SERVER_ASYNC_ROLLOUT_HEADER=x-tenant-id`
   to bucket by tenant instead of file), then `PARSE_SERVER_ASYNC_SESSIONS=0` for
   the process-level kill switch; `PARSE_SERVER_ASYNC_ROLLOUT_RAMP_PER_HOUR` can
   ramp the percentage with process uptime instead of a fixed target;
   `PARSE_SERVER_ASYNC_AUTO_PAUSE_ERROR_RATE` is the emergency brake (server-error
   ratio over 60 s pauses asynchronous creation for 5 min, visible in `/v1/health.canaryGuard`). Both
   the manual switches
   reject new asynchronous creation with 404; clients retry synchronously at the same v1 path without data
   migration; the canary bucket is derived from `fileId` or the configured tenant
   header, so a file/tenant never flips mid-read.
1. Stop accepting new work (drain), let running builds finish.
2. Keep MySQL configured after switching `PARSE_SERVER_ARTIFACT_BACKEND=local`:
   the catalog rows still protect saved sources and freshly built generations
   from local GC (`tests/rollback-mysql.test.ts` covers this path).
3. Old flat artifacts are rebuilt from the protected source on the next open;
   generation directories may stay on disk until an operator archives them.
4. Do not run a downgraded GC that ignores the library/catalog references.
5. The restore gate (`PARSE_SERVER_RESTORE_MANIFEST`) must pass before serving
   after a restore.

## Still deployment work

Target-instance SLO baselines, Redis master/replica and `maxmemory` drills,
real alert routing/on-call rotation, canary rollout and 8C/16G load tests are not
covered by these files; they need the deployment environment (plan §10/§11).
