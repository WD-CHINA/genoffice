import { spawn } from 'node:child_process'
import { buildServer } from './build.mjs'
import { root, app } from './paths.mjs'
import { resolve } from 'node:path'
let backend,
  frontend,
  stopping = false
const stop = () => {
  if (stopping) return
  stopping = true
  backend?.kill()
  frontend?.kill()
  process.exit()
}
await buildServer({
  watch: true,
  onRebuild() {
    if (stopping) return
    const previous = backend
    backend = undefined
    if (previous) {
      previous.once('exit', startBackend)
      previous.kill()
    } else startBackend()
  },
})
function startBackend() {
  if (stopping) return
  const child = spawn(process.execPath, ['dist/server/index.mjs'], { cwd: app, stdio: 'inherit' })
  backend = child
  child.on('exit', () => {
    if (backend === child) stop()
  })
}
frontend = spawn(
  process.execPath,
  [resolve(root, 'node_modules/vite/bin/vite.js'), '--config', resolve(app, 'vite.config.ts')],
  { cwd: app, stdio: 'inherit' },
)
frontend.on('exit', stop)
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
