// AES-256-GCM over the Web Crypto API (SubtleCrypto). Available on the browser and on node (>=16) as
// globalThis.crypto.subtle. The key and nonce arrive as hex text; the ciphertext is returned with the 16-byte GCM
// tag appended (SubtleCrypto encrypt produces ciphertext || tag, and decrypt expects the same), as hex text.
const cipher = (() => {
  const fromHex = (hex: string): Uint8Array => {
    const bytes = new Uint8Array(hex.length / 2)
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16)
    return bytes
  }
  const toHex = (buffer: ArrayBuffer): string =>
    Array.from(new Uint8Array(buffer)).map((b) => b.toString(16).padStart(2, '0')).join('')
  const importKey = (keyHex: string): Promise<CryptoKey> =>
    globalThis.crypto.subtle.importKey('raw', fromHex(keyHex), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
  return {
    encrypt: async (keyHex: string, nonceHex: string, plain: string): Promise<string> => {
      const key = await importKey(keyHex)
      const sealed = await globalThis.crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: fromHex(nonceHex) }, key, new TextEncoder().encode(plain),
      )
      return toHex(sealed)
    },
    decrypt: async (keyHex: string, nonceHex: string, cipherHex: string): Promise<string> => {
      const key = await importKey(keyHex)
      const opened = await globalThis.crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: fromHex(nonceHex) }, key, fromHex(cipherHex),
      )
      return new TextDecoder().decode(opened)
    },
  }
})()
