// Motion on Android (device-layer-0011), docked by ../motion.tree as `<global:native-motion>`, for both Android hosts.
// One accelerometer sample from SensorManager, gravity included, in metres per second squared, the platform's own unit.

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import kotlin.coroutines.resume
import kotlin.coroutines.suspendCoroutine

object nativeMotion {
    // `<x> <y> <z>`, or unavailable
    suspend fun sample(): String {
        val activity = hostActivity() ?: return "unavailable"
        val manager = activity.getSystemService(Context.SENSOR_SERVICE) as SensorManager
        val sensor = manager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER) ?: return "unavailable"
        return suspendCoroutine { continuation ->
            manager.registerListener(object : SensorEventListener {
                private var answered = false

                override fun onSensorChanged(event: SensorEvent) {
                    if (answered) return
                    answered = true
                    manager.unregisterListener(this)
                    val (x, y, z) = Triple(event.values[0], event.values[1], event.values[2])
                    continuation.resume("%.2f %.2f %.2f".format(java.util.Locale.ROOT, x, y, z))
                }

                override fun onAccuracyChanged(sensor: Sensor, accuracy: Int) {}
            }, sensor, SensorManager.SENSOR_DELAY_GAME)
        }
    }
}
