import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, resolve, sep } from 'node:path'
import { writeFile, mkdir } from 'node:fs/promises'
import { aliases, app, root } from './scripts/paths.mjs'

const host = process.env.VIEWER_HOST || '0.0.0.0'
const base = process.env.VIEWER_BASE || '/'

function pdfjsAssets(): Plugin {
  const pdfRoot = resolve(root, 'node_modules/pdfjs-dist')
  const types: Record<string, string> = {
    '.bcmap': 'application/octet-stream',
    '.pfb': 'application/octet-stream',
    '.ttf': 'font/ttf',
    '.wasm': 'application/wasm',
    '.json': 'application/json',
  }
  return {
    name: 'pdfjs-assets',
    configureServer(server) {
      server.middlewares.use(`${base.replace(/\/$/, '')}/pdfjs`, (req, res, next) => {
        const url = decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\/+/, '')
        const file = resolve(pdfRoot, url)
        if (file !== pdfRoot && !file.startsWith(pdfRoot + sep)) return next()
        if (!existsSync(file) || !statSync(file).isFile()) return next()
        res.setHeader('Content-Type', types[extname(file)] || 'application/octet-stream')
        createReadStream(file).pipe(res)
      })
    },
  }
}

export default defineConfig({
  base,
  root: resolve(app, 'src/web'),
  plugins: [
    react(),
    pdfjsAssets(),
    {
      name: 'viewer-runtime-boundary',
      async generateBundle() {
        const modules = [...this.getModuleIds()]
        const forbidden = modules.filter(
          (id) =>
            /\/apps\/(?!viewer\/)/.test(id) ||
            /\/(?:electron|ai-provider|ai-search|agent-runtime|agent-host)\//.test(id),
        )
        if (forbidden.length)
          this.error('Forbidden Viewer runtime modules: ' + forbidden.join(', '))
        await mkdir(resolve(app, 'dist/audit'), { recursive: true })
        await writeFile(
          resolve(app, 'dist/audit/frontend-modules.json'),
          JSON.stringify(modules, null, 2),
        )
      },
    },
  ],
  resolve: {
    // Viewer pins React under apps/viewer, while react-konva resolves the root
    // copy. Two Reacts make the hook dispatcher null: "reading 'useRef'".
    dedupe: ['react', 'react-dom'],
    alias: [
      {
        find: /^react(-dom)?(\/.*)?$/,
        replacement: resolve(app, 'node_modules/react$1$2'),
      },
      { find: 'crypto', replacement: resolve(app, 'src/web/shims/crypto.ts') },
      { find: 'node:crypto', replacement: resolve(app, 'src/web/shims/crypto.ts') },
      { find: 'node:zlib', replacement: resolve(app, 'src/web/shims/zlib.ts') },
      ...Object.entries(aliases).map(([find, replacement]) => ({ find, replacement })),
    ],
  },
  server: {
    host,
    port: 11001,
    strictPort: true,
    fs: { allow: [root] },
  },
  build: {
    outDir: resolve(app, 'dist/web'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        host: resolve(app, 'src/web/index.html'),
        preview: resolve(app, 'src/web/preview.html'),
      },
    },
  },
})
