// Local notifications on Android (device-layer-0007), docked by ../notification.tree as `<global:native-notification>`,
// for both Android hosts. The platform's NotificationManager, on one channel of the app's (made once, which Android 8
// requires), with the framework's own builder: no AndroidX. The grant is read through nativePermission.

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context

object nativeNotification {
    private const val CHANNEL = "term"
    private var next = 1

    // shown, not-determined, denied, unavailable or failed
    suspend fun post(title: String, body: String): String {
        val grant = nativePermission.status("notification")
        if (grant != "granted") return grant
        val activity = hostActivity() ?: return "unavailable"
        val manager = activity.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (manager.getNotificationChannel(CHANNEL) == null) {
            manager.createNotificationChannel(NotificationChannel(CHANNEL, "Notifications", NotificationManager.IMPORTANCE_DEFAULT))
        }
        val shown = Notification.Builder(activity, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(title)
            .setContentText(body)
            .setAutoCancel(true)
            .build()
        return try {
            manager.notify(next++, shown)
            "shown"
        } catch (e: SecurityException) {
            "denied"
        }
    }
}
