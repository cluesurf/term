// Location under Compose on the desktop (device-layer-0004), docked by ../../location.tree as
// `<global:native-location>` and found ahead of ../native-location.kt (Android's). A desktop JVM reaches none, and says so.

object nativeLocation {
    suspend fun position(): String = "unavailable"

    // nothing to watch on a desktop JVM: the handler hears `unavailable` once, and the number this answers is one `unwatch` takes (native-watch.kt)
    fun watch(handler: (String) -> Unit): Int = nativeWatch.join("position", handler) { tell ->
        tell("unavailable")
        this::stop
    }

    fun unwatch(id: Int) = nativeWatch.leave("position", id)

    private fun stop() {}
}
