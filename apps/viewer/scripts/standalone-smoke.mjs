import assert from 'node:assert/strict'
import { access } from 'node:fs/promises'
import { resolve } from 'node:path'
import { app } from './paths.mjs'

const release = resolve(app, 'releases/genoffice-viewer')
for (const file of ['index.html', 'preview.html'])
  await access(resolve(release, file))
for (const file of ['server', 'ecosystem.config.cjs', 'pm2-start.sh', 'package.json']) {
  await access(resolve(release, file)).then(
    () => {
      throw new Error('Static release still contains ' + file)
    },
    () => undefined,
  )
}
for (const file of [
  'ecosystem.config.cjs',
  'pm2-start.sh',
  'runtime-package.json',
  'src/server',
  'src/web/api.ts',
]) {
  await access(resolve(app, file)).then(
    () => {
      throw new Error('Viewer still contains server path ' + file)
    },
    () => undefined,
  )
}
assert.equal(true, true)
console.log('Static release has no Node server or PM2 configuration')
