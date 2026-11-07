import { fileURLToPath } from 'node:url'

const entry = new URL(process.argv[2])
if (entry.protocol !== 'file:' || !process.send) throw new Error('invalid parser process entry')
process.on('disconnect', () => process.exit(0))
let started = false
// The parent installs the optional cgroup before allowing parser code to execute.
process.on('message', async (message) => {
  if (message?.type !== 'bootstrap_start' || started) return
  started = true
  try {
    const { register } = await import('tsx/esm/api')
    register({ tsconfig: fileURLToPath(new URL('../tsconfig.json', import.meta.url)) })
    await import(entry.href)
    process.send({ type: 'bootstrap_loaded' })
  } catch {
    process.send({ type: 'bootstrap_failed' }, () => process.exit(1))
  }
})
process.send({ type: 'bootstrap_ready' })
