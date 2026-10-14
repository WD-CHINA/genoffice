import { spawn } from 'node:child_process'
import { root, app } from './paths.mjs'
import { resolve } from 'node:path'
const frontend = spawn(
  process.execPath,
  [resolve(root, 'node_modules/vite/bin/vite.js'), '--config', resolve(app, 'vite.config.ts')],
  { cwd: app, stdio: 'inherit' },
)
const stop = () => {
  frontend.kill()
  process.exit()
}
frontend.on('exit', (code) => process.exit(code ?? 0))
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
