import { readFile, writeFile } from 'node:fs/promises'
import { decryptOoxml } from '@genoffice/viewer-services/shared/ooxml-encryption'
import { parentPort } from './worker-channel'

// The shared Electron algorithm is CPU/memory intensive. Keep it in the same
// bounded child-process boundary as parsing; the password never leaves IPC.
if (!parentPort) throw new Error('office decrypt worker requires an isolated process')
parentPort.on(
  'message',
  (input: { path: string; output: string; password: string; maxBytes: number }) => {
    void (async () => {
      try {
        const plain = await decryptOoxml(await readFile(input.path), input.password)
        if (plain.length > input.maxBytes)
          throw Object.assign(new Error('decrypted document exceeds the parse limit'), {
            code: 'parse_limit',
          })
        await writeFile(input.output, plain, { mode: 0o600, flag: 'wx' })
        parentPort!.postMessage({ ok: true })
      } catch (error) {
        const reason = (error as { reason?: string }).reason
        parentPort!.postMessage({
          ok: false,
          code:
            reason === 'wrong-password'
              ? 'wrong_password'
              : ((error as { code?: string }).code ?? 'unsupported_encryption'),
        })
      }
    })()
  },
)
