import { build as viteBuild } from 'vite'
import { mkdir, cp } from 'node:fs/promises'
import { resolve } from 'node:path'
import { app, root } from './paths.mjs'

export async function copyPdfAssets() {
  const pdf = resolve(root, 'node_modules/pdfjs-dist')
  await mkdir(resolve(app, 'dist/web/pdfjs'), { recursive: true })
  for (const dir of ['cmaps', 'standard_fonts', 'wasm'])
    await cp(resolve(pdf, dir), resolve(app, 'dist/web/pdfjs', dir), { recursive: true })
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  await viteBuild({
    configFile: resolve(app, 'vite.config.ts'),
    base: process.env.VIEWER_BASE || '/viewer/',
  })
  await copyPdfAssets()
}
