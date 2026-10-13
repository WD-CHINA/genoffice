import { networkInterfaces } from 'node:os'

/** Non-loopback addresses of this machine, so a LAN browser can open the dev or packaged server. */
export function lanHosts(): string[] {
  const hosts: string[] = []
  for (const entries of Object.values(networkInterfaces()))
    for (const entry of entries || []) if (!entry.internal) hosts.push(entry.address)
  return hosts
}

export function originAllowed(origin: string, hostHeader: string | undefined): boolean {
  const allowed = new Set(
    [
      hostHeader ? `http://${hostHeader}` : '',
      hostHeader ? `https://${hostHeader}` : '',
      ...(process.env.VIEWER_ALLOWED_ORIGINS || 'http://127.0.0.1:5180,http://localhost:5180')
        .split(',')
        .map((item) => item.trim()),
    ].filter(Boolean),
  )
  if (allowed.has(origin)) return true
  try {
    const parsed = new URL(origin)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    const name = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase()
    return lanHosts().some((host) => host.toLowerCase() === name)
  } catch {
    return false
  }
}

export function listenUrls(host: string, port: number): string[] {
  const hosts = host === '0.0.0.0' || host === '::' ? ['127.0.0.1', ...lanHosts()] : [host]
  return [...new Set(hosts)].map(
    (item) => `http://${item.includes(':') ? `[${item}]` : item}:${port}`,
  )
}
