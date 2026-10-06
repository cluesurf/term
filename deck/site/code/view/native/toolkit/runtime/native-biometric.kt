// Biometrics on Android (device-layer-0021), docked by ../biometric.tree as `<global:native-biometric>`, for both
// Android hosts. The platform's own BiometricPrompt (API 28) and BiometricManager (API 30), no androidx, with strong or
// weak biometrics and never the device credential, which is not a biometric. The build declares USE_BIOMETRIC.

import android.content.Context
import android.content.pm.PackageManager
import android.hardware.biometrics.BiometricManager
import android.hardware.biometrics.BiometricPrompt
import android.os.Build
import android.os.CancellationSignal
import kotlin.coroutines.resume
import kotlin.coroutines.suspendCoroutine

object nativeBiometric {
    private const val ALLOWED = BiometricManager.Authenticators.BIOMETRIC_STRONG or BiometricManager.Authenticators.BIOMETRIC_WEAK

    // the hardware, face or fingerprint, or none, without showing anything
    fun kind(): String {
        val activity = hostActivity() ?: return "unavailable"
        val features = activity.packageManager
        return when {
            features.hasSystemFeature(PackageManager.FEATURE_FACE) -> "face"
            features.hasSystemFeature(PackageManager.FEATURE_FINGERPRINT) -> "fingerprint"
            else -> "none"
        }
    }

    // passed, failed, not-enrolled or unavailable
    suspend fun authenticate(reason: String): String {
        val activity = hostActivity() ?: return "unavailable"
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return "unavailable"
        val manager = activity.getSystemService(Context.BIOMETRIC_SERVICE) as BiometricManager
        when (manager.canAuthenticate(ALLOWED)) {
            BiometricManager.BIOMETRIC_SUCCESS -> Unit
            BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED -> return "not-enrolled"
            else -> return "unavailable"
        }
        return suspendCoroutine { continuation ->
            var answered = false
            fun answer(text: String) {
                if (!answered) {
                    answered = true
                    continuation.resume(text)
                }
            }
            val prompt = BiometricPrompt.Builder(activity)
                .setTitle(reason)
                .setAllowedAuthenticators(ALLOWED)
                .setNegativeButton("Cancel", activity.mainExecutor) { _, _ -> answer("failed") }
                .build()
            prompt.authenticate(CancellationSignal(), activity.mainExecutor, object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) = answer("passed")

                // a single failed match leaves the sheet up for another try; an error ends it
                override fun onAuthenticationError(code: Int, message: CharSequence) = answer("failed")
            })
        }
    }
}
