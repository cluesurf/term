// The Compose host on the DESKTOP (compose-target): the part of ./native-view.kt that differs by platform, for Compose
// Multiplatform on the JVM. The build reads it after native-view.kt, as one runtime (test/compile/shared/compose-build.ts);
// Android has its twin, ./host-android.kt, with the same `object composeHost`.
//
// TWO WAYS TO RUN. With `TERM_WINDOW_AWAY=1` (every test) or no display, `run` hosts the tree in Compose's own desktop
// test host at the root's size, with no window, and runs the after-launch bodies inside it, so a click, a text edit, a
// slider move and a key reach a control through Compose's input injection, the route a pointer and a keyboard take, and
// every read goes through the test host's semantics. Otherwise `run` opens a window.
import androidx.compose.ui.input.key.isAltPressed as cxIsAltPressed
import androidx.compose.ui.input.key.isMetaPressed as cxIsMetaPressed
import androidx.compose.ui.test.withKeyDown as cxWithKeyDown
import androidx.compose.ui.graphics.toAwtImage as cxToAwtImage
import androidx.compose.ui.graphics.toPixelMap as cxToPixelMap
import androidx.compose.ui.graphics.toComposeImageBitmap as cxToComposeImageBitmap
import androidx.compose.ui.test.DesktopComposeUiTest as CxUiTest
import androidx.compose.ui.test.ExperimentalTestApi as CxExperimentalTestApi
import androidx.compose.ui.test.captureToImage as cxCaptureToImage
import androidx.compose.ui.test.onAllNodesWithTag as cxOnAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag as cxOnNodeWithTag
import androidx.compose.ui.test.onRoot as cxOnRoot
import androidx.compose.ui.test.performClick as cxPerformClick
import androidx.compose.ui.test.performKeyInput as cxPerformKeyInput
import androidx.compose.ui.test.performSemanticsAction as cxPerformSemanticsAction
import androidx.compose.ui.test.performTextReplacement as cxPerformTextReplacement
import androidx.compose.ui.test.pressKey as cxPressKey
import androidx.compose.ui.test.requestFocus as cxRequestFocus
import androidx.compose.ui.test.runDesktopComposeUiTest as cxRunDesktopComposeUiTest
import androidx.compose.ui.unit.dp as cxDp
import androidx.compose.ui.window.Window as CxWindow
import androidx.compose.ui.window.application as cxApplication
import androidx.compose.ui.window.rememberWindowState as cxRememberWindowState

@OptIn(CxExperimentalTestApi::class)
object composeHost {
    // the desktop test host the tree is drawn in when there is no window (every test). Read-back and input go through it
    private var ui: CxUiTest? = null

    private fun headless(): Boolean =
        System.getenv("TERM_WINDOW_AWAY") == "1" || java.awt.GraphicsEnvironment.isHeadless()

    // hand the process to Compose. Headless: the tree in the desktop test host, `bodies` run inside it. Otherwise a
    // window, `bodies` run once it is composed
    fun run(content: TermNode, title: String, width: Int, height: Int, bodies: () -> Unit) {
        if (headless()) {
            cxRunDesktopComposeUiTest(width = width, height = height) {
                ui = this
                setContent { CxTree(content) }
                waitForIdle()
                bodies()
            }
            ui = null
            return
        }
        cxApplication {
            val state = cxRememberWindowState(width = width.cxDp, height = height.cxDp)
            CxWindow(onCloseRequest = { nativeView.exit(0) }, title = title, state = state) {
                CxTree(content)
            }
            androidx.compose.runtime.LaunchedEffect(Unit) { bodies() }
        }
    }

    // Compose settles a write on its next frame: every read and every act waits for the host to be idle first. False
    // where there is no test host to read through (a window)
    fun settle(): Boolean = ui?.also { it.waitForIdle() } != null

    // the semantics Compose drew for the node tagged `tag`, MERGED as a reader is told them or the node's own
    fun semantics(tag: String, merged: Boolean): androidx.compose.ui.semantics.SemanticsNode? {
        val host = ui ?: return null
        host.waitForIdle()
        return host.cxOnNodeWithTag(tag, useUnmergedTree = !merged).fetchSemanticsNode()
    }

    // whether Compose holds any node tagged `tag` right now, in any layer (a dialog's included)
    fun holds(tag: String): Boolean {
        val host = ui ?: return false
        host.waitForIdle()
        return host.cxOnAllNodesWithTag(tag, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
    }

    // a click injected at the node's center, so its own onClick runs. False where there is no test host
    fun click(tag: String): Boolean {
        val host = ui ?: return false
        host.waitForIdle()
        host.cxOnNodeWithTag(tag).cxPerformClick()
        host.waitForIdle()
        return true
    }

    // a field's text replaced through Compose's text input, so its own onValueChange reports it
    fun replaceText(tag: String, text: String) {
        val host = ui ?: return
        host.waitForIdle()
        host.cxOnNodeWithTag(tag).cxPerformTextReplacement(text)
        host.waitForIdle()
    }

    // an input method's edit to the field tagged `tag`: focused first, so it opens its text input session, then the
    // edit written through the session's request, `setComposingText` for marked text and `commitText` for the commit.
    // That is the call Compose's own InputMethodSession makes of an AWT InputMethodEvent, so the field's edit processor
    // makes of it what it makes of a real input method's
    @OptIn(androidx.compose.ui.ExperimentalComposeUiApi::class)
    fun inputMethod(
        tag: String,
        request: () -> androidx.compose.ui.platform.PlatformTextInputMethodRequest?,
        text: String,
        commit: Boolean,
    ) {
        val host = ui ?: return
        nativeView.keyboardIsTest = true
        host.waitForIdle()
        if (request() == null) {
            host.cxOnNodeWithTag(tag).cxRequestFocus()
            host.waitForIdle()
        }
        val session = request() ?: error("composeHost: the field $tag opened no text input session when focused")
        host.runOnUiThread {
            session.editText { if (commit) commitText(text, 1) else setComposingText(text, 1) }
        }
        host.waitForIdle()
    }

    // a slider moved through the semantics action a drag performs
    fun setProgress(tag: String, value: Float) {
        val host = ui ?: return
        host.waitForIdle()
        host.cxOnNodeWithTag(tag).cxPerformSemanticsAction(androidx.compose.ui.semantics.SemanticsActions.SetProgress) { it(value) }
        host.waitForIdle()
    }

    // a key pressed on the node tagged `tag`, focused first, as a real key event. False where there is no test host
    fun pressKey(tag: String, key: androidx.compose.ui.input.key.Key): Boolean {
        val host = ui ?: return false
        host.waitForIdle()
        val target = host.cxOnNodeWithTag(tag)
        target.cxRequestFocus()
        target.cxPerformKeyInput { cxPressKey(key) }
        host.waitForIdle()
        return true
    }

    // the desktop's back is a key chord, the one each desktop's own apps take: ⌘[ on macOS (as the AppKit host's menu
    // item has it), Alt+← on Windows and Linux (as their browsers and file managers have it)
    private val mac = System.getProperty("os.name").orEmpty().startsWith("Mac")

    fun isBackKey(event: androidx.compose.ui.input.key.KeyEvent): Boolean =
        if (mac) event.cxIsMetaPressed && event.cxKey == androidx.compose.ui.input.key.Key.LeftBracket
        else event.cxIsAltPressed && event.cxKey == androidx.compose.ui.input.key.Key.DirectionLeft

    // the back chord pressed on the window's root as real key events, the route a keyboard takes. False where there is
    // no test host
    fun pressBack(): Boolean {
        val host = ui ?: return false
        host.waitForIdle()
        val root = host.cxOnNodeWithTag("term-root")
        root.cxRequestFocus()
        root.cxPerformKeyInput {
            if (mac) {
                cxWithKeyDown(androidx.compose.ui.input.key.Key.MetaLeft) { cxPressKey(androidx.compose.ui.input.key.Key.LeftBracket) }
            } else {
                cxWithKeyDown(androidx.compose.ui.input.key.Key.AltLeft) { cxPressKey(androidx.compose.ui.input.key.Key.DirectionLeft) }
            }
        }
        host.waitForIdle()
        return true
    }

    // device pixels per dp
    fun density(): Float = ui?.density?.density ?: 1f

    // the color Compose drew at the node tagged `tag`, `dx` and `dy` dp in from its top left, as `#rrggbb`, read off the
    // captured image of the whole content. Null where there is no test host or the point is off the image
    fun pixel(tag: String, dx: Float, dy: Float): String? {
        val host = ui ?: return null
        host.waitForIdle()
        val node = host.cxOnNodeWithTag(tag, useUnmergedTree = true).fetchSemanticsNode()
        val image = host.cxOnRoot().cxCaptureToImage()
        val scale = host.density.density
        val x = Math.round(node.positionInRoot.x + dx * scale)
        val y = Math.round(node.positionInRoot.y + dy * scale)
        if (x !in 0 until image.width || y !in 0 until image.height) return null
        val color = image.cxToPixelMap()[x, y]
        return "#%02x%02x%02x".format(Math.round(color.red * 255), Math.round(color.green * 255), Math.round(color.blue * 255))
    }

    // a PNG of the whole content, as Compose drew it
    fun snapshot(path: String) {
        val host = ui ?: return
        host.waitForIdle()
        val image = host.cxOnRoot().cxCaptureToImage().cxToAwtImage()
        javax.imageio.ImageIO.write(image, "png", java.io.File(path))
    }

    // an encoded picture, decoded by Skia into a bitmap Compose draws
    fun decodePicture(bytes: ByteArray): androidx.compose.ui.graphics.ImageBitmap? =
        runCatching { org.jetbrains.skia.Image.makeFromEncoded(bytes).cxToComposeImageBitmap() }.getOrNull()

    // every registered face as Skia holds it, by family, so a glyph can be asked of it
    private val typefaces = mutableMapOf<String, org.jetbrains.skia.Typeface>()

    // a face from its file's bytes, as a family Compose draws text in (Skia reads the font), or null when it does not read
    fun fontOf(family: String, bytes: ByteArray): androidx.compose.ui.text.font.FontFamily? =
        runCatching {
            val font = androidx.compose.ui.text.platform.Font(identity = family, data = bytes)
            // Skia reads the face only when it is first drawn: a file that is not a font must be refused HERE, as the
            // other hosts refuse it, so its typeface is made now
            typefaces[family] = org.jetbrains.skia.FontMgr.default.makeFromData(org.jetbrains.skia.Data.makeFromBytes(bytes))
                ?: error("not a font")
            androidx.compose.ui.text.font.FontFamily(font)
        }.getOrNull()

    // the characters of `text` Skia would draw as a box, each once in the order first met: a character the text's own
    // face (`family`, when registered) has no glyph for, and that no font the system falls back to has either, which is
    // the fallback Compose's text goes through on the desktop
    fun missingGlyphs(text: String, family: String?): String {
        val face = family?.let { typefaces[it] }
        val manager = org.jetbrains.skia.FontMgr.default
        val missing = linkedSetOf<String>()
        var at = 0
        while (at < text.length) {
            val point = text.codePointAt(at)
            val character = String(Character.toChars(point))
            val own = face != null && face.getUTF32Glyph(point) != 0.toShort()
            // macOS answers every character with LastResort (named `.LastResort`, with the dot), whose glyph for one no
            // real font covers IS the box: a match there is a box, not a drawing. Counted as a match, every script read
            // as fully drawn
            val fallback = if (own) null else manager.matchFamilyStyleCharacter(null, org.jetbrains.skia.FontStyle.NORMAL, null, point)
            if (!own && (fallback == null || fallback.familyName.trimStart('.') == "LastResort" || fallback.getUTF32Glyph(point) == 0.toShort())) {
                missing.add(character)
            }
            at += character.length
        }
        return missing.joinToString("")
    }

    // a file's bytes, for a picture's `src` that is a path
    fun readFile(path: String): ByteArray? = java.io.File(path).takeIf { it.isFile }?.readBytes()

    fun log(line: String) {
        println(line)
        System.out.flush()
    }

    fun exit(status: Long) {
        kotlin.system.exitProcess(status.toInt())
    }
}
