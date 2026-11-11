/**
 * Plan §6: only transient infrastructure failures are retried, and only a
 * bounded number of times. Parse/model errors, corruption, lease loss and
 * storage exhaustion must surface immediately instead of looping.
 */
const RECOVERABLE_CODES = new Set([
  'EAGAIN',
  'EBUSY',
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ENETRESET',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ER_LOCK_DEADLOCK',
  'ER_LOCK_WAIT_TIMEOUT',
  'PROTOCOL_CONNECTION_LOST',
  'PROTOCOL_SEQUENCE_TIMEOUT',
])

/** Walk the cause chain: mysql2 and fs often wrap the actionable code. */
export function isRecoverableInfrastructureError(value: unknown): boolean {
  let current = value
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    const error = current as { code?: unknown; cause?: unknown }
    if (typeof error.code === 'string' && RECOVERABLE_CODES.has(error.code)) return true
    current = error.cause
  }
  return false
}

/** Exponential backoff without jitter: these retries run per build, not per request. */
export function retryDelayMs(attempt: number, baseMs = 50, maxMs = 2000): number {
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error('invalid retry attempt')
  return Math.min(maxMs, baseMs * 2 ** (attempt - 1))
}
