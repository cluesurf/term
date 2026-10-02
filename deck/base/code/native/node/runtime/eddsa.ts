// Ed25519 signatures over the Web Crypto API, on node (>=18) as globalThis.crypto.subtle. Keys, messages, and
// signatures are raw bytes: a 32-byte private seed and a 32-byte public key (a key-pair is the two concatenated, 64
// bytes). Web Crypto imports a private key as a PKCS8 DER blob, so the fixed Ed25519 PKCS8 prefix is prepended to the
// raw seed; public keys import as raw bytes. Reached only through the public signature API.
const eddsa = (() => {
  const PKCS8_PREFIX = new Uint8Array([
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65,
    0x70, 0x04, 0x22, 0x04, 0x20,
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
      const pair = await subtle().generateKey(
        { name: 'Ed25519' },
        true,
        ['sign', 'verify'],
      )
      const pkcs8 = new Uint8Array(
        await subtle().exportKey(
          'pkcs8',
          (pair as CryptoKeyPair).privateKey,
        ),
      )
      const raw = new Uint8Array(
        await subtle().exportKey(
          'raw',
          (pair as CryptoKeyPair).publicKey,
        ),
      )
      const seed = pkcs8.slice(pkcs8.length - 32)
      return concat(seed, raw)
    },
    sign: async (
      privateKey: Uint8Array,
      message: Uint8Array,
    ): Promise<Uint8Array> => {
      const key = await subtle().importKey(
        'pkcs8',
        concat(PKCS8_PREFIX, privateKey),
        { name: 'Ed25519' },
        false,
        ['sign'],
      )
      const signature = await subtle().sign('Ed25519', key, message)
      return new Uint8Array(signature)
    },
    verify: async (
      publicKey: Uint8Array,
      message: Uint8Array,
      signature: Uint8Array,
    ): Promise<boolean> => {
      const key = await subtle().importKey(
        'raw',
        publicKey,
        { name: 'Ed25519' },
        false,
        ['verify'],
      )
      return subtle().verify('Ed25519', key, signature, message)
    },
  }
})()
