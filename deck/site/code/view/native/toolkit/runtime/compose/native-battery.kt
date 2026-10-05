// Battery under Compose on the desktop (device-layer-0009), docked by ../../battery.tree as
// `<global:native-battery>` and found ahead of ../native-battery.kt (Android's). A desktop JVM reaches none, and says so.

object nativeBattery {
    suspend fun read(): String = "unavailable"

    // nothing to watch on a desktop JVM: the handler hears `unavailable` once, and the number this answers is one `unwatch` takes (native-watch.kt)
    fun watch(handler: (String) -> Unit): Int = nativeWatch.join("battery", handler) { tell ->
        tell("unavailable")
        this::stop
    }

    fun unwatch(id: Int) = nativeWatch.leave("battery", id)

    private fun stop() {}
}
