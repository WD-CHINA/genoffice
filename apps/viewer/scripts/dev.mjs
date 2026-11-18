import { spawn, spawnSync } from 'node:child_process'
import { root, app } from './paths.mjs'
import { resolve } from 'node:path'

const parsePort = process.env.PARSE_SERVER_PORT || '8787'
const env = {
  ...process.env,
  PARSE_SERVER_URL: process.env.PARSE_SERVER_URL || `http://127.0.0.1:${parsePort}`,
}

// The same deployment snapshot is required by the development entry too.
const snapshot = spawnSync(
  process.execPath,
  ['--import', 'tsx', resolve(app, 'scripts/build-electron-fonts.mts')],
  { cwd: root, stdio: 'inherit', env },
)
if (snapshot.status !== 0) process.exit(snapshot.status ?? 1)

const frontend = spawn(
  process.execPath,
  [resolve(app, 'node_modules/vite/bin/vite.js'), '--config', resolve(app, 'vite.config.ts')],
  { cwd: app, stdio: 'inherit', env },
)
const stop = () => {
  frontend.kill()
  process.exit()
}
frontend.on('exit', (code) => process.exit(code ?? 0))
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
