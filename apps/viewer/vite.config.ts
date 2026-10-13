import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { writeFile, mkdir } from 'node:fs/promises'
import { aliases, app, root } from './scripts/paths.mjs'

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
    host: true,
    port: 5180,
    fs: { allow: [root] },
    proxy: { '/api': 'http://127.0.0.1:3001', '/pdfjs': 'http://127.0.0.1:3001' },
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
