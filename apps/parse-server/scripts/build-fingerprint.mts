import { writeFile } from 'node:fs/promises'
import { parserFingerprint } from '../src/parser-fingerprint'

/**
 * Build-system fingerprint injection (plan §4.1/§4): source deployments hash
 * parser sources + lockfile, but the hash must be produced by the build and
 * passed in as PARSE_SERVER_BUILD_FINGERPRINT so the runtime never invents a
 * different value per process.
 *
 * Usage:
 *   node --import tsx scripts/build-fingerprint.mts [--version 0.1.0]  *     [--out build/parse-fingerprint.json] [--check]
 *
 * The printout is the value to export:
 *   export PARSE_SERVER_BUILD_FINGERPRINT=$(npm run -s fingerprint -w @genoffice/parse-server)
 */
function argument(name: string): string | undefined {
  const index = process.argv.indexOf('--' + name)
  return index >= 0 ? process.argv[index + 1] : undefined
}
const version = argument('version') ?? process.env.PARSE_SERVER_PARSER_VERSION ?? '0.1.0'
const output = argument('out')
const check = process.argv.includes('--check')
const fingerprint = await parserFingerprint(version)
const report = { version, fingerprint, generatedAt: new Date().toISOString() }
if (output) await writeFile(output, JSON.stringify(report, null, 2) + '\n')
console.log(fingerprint)
if (check) {
  const expected = process.env.PARSE_SERVER_BUILD_FINGERPRINT
  if (!expected) {
    console.error('PARSE_SERVER_BUILD_FINGERPRINT is not set')
    process.exitCode = 2
  } else if (expected !== fingerprint) {
    console.error('PARSE_SERVER_BUILD_FINGERPRINT does not match the current sources')
    process.exitCode = 1
  }
}
