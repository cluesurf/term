// Ed25519 signatures over the Web Crypto API. Available on the browser and on node (>=18) as globalThis.crypto.subtle.
// Keys move as hex: a 32-byte private seed and a 32-byte public key. Web Crypto imports a private key as a PKCS8 DER
// blob, so the fixed Ed25519 PKCS8 prefix is prepended to the raw seed; public keys import as raw bytes.
const eddsa = (() => {
  const PKCS8_PREFIX = '302e020100300506032b657004220420'
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
      const pair = await subtle().generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
      const pkcs8 = new Uint8Array(await subtle().exportKey('pkcs8', (pair as CryptoKeyPair).privateKey))
      const raw = await subtle().exportKey('raw', (pair as CryptoKeyPair).publicKey)
      const seed = pkcs8.slice(pkcs8.length - 32)
      return toHex(seed.buffer) + toHex(raw)
    },
    sign: async (privateHex: string, message: string): Promise<string> => {
      const key = await subtle().importKey('pkcs8', fromHex(PKCS8_PREFIX + privateHex), { name: 'Ed25519' }, false, ['sign'])
      const signature = await subtle().sign('Ed25519', key, new TextEncoder().encode(message))
      return toHex(signature)
    },
    verify: async (publicHex: string, message: string, signatureHex: string): Promise<boolean> => {
      const key = await subtle().importKey('raw', fromHex(publicHex), { name: 'Ed25519' }, false, ['verify'])
      return subtle().verify('Ed25519', key, fromHex(signatureHex), new TextEncoder().encode(message))
    },
  }
})()
