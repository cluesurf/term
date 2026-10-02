// The device traits on Android (native-dom-0012), docked by ../device.tree as `<global:native-device>`.
//
// Nothing is cached as truth. `readTrait` reads the Activity's Configuration every time, and `recheck` reads every
// trait again and calls the handler for each one that differs from what it last reported. The Activity's
// onConfigurationChanged (nativeView.configurationChanged, dom/native/toolkit/runtime/native-view.kt) only triggers a
// recheck. The manifest declares the trait changes as handled, so the Activity and the program survive them.

import android.content.res.Configuration
import android.provider.Settings

object nativeDevice {
    val names = listOf("idiom", "width-class", "pointer", "color-scheme", "reduce-motion", "text-scale")
    private var handler: ((String, String) -> Unit)? = null
    private val last = mutableMapOf<String, String>()
    private var installed = false

    private fun configuration(): Configuration =
        (nativeView.activity ?: error("nativeDevice: no Activity yet")).resources.configuration

    fun readTrait(name: String): String {
        val config = configuration()
        return when (name) {
            "idiom" -> if (config.smallestScreenWidthDp >= 600) "tablet" else "phone"
            "width-class" -> if (config.screenWidthDp < 600) "compact" else "regular"
            "pointer" -> if (config.touchscreen == Configuration.TOUCHSCREEN_NOTOUCH) "fine" else "touch"
            "color-scheme" ->
                if ((config.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES) "dark" else "light"
            "reduce-motion" -> if (animatorScale() == 0f) "yes" else "no"
            "text-scale" -> format(config.fontScale.toDouble())
            else -> "no"
        }
    }

    fun watch(body: (String, String) -> Unit) {
        handler = body
        for (name in names) last[name] = readTrait(name)
        if (!installed) {
            installed = true
            nativeView.configurationChanged.add { recheck() }
        }
    }

    fun unwatch() {
        handler = null
    }

    // read every trait again, and report each that the platform changed since the last report
    fun recheck() {
        val report = handler ?: return
        for (name in names) {
            val now = readTrait(name)
            if (last[name] != now) {
                last[name] = now
                report(name, now)
            }
        }
    }

    // for tests: the night bit of the Activity's own Configuration, which is what readTrait reads back
    @Suppress("DEPRECATION")
    fun changeTrait(name: String, value: String) {
        val activity = nativeView.activity ?: return
        if (name == "color-scheme") {
            val config = Configuration(activity.resources.configuration)
            val night = if (value == "dark") Configuration.UI_MODE_NIGHT_YES else Configuration.UI_MODE_NIGHT_NO
            config.uiMode = (config.uiMode and Configuration.UI_MODE_NIGHT_MASK.inv()) or night
            activity.resources.updateConfiguration(config, activity.resources.displayMetrics)
        }
        recheck()
    }

    // for tests: turn the Activity to landscape the way a rotation does, and let onConfigurationChanged report it
    // (native-dom-0035). The manifest handles the change, so the Activity and the program survive it
    fun turn() {
        // to whichever shape the device is not in now, so a run that starts where the last one left it still turns
        val activity = nativeView.activity ?: return
        val wide = activity.resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE
        activity.requestedOrientation =
            if (wide) android.content.pm.ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
            else android.content.pm.ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
    }

    private fun animatorScale(): Float {
        val activity = nativeView.activity ?: return 1f
        return Settings.Global.getFloat(activity.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
    }

    private fun format(value: Double): String {
        val rounded = Math.round(value * 100) / 100.0
        return if (rounded == Math.floor(rounded)) rounded.toLong().toString() else rounded.toString()
    }
}
