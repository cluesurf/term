// Network under Compose on the desktop (device-layer-0010), docked by ../../network.tree as
// `<global:native-network>` and found ahead of ../native-network.kt (Android's). Online when an interface other than the loopback is up and has an address. A JVM cannot tell wifi from wired, so the kind is `other`.

import java.net.NetworkInterface

object nativeNetwork {
    // `<online|offline> <kind>`
    suspend fun read(): String = interfacesUp()

    // the state now: a JVM is not told when the interfaces change, so the handler hears it once, and the number this answers is one `unwatch` takes (native-watch.kt)
    fun watch(handler: (String) -> Unit): Int = nativeWatch.join("network", handler) { tell ->
        tell(interfacesUp())
        this::stop
    }

    fun unwatch(id: Int) = nativeWatch.leave("network", id)

    private fun stop() {}

    private fun interfacesUp(): String {
        val up = runCatching {
            NetworkInterface.getNetworkInterfaces()?.toList().orEmpty().any { it.isUp && !it.isLoopback && it.inetAddresses.hasMoreElements() }
        }.getOrDefault(false)
        return if (up) "online other" else "offline none"
    }
}
