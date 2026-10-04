// Where the app has been, kept across a relaunch, on Jetpack Compose (live reload, ../../address.tree). An Activity is
// started by the system, so `term work` hands the address as the launch Intent's TERM_DEV_ADDRESS extra; a relative one
// is a file in the app's external files directory, which survives a reinstall over the same app and which `adb` reaches
// without a debuggable build. Without the extra nothing is read or written.
object nativeAddress {
    private fun file(): java.io.File? {
        val owner = composeHost.activity ?: return null
        val path = owner.intent?.getStringExtra("TERM_DEV_ADDRESS")?.takeIf { it.isNotEmpty() } ?: return null
        return if (path.startsWith("/")) java.io.File(path) else java.io.File(owner.getExternalFilesDir(null) ?: owner.filesDir, path)
    }

    // the history the run before this one kept, one path a line, or empty text
    fun read(): String = file()?.takeIf { it.isFile }?.readText() ?: ""

    fun write(text: String) {
        file()?.writeText(text)
    }
}
