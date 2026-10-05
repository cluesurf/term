// Motion under Compose on the desktop (device-layer-0011), docked by ../../motion.tree as
// `<global:native-motion>` and found ahead of ../native-motion.kt (Android's). A desktop JVM reaches none, and says so.

object nativeMotion {
    suspend fun sample(): String = "unavailable"

    // nothing to watch on a desktop JVM: the handler hears `unavailable` once, and the number this answers is one `unwatch` takes (native-watch.kt)
    fun watch(handler: (String) -> Unit): Int = nativeWatch.join("motion", handler) { tell ->
        tell("unavailable")
        this::stop
    }

    fun unwatch(id: Int) = nativeWatch.leave("motion", id)

    private fun stop() {}
}
