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
    private var follower: SensorEventListener? = null

    // every accelerometer sample at the platform's rate for a user interface (about 16 a second), to `handler` on the
    // main thread, until `unwatch` is given the number this answers: one subscription shared by every watcher
    // (native-watch.kt). `unavailable` once with no accelerometer
    fun watch(handler: (String) -> Unit): Int = nativeWatch.join("motion", handler) { tell ->
        start(tell)
        this::stop
    }

    fun unwatch(id: Int) = nativeWatch.leave("motion", id)

    private fun start(handler: (String) -> Unit) {
        stop()
        val activity = hostActivity() ?: return handler("unavailable")
        val manager = activity.getSystemService(Context.SENSOR_SERVICE) as SensorManager
        val sensor = manager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER) ?: return handler("unavailable")
        val listener = object : SensorEventListener {
            override fun onSensorChanged(event: SensorEvent) {
                handler("%.2f %.2f %.2f".format(java.util.Locale.ROOT, event.values[0], event.values[1], event.values[2]))
            }

            override fun onAccuracyChanged(sensor: Sensor, accuracy: Int) {}
        }
        follower = listener
        manager.registerListener(listener, sensor, SensorManager.SENSOR_DELAY_UI, android.os.Handler(android.os.Looper.getMainLooper()))
    }

    private fun stop() {
        val listener = follower ?: return
        follower = null
        (hostActivity()?.getSystemService(Context.SENSOR_SERVICE) as? SensorManager)?.unregisterListener(listener)
    }

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
