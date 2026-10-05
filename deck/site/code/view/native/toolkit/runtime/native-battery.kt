// The battery on Android (device-layer-0009), docked by ../battery.tree as `<global:native-battery>`, for both Android
// hosts. The last battery broadcast the platform keeps (`ACTION_BATTERY_CHANGED` is sticky, so registering with no
// receiver answers it at once): the level over the scale, and the charging status.

import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager

object nativeBattery {
    // `<level> <state>`, or unavailable
    suspend fun read(): String {
        val activity = hostActivity() ?: return "unavailable"
        val status = activity.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED)) ?: return "unavailable"
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
