import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bundledPackages } from '../scripts/package-dependencies.mjs'

test('licenses resolve nested pnpm and scoped package roots instead of .pnpm/package.json', () => {
  const packages = bundledPackages([
    '/repo/node_modules/.pnpm/sax@1.0/node_modules/sax/lib/parser.js',
    '/repo/node_modules/.pnpm/sax@1.0/node_modules/sax/lib/helpers.js',
    '/repo/node_modules/.pnpm/sax@2.0/node_modules/sax/index.js',
    '\0/repo/node_modules/.pnpm/@scope+pkg@1.0/node_modules/@scope/pkg/index.js?commonjs-proxy',
    '/repo/node_modules/react/index.js',
    '/repo/node_modules/.vite/deps/react.js',
    '/repo/apps/viewer/src/web/upload.tsx',
  ])
  assert.equal(packages.length, 4)
  assert.ok(packages.every((pkg) => !pkg.name.startsWith('.')))
  assert.deepEqual(
    packages.filter((pkg) => pkg.name === 'sax').map((pkg) => pkg.directory),
    [
      '/repo/node_modules/.pnpm/sax@1.0/node_modules/sax',
      '/repo/node_modules/.pnpm/sax@2.0/node_modules/sax',
    ],
  )
  assert.ok(
    packages.some(
      (pkg) => pkg.name === '@scope/pkg' && pkg.directory.endsWith('/node_modules/@scope/pkg'),
    ),
  )
})
