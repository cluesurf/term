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

    // the Android permissions a grant is, every one of which must be held. The calendar is two, since this module both
    // reads and writes it, and Android asks for both in one prompt
    private fun androidNames(name: String): List<String> = when (name) {
        "camera" -> listOf(Manifest.permission.CAMERA)
        "microphone" -> listOf(Manifest.permission.RECORD_AUDIO)
        "contacts" -> listOf(Manifest.permission.READ_CONTACTS)
        "calendar" -> listOf(Manifest.permission.READ_CALENDAR, Manifest.permission.WRITE_CALENDAR)
        "photos" -> listOf(if (Build.VERSION.SDK_INT >= 33) Manifest.permission.READ_MEDIA_IMAGES else Manifest.permission.READ_EXTERNAL_STORAGE)
        "location" -> listOf(Manifest.permission.ACCESS_FINE_LOCATION)
        "notification" -> if (Build.VERSION.SDK_INT >= 33) listOf(Manifest.permission.POST_NOTIFICATIONS) else emptyList()
        else -> emptyList()
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
        val permissions = androidNames(name)
        if (permissions.isEmpty() || permissions.any { !declared(activity, it) }) return "unavailable"
        if (permissions.all { activity.checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }) return "granted"
        if (name == "photos" && chosenPhotos(activity)) return "granted"
        return if (permissions.any { asked(activity).getBoolean(it, false) }) "denied" else "not-determined"
    }

    // Android 14 lets a person allow only the photos they choose, which is a grant of its own permission
    // (../../../photos.tree: limited access is a grant)
    private const val CHOSEN_PHOTOS = "android.permission.READ_MEDIA_VISUAL_USER_SELECTED"

    private fun chosenPhotos(activity: Activity): Boolean =
        Build.VERSION.SDK_INT >= 34 && declared(activity, CHOSEN_PHOTOS) && activity.checkSelfPermission(CHOSEN_PHOTOS) == PackageManager.PERMISSION_GRANTED

    suspend fun status(name: String): String = now(name)

    // the platform's own prompt, then the status after it. Asked again after a refusal for good, Android answers at
    // once without a prompt, and the status reads `denied`
    suspend fun request(name: String): String {
        val activity = hostActivity() ?: return "unavailable"
        val permissions = androidNames(name)
        if (permissions.isEmpty() || now(name) != "not-determined" && now(name) != "denied") return now(name)
        asked(activity).edit().apply { permissions.forEach { putBoolean(it, true) } }.apply()
        suspendCoroutine<Unit> { continuation ->
            lateinit var listener: (Int) -> Unit
            listener = { code ->
                if (code == REQUEST) {
                    hostPermissionAnswers.remove(listener)
                    continuation.resume(Unit)
                }
            }
            hostPermissionAnswers.add(listener)
            // asked beside the full permission, Android 14's prompt offers the choice of photos as well
            val asking = if (name == "photos" && Build.VERSION.SDK_INT >= 34) permissions + CHOSEN_PHOTOS else permissions
            activity.requestPermissions(asking.toTypedArray(), REQUEST)
        }
        return now(name)
    }
}
