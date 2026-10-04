// The toolkit view host on Compose (compose-target-0001): the dom's node contract over REAL Compose, so a Term program
// renders with no WebView and no JavaScript engine, on the desktop through Compose Multiplatform (Skia) and, with the
// same composables, on Android through Jetpack Compose. The render runtime (site/code/view/render.tree) is Solid-style
// and retained: it creates a node, sets a property, appends, removes (reactive-bridge-0002). Compose is declarative, so
// the retained tree is kept HERE, as snapshot state, and one composable, `CxNode`, draws each node from it. A call
// from Term writes the state, and Compose recomposes exactly the nodes that read it. Reached through
// ../../toolkit/dom.tree, whose tasks map to the functions of `object nativeView` below: the same functions, with the
// same answers, as its Android twin ../../toolkit/runtime/native-view.kt, so a program and its tests do not change.
//
// What a tag becomes:
//
//   a text node            Text
//   button                 Button. Its text is its children's text; they are never drawn as nodes of their own
//   input, textarea        TextField, its value two-way
//   switch                 Switch. `aria-checked` is its state, its change is `click`
//   slider                 Slider over `min`, `max` and `step`, its move `input`
//   choice                 a button showing the value and a DropdownMenu of `options`, its pick `change`
//   sheet                  Dialog, shown while `open` is true, its dismissal `close`
//   img                    Image, `src` a `data:` URI or a path, `alt` its content description
//   hr                     Divider, vertical in a row
//   scroll                 a Column that scrolls vertically
//   span a b i em strong   a Row (an inline run)
//   anything else          a Column, or a Row under `flex-direction: row`
//
// READ BACK FROM WHAT COMPOSE DREW. Every node carries a test tag, `term-<key>`, and `serialize`, `frame-of` and
// `accessibility-of` read Compose's SEMANTICS tree, the one accessibility services and Compose's own UI tests read, never
// this file's own state: a button's text is the text its semantics merge, a switch's state is its toggleable state, a
// field's value its editable text. A state written here and never drawn would read back wrong, which is the point.
//
// THIS FILE IS THE SAME ON EVERY PLATFORM. What differs (running the app, finding a node's semantics, injecting a
// click, a text edit, a slider move or a key, the density, a snapshot, decoding a picture, logging, exiting) is one
// `object composeHost`, in ./host-desktop.kt for Compose Multiplatform on the JVM and ./host-android.kt for Jetpack
// Compose. The build reads this file and then the platform's host as one runtime (test/compile/shared/compose-build.ts).
//
// EVERY COMPOSE NAME IS IMPORTED UNDER A `Cx` ALIAS. The build hoists these imports to the top of the one Kotlin file it
// writes, and an explicit import outranks a class in the same package: a Term `text` or `range` form is emitted as a
// class `Text` or `Range`, and a short import of Compose's would capture it. State is read and written through `.value`,
// never a `by` delegate, for the same reason: the program declares its own `getValue` and `setValue`.
//
// Not on Compose yet, each failing by name rather than doing nothing: composed input (`compose`, `commit-composition`,
// `composing-text`), registered fonts, the style table (`use-styles`, classes as styles), missing glyphs.
import androidx.compose.foundation.ScrollState as CxScrollState
import androidx.compose.foundation.layout.Arrangement as CxArrangement
import androidx.compose.foundation.layout.Box as CxBox
import androidx.compose.foundation.layout.Column as CxColumn
import androidx.compose.foundation.layout.Row as CxRow
import androidx.compose.foundation.layout.fillMaxHeight as cxFillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth as cxFillMaxWidth
import androidx.compose.foundation.layout.height as cxHeight
import androidx.compose.foundation.layout.heightIn as cxHeightIn
import androidx.compose.foundation.layout.widthIn as cxWidthIn
import androidx.compose.foundation.layout.wrapContentHeight as cxWrapContentHeight
import androidx.compose.foundation.layout.wrapContentWidth as cxWrapContentWidth
import androidx.compose.foundation.layout.padding as cxPadding
import androidx.compose.foundation.layout.width as cxWidth
import androidx.compose.foundation.focusable as cxFocusable
import androidx.compose.foundation.verticalScroll as cxVerticalScroll
import androidx.compose.ui.focus.FocusRequester as CxFocusRequester
import androidx.compose.ui.focus.focusRequester as cxFocusRequester
import androidx.compose.ui.input.key.Key as CxKey
import androidx.compose.ui.input.key.KeyEventType as CxKeyEventType
import androidx.compose.ui.input.key.key as cxKey
import androidx.compose.ui.input.key.onPreviewKeyEvent as cxOnPreviewKeyEvent
import androidx.compose.ui.input.key.type as cxType
import androidx.compose.material.Button as CxButton
import androidx.compose.material.Divider as CxDivider
import androidx.compose.material.DropdownMenu as CxDropdownMenu
import androidx.compose.material.DropdownMenuItem as CxDropdownMenuItem
import androidx.compose.material.Slider as CxSlider
import androidx.compose.material.Switch as CxSwitch
import androidx.compose.material.Text as CxText
import androidx.compose.material.TextField as CxTextField
import androidx.compose.runtime.Composable as CxComposable
import androidx.compose.runtime.MutableState as CxMutableState
import androidx.compose.runtime.mutableStateListOf as cxStateList
import androidx.compose.runtime.mutableStateOf as cxState
import androidx.compose.runtime.remember as cxRemember
import androidx.compose.ui.Alignment as CxAlignment
import androidx.compose.ui.Modifier as CxModifier
import androidx.compose.ui.graphics.Color as CxColor
import androidx.compose.ui.platform.testTag as cxTestTag
import androidx.compose.ui.semantics.SemanticsNode as CxSemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties as CxSemanticsProperties
import androidx.compose.ui.semantics.contentDescription as cxContentDescription
import androidx.compose.ui.semantics.getOrNull as cxGetOrNull
import androidx.compose.ui.semantics.heading as cxHeading
import androidx.compose.ui.semantics.invisibleToUser as cxInvisibleToUser
import androidx.compose.ui.semantics.semantics as cxSemantics
import androidx.compose.ui.state.ToggleableState as CxToggleableState
import androidx.compose.ui.unit.dp as cxDp
import androidx.compose.ui.unit.sp as cxSp
import androidx.compose.ui.window.Dialog as CxDialog
import kotlin.coroutines.startCoroutine as cxStartCoroutine

private val COMPOSE_INLINE_TAGS = setOf("span", "a", "b", "i", "em", "strong", "small", "code", "label", "abbr", "kbd")

// the families every platform can draw without registering one
private val COMPOSE_GENERIC_FAMILIES = setOf("", "system-ui", "sans-serif", "serif", "monospace")

// one node of the tree, as snapshot state: every field a composable reads is a MutableState or a state list, so a write
// from Term recomposes exactly the nodes that read it
class TermNode(val key: Long, val tag: String, text: String) {
    enum class Kind { TEXT, CONTAINER, BUTTON, FIELD, TOGGLE, RANGE, CHOICE, SHEET, IMAGE, DIVIDER, SCROLL }

    val kind: Kind = when {
        tag.isEmpty() -> Kind.TEXT
        tag == "button" -> Kind.BUTTON
        tag == "switch" -> Kind.TOGGLE
        tag == "slider" -> Kind.RANGE
        tag == "choice" -> Kind.CHOICE
        tag == "sheet" -> Kind.SHEET
        tag == "input" || tag == "textarea" -> Kind.FIELD
        tag == "img" -> Kind.IMAGE
        tag == "hr" -> Kind.DIVIDER
        tag == "scroll" -> Kind.SCROLL
        else -> Kind.CONTAINER
    }

    val text: CxMutableState<String> = cxState(text)
    val value: CxMutableState<String> = cxState("")
    // attributes and styles in the order they were set, each one state, so a composable reading one is told of a change
    val attributes = cxStateList<Pair<String, String>>()
    val styles = cxStateList<Pair<String, String>>()
    val children = cxStateList<TermNode>()
    val classes = mutableListOf<String>()
    var parent: TermNode? = null
    val listeners = mutableListOf<Pair<String, () -> Unit>>()
    // whether a choice's menu is showing
    val expanded: CxMutableState<Boolean> = cxState(false)
    // an image's decoded picture
    val picture: CxMutableState<androidx.compose.ui.graphics.ImageBitmap?> = cxState(null)

    val testTag: String get() = "term-$key"

    // the text under this node, in order: what a button shows
    val textContent: String
        get() = if (kind == Kind.TEXT) text.value else children.joinToString("") { it.textContent }

    fun attribute(name: String): String = attributes.firstOrNull { it.first == name }?.second ?: ""

    fun style(name: String): String = styles.firstOrNull { it.first == name }?.second ?: ""

    fun fire(event: String) {
        for ((name, run) in listeners.toList()) {
            if (name == event) run()
        }
    }
}

object nativeView {
    var root: TermNode? = null
    private var title = ""
    private var width = 800
    private var height = 600
    private val afterLaunch = mutableListOf<() -> Unit>()
    private var backHandler: (() -> Boolean)? = null
    private var nextKey = 0L

    private fun node(handle: Any): TermNode = handle as? TermNode ?: error("nativeView: not a node: $handle")

    // every node made, held weakly, so a test can count the ones still alive (reactive-bridge-0005)
    private val made = mutableListOf<java.lang.ref.WeakReference<TermNode>>()

    private fun make(tag: String, text: String): TermNode {
        nextKey += 1
        val node = TermNode(nextKey, tag, text)
        made.add(java.lang.ref.WeakReference(node))
        return node
    }

    private fun notYet(what: String): Nothing = error("nativeView: $what is not on Compose yet (compose-target)")

    fun liveNodes(): Long {
        repeat(2) {
            Runtime.getRuntime().gc()
            System.runFinalization()
            Thread.sleep(50)
        }
        made.removeAll { it.get() == null }
        return made.size.toLong()
    }

    // ---- the tree ----

    fun createElement(tag: String): Any = make(tag, "")

    fun createText(value: String): Any = make("", value)

    fun setText(handle: Any, value: String) {
        node(handle).text.value = value
    }

    fun setAttribute(handle: Any, name: String, value: String) {
        val node = node(handle)
        val index = node.attributes.indexOfFirst { it.first == name }
        if (index >= 0) node.attributes[index] = name to value else node.attributes.add(name to value)
        when (name) {
            "style" -> for (declaration in value.split(";")) {
                val parts = declaration.split(":", limit = 2).map { it.trim() }
                if (parts.size == 2 && parts[0].isNotEmpty()) setStyle(node, parts[0], parts[1])
            }
            "src" -> if (node.kind == TermNode.Kind.IMAGE) node.picture.value = loadPicture(value)
            "value" -> if (node.kind == TermNode.Kind.RANGE) node.value.value = value
        }
    }

    fun getAttribute(handle: Any, name: String): String = node(handle).attribute(name)

    // the layout words the toolkit hosts share (native-dom-0007): flex-direction, gap, align-items, justify-content,
    // padding, width, height, flex-grow, and `display: flex` as what every container already is. Lengths are CSS
    // pixels, which are dp. Anything else is recorded in `unsupported`, never dropped silently
    private val LAYOUT_WORDS = setOf(
        "display", "flex-direction", "gap", "align-items", "justify-content", "padding", "width", "height", "flex-grow",
        "min-width", "max-width", "min-height", "max-height",
    )

    val unsupported = sortedSetOf<String>()

    fun setStyle(handle: Any, property: String, raw: String) {
        val node = node(handle)
        val value = raw.trim()
        if (property !in LAYOUT_WORDS || (property == "display" && value != "flex" && value != "block")) {
            unsupported.add("$property: $value")
            return
        }
        val index = node.styles.indexOfFirst { it.first == property }
        if (index >= 0) node.styles[index] = property to value else node.styles.add(property to value)
    }

    fun unsupportedStyles(): String = unsupported.joinToString("\n")

    fun addClass(handle: Any, name: String) {
        val node = node(handle)
        if (name !in node.classes) node.classes.add(name)
    }

    fun removeClass(handle: Any, name: String) {
        node(handle).classes.remove(name)
    }

    fun useStyles(light: String, dark: String): Unit = notYet("the style table")

    fun useScheme(scheme: String): Unit = notYet("the style table")

    fun styleOf(handle: Any, property: String): String = notYet("style-of")

    // focus is the platform's to move; a request with nothing focusable is not an error on any host
    fun focus(handle: Any) {}

    fun blur(handle: Any) {}

    fun listen(handle: Any, event: String, handler: () -> Unit) {
        node(handle).listeners.add(event to handler)
    }

    // DOM semantics: a node has one parent, so appending one that already has a parent moves it
    fun append(parentHandle: Any, childHandle: Any) {
        val parent = node(parentHandle)
        val child = node(childHandle)
        detach(child)
        child.parent = parent
        parent.children.add(child)
    }

    // `child` goes in under `reference`'s parent just before it (note/term/view/12-render-seam.md)
    fun insertBefore(childHandle: Any, referenceHandle: Any) {
        val child = node(childHandle)
        val reference = node(referenceHandle)
        detach(child)
        val parent = reference.parent ?: return
        val index = parent.children.indexOf(reference)
        if (index < 0) return
        child.parent = parent
        parent.children.add(index, child)
    }

    fun remove(handle: Any) {
        detach(node(handle))
    }

    private fun detach(child: TermNode) {
        val parent = child.parent ?: return
        parent.children.remove(child)
        child.parent = null
    }

    fun replace(oldHandle: Any, newHandle: Any) {
        val old = node(oldHandle)
        val fresh = node(newHandle)
        detach(fresh)
        val parent = old.parent ?: return
        val index = parent.children.indexOf(old)
        if (index < 0) return
        parent.children[index] = fresh
        fresh.parent = parent
        old.parent = null
    }

    fun clear(handle: Any) {
        val node = node(handle)
        for (child in node.children) child.parent = null
        node.children.clear()
    }

    fun childCount(handle: Any): Long = node(handle).children.size.toLong()

    fun childAt(handle: Any, index: Long): Any = node(handle).children[index.toInt()]

    fun getValue(handle: Any): String = node(handle).value.value

    fun setValue(handle: Any, value: String) {
        node(handle).value.value = value
    }

    // a SwiftUI slot is Apple's (swiftui-target-0001); these test hooks answer as for one that hosts nothing
    fun hostedName(handle: Any): String = ""

    fun hostedAttribute(handle: Any, name: String): String = ""

    fun performHosted(handle: Any, action: String) {}

    // ---- keys: every key pressed, as KeyboardEvent.key names it ----

    private val keyListeners = mutableListOf<Pair<Long, (String) -> Unit>>()
    private var nextKeyListener = 0L

    fun listenKey(handler: (String) -> Unit): Long {
        nextKeyListener += 1
        keyListeners.add(nextKeyListener to handler)
        return nextKeyListener
    }

    fun dropKey(number: Long) {
        keyListeners.removeAll { it.first == number }
    }

    // every key the window's root heard go down, under its web name, to each listener (CxTree's onPreviewKeyEvent)
    fun deliverKey(name: String) {
        if (name.isEmpty()) return
        for ((_, run) in keyListeners.toList()) run(name)
    }

    // for tests: a key pressed through Compose's own input, the root focused and a real key event sent to it, the route
    // a keyboard takes. Where the host has no input to inject (a window), it is delivered as heard
    fun typeKey(name: String) {
        val key = cxKeyOf(name) ?: return
        if (!composeHost.pressKey(COMPOSE_ROOT_TAG, key)) deliverKey(name)
    }

    // ---- fonts and text ----

    fun hasFont(family: String): Boolean = family in COMPOSE_GENERIC_FAMILIES

    fun registerFont(family: String, source: String): Boolean = notYet("register-font")

    fun missingGlyphs(handle: Any): String = notYet("missing-glyphs")

    fun composingText(handle: Any): String = notYet("composed input")

    fun compose(handle: Any, text: String): Unit = notYet("composed input")

    fun commitComposition(handle: Any, text: String): Unit = notYet("composed input")

    // ---- the app around the tree ----

    // the window's content: a root container to mount the program into, at the size the window will have
    fun openRoot(title: String, width: Long, height: Long): Any {
        val made = make("main", "")
        this.title = title
        this.width = width.toInt()
        this.height = height.toInt()
        root = made
        return made
    }

    fun pageBody(): Any = root ?: make("main", "")

    fun afterLaunch(body: () -> Unit) {
        afterLaunch.add(body)
    }

    // a SUSPEND body once the app is running: a page's `boot` awaits its data before it mounts. Started with the
    // standard library's coroutines, so no kotlinx dependency of this file's own
    fun launch(body: suspend () -> Unit) {
        afterLaunch {
            body.cxStartCoroutine(object : kotlin.coroutines.Continuation<Unit> {
                override val context: kotlin.coroutines.CoroutineContext = kotlin.coroutines.EmptyCoroutineContext
                override fun resumeWith(result: Result<Unit>) {
                    result.exceptionOrNull()?.let { composeHost.log("launch: ${it.message}") }
                }
            })
        }
    }

    fun show() {}

    // hand the process to the platform's Compose host (./host-desktop.kt, ./host-android.kt). The after-launch bodies
    // run once the tree is drawn
    fun run() {
        val content = root ?: return
        composeHost.run(content, title, width, height) {
            val bodies = afterLaunch.toList()
            afterLaunch.clear()
            for (body in bodies) body()
        }
    }

    fun exit(status: Long) {
        composeHost.log("native-view exit $status")
        composeHost.exit(status)
    }

    fun onBack(handler: () -> Boolean) {
        backHandler = handler
    }

    fun pressBack() {
        backHandler?.invoke()
    }

    // ---- what a test, or a person, does to the tree and sees of it ----

    // run `body` once the platform has had its turn: here, once Compose has drawn what the code before asked for
    fun later(body: () -> Unit) {
        composeHost.settle()
        body()
    }

    fun say(text: String) {
        composeHost.settle()
        composeHost.log(text)
    }

    // press a control the platform's own way: a click through Compose's own input, so its own onClick runs. Where the
    // host has no input to inject (a window), the click is reported as the control would report it
    fun press(handle: Any) {
        val node = node(handle)
        if (!composeHost.click(node.testTag)) node.fire("click")
    }

    // for tests: type into a field the way a person does. The field's own onValueChange reports the edit
    fun type(handle: Any, text: String) {
        composeHost.replaceText(node(handle).testTag, text)
    }

    // for tests: move a slider the way a finger does, through the semantics action a drag performs
    fun slide(handle: Any, value: String) {
        val number = value.toFloatOrNull() ?: return
        composeHost.setProgress(node(handle).testTag, number)
    }

    // for tests: choose an item of a select the way a person does, the control first and then its report
    fun choose(handle: Any, value: String) {
        val node = node(handle)
        node.value.value = value
        node.expanded.value = false
        node.fire("change")
        composeHost.settle()
    }

    // for tests: dismiss a dialog the way a person does, and its report
    fun dismiss(handle: Any) {
        val node = node(handle)
        setAttribute(node, "open", "false")
        node.fire("close")
        composeHost.settle()
    }

    // the semantics Compose drew for a node, MERGED as a reader is told them (a button with its label) or the node's own
    private fun semanticsOf(node: TermNode, merged: Boolean): CxSemanticsNode? = composeHost.semantics(node.testTag, merged)

    private fun textsOf(semantics: CxSemanticsNode?): String =
        semantics?.config?.cxGetOrNull(CxSemanticsProperties.Text)?.joinToString("") { it.text } ?: ""

    // the tree as HTML, READ BACK FROM COMPOSE'S SEMANTICS: a button's text is what its semantics merge, a switch's state
    // its toggleable state, a field's value its editable text, a slider's its progress. Same spelling as the Android
    // host's, so a test judges both alike
    fun serialize(handle: Any): String {
        val node = node(handle)
        return when (node.kind) {
            TermNode.Kind.TEXT -> textsOf(semanticsOf(node, merged = false))
            TermNode.Kind.BUTTON -> "<button>${textsOf(semanticsOf(node, merged = true))}</button>"
            TermNode.Kind.FIELD -> {
                val shown = semanticsOf(node, merged = true)?.config?.cxGetOrNull(CxSemanticsProperties.EditableText)?.text ?: ""
                "<${node.tag} value=\"$shown\"></${node.tag}>"
            }
            TermNode.Kind.TOGGLE -> {
                val state = semanticsOf(node, merged = true)?.config?.cxGetOrNull(CxSemanticsProperties.ToggleableState)
                "<switch checked=\"${state == CxToggleableState.On}\"></switch>"
            }
            TermNode.Kind.RANGE -> {
                val progress = semanticsOf(node, merged = true)?.config?.cxGetOrNull(CxSemanticsProperties.ProgressBarRangeInfo)
                "<slider value=\"${progress?.let { plain(it.current) } ?: ""}\"></slider>"
            }
            TermNode.Kind.CHOICE -> "<select value=\"${textsOf(semanticsOf(node, merged = true))}\"></select>"
            // open when Compose holds the dialog's content: its semantics exist only while the Dialog is composed, and
            // then the content is read back from them. Closed, nothing is composed, so what the sheet HOLDS is said
            // from the retained tree, as the Android host says the views a closed dialog keeps
            TermNode.Kind.SHEET -> {
                val open = composeHost.holds(node.testTag)
                val inside = node.children.joinToString("") { if (open) serialize(it) else held(it) }
                "<sheet open=\"$open\">$inside</sheet>"
            }
            TermNode.Kind.CONTAINER ->
                "<${node.tag}>${node.children.filter { it.kind != TermNode.Kind.SHEET }.joinToString("") { serialize(it) }}</${node.tag}>"
            TermNode.Kind.IMAGE -> {
                val size = node.picture.value?.let { "${it.width}x${it.height}" } ?: "none"
                val alt = semanticsOf(node, merged = false)?.config?.cxGetOrNull(CxSemanticsProperties.ContentDescription)?.joinToString("") ?: ""
                "<img alt=\"$alt\" size=\"$size\"></img>"
            }
            TermNode.Kind.DIVIDER -> "<hr></hr>"
            // the content's laid-out size in dp: the frame plus how far it scrolls, read off its scroll semantics, so a
            // reader can see it is larger than the frame that scrolls it
            TermNode.Kind.SCROLL -> {
                val semantics = semanticsOf(node, merged = false)
                val reach = semantics?.config?.cxGetOrNull(CxSemanticsProperties.VerticalScrollAxisRange)?.maxValue?.invoke() ?: 0f
                val density = composeHost.density()
                val extent = semantics?.boundsInRoot?.let {
                    "${Math.round(it.width / density)},${Math.round((it.height + reach) / density)}"
                } ?: "0,0"
                "<scroll extent=\"$extent\">${node.children.joinToString("") { serialize(it) }}</scroll>"
            }
        }
    }

    // what a node HOLDS, from the retained tree alone, for content Compose has not composed (a closed dialog's)
    private fun held(node: TermNode): String = when (node.kind) {
        TermNode.Kind.TEXT -> node.text.value
        TermNode.Kind.BUTTON -> "<button>${node.textContent}</button>"
        else -> "<${node.tag}>${node.children.joinToString("") { held(it) }}</${node.tag}>"
    }

    // a number as a web range input reports it: `40`, never `40.0`
    private fun plain(number: Float): String {
        val tidy = Math.round(number * 1_000_000.0) / 1_000_000.0
        return if (tidy == Math.floor(tidy)) tidy.toLong().toString() else tidy.toString()
    }

    // where a node is drawn, in dp from the root's origin, read off its semantics node's position and size. Not its
    // `boundsInRoot`: that collapses a rectangle of no area to all zeros, and an empty spacer is as tall as nothing
    // while as wide as the room it takes
    fun frameOf(handle: Any): String {
        val node = node(handle)
        val semantics = composeHost.semantics(node.testTag, merged = false) ?: return "0,0,0,0"
        val density = composeHost.density()
        val at = semantics.positionInRoot
        return listOf(at.x, at.y, semantics.size.width.toFloat(), semantics.size.height.toFloat())
            .joinToString(",") { Math.round(it / density).toString() }
    }

    fun measureWidth(handle: Any): Long = frameOf(handle).split(",")[2].toLong()

    // what the semantics report for a node, `role|name`, the role in the contract's spelling
    fun accessibilityOf(handle: Any): String {
        val node = node(handle)
        val semantics = semanticsOf(node, merged = true) ?: return "|"
        val config = semantics.config
        if (config.contains(CxSemanticsProperties.InvisibleToUser)) return "hidden|"
        val role = when {
            config.contains(CxSemanticsProperties.ToggleableState) -> "switch"
            config.contains(CxSemanticsProperties.ProgressBarRangeInfo) -> "slider"
            config.contains(CxSemanticsProperties.EditableText) -> "textbox"
            config.contains(CxSemanticsProperties.Heading) -> "heading"
            config.cxGetOrNull(CxSemanticsProperties.Role)?.toString() == "Button" -> "button"
            node.kind == TermNode.Kind.IMAGE -> "img"
            node.kind == TermNode.Kind.TEXT -> "text"
            else -> ""
        }
        val name = config.cxGetOrNull(CxSemanticsProperties.ContentDescription)?.joinToString("")
            ?: textsOf(semantics)
        return "$role|$name"
    }

    // a PNG of the whole content, as Compose drew it
    fun snapshot(path: String) {
        composeHost.snapshot(path)
    }

    // a `data:` URI's or a file's bytes, decoded by the platform into a picture Compose draws
    private fun loadPicture(source: String): androidx.compose.ui.graphics.ImageBitmap? {
        val bytes = when {
            source.startsWith("data:") -> {
                val comma = source.indexOf(',')
                if (comma < 0) return null
                val head = source.substring(0, comma)
                val body = source.substring(comma + 1)
                if (head.endsWith(";base64")) java.util.Base64.getDecoder().decode(body) else body.toByteArray()
            }
            else -> composeHost.readFile(source) ?: return null
        }
        return composeHost.decodePicture(bytes)
    }
}

// a CSS length in px as dp, or null for one that is not a plain number of pixels
private fun cxLength(value: String): Float? = value.trim().removeSuffix("px").toFloatOrNull()

// the tag of the window's root box, which hears every key
private const val COMPOSE_ROOT_TAG = "term-root"

// the web's names for the keys that are not characters (KeyboardEvent.key), and the letters and digits, by Compose key
private val COMPOSE_KEY_NAMES: List<Pair<androidx.compose.ui.input.key.Key, String>> = listOf(
    CxKey.Escape to "Escape",
    CxKey.Enter to "Enter",
    CxKey.Tab to "Tab",
    CxKey.Backspace to "Backspace",
    CxKey.DirectionLeft to "ArrowLeft",
    CxKey.DirectionRight to "ArrowRight",
    CxKey.DirectionUp to "ArrowUp",
    CxKey.DirectionDown to "ArrowDown",
    CxKey.Spacebar to " ",
) + listOf(
    CxKey.A, CxKey.B, CxKey.C, CxKey.D, CxKey.E, CxKey.F, CxKey.G, CxKey.H, CxKey.I, CxKey.J, CxKey.K, CxKey.L, CxKey.M,
    CxKey.N, CxKey.O, CxKey.P, CxKey.Q, CxKey.R, CxKey.S, CxKey.T, CxKey.U, CxKey.V, CxKey.W, CxKey.X, CxKey.Y, CxKey.Z,
).mapIndexed { index, key -> key to ('a' + index).toString() } + listOf(
    CxKey.Zero, CxKey.One, CxKey.Two, CxKey.Three, CxKey.Four, CxKey.Five, CxKey.Six, CxKey.Seven, CxKey.Eight, CxKey.Nine,
).mapIndexed { index, key -> key to index.toString() }

private fun cxKeyName(key: androidx.compose.ui.input.key.Key): String = COMPOSE_KEY_NAMES.firstOrNull { it.first == key }?.second ?: ""

private fun cxKeyOf(name: String): androidx.compose.ui.input.key.Key? = COMPOSE_KEY_NAMES.firstOrNull { it.second == name }?.first

// the root: padded 24, as the Android host pads its content; FOCUSABLE, so it hears every key the window gets and
// hands each to `listen-key`'s listeners before the focused control sees it (swiftui-target-0003's contract); and
// SCROLLING, as a page does, so content taller than the window is laid out at its own size. Without it a Column gives
// each child only the height that remains, and everything past the bottom of a phone screen was laid out zero tall
@CxComposable
fun CxTree(root: TermNode) {
    val focus = cxRemember { CxFocusRequester() }
    val page = cxRemember { CxScrollState(0) }
    CxBox(
        CxModifier
            .cxTestTag(COMPOSE_ROOT_TAG)
            .cxOnPreviewKeyEvent { event ->
                if (event.cxType == CxKeyEventType.KeyDown) nativeView.deliverKey(cxKeyName(event.cxKey))
                false
            }
            .cxFocusRequester(focus)
            .cxFocusable()
            .cxVerticalScroll(page)
            .cxPadding(24.cxDp),
    ) {
        CxNode(root, CxModifier)
    }
    androidx.compose.runtime.LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
}

// a node's own size and padding, from its style rows, and what its parent gave it (a weight, a stretch). ORDER MATTERS:
// the node's own sizes and bounds come first, so they cap what the parent's stretch then fills (a `max-width: 60`
// button in a stretching column is 60 wide, as in CSS, not the column's width), then the test tag, then padding, inside
private fun cxSized(node: TermNode, given: CxModifier): CxModifier {
    var modifier: CxModifier = CxModifier
    // an explicit width or height is the node's own, as in CSS, even where the parent has less room: Compose's `width`
    // gives way to the parent, so the node is first let measure unbounded, kept at the start edge, then sized. (A 300
    // wide row on a 320dp phone with 24 of padding each side was 272 wide before this)
    cxLength(node.style("width"))?.let {
        modifier = modifier.cxWrapContentWidth(CxAlignment.Start, unbounded = true).cxWidth(it.cxDp)
    }
    cxLength(node.style("height"))?.let {
        modifier = modifier.cxWrapContentHeight(CxAlignment.Top, unbounded = true).cxHeight(it.cxDp)
    }
    // a frame's bounds (note/term/view/11-vocabulary.md): a floor and a ceiling on what the content asks for
    val minWidth = cxLength(node.style("min-width"))
    val maxWidth = cxLength(node.style("max-width"))
    if (minWidth != null || maxWidth != null) {
        modifier = modifier.cxWidthIn(
            min = minWidth?.cxDp ?: androidx.compose.ui.unit.Dp.Unspecified,
            max = maxWidth?.cxDp ?: androidx.compose.ui.unit.Dp.Unspecified,
        )
    }
    val minHeight = cxLength(node.style("min-height"))
    val maxHeight = cxLength(node.style("max-height"))
    if (minHeight != null || maxHeight != null) {
        modifier = modifier.cxHeightIn(
            min = minHeight?.cxDp ?: androidx.compose.ui.unit.Dp.Unspecified,
            max = maxHeight?.cxDp ?: androidx.compose.ui.unit.Dp.Unspecified,
        )
    }
    modifier = modifier.then(given)
    // the tag INSIDE the node's own size and outside its padding, so its semantics report the node as it is: tagged
    // first, a 300 wide row on a narrower phone reported the 272 it gave way to rather than its own 300
    modifier = modifier.cxTestTag(node.testTag)
    cxLength(node.style("padding"))?.let { modifier = modifier.cxPadding(it.cxDp) }
    return modifier
}

@CxComposable
fun CxNode(node: TermNode, given: CxModifier) {
    when (node.kind) {
        TermNode.Kind.TEXT -> {
            val heading = node.parent?.tag?.let { Regex("h[1-6]").matches(it) } == true
            CxText(
                node.text.value,
                modifier = given.cxTestTag(node.testTag).cxSemantics { if (heading) cxHeading() },
                fontSize = 17.cxSp,
                color = CxColor.Black,
            )
        }
        TermNode.Kind.BUTTON -> CxButton(onClick = { node.fire("click") }, modifier = cxSized(node, given)) {
            CxText(node.textContent)
        }
        TermNode.Kind.FIELD -> CxTextField(
            value = node.value.value,
            onValueChange = {
                node.value.value = it
                node.fire("input")
            },
            modifier = cxSized(node, given),
            placeholder = node.attribute("placeholder").takeIf { it.isNotEmpty() }?.let { hint -> { CxText(hint) } },
            singleLine = node.tag == "input",
        )
        TermNode.Kind.TOGGLE -> CxSwitch(
            checked = node.attribute("aria-checked") == "true",
            onCheckedChange = { node.fire("click") },
            modifier = cxSized(node, given),
        )
        TermNode.Kind.RANGE -> {
            val min = node.attribute("min").toFloatOrNull() ?: 0f
            val max = node.attribute("max").toFloatOrNull() ?: 100f
            val step = node.attribute("step").toFloatOrNull()?.takeIf { it > 0f } ?: 1f
            // Compose counts the stops BETWEEN the ends, the web counts steps: 0 to 100 by 1 is 99 stops between
            val stops = Math.max(0, Math.round((max - min) / step) - 1)
            CxSlider(
                value = node.value.value.toFloatOrNull() ?: min,
                onValueChange = {
                    node.value.value = cxPlainValue(it)
                    node.fire("input")
                },
                valueRange = min..max,
                steps = stops,
                modifier = cxSized(node, given).cxWidth(200.cxDp),
            )
        }
        // the tag is on the button, whose semantics merge the value it shows, which is what `serialize` reads
        TermNode.Kind.CHOICE -> CxBox {
            CxButton(onClick = { node.expanded.value = true }, modifier = cxSized(node, given)) { CxText(node.value.value) }
            CxDropdownMenu(expanded = node.expanded.value, onDismissRequest = { node.expanded.value = false }) {
                for (option in node.attribute("options").split("\n").filter { it.isNotEmpty() }) {
                    CxDropdownMenuItem(onClick = {
                        node.value.value = option
                        node.expanded.value = false
                        node.fire("change")
                    }) { CxText(option) }
                }
            }
        }
        // a dialog's content is never in the page: it is shown in a Dialog while `open` is true
        TermNode.Kind.SHEET -> if (node.attribute("open") == "true") {
            CxDialog(onDismissRequest = {
                nativeView.setAttribute(node, "open", "false")
                node.fire("close")
            }) {
                CxColumn(cxSized(node, CxModifier).cxPadding(24.cxDp)) {
                    for (child in node.children) CxNode(child, CxModifier)
                }
            }
        }
        TermNode.Kind.IMAGE -> {
            val picture = node.picture.value
            val alt = node.attribute("alt")
            // the picture's own contentDescription is its words; a placeholder with no picture yet says them itself
            if (picture != null) {
                androidx.compose.foundation.Image(bitmap = picture, contentDescription = alt.ifEmpty { null }, modifier = cxSized(node, given))
            } else {
                CxBox(cxSized(node, given).cxSemantics { if (alt.isNotEmpty()) cxContentDescription = alt })
            }
        }
        // a line is a picture of separation, not content: out of the accessibility tree, as the contract has it
        TermNode.Kind.DIVIDER -> {
            val inRow = node.parent?.let { cxIsRow(it) } == true
            val line = if (inRow) given.cxFillMaxHeight().cxWidth(1.cxDp) else given.cxFillMaxWidth()
            CxDivider(line.cxTestTag(node.testTag).cxSemantics { cxInvisibleToUser() })
        }
        TermNode.Kind.SCROLL -> {
            val scroll = cxRemember { CxScrollState(0) }
            CxColumn(cxSized(node, given).cxVerticalScroll(scroll)) {
                for (child in node.children) CxNode(child, CxModifier)
            }
        }
        TermNode.Kind.CONTAINER -> CxStack(node, given)
    }
}

private fun cxPlainValue(number: Float): String {
    val tidy = Math.round(number * 1_000_000.0) / 1_000_000.0
    return if (tidy == Math.floor(tidy)) tidy.toLong().toString() else tidy.toString()
}

// CSS's defaults (native-dom-0037), which a native host gets the other way round unless it says so: `display: flex`
// with no direction is a ROW, a block container stacks its children, and an inline element (span, a, strong) is a run
private fun cxIsFlex(node: TermNode): Boolean = node.style("display") == "flex"

private fun cxIsRow(node: TermNode): Boolean {
    val direction = node.style("flex-direction")
    return when {
        direction == "row" -> true
        direction.isNotEmpty() -> false
        cxIsFlex(node) -> true
        else -> node.tag in COMPOSE_INLINE_TAGS
    }
}

// a child that is a block in CSS's terms, which a block container stretches to its width: a container that is not an
// inline run, a scroll, a divider. A button, a field, a control, a picture and text are inline and keep their own width
private fun cxIsBlock(child: TermNode): Boolean = when (child.kind) {
    TermNode.Kind.CONTAINER -> child.tag !in COMPOSE_INLINE_TAGS
    TermNode.Kind.SCROLL, TermNode.Kind.DIVIDER -> true
    else -> false
}

// whether a column stretches this child across its width: `align-items: stretch` stretches every child, a flex column
// with no align-items does too (CSS's default), and a block container stretches its block children only
private fun cxStretches(column: TermNode, child: TermNode): Boolean = when (column.style("align-items")) {
    "stretch" -> true
    "" -> cxIsFlex(column) || cxIsBlock(child)
    else -> false
}

// a container: a Row or a Column, its gap, alignment and justification from its style rows, a child's `flex-grow` its
// weight. A sheet child is composed in place but draws in a Dialog's own layer and takes no room here, so it is
// called for every child: a sheet left out was a Dialog never composed, open or not
@CxComposable
fun CxStack(node: TermNode, given: CxModifier) {
    val gap = (cxLength(node.style("gap")) ?: 0f).cxDp
    val justify = node.style("justify-content")
    val align = node.style("align-items")
    val drawn = node.children.toList()
    if (cxIsRow(node)) {
        val arrangement = when (justify) {
            "center" -> CxArrangement.spacedBy(gap, CxAlignment.CenterHorizontally)
            "end", "flex-end" -> CxArrangement.spacedBy(gap, CxAlignment.End)
            "space-between" -> CxArrangement.SpaceBetween
            else -> CxArrangement.spacedBy(gap)
        }
        val vertical = when (align) {
            "center" -> CxAlignment.CenterVertically
            "end", "flex-end" -> CxAlignment.Bottom
            else -> CxAlignment.Top
        }
        CxRow(cxSized(node, given), horizontalArrangement = arrangement, verticalAlignment = vertical) {
            for (child in drawn) {
                val grow = child.style("flex-grow").toFloatOrNull() ?: 0f
                CxNode(child, if (grow > 0f) CxModifier.weight(grow) else CxModifier)
            }
        }
    } else {
        val arrangement = when (justify) {
            "center" -> CxArrangement.spacedBy(gap, CxAlignment.CenterVertically)
            "end", "flex-end" -> CxArrangement.spacedBy(gap, CxAlignment.Bottom)
            "space-between" -> CxArrangement.SpaceBetween
            else -> CxArrangement.spacedBy(gap)
        }
        val horizontal = when (align) {
            "center" -> CxAlignment.CenterHorizontally
            "end", "flex-end" -> CxAlignment.End
            else -> CxAlignment.Start
        }
        CxColumn(cxSized(node, given), verticalArrangement = arrangement, horizontalAlignment = horizontal) {
            for (child in drawn) {
                val grow = child.style("flex-grow").toFloatOrNull() ?: 0f
                val stretched = if (cxStretches(node, child)) CxModifier.cxFillMaxWidth() else CxModifier
                CxNode(child, if (grow > 0f) stretched.weight(grow) else stretched)
            }
        }
    }
}
