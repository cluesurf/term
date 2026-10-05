// The clipboard under Compose on the desktop (device-layer-0005), docked by ../../clipboard.tree as
// `<global:native-clipboard>` and found ahead of ../native-clipboard.kt (Android's) because the prelude tries
// `runtime/<env>/` first. The AWT system clipboard, the one every desktop app shares, on macOS, Linux and Windows. A JVM
// with no display (a server, a headless run on Linux) has none, and answers `unavailable`.

import java.awt.GraphicsEnvironment
import java.awt.Toolkit
import java.awt.datatransfer.DataFlavor
import java.awt.datatransfer.StringSelection

object nativeClipboard {
    private fun clipboard(): java.awt.datatransfer.Clipboard? =
        if (GraphicsEnvironment.isHeadless()) null else runCatching { Toolkit.getDefaultToolkit().systemClipboard }.getOrNull()

    // the text on the clipboard now, or empty text when it holds none or holds no text
    fun read(): String {
        val board = clipboard() ?: return ""
        return runCatching { board.getData(DataFlavor.stringFlavor) as? String }.getOrNull() ?: ""
    }

    // `written`, `denied` when another app holds the clipboard open, or `unavailable` with no display
    fun write(text: String): String {
        val board = clipboard() ?: return "unavailable"
        return runCatching { board.setContents(StringSelection(text), null) }.fold({ "written" }, { "denied" })
    }
}
