// Secure storage on Android (device-layer-0020), docked by ../secret.tree as `<global:native-secret>`, for both Android
// hosts. No androidx: an AES key that lives in the Android Keystore and never leaves it encrypts each secret with
// AES/GCM, and the ciphertext with its IV is kept in the app's own preferences (`term-secret`), so the file holds nothing
// readable without this app's key.

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

object nativeSecret {
    private const val ALIAS = "term-secret"

    // the app's key, made the first time it is needed
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build(),
        )
        return generator.generateKey()
    }

    private fun preferences() = hostActivity()?.getSharedPreferences(ALIAS, Context.MODE_PRIVATE)

    private fun encode(bytes: ByteArray): String = android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)

    private fun decode(text: String): ByteArray = android.util.Base64.decode(text, android.util.Base64.NO_WRAP)

    // saved, unavailable (no app to keep it for), or failed
    fun save(name: String, value: String): String {
        val preferences = preferences() ?: return "unavailable"
        return runCatching {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
            val sealed = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
            preferences.edit().putString(name, "${encode(cipher.iv)}.${encode(sealed)}").commit()
        }.getOrDefault(false).let { if (it) "saved" else "failed" }
    }

    // the value, or empty text when there is none
    fun read(name: String): String {
        val stored = preferences()?.getString(name, null) ?: return ""
        return runCatching {
            val (iv, sealed) = stored.split('.', limit = 2)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, decode(iv))) }
            String(cipher.doFinal(decode(sealed)), Charsets.UTF_8)
        }.getOrDefault("")
    }

    // removed, absent, unavailable, or failed
    fun remove(name: String): String {
        val preferences = preferences() ?: return "unavailable"
        if (!preferences.contains(name)) return "absent"
        return if (preferences.edit().remove(name).commit()) "removed" else "failed"
    }
}
