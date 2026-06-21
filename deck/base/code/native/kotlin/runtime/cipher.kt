import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

// AES-256-GCM over javax.crypto (built into the JDK, no extra dependency). doFinal on encrypt appends the 128-bit
// (16-byte) authentication tag, so the output is ciphertext || tag, matching the other platforms.
object cipher {
    private fun fromHex(hex: String): ByteArray = ByteArray(hex.length / 2) { hex.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
    private fun toHex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }
    fun encrypt(keyHex: String, nonceHex: String, plain: String): String {
        val instance = Cipher.getInstance("AES/GCM/NoPadding")
        instance.init(Cipher.ENCRYPT_MODE, SecretKeySpec(fromHex(keyHex), "AES"), GCMParameterSpec(128, fromHex(nonceHex)))
        return toHex(instance.doFinal(plain.toByteArray(Charsets.UTF_8)))
    }
    fun decrypt(keyHex: String, nonceHex: String, cipherHex: String): String {
        val instance = Cipher.getInstance("AES/GCM/NoPadding")
        instance.init(Cipher.DECRYPT_MODE, SecretKeySpec(fromHex(keyHex), "AES"), GCMParameterSpec(128, fromHex(nonceHex)))
        return String(instance.doFinal(fromHex(cipherHex)), Charsets.UTF_8)
    }
}
