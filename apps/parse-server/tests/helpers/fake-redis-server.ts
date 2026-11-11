import { createServer, type AddressInfo, type Server, type Socket } from 'node:net'

/**
 * In-process RESP2 server used by the redis-cache-client tests. It implements
 * only the commands the hot-cache store sends (PING/AUTH/SELECT/HSET/EXPIRE/
 * HGETALL/DEL/FLUSHALL) plus a few knobs for failure injection: reply delay,
 * one-shot error replies, and forced disconnects. Test-only helper, never
 * imported by `src/`.
 */

export interface FakeRedisCommand {
  name: string
  args: string[]
  /** Index of the TCP chunk that delivered the command (pipeline shape checks). */
  chunk: number
}

export interface FakeRedisServerOptions {
  username?: string
  password?: string
  /** Reply delay for every command, in milliseconds. */
  delayMs?: number
}

export interface FakeRedisServer {
  readonly port: number
  readonly commands: FakeRedisCommand[]
  /** Total sockets accepted since the server started. */
  readonly connectionCount: number
  readonly activeConnections: number
  listen(): Promise<number>
  close(): Promise<void>
  /** Destroy every open socket, simulating a Redis restart. */
  disconnectAll(): void
  /** Resolve once at least `count` commands have been received. */
  waitForCommands(count: number, timeoutMs?: number): Promise<void>
  setDelay(ms: number): void
  /** Make the next command fail with a `-<message>` reply. */
  failNext(message: string): void
  /** Forget recorded commands, hashes and injected failures. */
  reset(): void
}

function simpleString(value: string): string {
  return `+${value}\r\n`
}

function errorReply(message: string): string {
  return `-${message}\r\n`
}

function integerReply(value: number): string {
  return `:${value}\r\n`
}

function arrayReply(values: readonly string[]): string {
  let payload = `*${values.length}\r\n`
  for (const value of values) {
    payload += `$${Buffer.byteLength(value)}\r\n${value}\r\n`
  }
  return payload
}

function readLine(buffer: Buffer, offset: number): { line: string; next: number } | null {
  const end = buffer.indexOf('\r\n', offset)
  if (end === -1) return null
  return { line: buffer.toString('utf8', offset, end), next: end + 2 }
}

/** Parses client commands (RESP2 arrays of bulk strings). */
function parseCommand(buffer: Buffer, offset: number): { args: string[]; next: number } | null {
  if (offset >= buffer.length) return null
  if (buffer[offset] !== 0x2a) throw new Error('fake redis only accepts RESP arrays')
  const header = readLine(buffer, offset + 1)
  if (header === null) return null
  const count = Number.parseInt(header.line, 10)
  let next = header.next
  const args: string[] = []
  for (let index = 0; index < count; index += 1) {
    if (next >= buffer.length) return null
    if (buffer[next] !== 0x24) throw new Error('fake redis only accepts bulk strings')
    const size = readLine(buffer, next + 1)
    if (size === null) return null
    const length = Number.parseInt(size.line, 10)
    const end = size.next + length
    if (buffer.length < end + 2) return null
    args.push(buffer.toString('utf8', size.next, end))
    next = end + 2
  }
  return { args, next }
}

class CommandParser {
  private buffer: Buffer = Buffer.alloc(0)

  push(chunk: Buffer): string[][] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    const commands: string[][] = []
    let offset = 0
    for (;;) {
      const parsed = parseCommand(this.buffer, offset)
      if (parsed === null) break
      commands.push(parsed.args)
      offset = parsed.next
    }
    this.buffer = offset === 0 ? this.buffer : this.buffer.subarray(offset)
    return commands
  }
}

export async function startFakeRedisServer(
  options: FakeRedisServerOptions = {},
): Promise<FakeRedisServer> {
  const hashes = new Map<string, Map<string, string>>()
  const commands: FakeRedisCommand[] = []
  const sockets = new Set<Socket>()
  const injectedFailures: string[] = []
  const waiters: { count: number; resolve: () => void }[] = []
  let delayMs = options.delayMs ?? 0
  let connectionCount = 0
  let chunkIndex = 0
  let port = 0

  const notifyWaiters = (): void => {
    for (const waiter of waiters.slice()) {
      if (commands.length < waiter.count) continue
      waiters.splice(waiters.indexOf(waiter), 1)
      waiter.resolve()
    }
  }

  const handle = (command: FakeRedisCommand): string => {
    const failure = injectedFailures.shift()
    if (failure !== undefined) return errorReply(failure)
    switch (command.name) {
      case 'PING':
        return simpleString('PONG')
      case 'AUTH': {
        if (options.password === undefined)
          return errorReply('ERR Client sent AUTH, but no password is set')
        const username = command.args.length >= 2 ? command.args[0] : undefined
        const password = command.args.length >= 2 ? command.args[1] : command.args[0]
        if (password !== options.password) return errorReply('WRONGPASS invalid password')
        if (options.username !== undefined && username !== options.username)
          return errorReply('WRONGPASS invalid username')
        return simpleString('OK')
      }
      case 'SELECT':
        return simpleString('OK')
      case 'HSET': {
        const [key, ...pairs] = command.args
        if (key === undefined) return errorReply('ERR wrong number of arguments for HSET')
        const hash = hashes.get(key) ?? new Map<string, string>()
        for (let index = 0; index < pairs.length; index += 2) {
          hash.set(pairs[index], pairs[index + 1] ?? '')
        }
        hashes.set(key, hash)
        return integerReply(pairs.length / 2)
      }
      case 'EXPIRE': {
        const key = command.args[0]
        return integerReply(key !== undefined && hashes.has(key) ? 1 : 0)
      }
      case 'HGETALL': {
        const key = command.args[0]
        const hash = key === undefined ? undefined : hashes.get(key)
        if (hash === undefined) return arrayReply([])
        const values: string[] = []
        for (const [field, value] of hash) values.push(field, value)
        return arrayReply(values)
      }
      case 'DEL': {
        let removed = 0
        for (const key of command.args) if (hashes.delete(key)) removed += 1
        return integerReply(removed)
      }
      case 'FLUSHALL':
        hashes.clear()
        return simpleString('OK')
      default:
        return errorReply(`ERR unknown command '${command.name}'`)
    }
  }

  const server: Server = createServer((socket) => {
    connectionCount += 1
    sockets.add(socket)
    const parser = new CommandParser()
    socket.on('close', () => {
      sockets.delete(socket)
    })
    socket.on('error', () => {
      socket.destroy()
    })
    socket.on('data', (chunk: Buffer) => {
      const chunkId = chunkIndex
      chunkIndex += 1
      let parsed: string[][]
      try {
        parsed = parser.push(chunk)
      } catch {
        socket.destroy()
        return
      }
      for (const args of parsed) {
        const name = (args[0] ?? '').toUpperCase()
        const command: FakeRedisCommand = { name, args: args.slice(1), chunk: chunkId }
        commands.push(command)
        notifyWaiters()
        const reply = handle(command)
        if (delayMs <= 0) {
          if (!socket.destroyed) socket.write(reply)
          continue
        }
        setTimeout(() => {
          if (!socket.destroyed) socket.write(reply)
        }, delayMs)
      }
    })
  })

  const fake: FakeRedisServer = {
    get port() {
      return port
    },
    get commands() {
      return commands
    },
    get connectionCount() {
      return connectionCount
    },
    get activeConnections() {
      return sockets.size
    },
    async listen() {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => {
          server.off('error', reject)
          resolve()
        })
      })
      port = (server.address() as AddressInfo).port
      return port
    },
    async close() {
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
    },
    disconnectAll() {
      for (const socket of sockets) socket.destroy()
      sockets.clear()
    },
    waitForCommands(count: number, timeoutMs = 2000) {
      if (commands.length >= count) return Promise.resolve()
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.findIndex((waiter) => waiter.count === count)
          if (index !== -1) waiters.splice(index, 1)
          reject(new Error(`timed out waiting for ${count} commands`))
        }, timeoutMs)
        waiters.push({
          count,
          resolve: () => {
            clearTimeout(timer)
            resolve()
          },
        })
      })
    },
    setDelay(ms: number) {
      delayMs = ms
    },
    failNext(message: string) {
      injectedFailures.push(message)
    },
    reset() {
      commands.length = 0
      hashes.clear()
      injectedFailures.length = 0
    },
  }
  return fake
}
