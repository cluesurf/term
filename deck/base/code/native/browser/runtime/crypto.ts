const crypto = (() => {
  // digest / hmac take and return raw bytes (Uint8Array), the crypto currency; random is hex; hex is an edge codec
  const hex = buffer =>
    Array.from(new Uint8Array(buffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')
  const digest = async (algorithm, input) =>
    new Uint8Array(
      await globalThis.crypto.subtle.digest(algorithm, input),
    )
  const mac = async (algorithm, key, data) => {
    const cryptoKey = await globalThis.crypto.subtle.importKey(
      'raw',
      key,
      { name: 'HMAC', hash: algorithm },
      false,
      ['sign'],
    )
    return new Uint8Array(
      await globalThis.crypto.subtle.sign('HMAC', cryptoKey, data),
    )
  }
  return {
    sha256: input => digest('SHA-256', input),
    sha512: input => digest('SHA-512', input),
    // Web Crypto has no MD5, so it is RFC 1321 here, written out: the same bytes as node, Rust, Swift and Kotlin give,
    // where this used to throw on every call
    md5: input => {
      const shift = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21]
      const table = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0)
      const length = input.length
      const total = (((length + 8) >>> 6) + 1) * 64
      const bytes = new Uint8Array(total)
      bytes.set(input)
      bytes[length] = 0x80
      const view = new DataView(bytes.buffer)
      view.setUint32(total - 8, (length * 8) >>> 0, true)
      view.setUint32(total - 4, Math.floor((length * 8) / 2 ** 32), true)
      let a0 = 0x67452301
      let b0 = 0xefcdab89
      let c0 = 0x98badcfe
      let d0 = 0x10325476
      for (let block = 0; block < total; block += 64) {
        let a = a0
        let b = b0
        let c = c0
        let d = d0
        for (let i = 0; i < 64; i++) {
          let f
          let g
          if (i < 16) { f = (b & c) | (~b & d); g = i }
          else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16 }
          else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16 }
          else { f = c ^ (b | ~d); g = (7 * i) % 16 }
          const sum = (a + f + table[i] + view.getUint32(block + g * 4, true)) >>> 0
          const s = shift[(i >>> 4) * 4 + (i % 4)]
          a = d
          d = c
          c = b
          b = (b + ((sum << s) | (sum >>> (32 - s)))) >>> 0
        }
        a0 = (a0 + a) >>> 0
        b0 = (b0 + b) >>> 0
        c0 = (c0 + c) >>> 0
        d0 = (d0 + d) >>> 0
      }
      const out = new Uint8Array(16)
      const result = new DataView(out.buffer)
      ;[a0, b0, c0, d0].forEach((word, i) => result.setUint32(i * 4, word, true))
      return out
    },
    // `uuid.tree` reaches `crypto` too, and finds THIS shim beside it rather than the platform global, since a shim
    // shadows the global of the same name. So the platform's own call is forwarded here; without it every browser
    // program that raised an exception (whose code is a uuid) threw a TypeError instead
    randomUUID: () => globalThis.crypto.randomUUID(),
    hmacSha256: (key, data) => mac('SHA-256', key, data),
    hmacSha512: (key, data) => mac('SHA-512', key, data),
    // Web Crypto fills at most 65,536 bytes per call, so a larger draw is filled in chunks: the same size works here
    // as on every other backend
    randomBytes: size => {
      const out = new Uint8Array(size)
      for (let at = 0; at < size; at += 65536) {
        globalThis.crypto.getRandomValues(out.subarray(at, Math.min(at + 65536, size)))
      }
      return out
    },
    // equal without leaking where they differ: every byte is read whatever the earlier ones held. A length difference
    // is answered at once, as everywhere (a length is not the secret)
    equalSecret: (a, b) => {
      if (a.length !== b.length) return false
      let diff = 0
      for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
      return diff === 0
    },
  }
})()
