// The clipboard on Android (device-layer-0005), docked by ../clipboard.tree as `<global:native-clipboard>`, for both
// Android hosts: the Activity is `hostActivity()`, which the Android views host and Compose on Android each define.
// Plain text only, through the platform's ClipboardManager.
//
// ANDROID LETS ONLY THE APP WITH INPUT FOCUS READ THE CLIPBOARD (Android 10 on), and answers a read before that with
// nothing, not an error. A program's first code runs before its window has focus (the Android views host runs it from
// onCreate), so a read waits for the window's focus first, for as long as FOCUS_WAIT, and then reads.

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.view.ViewTreeObserver
import kotlin.coroutines.resume
import kotlin.coroutines.suspendCoroutine

object nativeClipboard {
    // how long a read waits for the window to have focus, in milliseconds
    private const val FOCUS_WAIT = 2000L

    private fun manager(): ClipboardManager? =
        hostActivity()?.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager

    // the window's input focus, or FOCUS_WAIT passing without it: whichever comes first, once
    private suspend fun awaitFocus(activity: android.app.Activity) {
        if (activity.hasWindowFocus()) return
        suspendCoroutine { continuation ->
            // the view's observer NOW, which before the window attaches is a temporary one: Android merges its
            // listeners into the live observer on attach and kills it, so a listener is removed through the view's
            // current observer, never through this reference, which threw "This ViewTreeObserver is not alive"
            val view = activity.window.decorView
            var done = false
            val finish = {
                if (!done) {
                    done = true
                    continuation.resume(Unit)
                }
            }
            val listener = object : ViewTreeObserver.OnWindowFocusChangeListener {
                override fun onWindowFocusChanged(hasFocus: Boolean) {
                    if (hasFocus) {
                        view.viewTreeObserver.takeIf { it.isAlive }?.removeOnWindowFocusChangeListener(this)
                        finish()
                    }
                }
            }
            view.viewTreeObserver.addOnWindowFocusChangeListener(listener)
            view.postDelayed({ finish() }, FOCUS_WAIT)
        }
    }

    // the text on the clipboard now, or empty text when it holds none
    suspend fun read(): String {
        val activity = hostActivity() ?: return ""
        awaitFocus(activity)
        val clip = manager()?.primaryClip ?: return ""
        if (clip.itemCount == 0) return ""
        return clip.getItemAt(0).coerceToText(activity).toString()
    }

    // `written`, or `unavailable` before the Activity exists. A write needs no focus
    fun write(text: String): String {
        val manager = manager() ?: return "unavailable"
        manager.setPrimaryClip(ClipData.newPlainText("text", text))
        return "written"
    }
}
