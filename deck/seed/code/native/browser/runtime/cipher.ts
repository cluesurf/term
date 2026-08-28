// AES-256-GCM over the Web Crypto API (SubtleCrypto), available on node (>=16) as globalThis.crypto.subtle. The key,
// nonce, plaintext, ciphertext and additional authenticated data are raw bytes (the crypto currency). SubtleCrypto
// encrypt produces ciphertext || tag (16-byte GCM tag appended) and decrypt expects the same layout. Reached only
// through the public cipher API.
//
// `extra` is the additional authenticated data. It is covered by the tag and is not part of the ciphertext, so a
// sealed value carries the context it was sealed in and cannot be moved to another slot without failing to open.
// `additionalData` is a field Web Crypto already defines on AesGcmParams, so nothing here implements anything: an
// empty array authenticates nothing, which is GCM's own default.
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
      extra: Uint8Array,
    ): Promise<Uint8Array> => {
      const cryptoKey = await importKey(key)
      const sealed = await globalThis.crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: nonce, additionalData: extra },
        cryptoKey,
        plain,
      )
      return new Uint8Array(sealed)
    },
    decrypt: async (
      key: Uint8Array,
      nonce: Uint8Array,
      sealed: Uint8Array,
      extra: Uint8Array,
    ): Promise<Uint8Array> => {
      const cryptoKey = await importKey(key)
      const opened = await globalThis.crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: nonce, additionalData: extra },
        cryptoKey,
        sealed,
      )
      return new Uint8Array(opened)
    },
  }
})()
