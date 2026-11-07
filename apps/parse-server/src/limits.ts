/** Upload and archive limits for the parse server; every value can be overridden per instance. */
export interface ServerLimits {
  /** Hard cap on one uploaded file. */
  maxUploadBytes: number
  /** Largest declared uncompressed part accepted while sniffing an archive. */
  maxPartBytes: number
  /** Declared uncompressed total accepted while sniffing an archive. */
  maxTotalUncompressedBytes: number
  /** Maximum number of parts accepted while sniffing an archive. */
  maxParts: number
  /** Largest file the in-process PPTX parser will open (MVP: whole file in memory). */
  maxParseBytes: number
}

export const DEFAULT_LIMITS: ServerLimits = {
  maxUploadBytes: 2 * 1024 * 1024 * 1024,
  maxPartBytes: 2 * 1024 * 1024 * 1024,
  maxTotalUncompressedBytes: 4 * 1024 * 1024 * 1024,
  maxParts: 10_000,
  maxParseBytes: 256 * 1024 * 1024,
}

export function resolveLimits(partial?: Partial<ServerLimits>): ServerLimits {
  const limits = { ...DEFAULT_LIMITS }
  for (const key of Object.keys(DEFAULT_LIMITS) as Array<keyof ServerLimits>) {
    const value = partial?.[key]
    if (value === undefined) continue
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`invalid server limit: ${key} must be a positive safe integer`)
    }
    limits[key] = value
  }
  return limits
}
