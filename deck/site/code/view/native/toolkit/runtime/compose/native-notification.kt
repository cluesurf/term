// Notification under Compose on the desktop (device-layer-0007), docked by ../../notification.tree as
// `<global:native-notification>` and found ahead of ../native-notification.kt (Android's). A desktop JVM reaches none, and says so.

object nativeNotification {
    suspend fun post(title: String, body: String): String = "unavailable"
}
