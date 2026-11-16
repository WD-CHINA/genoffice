/** Own only this drill's USB mappings; leave the application and other devices intact. */
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { connectAndroidWebView } from './android-cdp.mjs'

const sdkAdb = join(
  process.env.ANDROID_HOME ||
    process.env.ANDROID_SDK_ROOT ||
    join(homedir(), 'Library/Android/sdk'),
  'platform-tools',
  process.platform === 'win32' ? 'adb.exe' : 'adb',
)
const adbBinary = process.env.ADB || (existsSync(sdkAdb) ? sdkAdb : 'adb')
const execute = promisify(execFile)
// ADB joins shell operands before invoking the device shell. Preserve empty
// strings and quote metacharacters so intent extras keep their argument slots.
const remoteArgs = (args) =>
  args[0] === 'shell'
    ? ['shell', ...args.slice(1).map((word) => "'" + String(word).replaceAll("'", "'\\''") + "'")]
    : args
export async function androidAdb(serial, ...args) {
  return (
    await execute(adbBinary, ['-s', serial, ...remoteArgs(args)], {
      maxBuffer: 32 * 1024 * 1024,
      timeout: 180_000,
    })
  ).stdout
}

export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
export function createAndroidTestDevice(
  addresses,
  cdpPort = Number(process.env.ANDROID_MEDIA_CDP_PORT || 19224),
) {
  const serial = process.env.ANDROID_SERIAL
  if (!serial) throw Error('ANDROID_SERIAL required')
  const ports = [
    ...new Set(
      addresses.map((address) => {
        const url = new URL(address)
        if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port)
          throw Error('USB drill requires loopback HTTP services with explicit ports')
        return url.port
      }),
    ),
  ]
  const adb = (...args) =>
    execFileSync(adbBinary, ['-s', serial, ...remoteArgs(args)], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    })
  const mappings = (kind) =>
    adb(kind, '--list')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => line.trim().split(/\s+/))
  const reverses = new Map(mappings('reverse').map((parts) => parts.slice(-2)))
  const forwards = new Map(
    mappings('forward')
      .filter((parts) => parts[0] === serial)
      .map((parts) => parts.slice(-2)),
  )
  const connections = new Set()
  const connect = async (pid) => {
    if (pid) adb('forward', `tcp:${cdpPort}`, `localabstract:webview_devtools_remote_${pid}`)
    const client = await connectAndroidWebView(cdpPort)
    const owned = {
      ...client,
      close() {
        connections.delete(owned)
        client.close()
      },
    }
    connections.add(owned)
    return owned
  }
  return {
    adb,
    serial,
    ports,
    connect,
    readBytes(args, maxBuffer = 32 * 1024 * 1024) {
      return execFileSync(adbBinary, ['-s', serial, ...args], { maxBuffer, timeout: 180_000 })
    },
    access() {
      for (const port of ports) adb('reverse', `tcp:${port}`, `tcp:${port}`)
    },
    disconnect() {
      for (const port of ports) adb('reverse', '--remove', `tcp:${port}`)
    },
    restore() {
      for (const connection of connections) connection.close()
      for (const [kind, from, previous] of [
        ...ports.map((port) => ['reverse', `tcp:${port}`, reverses.get(`tcp:${port}`)]),
        ['forward', `tcp:${cdpPort}`, forwards.get(`tcp:${cdpPort}`)],
      ]) {
        if (previous) adb(kind, from, previous)
        else
          try {
            adb(kind, '--remove', from)
          } catch {
            /* A closed process may already have removed its mapping. */
          }
      }
    },
  }
}
