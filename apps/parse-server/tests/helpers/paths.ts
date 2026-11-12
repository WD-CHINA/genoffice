import { fileURLToPath } from 'node:url'

/** Test assets are relative to this package, independent of the invoking shell's cwd. */
export const serverRoot = fileURLToPath(new URL('../../', import.meta.url))
