package surf.term.blog

import android.app.Activity
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebViewClient
import java.io.File
import java.io.FileOutputStream
import kotlin.coroutines.Continuation
import kotlin.coroutines.CoroutineContext
import kotlin.coroutines.EmptyCoroutineContext
import kotlin.coroutines.startCoroutine
// The cask runtime on Android: one Activity holding one WebView, a JavaScript interface that receives what the page
// posts through `window.term.post(text)`, and `evaluateJavascript` to answer it. Reached only through the public
// cask API in ../cask.tree, whose tasks map to the functions of `object cask` below.
//
// ANDROID OWNS THE PROCESS. There is no `main`: the system creates the Activity, so `run` has nothing to do, and
// `openWindow` can only record what was asked until an Activity exists. The build emits a `TermActivity` that
// extends `CaskActivity` and calls the program's `boot` from `program()`; `onCreate` runs it, then builds the WebView
// from the handle `openWindow` left behind and applies the load that was asked for. That is the same shape the iOS
// runtime uses for UIApplicationMain.
//
// THE PAGE ADOPTS THE BRIDGE. `addJavascriptInterface` exposes `__term_native.post` to the page before any of its
// scripts run; the page-side runtime (deck/seed/code/native/webview/runtime/bridge.ts) builds `window.term` over it
// when the cask did not inject one. Injecting at document start would need androidx.webkit, and this file has no
// dependency beyond the platform.
//
// Every call into the WebView happens on the main thread, so replies and pushes hop there through a Handler. A
// reply handler is `suspend`, started with the standard library's `startCoroutine` and no kotlinx dependency, the
// way the rest of the Kotlin natives run their suspend functions.

// the log tag every line the cask prints goes under, so `adb logcat -s cask` reads it
private const val TAG = "cask"

// where the app's page lives inside the APK, and the asset directory whose files `bundlePath` answers with
private const val PAGE_ASSET = "webview"

private val main = Handler(Looper.getMainLooper())

// receives every `window.term.post`. Exposed to the page as `__term_native`
class CaskInterface(private val handle: CaskWindow) {
    @JavascriptInterface
    fun post(text: String) {
        val handler = handle.onMessage ?: return
        val trace = System.getenv("CASK_TRACE") != null
        if (trace) Log.i(TAG, "cask <- $text")
        val continuation = object : Continuation<String> {
            override val context: CoroutineContext = EmptyCoroutineContext
            override fun resumeWith(result: Result<String>) {
                val reply = result.getOrElse { "{\"exception\":\"${it.message}\"}" }
                if (trace) Log.i(TAG, "cask -> $reply")
                main.post { handle.webview?.evaluateJavascript("window.term.reply($reply)", null) }
            }
        }
        handler.startCoroutine(text, continuation)
    }
}

// what a page load is, kept until the Activity exists
internal sealed class PendingLoad {
    class Asset(val directory: String) : PendingLoad()
    class Url(val url: String) : PendingLoad()
}

// one window and the WebView inside it. The opaque handle Term holds. The WebView needs a Context, so it is made by
// the Activity, not at `openWindow`
class CaskWindow(val title: String, val width: Long, val height: Long) {
    var webview: WebView? = null
    var activity: Activity? = null
    var onMessage: (suspend (String) -> String)? = null
    var onReady: (() -> Unit)? = null
    internal var pending: PendingLoad? = null

    // build the WebView inside the Activity and run the load that was asked for
    internal fun attach(activity: Activity) {
        this.activity = activity
        val view = WebView(activity)
        view.settings.javaScriptEnabled = true
        view.settings.allowFileAccess = true
        view.settings.allowFileAccessFromFileURLs = true
        view.settings.allowUniversalAccessFromFileURLs = true
        view.addJavascriptInterface(CaskInterface(this), "__term_native")
        view.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView?, url: String?) {
                onReady?.invoke()
            }
        }
        webview = view
        activity.setContentView(view)
        activity.title = title
        applyPendingLoad()
    }

    internal fun applyPendingLoad() {
        val view = webview ?: return
        val load = pending ?: return
        pending = null
        when (load) {
            is PendingLoad.Asset -> view.loadUrl("file:///android_asset/${load.directory}/index.html")
            is PendingLoad.Url -> view.loadUrl(load.url)
        }
    }
}

// the Activity the build emits `TermActivity` from. `program` is the program's `boot`, called once the Activity
// exists, and it leaves a handle behind through `openWindow` for `onCreate` to show
abstract class CaskActivity : Activity() {
    abstract fun program()

    override fun onCreate(saved: Bundle?) {
        super.onCreate(saved)
        cask.activity = this
        program()
        cask.pending?.attach(this)
    }
}

object cask {
    internal var pending: CaskWindow? = null
    internal var activity: Activity? = null

    // Term's `number` is `Long` on this backend
    fun openWindow(title: String, width: Long, height: Long): CaskWindow {
        val handle = CaskWindow(title, width, height)
        pending = handle
        return handle
    }

    // `path` is the asset directory holding index.html when it is relative, or a directory on disk when absolute
    fun loadBundle(handle: CaskWindow, path: String) {
        handle.pending = if (path.startsWith("/")) PendingLoad.Url("file://$path/index.html") else PendingLoad.Asset(path)
        main.post { handle.applyPendingLoad() }
    }

    fun loadUrl(handle: CaskWindow, url: String) {
        handle.pending = PendingLoad.Url(url)
        main.post { handle.applyPendingLoad() }
    }

    fun eval(handle: CaskWindow, script: String) {
        main.post { handle.webview?.evaluateJavascript(script, null) }
    }

    fun onMessage(handle: CaskWindow, handler: suspend (String) -> String) {
        handle.onMessage = handler
    }

    // a JavaScript string literal for `text`, so an event or a reply can carry any text into the page
    private fun quote(text: String): String {
        val out = StringBuilder("\"")
        for (ch in text) {
            when (ch) {
                '\\' -> out.append("\\\\")
                '"' -> out.append("\\\"")
                '\n' -> out.append("\\n")
                '\r' -> out.append("\\r")
                '\t' -> out.append("\\t")
                '\u2028' -> out.append("\\u2028")
                '\u2029' -> out.append("\\u2029")
                else -> if (ch < ' ') out.append(String.format("\\u%04x", ch.code)) else out.append(ch)
            }
        }
        return out.append("\"").toString()
    }

    // push an event into the page: `listen` on the page side receives it by name
    fun emit(handle: CaskWindow, name: String, text: String) {
        val script = "window.term.push(${quote(name)}, ${quote(text)})"
        main.post { handle.webview?.evaluateJavascript(script, null) }
    }

    fun onReady(handle: CaskWindow, handler: () -> Unit) {
        handle.onReady = handler
    }

    // draws the WebView into a bitmap and writes it as a PNG, then calls `done`
    fun snapshot(handle: CaskWindow, path: String, done: () -> Unit) {
        main.post {
            val view = handle.webview
            if (view != null && view.width > 0 && view.height > 0) {
                val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
                view.draw(Canvas(bitmap))
                FileOutputStream(File(path)).use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
            }
            done()
        }
    }

    // the one window of an Android app is always on screen once the Activity runs
    fun show(handle: CaskWindow) {}

    fun activate(handle: CaskWindow) {}

    // the system runs the process; there is nothing to hand it
    fun run() {}

    fun quit() {
        main.post { activity?.finishAffinity() }
    }

    // leave with a status. Android has no caller reading it, so it is logged first for `adb logcat -s cask`
    fun exit(status: Long) {
        Log.i(TAG, "cask exit $status")
        System.exit(status.toInt())
    }

    // the app's own files: the assets beside the page, copied into the app's files directory once so they are
    // real files a path can name. `webview/` itself stays an asset and is loaded by URL
    fun bundlePath(): String {
        val activity = activity ?: return ""
        val target = File(activity.filesDir, "bundle")
        if (!target.exists()) {
            target.mkdirs()
            for (name in activity.assets.list("") ?: emptyArray()) {
                if (name == PAGE_ASSET) continue
                try {
                    activity.assets.open(name).use { input ->
                        FileOutputStream(File(target, name)).use { output -> input.copyTo(output) }
                    }
                } catch (_: Exception) {
                    // a directory rather than a file, or a system asset; not ours to copy
                }
            }
        }
        return target.path
    }

    // where the app may write: its own files directory, under `name`
    fun dataPath(name: String): String {
        val activity = activity ?: return ""
        val directory = File(activity.filesDir, name)
        directory.mkdirs()
        return directory.path
    }
}


object console {
    fun writeLine(message: String) { println(message) }
    fun writeError(message: String) { System.err.println(message) }
}


// Kotlin JSON with no library: the JDK has no JSON parser and nothing sits on a bare classpath, so the reader and
// the writer live here, small and complete (RFC 8259: objects, arrays, strings with every escape, numbers, the
// three words). The parsed value is the opaque dynamic value (Any: a LinkedHashMap<String, Any> keeping key order,
// a MutableList<Any>, a String, a Double, a Boolean, or JsonNull for null).

object JsonNull

object json {
    fun parse(text: String): Any = JsonReader(text).read()

    fun stringify(value: Any): String {
        val out = StringBuilder()
        write(value, out)
        return out.toString()
    }

    // a bare number spells the way JSON does everywhere else: a whole one without a point, the rest the shortest
    // digits that read back to the same value
    private fun write(value: Any?, out: StringBuilder) {
        when (value) {
            null, JsonNull -> out.append("null")
            is Boolean -> out.append(if (value) "true" else "false")
            is Double -> out.append(if (value == Math.rint(value) && Math.abs(value) < 1e15) value.toLong().toString() else value.toString())
            is Number -> out.append(value.toString())
            is String -> writeText(value, out)
            is Map<*, *> -> {
                out.append('{')
                var first = true
                for ((key, item) in value) {
                    if (!first) out.append(',')
                    first = false
                    writeText(key.toString(), out)
                    out.append(':')
                    write(item, out)
                }
                out.append('}')
            }
            is List<*> -> {
                out.append('[')
                var first = true
                for (item in value) {
                    if (!first) out.append(',')
                    first = false
                    write(item, out)
                }
                out.append(']')
            }
            else -> writeText(value.toString(), out)
        }
    }

    private fun writeText(text: String, out: StringBuilder) {
        out.append('"')
        for (c in text) {
            when (c) {
                '"' -> out.append("\\\"")
                '\\' -> out.append("\\\\")
                '\n' -> out.append("\\n")
                '\r' -> out.append("\\r")
                '\t' -> out.append("\\t")
                '\b' -> out.append("\\b")
                '' -> out.append("\\f")
                else -> if (c < ' ') out.append(String.format("\\u%04x", c.code)) else out.append(c)
            }
        }
        out.append('"')
    }

    fun getField(value: Any, key: String): Any = if (value is Map<*, *> && value.containsKey(key)) (value[key] ?: JsonNull) else JsonNull
    fun getItem(value: Any, index: Long): Any = if (value is List<*> && index >= 0 && index < value.size) (value[index.toInt()] ?: JsonNull) else JsonNull
    fun asNumber(value: Any): Double = (value as? Number)?.toDouble() ?: 0.0
    fun asText(value: Any): String = value as? String ?: ""
    fun asBoolean(value: Any): Boolean = value as? Boolean ?: false
    fun isNull(value: Any): Boolean = value === JsonNull
    fun makeObject(): Any = LinkedHashMap<String, Any>()
    @Suppress("UNCHECKED_CAST")
    fun setField(value: Any, key: String, field: Any): Any { if (value is MutableMap<*, *>) (value as MutableMap<String, Any>)[key] = field; return value }
    fun makeArray(): Any = mutableListOf<Any>()
    @Suppress("UNCHECKED_CAST")
    fun pushItem(value: Any, item: Any): Any { if (value is MutableList<*>) (value as MutableList<Any>).add(item); return value }
    fun fromText(value: String): Any = value
    fun fromNumber(value: Double): Any = value
    fun fromBoolean(value: Boolean): Any = value
    fun makeNull(): Any = JsonNull
    // the shape questions: what a parsed value is, so a reader can walk it without guessing
    fun isArray(value: Any): Boolean = value is List<*>
    fun isObject(value: Any): Boolean = value is Map<*, *>
    fun isText(value: Any): Boolean = value is String
    fun isBoolean(value: Any): Boolean = value is Boolean
    fun arraySize(value: Any): Long = ((value as? List<*>)?.size ?: 0).toLong()
    fun arrayItem(value: Any, index: Long): Any = getItem(value, index)
    fun objectKeys(value: Any): MutableList<String> = (value as? Map<*, *>)?.keys?.map { it.toString() }?.toMutableList() ?: mutableListOf()
}

// a recursive-descent reader over the text. Malformed text reads as JsonNull, the way the other shims answer.
private class JsonReader(private val text: String) {
    private var at = 0

    fun read(): Any {
        return try {
            skip()
            val value = value()
            skip()
            if (at != text.length) JsonNull else value
        } catch (e: RuntimeException) {
            JsonNull
        }
    }

    private fun skip() { while (at < text.length && text[at].isWhitespace()) at++ }

    private fun value(): Any {
        if (at >= text.length) throw RuntimeException("end")
        return when (text[at]) {
            '{' -> obj()
            '[' -> array()
            '"' -> string()
            't' -> word("true", true)
            'f' -> word("false", false)
            'n' -> word("null", JsonNull)
            else -> number()
        }
    }

    private fun word(spelling: String, value: Any): Any {
        if (!text.startsWith(spelling, at)) throw RuntimeException("word")
        at += spelling.length
        return value
    }

    private fun obj(): Any {
        val out = LinkedHashMap<String, Any>()
        at++
        skip()
        if (at < text.length && text[at] == '}') { at++; return out }
        while (true) {
            skip()
            val key = string()
            skip()
            if (at >= text.length || text[at] != ':') throw RuntimeException("colon")
            at++
            skip()
            out[key] = value()
            skip()
            if (at >= text.length) throw RuntimeException("end")
            if (text[at] == ',') { at++; continue }
            if (text[at] == '}') { at++; return out }
            throw RuntimeException("object")
        }
    }

    private fun array(): Any {
        val out = mutableListOf<Any>()
        at++
        skip()
        if (at < text.length && text[at] == ']') { at++; return out }
        while (true) {
            skip()
            out.add(value())
            skip()
            if (at >= text.length) throw RuntimeException("end")
            if (text[at] == ',') { at++; continue }
            if (text[at] == ']') { at++; return out }
            throw RuntimeException("array")
        }
    }

    private fun string(): String {
        if (at >= text.length || text[at] != '"') throw RuntimeException("quote")
        at++
        val out = StringBuilder()
        while (true) {
            if (at >= text.length) throw RuntimeException("end")
            val c = text[at++]
            when (c) {
                '"' -> return out.toString()
                '\\' -> {
                    if (at >= text.length) throw RuntimeException("end")
                    when (val e = text[at++]) {
                        '"' -> out.append('"')
                        '\\' -> out.append('\\')
                        '/' -> out.append('/')
                        'b' -> out.append('\b')
                        'f' -> out.append('')
                        'n' -> out.append('\n')
                        'r' -> out.append('\r')
                        't' -> out.append('\t')
                        'u' -> {
                            if (at + 4 > text.length) throw RuntimeException("unicode")
                            out.append(text.substring(at, at + 4).toInt(16).toChar())
                            at += 4
                        }
                        else -> throw RuntimeException("escape $e")
                    }
                }
                else -> out.append(c)
            }
        }
    }

    private fun number(): Any {
        val start = at
        if (at < text.length && text[at] == '-') at++
        while (at < text.length && (text[at].isDigit() || text[at] == '.' || text[at] == 'e' || text[at] == 'E' || text[at] == '+' || text[at] == '-')) at++
        if (start == at) throw RuntimeException("value")
        return text.substring(start, at).toDouble()
    }
}

fun loadBundle(self: CaskWindow, path: String): Unit {
    cask.loadBundle(self, path)
}

fun loadUrl(self: CaskWindow, url: String): Unit {
    cask.loadUrl(self, url)
}

fun onMessage(self: CaskWindow, handler: suspend (String) -> String): Unit {
    cask.onMessage(self, handler)
}

fun activate(self: CaskWindow): Unit {
    cask.activate(self)
}

fun run(): Unit {
    cask.run()
}

suspend fun quit(): Unit {
    cask.quit()
}

suspend fun exit(status: Long): Unit {
    cask.exit(status)
}

suspend fun bundlePath(): String {
    return cask.bundlePath()
}

suspend fun dataPath(name: String): String {
    return cask.dataPath(name)
}

fun writeLine(message: String): Unit {
    console.writeLine(message)
}

fun log(message: String): Unit {
    writeLine(message)
}

fun fieldText(value: Any, key: String): String {
    return json.asText(json.getField(value, key))
}

fun fieldNumber(value: Any, key: String): Double {
    return json.asNumber(json.getField(value, key))
}

fun isAllowed(command: String): Boolean {
    if ((command == "cask_bundle_path")) {
        return true
    } else if ((command == "cask_data_path")) {
        return true
    } else if ((command == "cask_exit")) {
        return true
    } else if ((command == "cask_quit")) {
        return true
    } else if ((command == "cask_log")) {
        return true
    } else {
        return false
    }
    throw IllegalStateException("unreachable")
}

suspend fun runCommand(command: String, arguments: Any): Any {
    var line = json.asText(json.getField(arguments, "text"))
    if ((command == "cask_bundle_path")) {
        return json.fromText(bundlePath())
    } else if ((command == "cask_data_path")) {
        return json.fromText(dataPath(fieldText(arguments, "name")))
    } else if ((command == "cask_exit")) {
        exit((fieldNumber(arguments, "status")).toLong())
        return json.makeNull()
    } else if ((command == "cask_quit")) {
        quit()
        return json.makeNull()
    } else {
        log("page: ${line}")
        return json.makeNull()
    }
    throw IllegalStateException("unreachable")
}

suspend fun dispatch(message: String): String {
    var request = json.parse(message)
    var id = json.asText(json.getField(request, "id"))
    var command = json.asText(json.getField(request, "command"))
    var reply = json.setField(json.makeObject(), "id", json.fromText(id))
    if (isAllowed(command)) {
        reply = json.setField(reply, "value", runCommand(command, json.getField(request, "arguments")))
    } else {
        reply = json.setField(reply, "exception", json.fromText("command-not-allowed"))
    }
    return json.stringify(reply)
}

fun boot(place: String, remote: Boolean): Unit {
    var made = cask.openWindow("Blog", 960L, 720L)
    onMessage(made, ::dispatch)
    if (remote) {
        loadUrl(made, place)
    } else {
        loadBundle(made, place)
    }
    activate(made)
    run()
}

class TermActivity : CaskActivity() {
  override fun program() { boot("webview", false) }
}
