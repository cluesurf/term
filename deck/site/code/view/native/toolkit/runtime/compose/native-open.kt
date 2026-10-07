// Open under Compose on the desktop (device-layer-0008), docked by ../../open.tree as
// `<global:native-open>` and found ahead of ../native-open.kt (Android's). An address goes to the desktop's handler through java.awt.Desktop. A desktop JVM has no share sheet.

import java.awt.Desktop
import java.net.URI

object nativeOpen {
    // opened, or unavailable when nothing handles the address (or it is not one, or there is no desktop)
    suspend fun address(address: String): String {
        val uri = runCatching { URI(address) }.getOrNull()
        if (uri?.scheme == null || !Desktop.isDesktopSupported() || !Desktop.getDesktop().isSupported(Desktop.Action.BROWSE)) return "unavailable"
        return runCatching { Desktop.getDesktop().browse(uri) }.fold({ "opened" }, { "unavailable" })
    }

    suspend fun share(text: String): String = "unavailable"

    suspend fun shareFile(path: String): String = "unavailable"
}
