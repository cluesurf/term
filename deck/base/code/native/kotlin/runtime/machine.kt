// Machine facts for kotlin. The platform and architecture are named as node's `os.platform()` and `os.arch()` name
// them (the JVM says `Mac OS X`, `aarch64`, `amd64`), so a program branches on one set of names. Reached only through
// the public machine API.
object machine {
    fun cores(): Long = Runtime.getRuntime().availableProcessors().toLong().coerceAtLeast(1L)

    fun platform(): String {
        val name = (System.getProperty("os.name") ?: "").lowercase()
        return if (name.contains("mac") || name.contains("darwin")) "darwin"
        else if (name.contains("win")) "win32"
        else "linux"
    }

    fun architecture(): String {
        val arch = (System.getProperty("os.arch") ?: "").lowercase()
        return if (arch == "aarch64" || arch == "arm64") "arm64"
        else if (arch == "amd64" || arch == "x86_64" || arch == "x64") "x64"
        else if (arch == "x86" || arch == "i386" || arch == "i686") "ia32"
        else arch
    }
}
