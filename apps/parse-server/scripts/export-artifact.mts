import { mkdir } from 'node:fs/promises'
import { ArtifactStore } from '../src/artifact-store'
import { exportArtifactDirectory } from '../src/artifact-export'
import { ArtifactGenerations } from '../src/artifact-generations'
import { MysqlArtifactCatalog } from '../src/artifact-catalog'
import { MysqlDatabase, mysqlConfigFromEnv } from '../src/mysql'

/**
 * Export one packed generation to the canonical document.json/units/fonts tree
 * for inspection or portability (plan §4.2). The runtime keeps using units.bin.
 *
 * Usage:
 *   node --import tsx scripts/export-artifact.mts --data-dir <dir> \
 *     --artifact-key <64-hex> --out <directory> [--catalog]
 *
 * --catalog reads the ready pointer from MYSQL_* and opens the catalog
 * generation under dataDir (instead of the local flat artifact).
 */
function argument(name: string): string | undefined {
  const index = process.argv.indexOf('--' + name)
  return index >= 0 ? process.argv[index + 1] : undefined
}
const dataDir = argument('data-dir')
const key = argument('artifact-key')
const out = argument('out')
const catalogMode = process.argv.includes('--catalog')
if (!dataDir || !key || !out) {
  console.error('usage: --data-dir <dir> --artifact-key <64-hex> --out <directory> [--catalog]')
  process.exit(2)
}
await mkdir(out, { recursive: true })
if (catalogMode) {
  const config = mysqlConfigFromEnv()
  if (!config) {
    console.error('--catalog requires MYSQL_DATABASE (and MYSQL_HOST/USER/...)')
    process.exit(2)
  }
  const db = new MysqlDatabase(config)
  try {
    const ready = await new MysqlArtifactCatalog(db).getReady(key)
    if (!ready) {
      console.error(`no ready catalog generation for ${key}`)
      process.exit(1)
    }
    const reader = await new ArtifactGenerations(dataDir).open(ready)
    const result = await exportArtifactDirectory(reader, out)
    console.log(JSON.stringify({ key, out, catalog: true, generation: ready.generation, ...result }, null, 2))
  } finally {
    await db.close().catch(() => undefined)
  }
} else {
  const store = new ArtifactStore(dataDir)
  const reader = await store.find(key)
  if (!reader) {
    console.error(`artifact not found: ${key}`)
    process.exit(1)
  }
  const result = await exportArtifactDirectory(reader, out)
  console.log(JSON.stringify({ key, out, ...result }, null, 2))
}
