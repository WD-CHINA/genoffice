/**
 * Browser stand-in for Node's Buffer. Installed only when the page has no Buffer,
 * so Node tests keep the real one. Covers the reads, writes, and encodings the
 * viewer uses while opening a document.
 */

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function fromHex(text: string): Uint8Array {
  const clean = text.length % 2 ? '0' + text : text
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

function fromUtf16le(text: string): Uint8Array {
  const out = new Uint8Array(text.length * 2)
  const view = new DataView(out.buffer)
  for (let i = 0; i < text.length; i++) view.setUint16(i * 2, text.charCodeAt(i), true)
  return out
}

// Node's Buffer.from signature clashes with Uint8Array.from; the runtime class is still a Uint8Array.
// @ts-expect-error static from is intentionally narrower than Uint8Array.from
export class BrowserBuffer extends Uint8Array {
  static isBuffer(value: unknown): value is BrowserBuffer {
    return value instanceof Uint8Array
  }

  static from(value: unknown, encoding?: string): BrowserBuffer {
    if (typeof value === 'string') {
      if (encoding === 'hex') return new BrowserBuffer(fromHex(value))
      if (encoding === 'base64') return new BrowserBuffer(fromBase64(value))
      if (encoding === 'utf16le' || encoding === 'ucs2') return new BrowserBuffer(fromUtf16le(value))
      if (encoding === 'binary' || encoding === 'latin1') {
        const out = new BrowserBuffer(value.length)
        for (let i = 0; i < value.length; i++) out[i] = value.charCodeAt(i) & 0xff
        return out
      }
      return new BrowserBuffer(utf8(value))
    }
    if (value instanceof ArrayBuffer) return new BrowserBuffer(value)
    if (ArrayBuffer.isView(value)) {
      const view = value as ArrayBufferView
      return new BrowserBuffer(Uint8Array.from(view as unknown as Uint8Array))
    }
    if (Array.isArray(value)) return new BrowserBuffer(value)
    throw new TypeError('Unsupported Buffer.from input')
  }

  static alloc(size: number, fill = 0): BrowserBuffer {
    const out = new BrowserBuffer(size)
    if (fill) out.fill(fill)
    return out
  }

  static allocUnsafe(size: number): BrowserBuffer {
    return BrowserBuffer.alloc(size)
  }

  static concat(list: ArrayLike<number>[], length?: number): BrowserBuffer {
    const items = [...list] as Uint8Array[]
    const total = length ?? items.reduce((sum, item) => sum + item.length, 0)
    const out = new BrowserBuffer(total)
    let offset = 0
    for (const item of items) {
      const slice = item.subarray(0, Math.max(0, total - offset))
      out.set(slice, offset)
      offset += slice.length
      if (offset >= total) break
    }
    return out
  }

  static byteLength(value: string, encoding?: string): number {
    return BrowserBuffer.from(value, encoding).length
  }

  override subarray(begin?: number, end?: number): BrowserBuffer {
    const view = super.subarray(begin, end)
    return new BrowserBuffer(view.buffer, view.byteOffset, view.byteLength)
  }

  slice(begin?: number, end?: number): BrowserBuffer {
    return BrowserBuffer.from(this.subarray(begin, end))
  }

  equals(other: Uint8Array): boolean {
    if (other.length !== this.length) return false
    for (let i = 0; i < this.length; i++) if (this[i] !== other[i]) return false
    return true
  }

  copy(target: Uint8Array, targetStart = 0, sourceStart = 0, sourceEnd = this.length): number {
    const slice = this.subarray(sourceStart, sourceEnd)
    target.set(slice, targetStart)
    return slice.length
  }

  readUInt16LE(offset: number): number {
    return new DataView(this.buffer, this.byteOffset, this.byteLength).getUint16(offset, true)
  }

  readUInt32LE(offset: number): number {
    return new DataView(this.buffer, this.byteOffset, this.byteLength).getUint32(offset, true)
  }

  writeUInt32LE(value: number, offset: number): number {
    new DataView(this.buffer, this.byteOffset, this.byteLength).setUint32(offset, value, true)
    return offset + 4
  }

  includes(needle: Uint8Array | number, from = 0): boolean {
    return this.indexOf(needle as number, from) !== -1
  }

  override indexOf(needle: Uint8Array | number, from = 0): number {
    if (typeof needle === 'number') return super.indexOf(needle, from)
    const start = Math.max(0, from)
    outer: for (let i = start; i <= this.length - needle.length; i++) {
      for (let j = 0; j < needle.length; j++) if (this[i + j] !== needle[j]) continue outer
      return i
    }
    return -1
  }

  toString(encoding?: string): string {
    if (encoding === 'hex') return [...this].map((b) => b.toString(16).padStart(2, '0')).join('')
    if (encoding === 'base64') {
      let binary = ''
      const chunk = 0x8000
      for (let i = 0; i < this.length; i += chunk)
        binary += String.fromCharCode(...this.subarray(i, i + chunk))
      return btoa(binary)
    }
    if (encoding === 'binary' || encoding === 'latin1')
      return String.fromCharCode(...this)
    if (encoding === 'utf16le' || encoding === 'ucs2') {
      const view = new DataView(this.buffer, this.byteOffset, this.byteLength)
      let text = ''
      for (let i = 0; i + 1 < this.length; i += 2) text += String.fromCharCode(view.getUint16(i, true))
      return text
    }
    return new TextDecoder().decode(this)
  }
}

export function installBrowserBuffer(): void {
  if (typeof globalThis.Buffer !== 'undefined') return
  ;(globalThis as unknown as { Buffer: typeof BrowserBuffer }).Buffer = BrowserBuffer
}

installBrowserBuffer()
