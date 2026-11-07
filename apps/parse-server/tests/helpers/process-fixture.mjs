let retained
process.on('message', (message) => {
  if (message.op === 'echo') process.send({ pid: process.pid, data: message.data })
  if (message.op === 'crash') process.exit(17)
  if (message.op === 'allocate') retained = Buffer.alloc(message.bytes, 127)
  if (message.op === 'allocate' || message.op === 'spin') {
    process.send({ started: true })
    const until = Date.now() + 15_000
    while (Date.now() < until) {
      /* Deliberately block child timers; the parent must enforce limits. */
    }
    process.send({ unexpected: true, bytes: retained?.length ?? 0 })
  }
})
