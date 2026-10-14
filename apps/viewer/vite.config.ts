import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { writeFile, mkdir } from 'node:fs/promises'
import { aliases, app, root } from './scripts/paths.mjs'

const host = process.env.VIEWER_HOST || '0.0.0.0'
const proxyHost = ['0.0.0.0', '::'].includes(host) ? '127.0.0.1' : host
const proxyTarget = `http://${proxyHost.includes(':') ? `[${proxyHost}]` : proxyHost}:${process.env.VIEWER_PORT || 11000}`

export default defineConfig({
  root: resolve(app, 'src/web'),
  plugins: [
    react(),
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
  resolve: { alias: aliases },
  server: {
    host,
    port: 11001,
    strictPort: true,
    fs: { allow: [root] },
    proxy: {
      '^/api(?:/|$)': { target: proxyTarget, changeOrigin: false },
      '^/pdfjs(?:/|$)': { target: proxyTarget, changeOrigin: false },
    },
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
