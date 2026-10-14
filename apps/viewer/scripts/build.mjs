import { build, context } from 'esbuild'
import { build as viteBuild } from 'vite'
import { mkdir, copyFile, cp, writeFile, readFile } from 'node:fs/promises'
import { basename, resolve, relative, dirname } from 'node:path'
import { app, root, aliases } from './paths.mjs'

export async function buildServer({ watch = false, onRebuild } = {}) {
  await mkdir(resolve(app, 'dist/assets'), { recursive: true })
  const assets = {
    name: 'viewer-assets',
    setup(b) {
      b.onResolve({ filter: /\?raw$/ }, (args) => ({
        path: resolve(args.resolveDir, args.path.replace(/\?raw$/, '')),
        namespace: 'raw',
      }))
      b.onLoad({ filter: /.*/, namespace: 'raw' }, async (args) => ({
        contents: `export default ${JSON.stringify(await readFile(args.path, 'utf8'))}`,
        loader: 'js',
        watchFiles: [args.path],
      }))
      b.onResolve({ filter: /\?asset$/ }, (args) => {
        const path = args.path.replace(/\?asset$/, '')
        return {
          path: path.startsWith('@genoffice/ui/')
            ? resolve(root, 'packages/ui/src', path.slice('@genoffice/ui/'.length))
            : resolve(args.resolveDir, path),
          namespace: 'asset',
        }
      })
      b.onLoad({ filter: /.*/, namespace: 'asset' }, async (args) => {
        await copyFile(args.path, resolve(app, 'dist/assets', basename(args.path)))
        return {
          contents: `import {fileURLToPath} from 'node:url';export default fileURLToPath(new URL('../assets/${basename(args.path)}',import.meta.url))`,
          loader: 'js',
          watchFiles: [args.path],
        }
      })
    },
  }
  const audit = {
    name: 'viewer-boundary',
    setup(b) {
      b.onEnd(async (result) => {
        if (result.errors.length || !result.metafile) return
        const forbidden = Object.keys(result.metafile.inputs).filter((p) =>
          /(?:^|\/)(?:electron|ai-provider|ai-search|agent-runtime)\//.test(p),
        )
        if (forbidden.length)
          throw new Error('Forbidden runtime dependencies: ' + forbidden.join(', '))
        await writeFile(
          resolve(app, 'dist/server/metafile.json'),
          JSON.stringify(result.metafile, null, 2),
        )
        onRebuild?.()
      })
    },
  }
  const buildTool = watch ? context : build
  const result = await buildTool({
    absWorkingDir: app,
    entryPoints: { index: 'src/server/index.ts', 'pptx-worker': 'src/server/pptx-worker.ts' },
    outdir: resolve(app, 'dist/server'),
    outExtension: { '.js': '.mjs' },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    alias: aliases,
    plugins: [assets, audit],
    external: ['playwright-core'],
    metafile: true,
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module';const require=__createRequire(import.meta.url);",
    },
  })
  const pdf = resolve(root, 'node_modules/pdfjs-dist')
  await mkdir(resolve(app, 'dist/web/pdfjs'), { recursive: true })
  for (const dir of ['cmaps', 'standard_fonts', 'wasm'])
    await cp(resolve(pdf, dir), resolve(app, 'dist/web/pdfjs', dir), { recursive: true })
  await copyFile(resolve(app, 'runtime-package.json'), resolve(app, 'dist/package.json'))
  await copyFile(resolve(app, 'runtime-package-lock.json'), resolve(app, 'dist/package-lock.json'))
  await copyFile(resolve(app, 'ecosystem.config.cjs'), resolve(app, 'dist/ecosystem.config.cjs'))
  await copyFile(resolve(app, 'pm2-start.sh'), resolve(app, 'dist/pm2-start.sh'))
  if (watch) {
    await result.watch()
    return result
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  await viteBuild({ configFile: resolve(app, 'vite.config.ts') })
  await buildServer()
}
