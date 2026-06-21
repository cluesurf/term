// AES-256-GCM over javax.crypto (built into the JDK, no extra dependency). Key, nonce, plaintext, and ciphertext are
// raw bytes (ByteArray). doFinal on encrypt appends the 128-bit (16-byte) authentication tag, so the output is
// ciphertext || tag, matching the other platforms. Fully qualified (no top-level imports) so the file can be prepended
// as a runtime prelude. Reached only through the public cipher API.
object cipher {
    fun encrypt(key: ByteArray, nonce: ByteArray, plain: ByteArray): ByteArray {
        val instance = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding")
        instance.init(
            javax.crypto.Cipher.ENCRYPT_MODE,
            javax.crypto.spec.SecretKeySpec(key, "AES"),
            javax.crypto.spec.GCMParameterSpec(128, nonce),
        )
        return instance.doFinal(plain)
    }
    fun decrypt(key: ByteArray, nonce: ByteArray, sealed: ByteArray): ByteArray {
        val instance = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding")
        instance.init(
            javax.crypto.Cipher.DECRYPT_MODE,
            javax.crypto.spec.SecretKeySpec(key, "AES"),
            javax.crypto.spec.GCMParameterSpec(128, nonce),
        )
        return instance.doFinal(sealed)
    }
}
