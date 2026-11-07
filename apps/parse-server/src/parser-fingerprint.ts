import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Source deployments use a content fingerprint, so unchanged version labels cannot reuse stale models. */
export async function parserFingerprint(version: string): Promise<string> {
  const root = fileURLToPath(new URL('../../../', import.meta.url))
  const hash = createHash('sha256').update(version)
  const roots = [
    'apps/parse-server/src',
    'packages/pptx-engine/src',
    'packages/pptx-render/src',
    'packages/docx-engine/src',
    'packages/zip-reader/src',
    'packages/zip-gate/src',
  ]
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) {
        hash
          .update(relative(root, path))
          .update('\0')
          .update(await readFile(path))
          .update('\0')
      }
    }
  }
  for (const path of roots) await visit(join(root, path))
  hash.update(await readFile(join(root, 'pnpm-lock.yaml')))
  return hash.digest('hex')
}
