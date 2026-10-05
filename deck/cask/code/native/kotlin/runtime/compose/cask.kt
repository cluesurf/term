// The cask runtime in the `compose` env (compose-target): Compose Multiplatform on the desktop JVM, found ahead of
// ../cask.kt (Android's, one Activity holding one WebView) because the prelude tries `runtime/<env>/` first. A program on
// Compose draws its own views, so it has no WebView to open: what it reaches the cask for is the app's own places on
// disk (`data-path`, `bundle-path`) and leaving with a status. Those answer here, the same functions with the same
// meaning; the WebView half fails by name rather than doing nothing, since a Compose app that opens one has asked for
// something this env does not have.
//
// The data directory follows each desktop's convention for an application's own files: `~/Library/Application Support`
// on macOS, `%APPDATA%` on Windows, `$XDG_DATA_HOME` (else `~/.local/share`) on Linux, under `term/<name>`.

// a cask window: on Compose there is none to hold, so it records what was asked
class CaskWindow(val title: String, val width: Long, val height: Long)

object cask {
    private fun noWebView(what: String): Nothing =
        error("cask: $what needs a WebView, which the compose env does not have (compose-target)")

    fun openWindow(title: String, width: Long, height: Long): CaskWindow = CaskWindow(title, width, height)

    fun loadBundle(handle: CaskWindow, path: String): Unit = noWebView("load-bundle")

    fun loadUrl(handle: CaskWindow, url: String): Unit = noWebView("load-url")

    fun eval(handle: CaskWindow, script: String): Unit = noWebView("eval")

    fun onMessage(handle: CaskWindow, handler: suspend (String) -> String): Unit = noWebView("on-message")

    fun emit(handle: CaskWindow, name: String, text: String): Unit = noWebView("emit")

    fun onReady(handle: CaskWindow, handler: () -> Unit): Unit = noWebView("on-ready")

    fun onClose(handle: CaskWindow, handler: () -> Unit): Unit = noWebView("on-close")

    fun close(handle: CaskWindow): Unit = noWebView("close")

    fun snapshot(handle: CaskWindow, path: String, done: () -> Unit): Unit = noWebView("snapshot")

    fun show(handle: CaskWindow) {}

    fun activate(handle: CaskWindow) {}

    fun run() {}

    fun quit() {
        kotlin.system.exitProcess(0)
    }

    fun exit(status: Long) {
        println("cask exit $status")
        System.out.flush()
        kotlin.system.exitProcess(status.toInt())
    }

    // the application's own directory on this desktop, by its convention
    private fun applicationHome(): java.io.File {
        val home = System.getProperty("user.home") ?: "."
        val os = (System.getProperty("os.name") ?: "").lowercase()
        val base = when {
            os.contains("mac") -> java.io.File(home, "Library/Application Support")
            os.contains("win") -> java.io.File(System.getenv("APPDATA") ?: home)
            else -> java.io.File(System.getenv("XDG_DATA_HOME") ?: java.io.File(home, ".local/share").path)
        }
        return java.io.File(base, "term")
    }

    // the files that ship beside the program: on the desktop JVM, the directory it was started from
    fun bundlePath(): String = java.io.File(System.getProperty("user.dir") ?: ".").path

    // where the app may write, under `name`, made if it is not there
    fun dataPath(name: String): String {
        val directory = java.io.File(applicationHome(), name)
        directory.mkdirs()
        return directory.path
    }

    // the person's home directory, which a scope's `$home` names (app-scope)
    fun homePath(): String = System.getProperty("user.home") ?: ""
}
