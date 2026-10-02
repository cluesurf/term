import java.net.InetAddress

// DNS over java.net.InetAddress (built into the JDK, getaddrinfo underneath). getAllByName returns every address a
// host maps to; hostAddress renders each as a numeric IP string.
object dns {
    fun resolve(hostname: String): MutableList<String> =
        InetAddress.getAllByName(hostname).map { it.hostAddress }.toMutableList()
    fun resolveOne(hostname: String): String =
        InetAddress.getByName(hostname).hostAddress
}
