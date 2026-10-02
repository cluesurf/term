// AES-256-GCM over javax.crypto (built into the JDK, no extra dependency). Key, nonce, plaintext, ciphertext and the
// additional authenticated data are raw bytes (ByteArray). doFinal on encrypt appends the 128-bit (16-byte)
// authentication tag, so the output is ciphertext || tag, matching the other platforms. Fully qualified (no top-level
// imports) so the file can be prepended as a runtime prelude. Reached only through the public cipher API.
//
// `extra` is covered by the tag and is not part of the ciphertext, so a sealed value carries the context it was sealed
// in. Empty authenticates nothing, which is GCM's own default, and `updateAAD` is skipped in that case because it is a
// no-op that some providers have historically rejected.
object cipher {
    fun encrypt(key: ByteArray, nonce: ByteArray, plain: ByteArray, extra: ByteArray): ByteArray {
        val instance = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding")
        instance.init(
            javax.crypto.Cipher.ENCRYPT_MODE,
            javax.crypto.spec.SecretKeySpec(key, "AES"),
            javax.crypto.spec.GCMParameterSpec(128, nonce),
        )
        if (extra.isNotEmpty()) {
            instance.updateAAD(extra)
        }
        return instance.doFinal(plain)
    }
    fun decrypt(key: ByteArray, nonce: ByteArray, sealed: ByteArray, extra: ByteArray): ByteArray {
        val instance = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding")
        instance.init(
            javax.crypto.Cipher.DECRYPT_MODE,
            javax.crypto.spec.SecretKeySpec(key, "AES"),
            javax.crypto.spec.GCMParameterSpec(128, nonce),
        )
        if (extra.isNotEmpty()) {
            instance.updateAAD(extra)
        }
        return instance.doFinal(sealed)
    }
}
