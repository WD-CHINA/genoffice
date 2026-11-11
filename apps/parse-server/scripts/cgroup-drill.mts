/** Run only in a disposable Linux container with its own writable cgroup namespace. */
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { IsolatedWorker, processRss } from '../src/isolated-worker'

assert.equal(process.platform, 'linux')
const root = '/sys/fs/cgroup'
// cgroup v2 domain controllers require the supervising process in a leaf.
await mkdir(`${root}/supervisor`, { recursive: true })
// tsx may already have started an esbuild helper, which must leave the domain too.
for (const pid of (await readFile(`${root}/cgroup.procs`, 'utf8')).trim().split(/\s+/)) {
  await writeFile(`${root}/supervisor/cgroup.procs`, pid)
}
await writeFile(`${root}/cgroup.subtree_control`, '+memory')
const child = new IsolatedWorker(new URL('../tests/helpers/process-fixture.mjs', import.meta.url), {
  heapMb: 64, rssMb: 192, sampleMs: 5000, cgroupRoot: root,
})
const failed = once(child, 'error')
const before = await readFile(`${root}/memory.events`, 'utf8')
child.postMessage({ op: 'allocate', bytes: 512 * 1024 ** 2 })
const [error] = await failed
await child.terminate()
const after = await readFile(`${root}/memory.events`, 'utf8')
const oomKills = (text: string) => Number(/^oom_kill (\d+)$/m.exec(text)?.[1] ?? 0)
assert.equal(error.code, 'parse_memory_limit')
assert.ok(oomKills(after) > oomKills(before), 'kernel OOM counter did not advance')
assert.equal(await processRss(child.pid!), null)
const report = { passed: true, errorCode: error.code, before, after,
  parentAlive: true, childExited: true, peakSampledRss: child.peakRssBytes }
console.log(JSON.stringify(report, null, 2))
