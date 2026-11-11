# Docker validation

This is an isolated acceptance environment, not the production image. MySQL has
an empty root password on a private Docker network/socket volume; only application
ports are published, on loopback. Do not expose this configuration publicly.
Private business documents and generated screenshots/SQL stay outside Git.

From the repository root:

```sh
docker compose -f apps/parse-server/deploy/validation/compose.yml build
docker compose -f apps/parse-server/deploy/validation/compose.yml up -d --wait mysql redis
docker compose -f apps/parse-server/deploy/validation/compose.yml run --rm tests
docker compose -f apps/parse-server/deploy/validation/compose.yml up -d app-a app-b
```

The default report directory is `/tmp/genoffice-validation`; set `EVIDENCE_DIR`
to a durable local directory when retaining reports. The suite creates and drops
only its own random databases. Do not point the sockets at a user database.

API corpus and separate-process reuse (choose your own local source directory):

```sh
export PARSE_SERVER_TOKEN=validation-local
node --import tsx apps/parse-server/scripts/corpus-drill.mts --input "$CORPUS_DIR" --url http://127.0.0.1:18787 --out /tmp/corpus-a.json
node --import tsx apps/parse-server/scripts/corpus-drill.mts --reopen-report /tmp/corpus-a.json --url http://127.0.0.1:18788 --out /tmp/corpus-b.json
node --import tsx apps/parse-server/scripts/docx-semantic-drill.mts --input "$CORPUS_DIR" --out /tmp/docx-semantics.json
```

The semantic drill compares body text, note numbering/formatting, section ranges,
and header/footer model content against the full parser, and fails on regressions.
Use the separate browser layout audit to accept actual geometry, fields and images.

Browser evidence uses the host's Chrome and repository development dependencies.
Compose allows the browser drill's `http://127.0.0.1:11019` origin. Other
deployments must allow that origin or use a same-origin deployment. The script
also points Vite's background API proxy at the selected server:

```sh
PARSE_SERVER_URL=http://127.0.0.1:18787 node --import tsx apps/viewer/scripts/corpus-browser.mts --corpus /tmp/corpus-a.json --out /tmp/corpus-browser
# The JSON from docx-semantic-drill is accepted too; --docx-layout scrolls every
# section and checks paper widths, columns, note marks, PAGE/NUMPAGES and images.
node --import tsx apps/viewer/scripts/corpus-browser.mts --corpus /tmp/docx-semantics.json --server http://127.0.0.1:18787 --docx-layout --out /tmp/docx-browser
# Optional --only-name NAME --only-index 0 --playback
node apps/viewer/scripts/weak-network-proxy.mjs --latency-ms 200 --bytes-per-second 131072
# In a separate terminal: corpus-browser accepts --server http://127.0.0.1:18789.
```

For a representative cold queue, set `CORPUS_FILE` to one PPTX filename under
`CORPUS_DIR` and run `docker compose ... run --rm load`. It preserves all ZIP
part bytes and changes only the archive comment to exercise unique cold builds.
The profile includes 2 running + 20 queued tasks, 50 cached readers and 500 sessions.
Container CPU/memory settings and cgroup memory.peak are included in the report.
The Docker VM must have sufficient actual resources; a container limit cannot
create RAM that the VM does not have.

GB body generation uses bounded-memory Python standard library code on the host:

```sh
python3 apps/parse-server/scripts/body-fixture.py --out /tmp/docx-1g-body.docx
node --import tsx apps/parse-server/scripts/body-load-drill.mts --file /tmp/docx-1g-body.docx --out /tmp/body-load.json
```

Default output is 65,536 paragraphs and 1,119,671,617 bytes of actual body XML.
`body-load-drill` samples health/RSS and checks first/middle/last units, not all
characters. Its optional `--warm-session ID` adds cached reads while parsing.

The kernel OOM drill needs its **own writable private cgroup namespace**. Only
this disposable validation container is privileged; no Docker socket or host
cgroup filesystem is mounted:

```sh
docker run --rm --privileged --cgroupns=private --cpus 1 --memory 512m --memory-swap 512m genoffice-validation:local node --import tsx scripts/cgroup-drill.mts
docker run --rm --entrypoint promtool -w /checks -v "$PWD/apps/parse-server/deploy/observability:/checks:ro" prom/prometheus:v3.13.1 check rules alerts.yml
docker run --rm --entrypoint promtool -w /checks -v "$PWD/apps/parse-server/deploy/observability:/checks:ro" prom/prometheus:v3.13.1 test rules alerts.test.yml
```

Cold recovery requires stopping writers, `backup-check.mts snapshot`, exporting
the matching catalog database with `mysqldump`, copying the data volume into a
different volume, importing into a different MySQL server, and running
`backup-check.mts verify --deep --no-invalidate`. Start the target with
`PARSE_SERVER_RESTORE_MANIFEST`, `PARSE_SERVER_RESTORE_DEEP=1`, the same parser
fingerprint, and the restored database. Reopen the corpus and require zero new
source parses. Corrupting a copied source must make verification fail; do not
inject corruption into the source deployment. Same-VM recovery does not validate
a second physical host.

Clean up only this Compose project's disposable resources:

```sh
docker compose -f apps/parse-server/deploy/validation/compose.yml down --volumes
```

Recorded results and unresolved acceptance failures:
[2026-11-11 validation report](../../../../docs/parse-docker-validation.zh-CN.md).
The three document defects from that initial report were subsequently fixed:
[repair verification](../../../../docs/parse-viewer-fixes-validation.zh-CN.md).
