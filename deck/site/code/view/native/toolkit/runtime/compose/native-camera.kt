// Camera under Compose on the desktop (device-layer-0003), docked by ../../camera.tree as
// `<global:native-camera>` and found ahead of ../native-camera.kt (Android's). A desktop JVM reaches none, and says so.

object nativeCamera {
    suspend fun capture(): String = "unavailable"
}
