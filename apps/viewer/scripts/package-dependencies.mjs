import { isAbsolute } from 'node:path'

/** Resolve actual bundled package roots, including pnpm's nested dependency paths.
 * @param {string[]} modules
 * @returns {{name: string, directory: string}[]}
 */
export function bundledPackages(modules) {
  const roots = new Map()
  for (const id of modules) {
    const path = id.replace(/^\0/, '').replaceAll('\\', '/')
    if (!isAbsolute(path)) continue
    const matches = [...path.matchAll(/\/node_modules\/((?:@[^/]+\/)?[^/]+)/g)]
    const match = matches.at(-1)
    if (!match || match[1].startsWith('.')) continue
    const directory = path.slice(0, match.index + match[0].length)
    roots.set(directory, { name: match[1], directory })
  }
  return [...roots.values()].sort((left, right) => left.directory.localeCompare(right.directory))
}
