// Network under Compose on the desktop (device-layer-0010), docked by ../../network.tree as
// `<global:native-network>` and found ahead of ../native-network.kt (Android's). Online when an interface other than the loopback is up and has an address. A JVM cannot tell wifi from wired, so the kind is `other`.

import java.net.NetworkInterface

object nativeNetwork {
    // `<online|offline> <kind>`
    suspend fun read(): String {
        val up = runCatching {
            NetworkInterface.getNetworkInterfaces()?.toList().orEmpty().any { it.isUp && !it.isLoopback && it.inetAddresses.hasMoreElements() }
        }.getOrDefault(false)
        return if (up) "online other" else "offline none"
    }
}
