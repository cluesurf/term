// Secure storage under Compose on the desktop (device-layer-0020), docked by ../../secret.tree as
// `<global:native-secret>` and found ahead of ../native-secret.kt (Android's). A desktop JVM has no vault of its own, and
// a file it wrote would not be one, so every answer says so.

object nativeSecret {
    fun save(name: String, value: String): String = "unavailable"

    fun read(name: String): String = ""

    fun remove(name: String): String = "unavailable"
}
