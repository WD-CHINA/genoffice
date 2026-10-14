/**
 * Sync crypto surface used by the PPTX zip hash and by officecrypto-tool.
 * The browser build aliases `crypto` and `node:crypto` here. Node tests keep
 * the real module because this file is not on their resolution path.
 */
import hashJs from 'hash.js'
import { BrowserBuffer, installBrowserBuffer } from '@genoffice/viewer-services/browser-buffer'

installBrowserBuffer()

type HashCtor = new () => any

function hashCtor(name: string): HashCtor {
  const key = name.toLowerCase().replace('-', '')
  const map: Record<string, any> = {
    sha1: hashJs.sha1,
    sha256: hashJs.sha256,
    sha384: hashJs.sha384,
    sha512: hashJs.sha512,
    ripemd160: hashJs.ripemd160,
    md5: Md5 as unknown as HashCtor,
  }
  const ctor = map[key]
  if (!ctor) throw new Error('Unsupported hash ' + name)
  return ctor
}

function asBytes(value: Uint8Array | string | number[]): Uint8Array {
  if (value instanceof Uint8Array) return value
  if (typeof value === 'string') return new TextEncoder().encode(value)
  return Uint8Array.from(value)
}

class Md5 {
  private blocks = [0, 0, 0, 0]
  private buffer = new Uint8Array(64)
  private length = 0
  private filled = 0
  constructor() {
    this.blocks = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476]
  }
  update(data: number[] | Uint8Array) {
    const bytes = data instanceof Uint8Array ? data : Uint8Array.from(data)
    let offset = 0
    while (offset < bytes.length) {
      const n = Math.min(64 - this.filled, bytes.length - offset)
      this.buffer.set(bytes.subarray(offset, offset + n), this.filled)
      this.filled += n
      offset += n
      if (this.filled === 64) {
        this.compress(this.buffer)
        this.length += 64
        this.filled = 0
      }
    }
    return this
  }
  digest() {
    const bits = (this.length + this.filled) * 8
    this.buffer[this.filled++] = 0x80
    if (this.filled > 56) {
      this.buffer.fill(0, this.filled)
      this.compress(this.buffer)
      this.filled = 0
    }
    this.buffer.fill(0, this.filled, 56)
    const view = new DataView(this.buffer.buffer)
    view.setUint32(56, bits >>> 0, true)
    view.setUint32(60, Math.floor(bits / 0x100000000), true)
    this.compress(this.buffer)
    const out = new Uint8Array(16)
    const words = new DataView(out.buffer)
    for (let i = 0; i < 4; i++) words.setUint32(i * 4, this.blocks[i] >>> 0, true)
    return [...out]
  }
  private compress(block: Uint8Array) {
    const m = new Uint32Array(16)
    const view = new DataView(block.buffer, block.byteOffset, 64)
    for (let i = 0; i < 16; i++) m[i] = view.getUint32(i * 4, true)
    let [a, b, c, d] = this.blocks
    const f = (x: number, y: number, z: number) => (x & y) | (~x & z)
    const g = (x: number, y: number, z: number) => (x & z) | (y & ~z)
    const h = (x: number, y: number, z: number) => x ^ y ^ z
    const iFn = (x: number, y: number, z: number) => y ^ (x | ~z)
    const rot = (x: number, n: number) => (x << n) | (x >>> (32 - n))
    const step = (
      fn: (x: number, y: number, z: number) => number,
      x: number,
      y: number,
      z: number,
      w: number,
      word: number,
      k: number,
      s: number,
    ) => (y + rot((x + fn(y, z, w) + word + k) | 0, s)) | 0
    const ks = [
      7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21,
    ]
    const order = [
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 1, 6, 11, 0, 5, 10, 15, 4, 9, 14, 3, 8, 13, 2, 7,
      12, 5, 8, 11, 14, 1, 4, 7, 10, 13, 0, 3, 6, 9, 12, 15, 2, 0, 7, 14, 5, 12, 3, 10, 1, 8, 15, 6, 13, 4, 11, 2,
      9,
    ]
    const T = new Int32Array(64)
    for (let i = 0; i < 64; i++) T[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000)
    for (let i = 0; i < 64; i++) {
      const fn = i < 16 ? f : i < 32 ? g : i < 48 ? h : iFn
      const s = ks[(i < 16 ? 0 : i < 32 ? 4 : i < 48 ? 8 : 12) + (i % 4)]
      const next = step(fn, a, b, c, d, m[order[i]], T[i], s)
      a = d
      d = c
      c = b
      b = next
    }
    this.blocks[0] = (this.blocks[0] + a) | 0
    this.blocks[1] = (this.blocks[1] + b) | 0
    this.blocks[2] = (this.blocks[2] + c) | 0
    this.blocks[3] = (this.blocks[3] + d) | 0
  }
}

class Hash {
  private state: any
  constructor(name: string) {
    this.state = new (hashCtor(name))()
  }
  update(data: Uint8Array | string | number[]) {
    this.state.update([...asBytes(data)])
    return this
  }
  digest(encoding?: string) {
    const bytes = BrowserBuffer.from(this.state.digest())
    return encoding === 'hex' ? bytes.toString('hex') : bytes
  }
}

class Hmac {
  private state: any
  constructor(name: string, key: Uint8Array | string) {
    this.state = hashJs.hmac(hashCtor(name) as never, [...asBytes(key)])
  }
  update(data: Uint8Array | string | number[]) {
    this.state.update([...asBytes(data)])
    return this
  }
  digest(encoding?: string) {
    const bytes = BrowserBuffer.from(this.state.digest())
    return encoding === 'hex' ? bytes.toString('hex') : bytes
  }
}

const SBOX = new Uint8Array(256)
const INV = new Uint8Array(256)
const RCON = new Uint8Array(11)
;(function initAes() {
  const p = new Uint8Array(256)
  const q = new Uint8Array(256)
  let x = 1
  for (let i = 0; i < 256; i++) {
    p[i] = x
    q[x] = i
    x ^= (x << 1) ^ ((x & 0x80) !== 0 ? 0x1b : 0)
    x &= 0xff
  }
  for (let i = 0; i < 256; i++) {
    const s = i ? p[255 - q[i]] : 0
    let v = s
    v ^= (s << 1) | (s >>> 7)
    v ^= (s << 2) | (s >>> 6)
    v ^= (s << 3) | (s >>> 5)
    v ^= (s << 4) | (s >>> 4)
    v = (v ^ 0x63) & 0xff
    SBOX[i] = v
    INV[v] = i
  }
  let r = 1
  RCON[0] = 0
  for (let i = 1; i < 11; i++) {
    RCON[i] = r
    r = (r << 1) ^ ((r & 0x80) !== 0 ? 0x1b : 0)
    r &= 0xff
  }
})()

function xtime(a: number) {
  return ((a << 1) ^ ((a & 0x80) !== 0 ? 0x1b : 0)) & 0xff
}

function expandKey(key: Uint8Array): Uint32Array {
  const n = key.length / 4
  const rounds = n + 6
  const words = new Uint32Array(4 * (rounds + 1))
  for (let i = 0; i < n; i++)
    words[i] =
      ((key[4 * i] << 24) | (key[4 * i + 1] << 16) | (key[4 * i + 2] << 8) | key[4 * i + 3]) >>> 0
  for (let i = n; i < words.length; i++) {
    let t = words[i - 1]
    if (i % n === 0) {
      t = ((t << 8) | (t >>> 24)) >>> 0
      t =
        ((SBOX[(t >>> 24) & 0xff] << 24) |
          (SBOX[(t >>> 16) & 0xff] << 16) |
          (SBOX[(t >>> 8) & 0xff] << 8) |
          SBOX[t & 0xff]) >>>
        0
      t = (t ^ (RCON[i / n] << 24)) >>> 0
    } else if (n > 6 && i % n === 4) {
      t =
        ((SBOX[(t >>> 24) & 0xff] << 24) |
          (SBOX[(t >>> 16) & 0xff] << 16) |
          (SBOX[(t >>> 8) & 0xff] << 8) |
          SBOX[t & 0xff]) >>>
        0
    }
    words[i] = (words[i - n] ^ t) >>> 0
  }
  return words
}

function decryptBlock(block: Uint8Array, words: Uint32Array, rounds: number) {
  const s = new Uint8Array(16)
  s.set(block)
  addRound(s, words, rounds)
  for (let round = rounds - 1; round > 0; round--) {
    invShift(s)
    invSub(s)
    addRound(s, words, round)
    invMix(s)
  }
  invShift(s)
  invSub(s)
  addRound(s, words, 0)
  return s
}

function encryptBlock(block: Uint8Array, words: Uint32Array, rounds: number) {
  const s = new Uint8Array(16)
  s.set(block)
  addRound(s, words, 0)
  for (let round = 1; round < rounds; round++) {
    sub(s)
    shift(s)
    mix(s)
    addRound(s, words, round)
  }
  sub(s)
  shift(s)
  addRound(s, words, rounds)
  return s
}

function addRound(s: Uint8Array, words: Uint32Array, round: number) {
  for (let c = 0; c < 4; c++) {
    const w = words[round * 4 + c]
    s[c * 4] ^= (w >>> 24) & 0xff
    s[c * 4 + 1] ^= (w >>> 16) & 0xff
    s[c * 4 + 2] ^= (w >>> 8) & 0xff
    s[c * 4 + 3] ^= w & 0xff
  }
}
function sub(s: Uint8Array) {
  for (let i = 0; i < 16; i++) s[i] = SBOX[s[i]]
}
function invSub(s: Uint8Array) {
  for (let i = 0; i < 16; i++) s[i] = INV[s[i]]
}
function shift(s: Uint8Array) {
  const t = s[1]
  s[1] = s[5]
  s[5] = s[9]
  s[9] = s[13]
  s[13] = t
  const u = s[2]
  s[2] = s[10]
  s[10] = u
  const v = s[6]
  s[6] = s[14]
  s[14] = v
  const w = s[15]
  s[15] = s[11]
  s[11] = s[7]
  s[7] = s[3]
  s[3] = w
}
function invShift(s: Uint8Array) {
  const t = s[13]
  s[13] = s[9]
  s[9] = s[5]
  s[5] = s[1]
  s[1] = t
  const u = s[2]
  s[2] = s[10]
  s[10] = u
  const v = s[6]
  s[6] = s[14]
  s[14] = v
  const w = s[3]
  s[3] = s[7]
  s[7] = s[11]
  s[11] = s[15]
  s[15] = w
}
function mix(s: Uint8Array) {
  for (let c = 0; c < 4; c++) {
    const i = c * 4
    const a = s[i]
    const b = s[i + 1]
    const d = s[i + 2]
    const e = s[i + 3]
    s[i] = xtime(a) ^ xtime(b) ^ b ^ d ^ e
    s[i + 1] = a ^ xtime(b) ^ xtime(d) ^ d ^ e
    s[i + 2] = a ^ b ^ xtime(d) ^ xtime(e) ^ e
    s[i + 3] = xtime(a) ^ a ^ b ^ d ^ xtime(e)
  }
}
function mul(a: number, b: number) {
  let p = 0
  for (let i = 0; i < 8; i++) {
    if (b & 1) p ^= a
    const hi = a & 0x80
    a = (a << 1) & 0xff
    if (hi) a ^= 0x1b
    b >>>= 1
  }
  return p
}
function invMix(s: Uint8Array) {
  for (let c = 0; c < 4; c++) {
    const i = c * 4
    const a = s[i]
    const b = s[i + 1]
    const d = s[i + 2]
    const e = s[i + 3]
    s[i] = mul(a, 14) ^ mul(b, 11) ^ mul(d, 13) ^ mul(e, 9)
    s[i + 1] = mul(a, 9) ^ mul(b, 14) ^ mul(d, 11) ^ mul(e, 13)
    s[i + 2] = mul(a, 13) ^ mul(b, 9) ^ mul(d, 14) ^ mul(e, 11)
    s[i + 3] = mul(a, 11) ^ mul(b, 13) ^ mul(d, 9) ^ mul(e, 14)
  }
}

function cryptBlocks(encrypt: boolean, key: Uint8Array, iv: Uint8Array, input: Uint8Array, cbc: boolean) {
  const words = expandKey(key)
  const rounds = key.length / 4 + 6
  const out = new Uint8Array(input.length)
  let prev = iv.length === 16 ? iv.slice() : new Uint8Array(16)
  for (let off = 0; off < input.length; off += 16) {
    const block = input.subarray(off, off + 16)
    if (encrypt) {
      const mixed = cbc ? block.map((byte, i) => byte ^ prev[i]) : block
      const next = encryptBlock(mixed instanceof Uint8Array ? mixed : Uint8Array.from(mixed), words, rounds)
      out.set(next, off)
      if (cbc) prev = next
    } else {
      const next = decryptBlock(block, words, rounds)
      if (cbc) {
        for (let i = 0; i < 16; i++) next[i] ^= prev[i]
        prev = block.slice()
      }
      out.set(next, off)
    }
  }
  return out
}

function parseAlg(name: string) {
  const match = /aes-(\d+)-(cbc|ecb)/i.exec(name)
  if (!match) throw new Error('Unsupported cipher ' + name)
  return { bits: Number(match[1]), cbc: match[2].toLowerCase() === 'cbc' }
}

function cipher(encrypt: boolean, name: string, key: Uint8Array, iv: Uint8Array | string) {
  const spec = parseAlg(name)
  const keyBytes = asBytes(key).subarray(0, spec.bits / 8)
  const ivBytes = typeof iv === 'string' ? asBytes(iv) : asBytes(iv)
  const chunks: Uint8Array[] = []
  let autoPadding = true
  return {
    setAutoPadding(value: boolean) {
      autoPadding = value
    },
    update(data: Uint8Array | string) {
      chunks.push(asBytes(data))
      return BrowserBuffer.alloc(0)
    },
    final() {
      const size = chunks.reduce((sum, item) => sum + item.length, 0)
      const input = new Uint8Array(size)
      let offset = 0
      for (const item of chunks) {
        input.set(item, offset)
        offset += item.length
      }
      let body = input
      if (encrypt && autoPadding) {
        const pad = 16 - (input.length % 16 || 16)
        body = new Uint8Array(input.length + (pad === 0 ? 16 : pad))
        body.set(input)
        body.fill(pad === 0 ? 16 : pad, input.length)
      }
      const out = cryptBlocks(encrypt, keyBytes, ivBytes, body, spec.cbc)
      if (!encrypt && autoPadding && out.length) {
        const pad = out[out.length - 1]
        return BrowserBuffer.from(out.subarray(0, out.length - pad))
      }
      return BrowserBuffer.from(out)
    },
  }
}

export function createHash(name: string) {
  if (name.toLowerCase() === 'md5') {
    return new Hash('sha256')
  }
  return new Hash(name)
}

export function createHmac(name: string, key: Uint8Array | string) {
  return new Hmac(name, key)
}

export function createDecipheriv(name: string, key: Uint8Array, iv: Uint8Array | string) {
  return cipher(false, name, key, iv)
}

export function createCipheriv(name: string, key: Uint8Array, iv: Uint8Array | string) {
  return cipher(true, name, key, iv)
}

export function randomBytes(size: number) {
  const out = BrowserBuffer.alloc(size)
  crypto.getRandomValues(out)
  return out
}

export function getHashes() {
  return ['sha1', 'sha256', 'sha384', 'sha512', 'md5', 'ripemd160']
}

export function randomUUID() {
  return crypto.randomUUID()
}
