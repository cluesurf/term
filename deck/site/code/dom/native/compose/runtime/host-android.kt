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
        program()
    }
}

object composeHost {
    var activity: androidx.activity.ComponentActivity? = null
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
    // out, so what is read back is what the last write asked for. True: Android always has its roots to read through
    fun settle(): Boolean {
        androidx.compose.runtime.snapshots.Snapshot.sendApplyNotifications()
        repeat(3) { awaitFrame() }
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

    fun density(): Float = activity?.resources?.displayMetrics?.density ?: 1f

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

    fun readFile(path: String): ByteArray? = java.io.File(path).takeIf { it.isFile }?.readBytes()

    fun log(line: String) {
        android.util.Log.i(COMPOSE_LOG_TAG, line)
    }

    fun exit(status: Long) {
        main.post { activity?.finishAndRemoveTask() }
        main.postDelayed({ kotlin.system.exitProcess(status.toInt()) }, 300)
    }
}
