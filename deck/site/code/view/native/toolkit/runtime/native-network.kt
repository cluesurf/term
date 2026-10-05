// The network on Android (device-layer-0010), docked by ../network.tree as `<global:native-network>`, for both Android
// hosts. The active network's capabilities from ConnectivityManager: online when it reaches the internet, and its kind
// by transport.

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities

object nativeNetwork {
    // `<online|offline> <kind>`, the kind wifi, cellular, wired, other or none
    suspend fun read(): String {
        val activity = hostActivity() ?: return "unavailable"
        val manager = activity.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val capabilities = manager.activeNetwork?.let { manager.getNetworkCapabilities(it) } ?: return "offline none"
        if (!capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) return "offline none"
        val kind = when {
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "wired"
            else -> "other"
        }
        return "online $kind"
    }
}
