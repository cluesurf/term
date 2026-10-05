// Battery under Compose on the desktop (device-layer-0009), docked by ../../battery.tree as
// `<global:native-battery>` and found ahead of ../native-battery.kt (Android's). A desktop JVM reaches none, and says so.

object nativeBattery {
    suspend fun read(): String = "unavailable"
}
