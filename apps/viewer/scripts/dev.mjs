import { spawn } from 'node:child_process'
import { root, app } from './paths.mjs'
import { resolve } from 'node:path'

const parsePort = process.env.PARSE_SERVER_PORT || '8787'
const env = {
  ...process.env,
  PARSE_SERVER_URL:
    process.env.PARSE_SERVER_URL || `http://127.0.0.1:${parsePort}`,
}

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
