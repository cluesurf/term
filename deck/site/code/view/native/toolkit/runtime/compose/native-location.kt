// Location under Compose on the desktop (device-layer-0004), docked by ../../location.tree as
// `<global:native-location>` and found ahead of ../native-location.kt (Android's). A desktop JVM reaches none, and says so.

object nativeLocation {
    suspend fun position(): String = "unavailable"
}
