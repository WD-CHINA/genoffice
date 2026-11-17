import { IsolatedWorker, type ProcessLimits } from './isolated-worker'

export async function decryptOfficeUpload(
  input: { path: string; output: string; password: string; maxBytes: number },
  limits: ProcessLimits,
): Promise<void> {
  const worker = new IsolatedWorker(new URL('./office-decrypt-worker.ts', import.meta.url), limits)
  try {
    await new Promise<void>((resolve, reject) => {
      worker.once('error', reject)
      worker.once('exit', () => reject(new Error('Office decrypt worker exited before completion')))
      worker.once('message', (result: { ok: boolean; code?: string }) => {
        if (result.ok) resolve()
        else
          reject(
            Object.assign(new Error('Office document could not be decrypted'), {
              code: result.code,
            }),
          )
      })
      worker.postMessage(input)
    })
  } finally {
    await worker.terminate()
  }
}
