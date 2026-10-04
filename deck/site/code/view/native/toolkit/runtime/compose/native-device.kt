// The device traits in the `compose` env (compose-target): Compose Multiplatform on the desktop JVM, docked by
// ../../device.tree as `<global:native-device>` and found ahead of ../native-device.kt (Android's) because the prelude
// tries `runtime/<env>/` first. A desktop answers as a desktop: idiom `desktop`, pointer `fine`, motion and text at the
// system's defaults; the width class from the window's own width; the color scheme from the system, which on macOS is
// `defaults read -g AppleInterfaceStyle` (`Dark` when dark, absent when light), and light elsewhere until a reader for
// that desktop is written. `change-trait` overrides a trait the way a test turns a device, and every change is
// reported to the watcher as Android's recheck reports one.
object nativeDevice {
    val names = listOf("idiom", "width-class", "pointer", "color-scheme", "reduce-motion", "text-scale")
    private var handler: ((String, String) -> Unit)? = null
    private val last = mutableMapOf<String, String>()
    // what a test set, ahead of what the system says
    private val overridden = mutableMapOf<String, String>()

    private fun systemScheme(): String {
        if (!(System.getProperty("os.name") ?: "").lowercase().contains("mac")) return "light"
        return runCatching {
            val process = ProcessBuilder("defaults", "read", "-g", "AppleInterfaceStyle").redirectErrorStream(true).start()
            val said = process.inputStream.bufferedReader().readText().trim()
            process.waitFor()
            if (said == "Dark") "dark" else "light"
        }.getOrDefault("light")
    }

    fun readTrait(name: String): String = overridden[name] ?: when (name) {
        "idiom" -> "desktop"
        "width-class" -> if (nativeView.windowWidth() < 600) "compact" else "regular"
        "pointer" -> "fine"
        "color-scheme" -> systemScheme()
        "reduce-motion" -> "no"
        "text-scale" -> "1"
        else -> "no"
    }

    fun watch(body: (String, String) -> Unit) {
        handler = body
        for (name in names) last[name] = readTrait(name)
    }

    fun unwatch() {
        handler = null
    }

    // read every trait again, and report each that changed since the last report
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

    // for tests: set a trait as the desktop would report it, and report the change
    fun changeTrait(name: String, value: String) {
        overridden[name] = value
        recheck()
    }

    // a desktop does not rotate: the window's width class is turned instead, to the other one
    fun turn() {
        overridden["width-class"] = if (readTrait("width-class") == "compact") "regular" else "compact"
        recheck()
    }
}
