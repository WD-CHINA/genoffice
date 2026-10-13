import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
export const app = fileURLToPath(new URL('../', import.meta.url))
export const root = resolve(app, '../..')
export const aliases = {
  '@genoffice/viewer-renderers/ui': resolve(root, 'packages/viewer-renderers/src/ui/index.ts'),
  '@genoffice/viewer-renderers': resolve(root, 'packages/viewer-renderers/src'),
  '@genoffice/viewer-services': resolve(root, 'packages/viewer-services/src'),
  '@genoffice/docx-engine/metafile': resolve(root, 'packages/docx-engine/src/metafile.ts'),
  '@genoffice/docx-engine': resolve(root, 'packages/docx-engine/src/index.ts'),
}
