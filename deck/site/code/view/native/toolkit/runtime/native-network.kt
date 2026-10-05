// The network on Android (device-layer-0010), docked by ../network.tree as `<global:native-network>`, for both Android
// hosts. The active network's capabilities from ConnectivityManager: online when it reaches the internet, and its kind
// by transport.

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities

object nativeNetwork {
    private var callback: ConnectivityManager.NetworkCallback? = null

    // `<online|offline> <kind>`, the kind wifi, cellular, wired, other or none
    suspend fun read(): String {
        val activity = hostActivity() ?: return "unavailable"
        val manager = activity.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        return describe(manager.activeNetwork?.let { manager.getNetworkCapabilities(it) })
    }

    // every change of the default network, the current one first, to `handler` on the main thread, until `unwatch` is
    // given the number this answers: one subscription shared by every watcher (native-watch.kt). A change that reads
    // the same as the last is not reported
    fun watch(handler: (String) -> Unit): Int = nativeWatch.join("network", handler) { tell ->
        start(tell)
        this::stop
    }

    fun unwatch(id: Int) = nativeWatch.leave("network", id)

    private fun start(handler: (String) -> Unit) {
        stop()
        val activity = hostActivity() ?: return handler("unavailable")
        val manager = activity.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val main = android.os.Handler(android.os.Looper.getMainLooper())
        var last = ""
        val report = { now: String ->
            main.post {
                if (now != last) {
                    last = now
                    handler(now)
                }
            }
        }
        report(describe(manager.activeNetwork?.let { manager.getNetworkCapabilities(it) }))
        val made = object : ConnectivityManager.NetworkCallback() {
            override fun onCapabilitiesChanged(network: android.net.Network, capabilities: NetworkCapabilities) {
                report(describe(capabilities))
            }

            override fun onLost(network: android.net.Network) {
                report("offline none")
            }
        }
        callback = made
        manager.registerDefaultNetworkCallback(made)
    }

    private fun stop() {
        val made = callback ?: return
        callback = null
        (hostActivity()?.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager)?.unregisterNetworkCallback(made)
    }

    private fun describe(capabilities: NetworkCapabilities?): String {
        if (capabilities == null || !capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) return "offline none"
        val kind = when {
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "wired"
            else -> "other"
        }
        return "online $kind"
    }
}
