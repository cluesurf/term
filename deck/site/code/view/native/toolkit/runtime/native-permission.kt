// Permissions on Android (device-layer-0001), docked by ../permission.tree as `<global:native-permission>`, for both
// Android hosts (`hostActivity()`, `hostPermissionAnswers`, which each host defines).
//
// Android's runtime permissions: `checkSelfPermission` says granted or not, and nothing says whether the person was ever
// asked, so the runtime remembers that it asked (one flag per permission, in the app's own preferences). Not granted and
// never asked is `not-determined`; not granted after asking is `denied`. A permission the manifest does not declare
// cannot be granted at all, and reads `unavailable` (the build declares what an app reaches, device-layer-0012).
// Notifications before Android 13 need no grant, and read whether the person has them turned on.

import android.Manifest
import android.app.Activity
import android.app.NotificationManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import kotlin.coroutines.resume
import kotlin.coroutines.suspendCoroutine

object nativePermission {
    // the request code this runtime's requests carry, so another request's answer is not mistaken for its own
    private const val REQUEST = 7301

    private fun androidName(name: String): String? = when (name) {
        "camera" -> Manifest.permission.CAMERA
        "location" -> Manifest.permission.ACCESS_FINE_LOCATION
        "notification" -> if (Build.VERSION.SDK_INT >= 33) Manifest.permission.POST_NOTIFICATIONS else null
        else -> null
    }

    private fun asked(activity: Activity) = activity.getSharedPreferences("term-permission", Context.MODE_PRIVATE)

    @Suppress("DEPRECATION")
    private fun declared(activity: Activity, permission: String): Boolean =
        activity.packageManager.getPackageInfo(activity.packageName, PackageManager.GET_PERMISSIONS)
            .requestedPermissions?.contains(permission) == true

    private fun now(name: String): String {
        val activity = hostActivity() ?: return "unavailable"
        if (name == "notification" && Build.VERSION.SDK_INT < 33) {
            val manager = activity.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            return if (manager.areNotificationsEnabled()) "granted" else "denied"
        }
        val permission = androidName(name) ?: return "unavailable"
        if (!declared(activity, permission)) return "unavailable"
        if (activity.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED) return "granted"
        return if (asked(activity).getBoolean(permission, false)) "denied" else "not-determined"
    }

    suspend fun status(name: String): String = now(name)

    // the platform's own prompt, then the status after it. Asked again after a refusal for good, Android answers at
    // once without a prompt, and the status reads `denied`
    suspend fun request(name: String): String {
        val activity = hostActivity() ?: return "unavailable"
        val permission = androidName(name)
        if (permission == null || now(name) != "not-determined" && now(name) != "denied") return now(name)
        asked(activity).edit().putBoolean(permission, true).apply()
        suspendCoroutine<Unit> { continuation ->
            lateinit var listener: (Int) -> Unit
            listener = { code ->
                if (code == REQUEST) {
                    hostPermissionAnswers.remove(listener)
                    continuation.resume(Unit)
                }
            }
            hostPermissionAnswers.add(listener)
            activity.requestPermissions(arrayOf(permission), REQUEST)
        }
        return now(name)
    }
}
