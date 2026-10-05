// Permissions under Compose on the desktop (device-layer-0001), docked by ../../permission.tree as
// `<global:native-permission>`, found ahead of ../native-permission.kt (Android's). A desktop JVM reaches no camera,
// location or notification service of its own, so every grant reads `unavailable`, and the capabilities say the same.

object nativePermission {
    suspend fun status(name: String): String = "unavailable"

    suspend fun request(name: String): String = "unavailable"
}
