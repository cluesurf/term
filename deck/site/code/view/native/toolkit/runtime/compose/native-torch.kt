// Torch under Compose on the desktop (device-layer-0002), docked by ../../torch.tree as
// `<global:native-torch>` and found ahead of ../native-torch.kt (Android's). A desktop JVM reaches none, and says so.

object nativeTorch {
    suspend fun state(): String = "unavailable"

    suspend fun set(state: String): String = "unavailable"
}
