// Vibration and haptics on Android (device-layer-0006), docked by ../vibration.tree as `<global:native-vibration>`,
// for both Android hosts. The device's vibrator: the platform's predefined effects from Android 10 (a tick, a click, a
// heavy click, a double click), short waveforms for the warning and error patterns, and one-shots before Android 10.

import android.content.Context
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager

object nativeVibration {
    @Suppress("DEPRECATION")
    private fun vibrator(activity: android.app.Activity): Vibrator =
        if (Build.VERSION.SDK_INT >= 31) (activity.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager).defaultVibrator
        else activity.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator

    private fun effect(kind: String): VibrationEffect? = when (kind) {
        "warning" -> VibrationEffect.createWaveform(longArrayOf(0, 40, 60, 40), -1)
        "error" -> VibrationEffect.createWaveform(longArrayOf(0, 60, 50, 60, 50, 60), -1)
        "light", "medium", "heavy", "success" ->
            if (Build.VERSION.SDK_INT >= 29) VibrationEffect.createPredefined(
                when (kind) {
                    "light" -> VibrationEffect.EFFECT_TICK
                    "medium" -> VibrationEffect.EFFECT_CLICK
                    "heavy" -> VibrationEffect.EFFECT_HEAVY_CLICK
                    else -> VibrationEffect.EFFECT_DOUBLE_CLICK
                },
            ) else VibrationEffect.createOneShot(if (kind == "heavy") 60 else 30, VibrationEffect.DEFAULT_AMPLITUDE)
        else -> null
    }

    // `played`, or `unavailable` with no vibrator or a kind outside the set
    suspend fun play(kind: String): String {
        val activity = hostActivity() ?: return "unavailable"
        val vibrator = vibrator(activity)
        val effect = effect(kind)
        if (!vibrator.hasVibrator() || effect == null) return "unavailable"
        vibrator.vibrate(effect)
        return "played"
    }
}
