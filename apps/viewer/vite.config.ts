import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, resolve, sep } from 'node:path'
import { writeFile, mkdir } from 'node:fs/promises'
import { aliases, app, root } from './scripts/paths.mjs'

const host = process.env.VIEWER_HOST || '0.0.0.0'

function pdfjsAssets() {
  const base = resolve(root, 'node_modules/pdfjs-dist')
  const types = {
    '.bcmap': 'application/octet-stream',
    '.pfb': 'application/octet-stream',
    '.ttf': 'font/ttf',
    '.wasm': 'application/wasm',
    '.json': 'application/json',
  }
  return {
    name: 'pdfjs-assets',
    configureServer(server) {
      server.middlewares.use('/pdfjs', (req, res, next) => {
        const url = decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\/+/, '')
        const file = resolve(base, url)
        if (file !== base && !file.startsWith(base + sep)) return next()
        if (!existsSync(file) || !statSync(file).isFile()) return next()
        res.setHeader('Content-Type', types[extname(file)] || 'application/octet-stream')
        createReadStream(file).pipe(res)
      })
    },
  }
}

export default defineConfig({
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
    alias: {
      ...aliases,
      crypto: resolve(app, 'src/web/shims/crypto.ts'),
      'node:crypto': resolve(app, 'src/web/shims/crypto.ts'),
      'node:zlib': resolve(app, 'src/web/shims/zlib.ts'),
    },
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
