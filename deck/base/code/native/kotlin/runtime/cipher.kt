import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

// AES-256-GCM over javax.crypto (built into the JDK, no extra dependency). Key, nonce, plaintext, and ciphertext are
// raw bytes (ByteArray). doFinal on encrypt appends the 128-bit (16-byte) authentication tag, so the output is
// ciphertext || tag, matching the other platforms. Reached only through the public cipher API.
object cipher {
    fun encrypt(key: ByteArray, nonce: ByteArray, plain: ByteArray): ByteArray {
        val instance = Cipher.getInstance("AES/GCM/NoPadding")
        instance.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
        return instance.doFinal(plain)
    }
    fun decrypt(key: ByteArray, nonce: ByteArray, sealed: ByteArray): ByteArray {
        val instance = Cipher.getInstance("AES/GCM/NoPadding")
        instance.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
        return instance.doFinal(sealed)
    }
}
