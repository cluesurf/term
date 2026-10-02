// Standard user folders. Reached only through the public environment API. Each folder follows the host convention:
// the Apple layout under `~/Library`, the Windows `APPDATA` / `LOCALAPPDATA` pair, and the XDG base directories
// elsewhere, falling back to the documented default when the XDG variable is unset.
object folder {
    private fun homeOrEmpty(): String = System.getProperty("user.home") ?: ""

    private fun onMac(): Boolean =
        (System.getProperty("os.name") ?: "").startsWith("Mac")

    private fun onWindows(): Boolean =
        (System.getProperty("os.name") ?: "").startsWith("Windows")

    private fun xdgOr(variable: String, fallback: String): String =
        System.getenv(variable) ?: "${homeOrEmpty()}/$fallback"

    fun home(): String = homeOrEmpty()

    fun temporary(): String = System.getProperty("java.io.tmpdir") ?: ""

    fun data(): String = when {
        onMac() -> "${homeOrEmpty()}/Library/Application Support"
        onWindows() -> System.getenv("APPDATA") ?: ""
        else -> xdgOr("XDG_DATA_HOME", ".local/share")
    }

    fun configuration(): String = when {
        onMac() -> "${homeOrEmpty()}/Library/Preferences"
        onWindows() -> System.getenv("APPDATA") ?: ""
        else -> xdgOr("XDG_CONFIG_HOME", ".config")
    }

    fun cache(): String = when {
        onMac() -> "${homeOrEmpty()}/Library/Caches"
        onWindows() -> "${System.getenv("LOCALAPPDATA") ?: ""}\\Temp"
        else -> xdgOr("XDG_CACHE_HOME", ".cache")
    }
}
