// X25519 ECDH over the Web Crypto API. Available on the browser and on node (>=18) as globalThis.crypto.subtle. Keys
// move as hex: a 32-byte private key and a 32-byte public key. Web Crypto imports a private key as a PKCS8 DER blob,
// so the fixed X25519 PKCS8 prefix is prepended to the raw key; public keys import as raw bytes. The shared secret is
// the raw 32-byte (256-bit) X25519 output.
const x25519 = (() => {
  const PKCS8_PREFIX = '302e020100300506032b656e04220420'
  const fromHex = (hex: string): Uint8Array => {
    const bytes = new Uint8Array(hex.length / 2)
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16)
    return bytes
  }
  const toHex = (buffer: ArrayBuffer): string =>
    Array.from(new Uint8Array(buffer)).map((b) => b.toString(16).padStart(2, '0')).join('')
  const subtle = (): SubtleCrypto => globalThis.crypto.subtle
  return {
    makeKeyPair: async (): Promise<string> => {
      const pair = await subtle().generateKey({ name: 'X25519' }, true, ['deriveBits'])
      const pkcs8 = new Uint8Array(await subtle().exportKey('pkcs8', (pair as CryptoKeyPair).privateKey))
      const raw = await subtle().exportKey('raw', (pair as CryptoKeyPair).publicKey)
      const seed = pkcs8.slice(pkcs8.length - 32)
      return toHex(seed.buffer) + toHex(raw)
    },
    sharedSecret: async (privateHex: string, publicHex: string): Promise<string> => {
      const privateKey = await subtle().importKey('pkcs8', fromHex(PKCS8_PREFIX + privateHex), { name: 'X25519' }, false, ['deriveBits'])
      const publicKey = await subtle().importKey('raw', fromHex(publicHex), { name: 'X25519' }, false, [])
      const bits = await subtle().deriveBits({ name: 'X25519', public: publicKey }, privateKey, 256)
      return toHex(bits)
    },
  }
})()
