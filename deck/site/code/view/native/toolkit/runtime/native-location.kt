// Location on Android (device-layer-0004), docked by ../location.tree as `<global:native-location>`, for both Android
// hosts (`hostActivity()`). The platform's LocationManager, with no Play Services: one current position from the GPS
// provider, or the network provider when GPS is off. The grant is read through nativePermission, docked beside this.

import android.content.Context
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Looper
import kotlin.coroutines.resume
import kotlin.coroutines.suspendCoroutine

object nativeLocation {
    // `<latitude> <longitude> <accuracy>`, or not-determined, denied, unavailable or failed
    suspend fun position(): String {
        val grant = nativePermission.status("location")
        if (grant != "granted") return grant
        val activity = hostActivity() ?: return "unavailable"
        val manager = activity.getSystemService(Context.LOCATION_SERVICE) as LocationManager
        val provider = listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER).firstOrNull { manager.isProviderEnabled(it) }
            ?: return "unavailable"
        val at = current(manager, provider, activity) ?: return "failed"
        return "%.6f %.6f %.0f".format(java.util.Locale.ROOT, at.latitude, at.longitude, at.accuracy.toDouble())
    }

    private var follower: LocationListener? = null

    // every position the provider reports, a second apart at most, the last known one first, to `handler` on the main
    // thread, until `unwatch` is given the number this answers: one subscription shared by every watcher
    // (native-watch.kt). Without the grant the handler hears the grant's status once
    fun watch(handler: (String) -> Unit): Int = nativeWatch.join("position", handler) { tell ->
        start(tell)
        this::stop
    }

    fun unwatch(id: Int) = nativeWatch.leave("position", id)

    @Suppress("MissingPermission")
    private fun start(handler: (String) -> Unit) {
        stop()
        val activity = hostActivity() ?: return handler("unavailable")
        if (activity.checkSelfPermission(android.Manifest.permission.ACCESS_FINE_LOCATION) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            return handler(if (activity.getSharedPreferences("term-permission", Context.MODE_PRIVATE).getBoolean(android.Manifest.permission.ACCESS_FINE_LOCATION, false)) "denied" else "not-determined")
        }
        val manager = activity.getSystemService(Context.LOCATION_SERVICE) as LocationManager
        val provider = listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER).firstOrNull { manager.isProviderEnabled(it) }
            ?: return handler("unavailable")
        val listener = LocationListener { at -> handler(describe(at)) }
        follower = listener
        manager.getLastKnownLocation(provider)?.let { handler(describe(it)) }
        manager.requestLocationUpdates(provider, 1000L, 0f, listener, Looper.getMainLooper())
    }

    private fun stop() {
        val listener = follower ?: return
        follower = null
        (hostActivity()?.getSystemService(Context.LOCATION_SERVICE) as? LocationManager)?.removeUpdates(listener)
    }

    private fun describe(at: Location): String =
        "%.6f %.6f %.0f".format(java.util.Locale.ROOT, at.latitude, at.longitude, at.accuracy.toDouble())

    // one fix: the platform's one-shot request from Android 11, and a single update before it
    @Suppress("MissingPermission", "DEPRECATION")
    private suspend fun current(manager: LocationManager, provider: String, activity: android.app.Activity): Location? =
        suspendCoroutine { continuation ->
            if (Build.VERSION.SDK_INT >= 30) {
                manager.getCurrentLocation(provider, null, activity.mainExecutor) { found -> continuation.resume(found) }
            } else {
                manager.requestSingleUpdate(provider, object : LocationListener {
                    override fun onLocationChanged(found: Location) = continuation.resume(found)
                }, Looper.getMainLooper())
            }
        }
}
