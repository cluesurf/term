// The Compose host on ANDROID (compose-target-0004): the part of ./native-view.kt that differs by platform, for Jetpack
// Compose. The build reads it after native-view.kt, as one runtime; the desktop twin is ./host-desktop.kt, with the
// same `object composeHost`.
//
// ANDROID OWNS THE PROCESS: the system makes the Activity, so the build emits a `TermActivity` extending
// `TermComposeActivity`, whose `program()` runs the Term program inside `onCreate`. `run` sets the tree as the
// Activity's Compose content.
//
// THE LAUNCH BODIES RUN ON THEIR OWN THREAD, the way an instrumented Compose test runs beside the app. Compose draws on
// the main thread one frame at a time, so a body that changes the tree and then reads it back must wait for frames,
// which the main thread cannot do for itself. Snapshot state may be written from any thread; every read of what Compose
// drew, and every act on a control, is done on the main thread and waited for.
//
// READ BACK THROUGH THE SEMANTICS OWNERS, the ones Compose's own Android tests read: every Compose root the app makes
// (the content's, and each dialog's window) is collected through `ViewRootForTest.onViewCreatedCallback`, and a node
// is found by its test tag. An act is the SEMANTICS ACTION an accessibility service performs (click, set text, set
// progress), so it reaches the control's own handler; a key goes through the Activity's own key dispatch.
import androidx.activity.compose.setContent as cxSetContent
import androidx.compose.ui.graphics.asImageBitmap as cxAsImageBitmap
import androidx.compose.ui.input.key.nativeKeyCode as cxNativeKeyCode
import androidx.compose.ui.platform.ViewRootForTest as CxViewRootForTest
import androidx.compose.ui.semantics.SemanticsActions as CxHostActions
import androidx.compose.ui.semantics.SemanticsProperties as CxHostProperties
import androidx.compose.ui.semantics.getOrNull as cxHostGetOrNull
import androidx.compose.ui.text.AnnotatedString as CxAnnotatedString

// the log tag every line goes under, so `adb logcat -s native-dom` reads them, as the Android views host does
private const val COMPOSE_LOG_TAG = "native-dom"

// the Activity the build emits `TermActivity` from: it runs the Term program once the Activity exists
abstract class TermComposeActivity : androidx.activity.ComponentActivity() {
    abstract fun program()

    override fun onCreate(saved: android.os.Bundle?) {
        super.onCreate(saved)
        composeHost.activity = this
        // the system back (the back gesture, the back key) reaches the dispatcher: the app's navigation takes it first,
        // and only a back it refuses, at the first place, goes on to the platform and leaves the app, as Android's own
        // does (native-navigation-0007)
        onBackPressedDispatcher.addCallback(this, object : androidx.activity.OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (nativeView.takeBack()) return
                isEnabled = false
                onBackPressedDispatcher.onBackPressed()
                isEnabled = true
            }
        })
        program()
    }

    // the manifest declares the device's trait changes as handled, so the Activity stays and says so here instead, to
    // the device traits (view/native/toolkit/runtime/compose-android/native-device.kt)
    override fun onConfigurationChanged(config: android.content.res.Configuration) {
        super.onConfigurationChanged(config)
        for (body in composeHost.configurationChanged.toList()) body()
    }

    // the platform's answer to a permission request (view/native/toolkit/runtime/native-permission.kt)
    @Deprecated("the framework's callback, which a ComponentActivity still delivers")
    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        @Suppress("DEPRECATION")
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        for (body in hostPermissionAnswers.toList()) body(requestCode)
    }
}

// The Activity a device capability's runtime asks the platform through, the twin of the Android views host's
// (dom/native/toolkit/runtime/native-view.kt), so one capability runtime serves both Android hosts (device-layer)
fun hostActivity(): android.app.Activity? = composeHost.activity

// called with the request code whenever the platform answers a permission request, the Android views host's twin
val hostPermissionAnswers = mutableListOf<(Int) -> Unit>()

object composeHost {
    var activity: androidx.activity.ComponentActivity? = null
    // called on every configuration change the Activity handles
    val configurationChanged = mutableListOf<() -> Unit>()
    private val main = android.os.Handler(android.os.Looper.getMainLooper())
    // every Compose root the app has made, the content's and each dialog's, held weakly
    private val roots = mutableListOf<java.lang.ref.WeakReference<CxViewRootForTest>>()

    // run `body` on the main thread and wait for its answer: an immediate call when already there. A null answer is an
    // answer (no node holds that tag), told apart from no answer at all by whether the latch was counted down
    private fun <T> onMain(body: () -> T): T {
        if (android.os.Looper.myLooper() == android.os.Looper.getMainLooper()) return body()
        val done = java.util.concurrent.CountDownLatch(1)
        var answer: Result<T>? = null
        main.post {
            answer = runCatching(body)
            done.countDown()
        }
        if (!done.await(10, java.util.concurrent.TimeUnit.SECONDS)) error("composeHost: the main thread did not answer")
        return answer!!.getOrThrow()
    }

    // wait for one frame the main thread draws
    private fun awaitFrame() {
        val done = java.util.concurrent.CountDownLatch(1)
        main.post { android.view.Choreographer.getInstance().postFrameCallback { done.countDown() } }
        done.await(2, java.util.concurrent.TimeUnit.SECONDS)
    }

    private fun liveRoots(): List<CxViewRootForTest> {
        roots.removeAll { it.get() == null }
        return roots.mapNotNull { it.get() }
    }

    fun run(content: TermNode, title: String, width: Int, height: Int, bodies: () -> Unit) {
        val owner = activity ?: error("composeHost: no Activity yet. A program runs inside TermActivity.program()")
        CxViewRootForTest.onViewCreatedCallback = { made -> roots.add(java.lang.ref.WeakReference(made)) }
        owner.title = title
        owner.cxSetContent { CxTree(content) }
        // the bodies once the first frame is drawn, on their own thread, so they can wait for the frames after it
        owner.window.decorView.post {
            Thread({
                settle()
                bodies()
            }, "term-launch").start()
        }
    }

    // Compose recomposes, lays out and builds semantics on its frames: a few frames, then every root measured and laid
    // out, so what is read back is what the last write asked for. True: Android always has its roots to read through.
    // ON THE MAIN THREAD (a handler a control called, saying what it saw) no frame can be waited for, because the main
    // thread is the one that would draw it: each wait ran out its two seconds instead, so it lays out what it has
    fun settle(): Boolean {
        androidx.compose.runtime.snapshots.Snapshot.sendApplyNotifications()
        if (android.os.Looper.myLooper() != android.os.Looper.getMainLooper()) repeat(3) { awaitFrame() }
        onMain { for (root in liveRoots()) root.measureAndLayoutForTest() }
        return true
    }

    private fun find(tag: String, merged: Boolean): androidx.compose.ui.semantics.SemanticsNode? = onMain {
        for (root in liveRoots()) {
            val top = if (merged) root.semanticsOwner.rootSemanticsNode else root.semanticsOwner.unmergedRootSemanticsNode
            val pending = ArrayDeque(listOf(top))
            while (pending.isNotEmpty()) {
                val at = pending.removeFirst()
                if (at.config.cxHostGetOrNull(CxHostProperties.TestTag) == tag) return@onMain at
                pending.addAll(at.children)
            }
        }
        null
    }

    fun semantics(tag: String, merged: Boolean): androidx.compose.ui.semantics.SemanticsNode? {
        settle()
        return find(tag, merged)
    }

    fun holds(tag: String): Boolean {
        settle()
        return find(tag, merged = false) != null
    }

    // the control's own click, through the semantics action TalkBack performs
    fun click(tag: String): Boolean {
        settle()
        val node = find(tag, merged = true) ?: return false
        onMain { node.config.cxHostGetOrNull(CxHostActions.OnClick)?.action?.invoke() }
        settle()
        return true
    }

    fun replaceText(tag: String, text: String) {
        settle()
        val node = find(tag, merged = true) ?: return
        onMain { node.config.cxHostGetOrNull(CxHostActions.SetText)?.action?.invoke(CxAnnotatedString(text)) }
        settle()
    }

    // the InputConnection each text input request made, the one a keyboard is handed, so every edit of one session goes
    // through one connection as a keyboard's do
    private val connections = java.util.WeakHashMap<Any, android.view.inputmethod.InputConnection>()

    // an input method's edit to the field tagged `tag`: focused first, through the semantics action TalkBack performs,
    // so it opens its text input session, then the edit written through the InputConnection that session's request
    // creates, `setComposingText` for marked text and `commitText` for the commit, which is what a keyboard calls
    fun inputMethod(
        tag: String,
        request: () -> androidx.compose.ui.platform.PlatformTextInputMethodRequest?,
        text: String,
        commit: Boolean,
    ) {
        nativeView.keyboardIsTest = true
        settle()
        if (request() == null) {
            val node = find(tag, merged = true) ?: return
            onMain {
                node.config.cxHostGetOrNull(CxHostActions.RequestFocus)?.action?.invoke()
                    ?: node.config.cxHostGetOrNull(CxHostActions.OnClick)?.action?.invoke()
            }
            settle()
        }
        val session = request() ?: error("composeHost: the field $tag opened no text input session when focused")
        onMain {
            val connection = connections.getOrPut(session) { session.createInputConnection(android.view.inputmethod.EditorInfo()) }
            if (commit) connection.commitText(text, 1) else connection.setComposingText(text, 1)
        }
        settle()
    }

    fun setProgress(tag: String, value: Float) {
        settle()
        val node = find(tag, merged = true) ?: return
        onMain { node.config.cxHostGetOrNull(CxHostActions.SetProgress)?.action?.invoke(value) }
        settle()
    }

    // a key down and up through the Activity's own dispatch, the route a hardware keyboard takes, to the focused root
    fun pressKey(tag: String, key: androidx.compose.ui.input.key.Key): Boolean {
        val owner = activity ?: return false
        settle()
        val code = key.cxNativeKeyCode
        onMain {
            owner.dispatchKeyEvent(android.view.KeyEvent(android.view.KeyEvent.ACTION_DOWN, code))
            owner.dispatchKeyEvent(android.view.KeyEvent(android.view.KeyEvent.ACTION_UP, code))
        }
        settle()
        return true
    }

    // Android's back is the dispatcher's, never a key the tree hears
    fun isBackKey(event: androidx.compose.ui.input.key.KeyEvent): Boolean = false

    // the system back through the Activity's dispatcher, the entry the back gesture and the back key reach
    fun pressBack(): Boolean {
        val owner = activity ?: return false
        settle()
        onMain { owner.onBackPressedDispatcher.onBackPressed() }
        settle()
        return true
    }

    fun density(): Float = activity?.resources?.displayMetrics?.density ?: 1f

    // the color Compose drew at the node tagged `tag`, `dx` and `dy` dp in from its top left, as `#rrggbb`: the Compose
    // root holding the node drawn into a bitmap, and the pixel read off it. A node below the screen is scrolled to first,
    // through the page's own scroll action (the one TalkBack performs), as a person would scroll to look at it
    // TRIED A FEW TIMES, scrolling again while the node is still off the screen, and looking again while no root holds
    // it yet: on a loaded emulator the panel's fill came back `none` in a full gate run while the same leg alone read it
    // right, the frame after the write or the scroll not yet laid out when the bitmap was drawn
    fun pixel(tag: String, dx: Float, dy: Float): String? {
        repeat(PIXEL_TRIES) {
            settle()
            val drawn = sample(tag, dx, dy)
            if (drawn != null && drawn != OFF_SCREEN) return drawn
            if (drawn == OFF_SCREEN) {
                val top = find(tag, merged = false)?.positionInRoot?.y
                val page = find("term-root", merged = false)
                if (top != null && page != null) {
                    onMain { page.config.cxHostGetOrNull(CxHostActions.ScrollBy)?.action?.invoke(0f, top - 200f * density()) }
                }
            }
        }
        settle()
        return sample(tag, dx, dy).takeIf { it != OFF_SCREEN }
    }

    // a point outside the drawn window, told apart from a node that is not there at all
    private const val OFF_SCREEN = "off-screen"

    // how many times a pixel is looked for before the node is said to be off the screen
    private const val PIXEL_TRIES = 4

    private fun sample(tag: String, dx: Float, dy: Float): String? =
        onMain {
            for (root in liveRoots()) {
                val pending = ArrayDeque(listOf(root.semanticsOwner.unmergedRootSemanticsNode))
                var found: androidx.compose.ui.semantics.SemanticsNode? = null
                while (pending.isNotEmpty() && found == null) {
                    val at = pending.removeFirst()
                    if (at.config.cxHostGetOrNull(CxHostProperties.TestTag) == tag) found = at else pending.addAll(at.children)
                }
                val node = found ?: continue
                val view = root.view
                if (view.width <= 0 || view.height <= 0) return@onMain null
                val bitmap = android.graphics.Bitmap.createBitmap(view.width, view.height, android.graphics.Bitmap.Config.ARGB_8888)
                view.draw(android.graphics.Canvas(bitmap))
                val scale = density()
                val x = Math.round(node.positionInRoot.x + dx * scale)
                val y = Math.round(node.positionInRoot.y + dy * scale)
                if (x !in 0 until bitmap.width || y !in 0 until bitmap.height) return@onMain OFF_SCREEN
                val color = bitmap.getPixel(x, y)
                return@onMain "#%02x%02x%02x".format(android.graphics.Color.red(color), android.graphics.Color.green(color), android.graphics.Color.blue(color))
            }
            null
        }

    // a PNG of the window, drawn from its views. A path that is not absolute lands in the app's external files
    // directory, which `adb` reads without a debuggable build
    fun snapshot(path: String) {
        val owner = activity ?: return
        settle()
        onMain {
            val view = owner.window.decorView
            val bitmap = android.graphics.Bitmap.createBitmap(view.width, view.height, android.graphics.Bitmap.Config.ARGB_8888)
            view.draw(android.graphics.Canvas(bitmap))
            val file = if (path.startsWith("/")) java.io.File(path) else java.io.File(owner.getExternalFilesDir(null) ?: owner.filesDir, path)
            java.io.FileOutputStream(file).use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
        }
    }

    fun decodePicture(bytes: ByteArray): androidx.compose.ui.graphics.ImageBitmap? =
        android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.cxAsImageBitmap()

    // a file's bytes; `asset:<name>` is a file the APK carries
    fun readFile(path: String): ByteArray? {
        if (path.startsWith("asset:")) {
            return runCatching { activity?.assets?.open(path.removePrefix("asset:"))?.use { it.readBytes() } }.getOrNull()
        }
        return java.io.File(path).takeIf { it.isFile }?.readBytes()
    }

    // a face from its file's bytes, as a family Compose draws text in. Android makes a Typeface from a file, so the
    // bytes are written to the cache first; a file that is not a font is refused here, as the other hosts refuse it
    fun fontOf(family: String, bytes: ByteArray): androidx.compose.ui.text.font.FontFamily? {
        val owner = activity ?: return null
        return runCatching {
            val file = java.io.File(owner.cacheDir, "term-font-${java.util.UUID.randomUUID()}")
            file.writeBytes(bytes)
            typefaces[family] = android.graphics.Typeface.createFromFile(file)
            androidx.compose.ui.text.font.FontFamily(androidx.compose.ui.text.font.Font(file))
        }.getOrNull()
    }

    // every registered face as a Typeface, by family, so a glyph can be asked of it
    private val typefaces = mutableMapOf<String, android.graphics.Typeface>()

    // the characters of `text` Android would draw as a box, each once in the order first met: asked of a Paint in the
    // text's face (`family`, when registered, else the system's), whose `hasGlyph` follows the system's fallback chain
    // as drawing does, the same question the Android views host asks of its TextView's paint
    fun missingGlyphs(text: String, family: String?): String {
        val paint = android.graphics.Paint()
        paint.typeface = family?.let { typefaces[it] } ?: android.graphics.Typeface.DEFAULT
        val missing = linkedSetOf<String>()
        var at = 0
        while (at < text.length) {
            val character = String(Character.toChars(text.codePointAt(at)))
            if (!paint.hasGlyph(character)) missing.add(character)
            at += character.length
        }
        return missing.joinToString("")
    }

    fun log(line: String) {
        android.util.Log.i(COMPOSE_LOG_TAG, line)
    }

    fun exit(status: Long) {
        main.post { activity?.finishAndRemoveTask() }
        main.postDelayed({ kotlin.system.exitProcess(status.toInt()) }, 300)
    }
}
