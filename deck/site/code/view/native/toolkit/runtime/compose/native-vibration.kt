// Vibration under Compose on the desktop (device-layer-0006), docked by ../../vibration.tree as
// `<global:native-vibration>` and found ahead of ../native-vibration.kt (Android's). A desktop JVM reaches none, and says so.

object nativeVibration {
    suspend fun play(kind: String): String = "unavailable"
}
