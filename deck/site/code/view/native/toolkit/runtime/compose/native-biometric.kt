// Biometrics under Compose on the desktop (device-layer-0021), docked by ../../biometric.tree as
// `<global:native-biometric>` and found ahead of ../native-biometric.kt (Android's). A desktop JVM has no biometric to
// ask, so every answer says so.

object nativeBiometric {
    fun kind(): String = "unavailable"

    suspend fun authenticate(reason: String): String = "unavailable"
}
