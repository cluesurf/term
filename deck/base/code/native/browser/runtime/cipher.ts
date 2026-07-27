// AES-256-GCM over the Web Crypto API (SubtleCrypto), available on node (>=16) as globalThis.crypto.subtle. The key,
// nonce, plaintext, and ciphertext are raw bytes (the crypto currency). SubtleCrypto encrypt produces
// ciphertext || tag (16-byte GCM tag appended) and decrypt expects the same layout. Reached only through the public
// cipher API.
const cipher = (() => {
  const importKey = (key: Uint8Array): Promise<CryptoKey> =>
    globalThis.crypto.subtle.importKey(
      'raw',
      key,
      { name: 'AES-GCM' },
      false,
      ['encrypt', 'decrypt'],
    )
  return {
    encrypt: async (
      key: Uint8Array,
      nonce: Uint8Array,
      plain: Uint8Array,
    ): Promise<Uint8Array> => {
      const cryptoKey = await importKey(key)
      const sealed = await globalThis.crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: nonce },
        cryptoKey,
        plain,
      )
      return new Uint8Array(sealed)
    },
    decrypt: async (
      key: Uint8Array,
      nonce: Uint8Array,
      sealed: Uint8Array,
    ): Promise<Uint8Array> => {
      const cryptoKey = await importKey(key)
      const opened = await globalThis.crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: nonce },
        cryptoKey,
        sealed,
      )
      return new Uint8Array(opened)
    },
  }
})()
