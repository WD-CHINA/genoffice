/**
 * Backup manifest / recovery drill CLI (read-only apart from withdrawing
 * proven-bad ready pointers during `verify`).
 *
 *   PARSE_SERVER_DATA_DIR=/srv/parse MYSQL_DATABASE=... \
 *     node --import tsx scripts/backup-check.mts snapshot --out=./backup.json
 *   PARSE_SERVER_DATA_DIR=/srv/parse MYSQL_DATABASE=... \
 *     node --import tsx scripts/backup-check.mts verify --in=./backup.json [--deep] [--no-invalidate]
 *
 * `snapshot` exits non-zero when the catalog changes while files are hashed.
 * `verify` exits non-zero unless ok && readyAllowed; its JSON report is written
 * to stdout so a failed drill can be archived and reviewed.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createBackupManifest, verifyRestore, type BackupManifest } from '../src/backup-manifest'
import { MysqlDatabase, mysqlConfigFromEnv } from '../src/mysql'

function flag(name: string, fallback: string): string {
  const prefix = `--${name}=`
  const argument = process.argv.slice(3).find((value) => value.startsWith(prefix))
  return argument ? argument.slice(prefix.length) : fallback
}
function has(name: string): boolean {
  return process.argv.slice(3).includes(`--${name}`)
}
function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

const command = process.argv[2]
if (!['snapshot', 'verify'].includes(command ?? ''))
  fail('usage: backup-check.mts snapshot|verify [--data-dir=DIR] [--out=FILE|--in=FILE] [--deep] [--no-invalidate]')

const dataDir = resolve(flag('data-dir', process.env.PARSE_SERVER_DATA_DIR ?? '.parse-server-data'))
const path = resolve(flag(command === 'snapshot' ? 'out' : 'in', './backup-manifest.json'))
const mysql = mysqlConfigFromEnv()
const db = mysql ? new MysqlDatabase(mysql) : undefined

try {
  if (command === 'snapshot') {
    const manifest = await createBackupManifest({ dataDir, db })
    await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`)
    console.log(JSON.stringify({
      ok: true, digest: manifest.digest, backend: manifest.catalog.backend,
      catalogRows: manifest.catalog.files.length + manifest.catalog.library.length +
        manifest.catalog.artifacts.length + manifest.catalog.archives.length,
      entries: manifest.entries.length,
      bytes: manifest.entries.reduce((total, entry) => total + entry.size, 0),
      out: path,
    }, null, 2))
  } else {
    let manifest: BackupManifest
    try { manifest = JSON.parse(await readFile(path, 'utf8')) as BackupManifest }
    catch (error) { fail(`cannot read backup manifest: ${error instanceof Error ? error.message : String(error)}`) }
    const report = await verifyRestore({
      dataDir, db, manifest, deep: has('deep'), invalidate: !has('no-invalidate'),
    })
    console.log(JSON.stringify(report, null, 2))
    process.exitCode = report.ok && report.readyAllowed ? 0 : 1
  }
} catch (error) {
  fail(`backup ${command} failed: ${error instanceof Error ? error.message : String(error)}`)
} finally {
  await db?.close()
}
