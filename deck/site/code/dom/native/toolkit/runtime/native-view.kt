// The toolkit view host on Android (native-dom-0006): the dom's node contract over REAL Android views, so a Term program renders
// with no WebView and no JavaScript engine. The render runtime (site/code/view/render.tree) is Solid-style: it creates
// a node, sets a property, appends, removes. An Android View tree is retained and mutated exactly that way, so each
// call is one platform call. See note/term/app/10-native-dom.md. Reached only through ../dom.tree, whose tasks map to
// the functions of `object nativeView` below. Its Apple twin is native-view.swift beside it.
//
// What a tag becomes:
//
//   a text node            a TextView
//   button                 an android.widget.Button. Its text is its children's text; they are never added as views
//   input, textarea        an EditText, its value two-way
//   switch                 an android.widget.Switch. `aria-checked` is its state, its change is `click`
//   span a b i em strong   a horizontal LinearLayout (an inline run)
//   anything else          a vertical LinearLayout
//
// NO SHORT IMPORT OF A NAME A PROGRAM CAN DECLARE. The build hoists this file's imports to the top of the one Kotlin
// file it writes, and an explicit import outranks a class in the same package: `import android.view.View` made every
// Term `view` (emitted as `class View`) mean Android's. So `android.view.View` is written out in full.
//
// ANDROID OWNS THE PROCESS, as in the cask runtime: the system makes the Activity, and a View needs its Context, so the
// build emits a `TermActivity` extending `TermViewActivity` whose `program()` runs the Term program INSIDE `onCreate`,
// after the context is known. Everything runs on the main thread, where the Activity's callbacks and every click are.
import android.app.Activity
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.Editable
import android.text.TextWatcher
import android.util.Log
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import java.io.File
import java.io.FileOutputStream

// the log tag every line goes under, so `adb logcat -s native-dom` reads them
private const val VIEW_TAG = "native-dom"

private val INLINE_TAGS = setOf("span", "a", "b", "i", "em", "strong", "small", "code", "label", "abbr", "kbd")

private val viewMain = Handler(Looper.getMainLooper())

// one node of the tree: the platform view, plus what the dom contract can ask that a view does not hold itself
class TermNode(val key: Long, val tag: String, var text: String, context: Activity) {
    // RANGE is face's slider on Android, a SeekBar, and CHOICE its select, a Spinner (native-dom-0026)
    // SHEET is face's dialog: a column of content an android.app.Dialog shows, never placed in the page (0026)
    enum class Kind { TEXT, CONTAINER, BUTTON, FIELD, TOGGLE, RANGE, CHOICE, SHEET }

    val kind: Kind = when {
        tag.isEmpty() -> Kind.TEXT
        tag == "button" -> Kind.BUTTON
        tag == "switch" -> Kind.TOGGLE
        tag == "slider" -> Kind.RANGE
        tag == "choice" -> Kind.CHOICE
        tag == "sheet" -> Kind.SHEET
        tag == "input" || tag == "textarea" -> Kind.FIELD
        else -> Kind.CONTAINER
    }

    val view: android.view.View = when (kind) {
        Kind.TEXT -> TextView(context).also {
            it.text = text
            it.textSize = 17f
            it.setTextColor(Color.BLACK)
        }
        Kind.BUTTON -> Button(context).also { it.isAllCaps = false }
        Kind.FIELD -> EditText(context)
        Kind.TOGGLE -> android.widget.Switch(context)
        // a SeekBar counts whole steps from zero; the node keeps min and step and maps the two (see `rangeOf`)
        Kind.RANGE -> android.widget.SeekBar(context).also { it.max = 100 }
        Kind.CHOICE -> android.widget.Spinner(context)
        Kind.SHEET -> LinearLayout(context).also {
            it.orientation = LinearLayout.VERTICAL
            val pad = (24 * context.resources.displayMetrics.density).toInt()
            it.setPadding(pad, pad, pad, pad)
        }
        Kind.CONTAINER -> LinearLayout(context).also {
            it.orientation = if (tag in INLINE_TAGS) LinearLayout.HORIZONTAL else LinearLayout.VERTICAL
        }
    }

    var value = ""
    val attributes = mutableListOf<Pair<String, String>>()
    val styles = mutableMapOf<String, String>()
    val classes = mutableListOf<String>()
    val children = mutableListOf<TermNode>()
    var parent: TermNode? = null
    val listeners = mutableListOf<Pair<String, () -> Unit>>()
    var clickInstalled = false
    var watchInstalled = false
    // a Spinner selection made from code is in flight, so the report it sends is not the person's
    var settingChoice = false
    // the platform's dialog showing a SHEET's content, made the first time it opens
    var dialog: android.app.Dialog? = null
    // the weighted empty views `justify-content: space-between` puts between children
    val spacers = mutableListOf<android.view.View>()

    // the text under this node, in order: what a button shows
    val textContent: String
        get() = if (kind == Kind.TEXT) text else children.joinToString("") { it.textContent }

    // this node or the nearest above whose children are drawn by the node itself rather than added as views
    val drawingAncestor: TermNode?
        get() {
            var at: TermNode? = this
            while (at != null) {
                if (at.kind == Kind.BUTTON) return at
                at = at.parent
            }
            return null
        }

    fun fire(event: String) {
        for ((name, run) in listeners.toList()) {
            if (name == event) run()
        }
    }

    fun refreshTitle() {
        if (kind == Kind.BUTTON) (view as Button).text = textContent
    }
}

// the Activity the build emits `TermActivity` from: it runs the Term program once the context exists
abstract class TermViewActivity : Activity() {
    abstract fun program()

    override fun onCreate(saved: Bundle?) {
        super.onCreate(saved)
        nativeView.activity = this
        program()
        for (body in nativeView.afterLaunch) viewMain.post(body)
        nativeView.afterLaunch.clear()
    }

    // the manifest declares the device's trait changes as handled, so the Activity stays and says so here instead
    override fun onConfigurationChanged(config: Configuration) {
        super.onConfigurationChanged(config)
        for (body in nativeView.configurationChanged.toList()) body()
    }
}

object nativeView {
    var activity: Activity? = null
    var root: TermNode? = null
    internal val afterLaunch = mutableListOf<() -> Unit>()
    // called on every configuration change the Activity handles (view/native/toolkit/runtime/native-device.kt)
    val configurationChanged = mutableListOf<() -> Unit>()
    private var nextKey = 0L

    private fun context(): Activity = activity ?: error("nativeView: no Activity yet. A program runs inside TermActivity.program()")

    // the handle Term holds is `Any`, so every entry point takes `Any` and reads the node out of it
    private fun node(handle: Any): TermNode = handle as? TermNode ?: error("nativeView: not a node: $handle")

    private fun make(tag: String, text: String): TermNode {
        nextKey += 1
        return TermNode(nextKey, tag, text, context())
    }

    fun createElement(tag: String): Any = make(tag, "")

    fun createText(value: String): Any = make("", value)

    fun setText(handle: Any, value: String) {
        val node = node(handle)
        node.text = value
        (node.view as? TextView)?.takeIf { node.kind == TermNode.Kind.TEXT }?.text = value
        node.drawingAncestor?.refreshTitle()
    }

    fun setAttribute(handle: Any, name: String, value: String) {
        val node = node(handle)
        node.attributes.removeAll { it.first == name }
        node.attributes.add(name to value)
        when (name) {
            "style" -> for (declaration in value.split(";")) {
                val parts = declaration.split(":", limit = 2).map { it.trim() }
                if (parts.size == 2 && parts[0].isNotEmpty()) setStyle(node, parts[0], parts[1])
            }
            "placeholder" -> (node.view as? EditText)?.hint = value
            "aria-label" -> node.view.contentDescription = value
            "disabled" -> node.view.isEnabled = value == "false"
            "aria-checked" -> (node.view as? android.widget.Switch)?.isChecked = value == "true"
            "min", "max", "step" -> if (node.kind == TermNode.Kind.RANGE) {
                // the bar's length in steps follows the range; the position is kept, in the range's own numbers
                val held = rangeValue(node)
                (node.view as android.widget.SeekBar).max = rangeOf(node).steps
                setValue(node, held)
            }
            "value" -> if (node.kind == TermNode.Kind.RANGE) setValue(node, value)
            "options" -> if (node.kind == TermNode.Kind.CHOICE) setChoices(node, value.split("\n").filter { it.isNotEmpty() })
            "open" -> if (node.kind == TermNode.Kind.SHEET) {
                if (value == "true") present(node) else node.dialog?.takeIf { it.isShowing }?.dismiss()
            }
            "title" -> if (node.kind == TermNode.Kind.SHEET) node.dialog?.setTitle(value)
        }
    }

    // ---- the dialog (native-dom-0026): an android.app.Dialog shows the sheet's content ----

    private fun present(node: TermNode) {
        val dialog = node.dialog ?: android.app.Dialog(context()).also { made ->
            made.setContentView(node.view)
            // back, or a tap outside: the person's own dismissal, reported as `close`
            made.setOnCancelListener { node.fire("close") }
            node.dialog = made
        }
        dialog.setTitle(node.attributes.firstOrNull { it.first == "title" }?.second ?: "")
        if (!dialog.isShowing) dialog.show()
    }

    // run `body` once the platform has had its turn: a Dialog shows and hides on the main looper, after the code that
    // asked has returned
    fun later(body: () -> Unit) {
        viewMain.postDelayed(body, 600)
    }

    // for tests: dismiss the dialog the way a person does. Back and a tap outside take `cancel`, whose listener the
    // Dialog runs LATER, through the main looper, so a test reading straight after would see it still open: the
    // presentation is ended as `cancel` ends it, and the report the listener sends is sent now. The listener itself
    // (`present`) is what a person's back press reaches
    fun dismiss(handle: Any) {
        val node = node(handle)
        node.dialog?.takeIf { it.isShowing }?.dismiss()
        node.fire("close")
    }

    // ---- the select (native-dom-0026): a Spinner, its items the options, the chosen one its value ----

    private fun spinnerOf(node: TermNode): android.widget.Spinner = node.view as android.widget.Spinner

    private fun choicesOf(node: TermNode): List<String> {
        val adapter = spinnerOf(node).adapter ?: return emptyList()
        return (0 until adapter.count).map { adapter.getItem(it).toString() }
    }

    private fun setChoices(node: TermNode, choices: List<String>) {
        val held = choiceValue(node)
        val adapter = android.widget.ArrayAdapter(context(), android.R.layout.simple_spinner_item, choices)
        adapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
        spinnerOf(node).adapter = adapter
        if (held.isNotEmpty()) setChoice(node, held)
    }

    private fun setChoice(node: TermNode, value: String) {
        val index = choicesOf(node).indexOf(value)
        // `false`: not animated, and the spinner's listener knows a selection made here is not the person's
        // only a selection that changes sends a report, so only that one raises the flag: one raised for nothing would
        // swallow the person's next choice
        if (index >= 0 && index != spinnerOf(node).selectedItemPosition) {
            node.settingChoice = true
            spinnerOf(node).setSelection(index, false)
        }
    }

    private fun choiceValue(node: TermNode): String = spinnerOf(node).selectedItem?.toString() ?: ""

    // for tests: choose an item the way a person does. The Spinner's dropdown cannot be tapped from code, so the
    // selection is made as the dropdown makes it, and the report it sends is sent
    fun choose(handle: Any, value: String) {
        val node = node(handle)
        setChoice(node, value)
        node.fire("change")
    }

    // a slider's range in the SeekBar's terms: whole steps from `min`, `steps` of them to `max`
    private data class Range(val min: Double, val step: Double, val steps: Int)

    private fun rangeOf(node: TermNode): Range {
        fun number(name: String, fallback: Double) =
            node.attributes.firstOrNull { it.first == name }?.second?.toDoubleOrNull() ?: fallback
        val min = number("min", 0.0)
        val max = number("max", 100.0)
        val step = number("step", 1.0).takeIf { it > 0 } ?: 1.0
        return Range(min, step, Math.max(1, Math.round((max - min) / step).toInt()))
    }

    // the position as a web range input reports it: `40`, never `40.0`
    private fun rangeValue(node: TermNode): String {
        val range = rangeOf(node)
        val value = range.min + (node.view as android.widget.SeekBar).progress * range.step
        val tidy = Math.round(value * 1_000_000) / 1_000_000.0
        return if (tidy == Math.floor(tidy)) tidy.toLong().toString() else tidy.toString()
    }

    fun getAttribute(handle: Any, name: String): String = node(handle).attributes.firstOrNull { it.first == name }?.second ?: ""

    // ---- layout (native-dom-0007): the layout model mapped onto LinearLayout, no solver of ours. The same words as
    // the Apple host (native-view.swift): flex-direction, gap, align-items, justify-content start | space-between,
    // padding, width, height, flex-grow, and `display: flex` accepted as what every container already is. A LinearLayout
    // has no gap, so a gap is the leading margin of every child after the first, kept right as children come and go.
    // Lengths are CSS pixels, which are Android's dp. Anything else is recorded in `unsupported`, never dropped silently

    val unsupported = sortedSetOf<String>()

    private fun dp(value: String): Int? =
        value.trim().removeSuffix("px").toDoubleOrNull()?.let { (it * context().resources.displayMetrics.density).toInt() }

    fun setStyle(handle: Any, property: String, raw: String) {
        val node = node(handle)
        node.styles[property] = raw
        val value = raw.trim()
        val layout = node.view as? LinearLayout
        val ok: Boolean = when {
            property == "display" && (value == "flex" || value == "block") -> {
                // `display: flex` is a ROW in CSS until a `flex-direction` says otherwise (native-dom-0037)
                if (value == "flex" && layout != null && node.styles["flex-direction"] == null) {
                    layout.orientation = LinearLayout.HORIZONTAL
                    applyAlignment(node)
                    applyGap(node)
                }
                true
            }
            property == "flex-direction" && layout != null -> {
                layout.orientation = if (value.startsWith("row")) LinearLayout.HORIZONTAL else LinearLayout.VERTICAL
                applyAlignment(node)
                applyGap(node)
                true
            }
            property == "gap" && layout != null && dp(value) != null -> {
                applyGap(node)
                true
            }
            property == "align-items" && layout != null && value in setOf("start", "flex-start", "center", "end", "flex-end", "stretch") -> {
                applyAlignment(node)
                true
            }
            property == "justify-content" && layout != null && value in setOf("start", "flex-start", "space-between") -> {
                applySpread(node)
                true
            }
            property == "padding" && dp(value) != null -> {
                val inset = dp(value)!!
                node.view.setPadding(inset, inset, inset, inset)
                true
            }
            (property == "width" || property == "height") && dp(value) != null -> {
                val params = node.view.layoutParams ?: ViewGroup.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
                if (property == "width") params.width = dp(value)!! else params.height = dp(value)!!
                node.view.layoutParams = params
                true
            }
            property == "flex-grow" && (value.toDoubleOrNull() ?: 0.0) > 0 -> {
                node.parent?.let { applySpread(it) }
                true
            }
            else -> false
        }
        if (!ok) unsupported.add("$property: $value")
    }

    // `align-items`: where children sit across the axis. Gravity for start, center and end; MATCH_PARENT for stretch
    private fun applyAlignment(node: TermNode) {
        val layout = node.view as? LinearLayout ?: return
        val row = layout.orientation == LinearLayout.HORIZONTAL
        val declared = node.styles["align-items"]?.trim()
        val align = declared ?: "start"
        layout.gravity = when (align) {
            "center" -> if (row) android.view.Gravity.CENTER_VERTICAL else android.view.Gravity.CENTER_HORIZONTAL
            "end", "flex-end" -> if (row) android.view.Gravity.BOTTOM else android.view.Gravity.END
            else -> if (row) android.view.Gravity.TOP else android.view.Gravity.START
        }
        for (child in node.children) {
            val params = child.view.layoutParams as? LinearLayout.LayoutParams ?: continue
            // the cross axis, by CSS's rules (native-dom-0027, 0037): a size the child declared wins, an explicit
            // `align-items` decides by itself, a FLEX column stretches every child (CSS's default is `stretch`), and a
            // BLOCK container's block-level children fill its width while inline ones and controls keep their size
            val cross = if (row) "height" else "width"
            val fills = when {
                declared != null -> declared == "stretch"
                node.styles["display"]?.trim() == "flex" -> !row
                else -> !row && child.kind == TermNode.Kind.CONTAINER && child.tag !in INLINE_TAGS
            }
            val size = if (child.styles[cross]?.let { dp(it) } != null) sizeOf(child, cross)
                else if (fills) ViewGroup.LayoutParams.MATCH_PARENT
                else ViewGroup.LayoutParams.WRAP_CONTENT
            if (row) params.height = size else params.width = size
            child.view.layoutParams = params
        }
    }

    // a node's own `width` or `height` in pixels, or WRAP_CONTENT when it declared none
    private fun sizeOf(node: TermNode, property: String): Int =
        node.styles[property]?.let { dp(it) } ?: ViewGroup.LayoutParams.WRAP_CONTENT

    // `gap`: the leading margin of every installed child after the first, along the axis
    private fun applyGap(node: TermNode) {
        val layout = node.view as? LinearLayout ?: return
        val gap = node.styles["gap"]?.let { dp(it) } ?: 0
        val row = layout.orientation == LinearLayout.HORIZONTAL
        val installed = node.children.filter { it.view.parent === layout }
        installed.forEachIndexed { index, child ->
            val params = child.view.layoutParams as? LinearLayout.LayoutParams ?: return@forEachIndexed
            val lead = if (index == 0) 0 else gap
            if (row) params.setMargins(lead, 0, 0, 0) else params.setMargins(0, lead, 0, 0)
            child.view.layoutParams = params
        }
    }

    // `flex-grow` on children and `space-between` on the container, both as layout weights along the axis
    private fun applySpread(node: TermNode) {
        val layout = node.view as? LinearLayout ?: return
        val row = layout.orientation == LinearLayout.HORIZONTAL
        val between = node.styles["justify-content"]?.trim() == "space-between"
        val installed = node.children.filter { it.view.parent === layout }
        installed.forEach { child ->
            val params = child.view.layoutParams as? LinearLayout.LayoutParams ?: return@forEach
            val grow = child.styles["flex-grow"]?.trim()?.toFloatOrNull() ?: 0f
            params.weight = if (grow > 0) grow else 0f
            if (grow > 0) {
                if (row) params.width = 0 else params.height = 0
            }
            child.view.layoutParams = params
        }
        // space-between: a weighted empty view between each pair pushes them apart, LinearLayout's own way to spread
        if (between && installed.size > 1 && node.spacers.isEmpty()) {
            for (index in installed.size - 1 downTo 1) {
                val spacer = android.view.View(context())
                node.spacers.add(spacer)
                layout.addView(spacer, layout.indexOfChild(installed[index].view), LinearLayout.LayoutParams(if (row) 0 else 1, if (row) 1 else 0, 1f))
            }
        }
    }

    // a child joins its parent with the parent's layout already applied: wrapped in both directions unless stretched,
    // and the gap and spread recomputed, so web and native agree that a button is as wide as its label
    private fun adopt(parent: TermNode) {
        applyAlignment(parent)
        applyGap(parent)
        if (parent.styles["justify-content"] != null || parent.children.any { it.styles["flex-grow"] != null }) applySpread(parent)
    }

    fun unsupportedStyles(): String = unsupported.joinToString("\n")

    // where a node is drawn, in dp from the root's origin: `x,y,width,height`, what a layout test reads
    fun frameOf(handle: Any): String {
        val node = node(handle)
        val root = root?.view ?: return "0,0,0,0"
        // laid out now, at the screen's size: a read before Android's first layout pass found every frame at zero
        layoutNow(root)
        val density = context().resources.displayMetrics.density
        // the offset from the root, summed up the parents: getLocationInWindow answered zero before the window's
        // own first pass, while the left and top a layout assigns are there at once
        var x = 0
        var y = 0
        var at: android.view.View? = node.view
        while (at != null && at !== root) {
            x += at.left
            y += at.top
            at = at.parent as? android.view.View
        }
        return listOf(x, y, node.view.width, node.view.height)
            .joinToString(",") { Math.round(it / density).toString() }
    }

    fun addClass(handle: Any, name: String) {
        val node = node(handle)
        if (name !in node.classes) node.classes.add(name)
    }

    fun removeClass(handle: Any, name: String) {
        node(handle).classes.remove(name)
    }

    fun focus(handle: Any) {
        node(handle).view.requestFocus()
    }

    fun blur(handle: Any) {
        node(handle).view.clearFocus()
    }

    fun listen(handle: Any, event: String, handler: () -> Unit) {
        val node = node(handle)
        node.listeners.add(event to handler)
        if (event == "click" && !node.clickInstalled) {
            node.clickInstalled = true
            node.view.setOnClickListener { node.fire("click") }
        }
        // the spinner reports a choice the person made as `change`. It also reports every selection made from code,
        // the first one included, so those are told apart by the flag `setChoice` raises
        if (event == "change" && node.kind == TermNode.Kind.CHOICE && !node.watchInstalled) {
            node.watchInstalled = true
            spinnerOf(node).onItemSelectedListener = object : android.widget.AdapterView.OnItemSelectedListener {
                override fun onItemSelected(parent: android.widget.AdapterView<*>?, view: android.view.View?, position: Int, id: Long) {
                    if (node.settingChoice) node.settingChoice = false else node.fire("change")
                }
                override fun onNothingSelected(parent: android.widget.AdapterView<*>?) {}
            }
        }
        // the slider reports a move the person made as `input`, the event a web range input fires while dragged
        if (event == "input" && node.kind == TermNode.Kind.RANGE && !node.watchInstalled) {
            node.watchInstalled = true
            (node.view as android.widget.SeekBar).setOnSeekBarChangeListener(object : android.widget.SeekBar.OnSeekBarChangeListener {
                override fun onProgressChanged(bar: android.widget.SeekBar?, progress: Int, fromUser: Boolean) {
                    if (fromUser) node.fire("input")
                }
                override fun onStartTrackingTouch(bar: android.widget.SeekBar?) {}
                override fun onStopTrackingTouch(bar: android.widget.SeekBar?) {}
            })
        }
        if (event == "input" && node.kind == TermNode.Kind.FIELD && !node.watchInstalled) {
            node.watchInstalled = true
            (node.view as EditText).addTextChangedListener(object : TextWatcher {
                override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
                override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
                override fun afterTextChanged(s: Editable?) {
                    node.value = s?.toString() ?: ""
                    node.fire("input")
                }
            })
        }
    }

    // DOM semantics: a node has one parent, so appending one that already has a parent moves it
    fun append(parentHandle: Any, childHandle: Any) {
        val parent = node(parentHandle)
        val child = node(childHandle)
        detach(child)
        child.parent = parent
        parent.children.add(child)
        val drawing = parent.drawingAncestor
        if (drawing != null) {
            drawing.refreshTitle()
        } else if (child.kind == TermNode.Kind.SHEET) {
            // a dialog's content is never in the page: its dialog shows it when it opens
            return
        } else if (parent.view is LinearLayout) {
            // wrapped, not stretched: LinearLayout's default made a vertical stack's children as wide as the stack. A
            // `width` or `height` the child declared is kept: these params replace whatever it was given before it
            // had a parent, which is where a style attribute set it (native-dom-0027)
            (parent.view as LinearLayout).addView(
                child.view,
                LinearLayout.LayoutParams(sizeOf(child, "width"), sizeOf(child, "height")),
            )
            adopt(parent)
        } else {
            (parent.view as? ViewGroup)?.addView(child.view)
        }
    }

    fun remove(handle: Any) {
        detach(node(handle))
    }

    private fun detach(child: TermNode) {
        val parent = child.parent ?: return
        parent.children.remove(child)
        child.parent = null
        (child.view.parent as? ViewGroup)?.removeView(child.view)
        parent.drawingAncestor?.refreshTitle()
    }

    // `new` takes `old`'s place under the same parent, at the same position
    fun replace(oldHandle: Any, newHandle: Any) {
        val old = node(oldHandle)
        val fresh = node(newHandle)
        detach(fresh)
        val parent = old.parent ?: return
        val index = parent.children.indexOf(old)
        if (index < 0) return
        val group = parent.view as? ViewGroup
        // the position among the views actually added, which is the group's own index
        val installedBefore = parent.children.subList(0, index).count { it.view.parent === group }
        parent.children[index] = fresh
        fresh.parent = parent
        old.parent = null
        (old.view.parent as? ViewGroup)?.removeView(old.view)
        val drawing = parent.drawingAncestor
        if (drawing != null) {
            drawing.refreshTitle()
        } else {
            group?.addView(
                fresh.view,
                installedBefore,
                LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT),
            )
            adopt(parent)
        }
    }

    fun clear(handle: Any) {
        val node = node(handle)
        for (child in node.children) {
            child.parent = null
            (child.view.parent as? ViewGroup)?.removeView(child.view)
        }
        node.children.clear()
        node.drawingAncestor?.refreshTitle()
    }

    fun childCount(handle: Any): Long = node(handle).children.size.toLong()

    fun getValue(handle: Any): String {
        val node = node(handle)
        return when (node.kind) {
            TermNode.Kind.FIELD -> (node.view as EditText).text.toString()
            TermNode.Kind.RANGE -> rangeValue(node)
            TermNode.Kind.CHOICE -> choiceValue(node)
            else -> node.value
        }
    }

    fun setValue(handle: Any, value: String) {
        val node = node(handle)
        node.value = value
        // a field that already holds the text is left alone: setText moves the cursor and ends an input method's
        // composition, and the face input writes its signal back after every keystroke (native-dom-0026)
        if (node.kind == TermNode.Kind.FIELD && (node.view as EditText).text.toString() != value) (node.view as EditText).setText(value)
        if (node.kind == TermNode.Kind.CHOICE) setChoice(node, value)
        if (node.kind == TermNode.Kind.RANGE) {
            val range = rangeOf(node)
            val number = value.toDoubleOrNull() ?: return
            (node.view as android.widget.SeekBar).progress = Math.round((number - range.min) / range.step).toInt()
        }
    }

    // for tests: type into a field the way a person does. EditText's own watcher reports the edit, as it would a key
    fun type(handle: Any, text: String) {
        val node = node(handle)
        (node.view as? EditText)?.setText(text)
    }

    // for tests: move a slider the way a finger does. A SeekBar reports a programmatic move as not from the user, so
    // the listener's own `fromUser` path is taken by firing what it would fire
    fun slide(handle: Any, value: String) {
        val node = node(handle)
        setValue(node, value)
        node.fire("input")
    }

    fun measureWidth(handle: Any): Long = node(handle).view.width.toLong()

    // ---- the app around the tree ----

    // the Activity's content: a root container to mount the program into
    fun openRoot(title: String, width: Long, height: Long): Any {
        val root = make("main", "")
        val layout = root.view as LinearLayout
        val pad = (24 * context().resources.displayMetrics.density).toInt()
        layout.setPadding(pad, pad * 3, pad, pad)
        layout.setBackgroundColor(Color.WHITE)
        context().title = title
        context().setContentView(layout)
        this.root = root
        return root
    }

    // run `body` once `onCreate` has returned and the content is set
    fun afterLaunch(body: () -> Unit) {
        afterLaunch.add(body)
    }

    fun show() {}

    // Android runs the process; there is no loop to hand it
    fun run() {}

    fun exit(status: Long) {
        Log.i(VIEW_TAG, "native-view exit $status")
        context().finishAndRemoveTask()
        viewMain.postDelayed({ kotlin.system.exitProcess(status.toInt()) }, 200)
    }

    // ---- what a test, or a person, does to the tree and sees of it ----

    fun childAt(handle: Any, index: Long): Any = node(handle).children[index.toInt()]

    fun say(text: String) {
        Log.i(VIEW_TAG, text)
    }

    // press a control the platform's own way: performClick runs its click listener and plays its sound
    fun press(handle: Any) {
        val node = node(handle)
        if (!node.view.performClick()) node.fire("click")
    }

    // the tree as HTML, READ BACK FROM THE VIEWS: a button's text is what the Button holds, a label's is its TextView's
    fun serialize(handle: Any): String {
        val node = node(handle)
        return when (node.kind) {
            TermNode.Kind.TEXT -> (node.view as TextView).text.toString()
            TermNode.Kind.BUTTON -> "<button>${(node.view as Button).text}</button>"
            TermNode.Kind.FIELD -> "<${node.tag} value=\"${getValue(node)}\"></${node.tag}>"
            TermNode.Kind.TOGGLE -> "<switch checked=\"${(node.view as android.widget.Switch).isChecked}\"></switch>"
            TermNode.Kind.RANGE -> "<slider value=\"${rangeValue(node)}\"></slider>"
            TermNode.Kind.CHOICE -> "<select value=\"${choiceValue(node)}\"></select>"
            TermNode.Kind.SHEET -> {
                val group = node.view as ViewGroup
                val installed = node.children.filter { it.view.parent === group }
                "<sheet open=\"${node.dialog?.isShowing == true}\">${installed.joinToString("") { serialize(it) }}</sheet>"
            }
            TermNode.Kind.CONTAINER -> {
                val group = node.view as ViewGroup
                val installed = node.children.filter { it.view.parent === group }
                "<${node.tag}>${installed.joinToString("") { serialize(it) }}</${node.tag}>"
            }
        }
    }

    // a PNG of the content, laid out at the screen's size first, so it is right even before the next frame. A path
    // that is not absolute lands in the app's own EXTERNAL files directory (/sdcard/Android/data/<id>/files), which
    // `adb` reads with no permission, where the private one needs a debuggable build for `run-as`
    // measure and lay out the content at the screen's size, so frames and pixels are right before the next frame
    private fun layoutNow(view: android.view.View) {
        val metrics = context().resources.displayMetrics
        view.measure(
            android.view.View.MeasureSpec.makeMeasureSpec(metrics.widthPixels, android.view.View.MeasureSpec.EXACTLY),
            android.view.View.MeasureSpec.makeMeasureSpec(metrics.heightPixels, android.view.View.MeasureSpec.EXACTLY),
        )
        view.layout(0, 0, metrics.widthPixels, metrics.heightPixels)
    }

    fun snapshot(path: String) {
        val view = root?.view ?: return
        val metrics = context().resources.displayMetrics
        layoutNow(view)
        val bitmap = Bitmap.createBitmap(metrics.widthPixels, metrics.heightPixels, Bitmap.Config.ARGB_8888)
        view.draw(Canvas(bitmap))
        val file = if (path.startsWith("/")) File(path) else File(context().getExternalFilesDir(null) ?: context().filesDir, path)
        FileOutputStream(file).use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
}
