// X25519 ECDH over the Web Crypto API, on node (>=18) as globalThis.crypto.subtle. Keys and the shared secret are raw
// bytes: a 32-byte private key and a 32-byte public key (a key-pair is the two concatenated, 64 bytes); the shared
// secret is the raw 32-byte X25519 output. Web Crypto imports a private key as a PKCS8 DER blob, so the fixed X25519
// PKCS8 prefix is prepended to the raw key; public keys import as raw bytes. Reached only through the public
// key-agreement API.
const x25519 = (() => {
  const PKCS8_PREFIX = new Uint8Array([
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20,
  ])
  const subtle = (): SubtleCrypto => globalThis.crypto.subtle
  const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => {
    const out = new Uint8Array(a.length + b.length)
    out.set(a, 0)
    out.set(b, a.length)
    return out
  }
  return {
    makeKeyPair: async (): Promise<Uint8Array> => {
      const pair = await subtle().generateKey({ name: 'X25519' }, true, ['deriveBits'])
      const pkcs8 = new Uint8Array(await subtle().exportKey('pkcs8', (pair as CryptoKeyPair).privateKey))
      const raw = new Uint8Array(await subtle().exportKey('raw', (pair as CryptoKeyPair).publicKey))
      const seed = pkcs8.slice(pkcs8.length - 32)
      return concat(seed, raw)
    },
    sharedSecret: async (privateKey: Uint8Array, publicKey: Uint8Array): Promise<Uint8Array> => {
      const priv = await subtle().importKey('pkcs8', concat(PKCS8_PREFIX, privateKey), { name: 'X25519' }, false, ['deriveBits'])
      const pub = await subtle().importKey('raw', publicKey, { name: 'X25519' }, false, [])
      const bits = await subtle().deriveBits({ name: 'X25519', public: pub }, priv, 256)
      return new Uint8Array(bits)
    },
  }
})()
