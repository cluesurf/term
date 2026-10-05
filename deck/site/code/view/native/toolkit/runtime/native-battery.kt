// The battery on Android (device-layer-0009), docked by ../battery.tree as `<global:native-battery>`, for both Android
// hosts. The last battery broadcast the platform keeps (`ACTION_BATTERY_CHANGED` is sticky, so registering with no
// receiver answers it at once): the level over the scale, and the charging status.

import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager

object nativeBattery {
    private var receiver: android.content.BroadcastReceiver? = null

    // `<level> <state>`, or unavailable
    suspend fun read(): String {
        val activity = hostActivity() ?: return "unavailable"
        val status = activity.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED)) ?: return "unavailable"
        return describe(status)
    }

    // every battery broadcast the platform sends, the current one first (it is sticky), to `handler` on the main
    // thread, until `unwatch` is given the number this answers: one subscription shared by every watcher
    // (native-watch.kt). A broadcast that reads the same as the last is not reported
    fun watch(handler: (String) -> Unit): Int = nativeWatch.join("battery", handler) { tell ->
        start(tell)
        this::stop
    }

    fun unwatch(id: Int) = nativeWatch.leave("battery", id)

    private fun start(handler: (String) -> Unit) {
        stop()
        val activity = hostActivity() ?: return handler("unavailable")
        var last = ""
        val made = object : android.content.BroadcastReceiver() {
            override fun onReceive(context: android.content.Context, intent: Intent) {
                val now = describe(intent)
                if (now != last) {
                    last = now
                    handler(now)
                }
            }
        }
        receiver = made
        // a system broadcast, which needs no export flag; RECEIVER_NOT_EXPORTED says so to the platforms that ask
        if (android.os.Build.VERSION.SDK_INT >= 33) {
            activity.registerReceiver(made, IntentFilter(Intent.ACTION_BATTERY_CHANGED), android.content.Context.RECEIVER_NOT_EXPORTED)
        } else {
            activity.registerReceiver(made, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        }
    }

    private fun stop() {
        val made = receiver ?: return
        receiver = null
        runCatching { hostActivity()?.unregisterReceiver(made) }
    }

    private fun describe(status: Intent): String {
        if (!status.getBooleanExtra(BatteryManager.EXTRA_PRESENT, true)) return "unavailable"
        val level = status.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
        val scale = status.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
        val fraction = if (level >= 0 && scale > 0) "%.2f".format(java.util.Locale.ROOT, level.toDouble() / scale) else "unknown"
        val state = when (status.getIntExtra(BatteryManager.EXTRA_STATUS, -1)) {
            BatteryManager.BATTERY_STATUS_CHARGING -> "charging"
            BatteryManager.BATTERY_STATUS_FULL -> "full"
            BatteryManager.BATTERY_STATUS_DISCHARGING, BatteryManager.BATTERY_STATUS_NOT_CHARGING -> "unplugged"
            else -> "unknown"
        }
        return "$fraction $state"
    }
}
