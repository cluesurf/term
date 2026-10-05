// The Kotlin backend: emit the language as idiomatic, type-static Kotlin. Parity with the TypeScript backend across
// every AST form. Algebraic data types lower to NATIVE sealed-class hierarchies (`sealed class Maybe<out T>` with a
// subclass per variant), `match` to an exhaustive `when (subject) { is MaybeSome -> ... }` whose smart-casts make a
// variant's fields directly accessible (no rewrite needed), and struct forms to `data class`es. A variant subclass
// carries only the generics its own fields use, filling the rest with `Nothing` (valid under `out` variance), so
// construction infers cleanly. Pure, browser-safe. See note/research/vibe/computation/plans/07-codegen.md.

import { armLocals } from '@term/make/code/check/arm'
import { provenIncrements } from '@term/make/code/ir/facts/range'
import { provenArithmetic, type Proven } from '@term/make/code/compile/proven'
import { boundedLoops, listKey } from '@term/make/code/ir/facts/bounds'
import { asciiTexts } from '@term/make/code/ir/facts/text'
import type {
  Expression,
  Program,
  Statement,
  Type,
} from '@term/make/code/compile/node'
import {
  collectionCall,
  collectionRead,
  exhausted,
  reassigned,
  stringCall,
  stringRead,
  isText,
  textValued,
} from '@term/make/code/compile/backend'
import type { CollectionOp, FormKind, FormSpec } from '@term/make/code/compile/backend'
import { asciiCharAppend, assignsName, emptyText, fillCall, fillTasks, lastReads, listGenerator, mapUpdate, namesIn, ownedFields, slotTakes, tailTasks, recordCopies, redeclaredLets, textAppend, textBuilders, textCursors } from '@term/make/code/compile/backend'
import { rustBoxing } from '@term/make/code/compile/rust'
import type { TextCursors } from '@term/make/code/compile/backend'
import { privateForms, recordPlaces, recordReuse } from '@term/make/code/compile/place'
import {
  escapingParams,
  formSpec,
  hasValuedReturn,
  refuseAny,
  specForms,
  swapAt,
  gatedTasks,
  listFacts,
  fixedLists,
} from '@term/make/code/compile/backend'
import {
  collectBinds,
  renderBind,
  bindGap,
  bindImports,
  referencedBinds,
} from '@term/make/code/compile/bind'

// Kotlin hard keywords: one used as an identifier (a local named `continue`, a param named `object`) is
// backtick-escaped, in the declaration and every reference alike
const KOTLIN_KEYWORDS = new Set([
  'as', 'break', 'class', 'continue', 'do', 'else', 'false', 'for', 'fun', 'if', 'in', 'interface', 'is',
  'null', 'object', 'package', 'return', 'super', 'this', 'throw', 'true', 'try', 'typealias', 'typeof',
  'val', 'var', 'when', 'while',
])

function rawCamel(name: string): string {
  // strip every hyphen, including one before a digit (`sha-256` -> `sha256`), so the result is a valid identifier
  return name.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())
}

function camel(name: string): string {
  const spelled = rawCamel(name)

  return KOTLIN_KEYWORDS.has(spelled) ? `\`${spelled}\`` : spelled
}

function pascal(name: string): string {
  const c = rawCamel(name)

  return c.charAt(0).toUpperCase() + c.slice(1)
}

// gather the inference-variable ids appearing in a type (each an implicit generic parameter of its function)
function collectVars(type: Type | undefined, into: Set<number>): void {
  switch (type?.kind) {
    case 'variable':
      into.add(type.id)
      break
    case 'array':
      collectVars(type.element, into)
      break
    case 'map':
      collectVars(type.key, into)
      collectVars(type.value, into)
      break
    case 'function':
      type.params.forEach(p => collectVars(p, into))
      collectVars(type.result, into)
      break
    case 'named':
      type.args?.forEach(a => collectVars(a, into))
      break
    default:
      break
  }
}

const OP: Record<string, string> = {
  '&&': '&&',
  '||': '||',
  '==': '==',
  '!=': '!=',
  '<': '<',
  '<=': '<=',
  '>': '>',
  '>=': '>=',
  '+': '+',
  '-': '-',
  '*': '*',
  '/': '/',
  '%': '%',
}

// The text operations by code point (note/term/stdlib/semantics.md). Kotlin's String is UTF-16, so a position counts
// code points by stepping through the string where it lies: nothing is converted to an array, and a call allocates
// only its result. Matching itself (indexOf, split, replace) is the String's own UTF-16 search, which finds exactly the
// code point matches because a needle is whole code points. It converted every string to an IntArray on almost every
// call until 2026-10-02, so a loop reading a text by position was quadratic and allocated a copy per turn.
export const KOTLIN_TEXT = `object TermText {
    // the UTF-16 offset of code point i, the length when i is the count, -1 past that
    private fun unit(s: String, i: Long): Int {
        var u = 0
        var k = 0L
        while (k < i) {
            if (u >= s.length) return -1
            u += Character.charCount(s.codePointAt(u))
            k++
        }
        return if (u <= s.length) u else -1
    }
    private fun white(c: Int): Boolean = c in 9..13 || c == 32 || c == 133 || c == 160 || c == 5760 || c in 8192..8202 || c == 8232 || c == 8233 || c == 8239 || c == 8287 || c == 12288
    fun length(s: String): Long = s.codePointCount(0, s.length).toLong()
    fun charAt(s: String, i: Long): String {
        if (i < 0) return ""
        val u = unit(s, i)
        return if (u < 0 || u >= s.length) "" else s.substring(u, u + Character.charCount(s.codePointAt(u)))
    }
    fun charCodeAt(s: String, i: Long): Long {
        if (i < 0) return -1L
        val u = unit(s, i)
        return if (u < 0 || u >= s.length) -1L else s.codePointAt(u).toLong()
    }
    // an ASCII text (ir/facts/text.ts): a code point is one UTF-16 unit, read by its index
    fun asciiCodeAt(s: CharSequence, i: Long): Long = if (i >= 0 && i < s.length) s[i.toInt()].code.toLong() else -1L
    fun asciiCharAt(s: CharSequence, i: Long): String = if (i >= 0 && i < s.length) s[i.toInt()].toString() else ""
    fun asciiAppend(out: StringBuilder, s: CharSequence, i: Long) { if (i >= 0 && i < s.length) out.append(s[i.toInt()]) }
    // both ends clamped to the text and swapped when reversed (the Term meaning), as unit indexes
    fun asciiSubstring(s: String, a: Long, e: Long = s.length.toLong()): String {
        val n = s.length.toLong()
        val x = a.coerceIn(0L, n)
        val y = e.coerceIn(0L, n)
        return if (x <= y) s.substring(x.toInt(), y.toInt()) else s.substring(y.toInt(), x.toInt())
    }
    // a code point read through a cursor (backend.ts, textCursors): [code-point index, unit offset] of the last read,
    // stepped forward or back from, or restarted at the start when that is nearer. A read past the end leaves it there
    // the UTF-16 offset of code point i, the end past the last
    fun cursorTo(s: String, i: Long, c: LongArray): Int {
        var k = c[0]
        var u = c[1].toInt()
        if (i < k) {
            if (i <= k - i) {
                k = 0L
                u = 0
            } else {
                while (k > i) {
                    u--
                    if (u > 0 && Character.isLowSurrogate(s[u]) && Character.isHighSurrogate(s[u - 1])) u--
                    k--
                }
            }
        }
        while (k < i && u < s.length) {
            u += Character.charCount(s.codePointAt(u))
            k++
        }
        c[0] = k
        c[1] = u.toLong()
        return u
    }
    fun cursorAt(s: String, i: Long, c: LongArray): Int {
        if (i < 0) return -1
        val u = cursorTo(s, i, c)
        return if (c[0] == i && u < s.length) s.codePointAt(u) else -1
    }
    // the code points from a to e through the cursor, both clamped and swapped when reversed: the cursor moves to the
    // start, and the end is counted on from it
    fun cursorSlice(s: String, a: Long, e: Long, c: LongArray): String {
        val x = maxOf(minOf(a, e), 0L)
        val y = maxOf(maxOf(a, e), 0L)
        val from = cursorTo(s, x, c)
        var to = from
        var k = c[0]
        while (k < y && to < s.length) {
            to += Character.charCount(s.codePointAt(to))
            k++
        }
        return s.substring(from, to)
    }
    fun cursorCodeAt(s: String, i: Long, c: LongArray): Long = cursorAt(s, i, c).toLong()
    fun cursorCharAt(s: String, i: Long, c: LongArray): String { val x = cursorAt(s, i, c); return if (x < 0) "" else String(Character.toChars(x)) }
    fun indexOf(s: String, n: String, from: Long = 0L): Long {
        val u = if (from <= 0L) 0 else unit(s, from).let { if (it < 0) s.length else it }
        val r = s.indexOf(n, u)
        return if (r < 0) -1L else s.codePointCount(0, r).toLong()
    }
    fun lastIndexOf(s: String, n: String): Long {
        // Kotlin's String.lastIndexOf starts at the last INDEX, so it finds the empty text one before the end
        if (n.isEmpty()) return length(s)
        val r = s.lastIndexOf(n)
        return if (r < 0) -1L else s.codePointCount(0, r).toLong()
    }
    fun split(s: String, d: String): MutableList<String> {
        // the pieces straight into the one list returned, where split(d).toMutableList() built it twice
        if (d.isNotEmpty()) {
            val out = ArrayList<String>()
            var start = 0
            while (true) {
                val at = s.indexOf(d, start)
                if (at < 0) break
                out.add(s.substring(start, at))
                start = at + d.length
            }
            out.add(s.substring(start))
            return out
        }
        val out = ArrayList<String>(s.length)
        var u = 0
        while (u < s.length) { val w = Character.charCount(s.codePointAt(u)); out.add(s.substring(u, u + w)); u += w }
        return out
    }
    fun substring(s: String, a: Long, b: Long? = null): String {
        val count = s.codePointCount(0, s.length).toLong()
        var x = a.coerceIn(0L, count)
        var y = (b ?: count).coerceIn(0L, count)
        if (x > y) { val t = x; x = y; y = t }
        if (x == y) return ""
        val ux = s.offsetByCodePoints(0, x.toInt())
        return s.substring(ux, s.offsetByCodePoints(ux, (y - x).toInt()))
    }
    fun slice(s: String, a: Long, b: Long? = null): String = substring(s, a, b)
    fun toLowerCase(s: String): String = s.lowercase()
    fun toUpperCase(s: String): String = s.uppercase()
    fun trimStart(s: String): String {
        var u = 0
        while (u < s.length) { val c = s.codePointAt(u); if (!white(c)) break; u += Character.charCount(c) }
        return s.substring(u)
    }
    fun trimEnd(s: String): String {
        var u = s.length
        while (u > 0) { val c = s.codePointBefore(u); if (!white(c)) break; u -= Character.charCount(c) }
        return s.substring(0, u)
    }
    fun trim(s: String): String = trimEnd(trimStart(s))
    private fun pad(s: String, w: Long, f: String, front: Boolean): String {
        val n = length(s)
        if (n >= w || f.isEmpty()) return s
        val out = StringBuilder(s.length + (w - n).toInt() * 2)
        if (!front) out.append(s)
        var u = 0
        for (i in 0 until (w - n).toInt()) {
            if (u >= f.length) u = 0
            val c = f.codePointAt(u)
            out.appendCodePoint(c)
            u += Character.charCount(c)
        }
        if (front) out.append(s)
        return out.toString()
    }
    fun padStart(s: String, w: Long, f: String): String = pad(s, w, f, true)
    fun padEnd(s: String, w: Long, f: String): String = pad(s, w, f, false)
    fun replace(s: String, a: String, b: String): String { val i = s.indexOf(a); return if (i < 0) s else s.substring(0, i) + b + s.substring(i + a.length) }
    fun replaceAll(s: String, a: String, b: String): String {
        if (a.isNotEmpty()) return s.replace(a, b)
        val out = StringBuilder(s.length * (b.length + 1) + b.length)
        out.append(b)
        var u = 0
        while (u < s.length) { val c = s.codePointAt(u); out.appendCodePoint(c); out.append(b); u += Character.charCount(c) }
        return out.toString()
    }
    fun includes(s: String, n: String): Boolean = s.contains(n)
    fun startsWith(s: String, n: String): Boolean = s.startsWith(n)
    fun endsWith(s: String, n: String): Boolean = s.endsWith(n)
    fun repeat(s: String, n: Long): String = if (n > 0) s.repeat(n.toInt()) else ""
    fun concat(s: String, b: String): String = s + b
    // code point order, read in place. Up to the first unit that differs both strings agree, so that unit's position
    // is a code point boundary in both or the low half of the same high surrogate in both. Two units outside the
    // surrogate range order as their code points, and only a surrogate needs the whole code point read
    fun compare(a: String, b: String): Long {
        val n = minOf(a.length, b.length)
        var i = 0
        while (i < n) {
            val x = a[i]
            val y = b[i]
            if (x != y) {
                if (!x.isSurrogate() && !y.isSurrogate()) return if (x < y) -1L else 1L
                val p = a.codePointAt(i)
                val q = b.codePointAt(i)
                return if (p < q) -1L else if (p > q) 1L else 0L
            }
            i++
        }
        return a.length.compareTo(b.length).toLong()
    }
}`

// A float as text, the same on every backend (note/term/stdlib/semantics.md, "Numbers as text"): the shortest digits
// that read back as the same float (the JDK's Double.toString gives them since 19), laid out as ECMAScript's
// Number::toString lays them out. Kotlin's own rendering prints two as `2.0` and 1e21 as `1.0E21`.
const KOTLIN_NUMBER = `fun termNumber(x: Double): String {
    if (x.isNaN()) return "NaN"
    if (x.isInfinite()) return if (x > 0) "Infinity" else "-Infinity"
    if (x == 0.0) return "0"
    val shortest = Math.abs(x).toString().lowercase()
    val halves = shortest.split("e")
    val exponent = if (halves.size > 1) halves[1].toInt() else 0
    val pieces = halves[0].split(".")
    val whole = pieces[0]
    var all = whole + (if (pieces.size > 1) pieces[1] else "")
    var n = whole.length + exponent
    while (all.length > 1 && all[0] == '0') { all = all.substring(1); n -= 1 }
    all = all.trimEnd('0').ifEmpty { "0" }
    val k = all.length
    val body = when {
        k <= n && n <= 21 -> all + "0".repeat(n - k)
        0 < n && n <= 21 -> all.substring(0, n) + "." + all.substring(n)
        -6 < n && n <= 0 -> "0." + "0".repeat(-n) + all
        else -> {
            val e = n - 1
            (if (k == 1) all else all.substring(0, 1) + "." + all.substring(1)) + "e" + (if (e < 0) "-" else "+") + Math.abs(e)
        }
    }
    return if (x < 0) "-" + body else body
}`

// A list of integers held in one LongArray, made wherever a list is built knowing its element is an integer. It IS a
// `MutableList<Long>`, and the factory is typed as one, so every operation, generic task and equality works as before
// and a variable may still be given any other list: only the storage differs, with no object per element and no GC
// write barrier per store. Out-of-range access throws what ArrayList throws. Held against ArrayList, operation for
// operation, by test/compile/kotlin-longs.ts
export const KOTLIN_LONGS = `class TermLongs(capacity: Int) : AbstractMutableList<Long>(), RandomAccess {
    @JvmField var data = LongArray(capacity)
    @JvmField var count = 0
    override val size: Int get() = count
    private fun outside(index: Int): Nothing = throw IndexOutOfBoundsException("Index " + index + " out of bounds for length " + count)
    private fun room(need: Int) {
        if (need > data.size) data = data.copyOf(maxOf(need, data.size + (data.size shr 1), 8))
    }
    override fun get(index: Int): Long {
        if (index < 0 || index >= count) outside(index)
        return data[index]
    }
    override fun set(index: Int, element: Long): Long {
        if (index < 0 || index >= count) outside(index)
        val old = data[index]
        data[index] = element
        return old
    }
    // the same reads and writes, not through the generic List signature, which boxes on the JVM: what a record's own
    // list field typed TermLongs is read and written with (kotlin.ts, fieldLists)
    fun getLong(index: Int): Long {
        if (index < 0 || index >= count) outside(index)
        return data[index]
    }
    fun setLong(index: Int, element: Long) {
        if (index < 0 || index >= count) outside(index)
        data[index] = element
    }
    // a push past the generic List signature, which boxes: what \`termPushLong\` calls
    fun addLong(element: Long) {
        room(count + 1)
        data[count++] = element
        modCount++
    }
    override fun add(element: Long): Boolean {
        room(count + 1)
        data[count++] = element
        modCount++
        return true
    }
    override fun add(index: Int, element: Long) {
        if (index < 0 || index > count) outside(index)
        room(count + 1)
        System.arraycopy(data, index, data, index + 1, count - index)
        data[index] = element
        count++
        modCount++
    }
    override fun addAll(elements: Collection<Long>): Boolean {
        if (elements !is TermLongs) return super.addAll(elements)
        val n = elements.count
        room(count + n)
        System.arraycopy(elements.data, 0, data, count, n)
        count += n
        modCount++
        return n > 0
    }
    override fun removeAt(index: Int): Long {
        if (index < 0 || index >= count) outside(index)
        val old = data[index]
        System.arraycopy(data, index + 1, data, index, count - index - 1)
        count--
        modCount++
        return old
    }
    override fun clear() {
        count = 0
        modCount++
    }
}

fun mutableLongListOf(vararg items: Long): MutableList<Long> {
    val list = TermLongs(maxOf(items.size, 10))
    System.arraycopy(items, 0, list.data, 0, items.size)
    list.count = items.size
    return list
}

// a push onto a list of \`Long\`, the value passed unboxed: a TermLongs takes it straight into its storage, any other
// list through the generic add. Answers the new size, as \`list_push\` does
fun termPushLong(xs: MutableList<Long>, x: Long): Long {
    if (xs is TermLongs) {
        xs.addLong(x)
        return xs.count.toLong()
    }
    xs.add(x)
    return xs.size.toLong()
}

// a fixed list (backend.ts, fixedLists) taken from a fresh task's result: one copy of the storage
fun termLongArray(xs: MutableList<Long>): LongArray = if (xs is TermLongs) xs.data.copyOf(xs.count) else xs.toLongArray()

// a list a record owns (kotlin.ts, fieldLists), as the TermLongs its field is typed: the list itself when it is one,
// else a copy, which is safe since nothing else holds a list the record owns
fun termLongs(xs: MutableList<Long>): TermLongs = if (xs is TermLongs) xs else (mutableLongListOf(xs) as TermLongs)

// a list of n copies of x (backend.ts, fillTasks): one allocation, already zero, written only for another value
fun termLongsFilled(n: Long, x: Long): MutableList<Long> {
    val size = Math.toIntExact(maxOf(n, 0L))
    val list = TermLongs(maxOf(size, 10))
    if (x != 0L) list.data.fill(x, 0, size)
    list.count = size
    return list
}

fun mutableLongListOf(from: Collection<Long>): MutableList<Long> {
    val list = TermLongs(maxOf(from.size, 10))
    list.addAll(from)
    return list
}`

// The prelude helpers a Kotlin program may call, each written once, in the order they are emitted. The emitter records
// a helper in `needs` at the moment it writes a call to it (`need`), and the prelude is exactly the recorded set.
// It used to be chosen by searching the emitted text for a helper's name, which included `termNumber` for every
// program whose form walkers called `__termNumber`, and could not see a helper spelled any other way.
const KOTLIN_HELPERS = {
  error: 'class SeedError(message: String) : RuntimeException(message)',
  text: KOTLIN_TEXT,
  number: KOTLIN_NUMBER,
  // integer division that stops where the JVM wraps (`Long.MIN_VALUE / -1`), and throws on zero as `/` does
  divide: 'fun termDivide(a: Long, b: Long): Long = if (b == -1L) Math.negateExact(a) else a / b',
  // integer lists in a LongArray (KOTLIN_LONGS)
  longs: KOTLIN_LONGS,
  // the one exception value of a Term program on this backend (note/term/hive/11-native-exceptions.md): the shared
  // fields of every exception, the props as `link`, the raised record as `base`. No stack trace: filling one walks
  // the stack on every raise, and the hive keeps Term's own `flow`. `termException` is the boundary that makes a
  // foreign throw a `failure`.
  exception: [
    'class TermException(val host: String, val form: String, val note: String, val code: String, val time: Long, val link: Any?, val base: Any?) : RuntimeException(form + ": " + note, null, false, false)',
    'fun termException(thrown: Any?): TermException = if (thrown is TermException) thrown else TermException("", "failure", thrown?.toString() ?: "", "", 0L, null, thrown)',
  ].join('\n\n'),
  // an async call nothing awaits, started as a coroutine of its own. A raise in it is thrown where it ends, as an
  // unhandled raise ends the program anywhere else
  start: [
    'import kotlin.coroutines.startCoroutine',
    'fun termStart(body: suspend () -> Unit) {\n    body.startCoroutine(object : kotlin.coroutines.Continuation<Unit> {\n        override val context: kotlin.coroutines.CoroutineContext = kotlin.coroutines.EmptyCoroutineContext\n        override fun resumeWith(result: Result<Unit>) {\n            result.getOrThrow()\n        }\n    })\n}',
  ].join('\n\n'),
} as const

type KotlinHelper = keyof typeof KOTLIN_HELPERS

// Kotlin requires every `import` at the top of the file, but a built program concatenates the runtime prelude (one or
// more shim files, each with its own imports) with the emitted program (which may also emit imports). Hoist every
// `import` line to the top, deduplicated and order-preserved, so the assembled source is valid. Apply this to the FINAL
// `prelude + program` string for the kotlin target.
export function hoistKotlinImports(source: string): string {
  const imports: string[] = []
  const seen = new Set<string>()
  const body: string[] = []

  for (const line of source.split('\n')) {
    if (/^\s*import\s+\S/.test(line)) {
      const trimmed = line.trim()

      if (!seen.has(trimmed)) {
        seen.add(trimmed)
        imports.push(trimmed)
      }
    } else {
      body.push(line)
    }
  }

  return imports.length > 0
    ? `${imports.join('\n')}\n${body.join('\n')}`
    : source
}

// the seed primitive forms by name, for a `named` reference the checker did not seed
const KOTLIN_PRIMITIVES: Record<string, string> = {
  text: 'String',
  boolean: 'Boolean',
  number: 'Long',
  integer: 'Long',
  decimal: 'Double',
}

// the roll grouped by deck, for the generated wake chain (the same shape emitTypeScript takes)
export type WakeGroup = {
  deck: string
  entries: Record<string, unknown>[]
}

export function emitKotlin(
  program: Program,
  options?: { wake?: WakeGroup[] },
): string {
  // the prelude helpers this program calls, recorded where each call is written (KOTLIN_HELPERS)
  const needs = new Set<KotlinHelper>()
  // the `+`, `-` and `*` nodes proven not to overflow (compile/proven.ts): written as the plain operator. The counted
  // steps here, joined below by the interval fact once the list facts it reads are known
  let provenSteps: Proven = provenIncrements(program)
  // the counted loops whose calls to a bounded task may run its unchecked copy (ir/facts/bounds.ts), the calls in the
  // copy being emitted, the tasks some such call reached, and whether the body being emitted is an unchecked copy
  // no lend facts: a fast copy of a task that takes a list is emitted under its own name, which this backend's list
  // facts (the lent, fixed and borrowed parameters, all keyed by task) do not reach, so only tasks that take no list
  // run unchecked here. TypeScript keys no list representation by task and passes them
  const loopGuards = boundedLoops(program)
  // where a record is copied so a write through one name cannot reach another (backend.ts, `recordCopies`)
  const copies = recordCopies(program)
  // the text expressions proven ASCII, read by index (ir/facts/text.ts)
  const asciiNodes = asciiTexts(program)
  let fastCalls = new Set<object>()
  const fastTasks = new Set<string>()
  let uncheckedInts = false
  // the lists the loop copy being emitted indexes with `toInt()`: its guard proved every index inside them, keyed by
  // `listKey` (a variable's name, or a path's key)
  let intLists = new Set<string>()
  // the lists reached through a path that the loop copy being emitted read once before it, each by its key, and the
  // count for their locals' names
  let hoisted = new Map<string, string>()
  let pathCount = 0
  // the text locals of the task being emitted that are built only by appending: StringBuilders (`textBuilders`)
  let builders = new Set<string>()
  // the texts this task reads through a cursor (backend.ts, `textCursors`)
  let cursors: TextCursors = { names: [], reads: new Map() }
  let redeclared = new WeakSet<Statement>()
  // the field names some assignment in the program writes (`save p/x, ...`): every other field is a `val`
  const assignedFields = fieldsAssigned(program)
  // the slot writes of a record that assign the changed fields of the object already there (compile/place.ts): no
  // allocation per write. Their fields are written, so they are `var` too
  const places = recordPlaces(program).writes

  for (const place of places.values()) {
    place.fields.forEach(f => assignedFields.add(f.name))
  }

  // a record built in the object its task was given, where the caller's slot is written with it at once
  // (compile/place.ts, `recordReuse`): the sites call the task's reusing copy, and that form's fields are `var`
  const reuse = recordReuse(program)
  // the tasks whose every self call is a tail call (backend.ts, `tailTasks`)
  const tailCalls = tailTasks(program)
  const reuseTasks = new Set<string>()
  // set while a reusing copy is emitted: its record parameter, and the builds it makes in that object
  let reusing: { param: string; builds: WeakSet<object>; keep?: string; carriers?: WeakSet<object> } | undefined
  // the carrier locals of the task being emitted that hold their kept field alone, to that field's name
  let carrierLocals = new Map<string, string>()

  for (const n of program) {
    if (n.form === 'record-type' && reuse.forms.has(n.name)) {
      n.fields.forEach(f => assignedFields.add(f.name))
    }
  }

  // the names the function being emitted reassigns, for `var` against `val`; undefined at module level
  let fnAssigned: Set<string> | undefined
  // the tasks this program defines with a body: their emitted result type is exactly what the checker says
  const bodiedTasks = new Set(program.flatMap(n => (n.form === 'function' && n.body.length > 0 ? [n.name] : [])))
  const inlineTasks = inlinable(program)
  const need = (helper: KotlinHelper, code: string): string => {
    needs.add(helper)

    return code
  }

  // when the stdlib hive is in the program, every new raise tells it (the throw lowering), and the compiler can
  // emit the wake chain (`wakeHive`) from the roll the driver hands over
  const hasHiveTell = program.some(
    n => n.form === 'function' && n.name === 'hive-tell',
  )

  const pad = (d: number) => '    '.repeat(d)
  // opaque per-backend handle types (`dock type / load <java.lang.Process>, name child-handle`): seed name -> concrete
  // kotlin type, so a `like child-handle` field emits the real handle type rather than a nonexistent class.
  const opaqueTypes = new Map<string, string>(
    program
      .filter(
        (n): n is Extract<Statement, { form: 'native' }> =>
          n.form === 'native' && n.kind === 'type',
      )
      .map(n => [n.alias, n.module === 'any' ? 'Any' : n.module]),
  )

  // how many type parameters each generic form declares, for a reference that names the form without them
  const genericArity = new Map<string, number>(
    program
      .filter((n): n is Extract<Statement, { form: 'record-type' }> => n.form === 'record-type')
      .map(n => [n.name, n.params?.length ?? 0]),
  )

  // every known function's declared parameter types, for filling a left-out trailing `need false` argument
  const functionParams = new Map<string, (Type | undefined)[]>(
    program
      .filter(
        (n): n is Extract<Statement, { form: 'function' }> =>
          n.form === 'function',
      )
      .map(n => [n.name, n.params.map(p => p.type)]),
  )

  // the names bound locally in the function being emitted: its parameters, its lets, its closures' parameters.
  // A top-level task named as a VALUE (`call on-message / read made / read dispatch`) is a function reference in
  // Kotlin, `::dispatch`, and a bare name only when a local shadows the task
  const localNames = new Set<string>()

  // the `note async` tasks, whether the code being emitted is a suspend body (a `note async` task or closure), and
  // whether the expression being emitted is the operand of a `wait true`
  const asyncFns = new Set(
    program.flatMap(node => (node.form === 'function' && node.async ? [node.name] : [])),
  )
  let suspendContext = false
  let awaiting = false

  // declarative native bindings render their `case kotlin` template at call sites
  const binds = collectBinds(program)

  // the Kotlin subclass for a variant label, and each variant's field names (for construction / smart-cast access)
  const variantClass = new Map<string, string>()
  const variantFieldNames = new Map<string, string[]>()
  // a counter for the locals a `when` binds its subject to
  let matchCount = 0
  // the enclosing function's declared result, so a `return <unknown-typed value>` can cast at the gradual
  // boundary (`read mock/dock` returned as `like mock-data`)
  let currentResult: Type | undefined
  // the declared generics of the function being emitted (`head t` as `T`), so a construction pins a type argument only
  // when that argument means something where the code lands. An inlined generic task leaves its own `t` in the checked
  // type of a construction it built (`make-signal` inlined into `counter` gave `Signal<T>` in a function with no `T`)
  let scopeGenerics = new Set<string>()
  // the forms a `fill` / `melt` with a form walks, gathered while the bodies are emitted
  const fillSpecs = new Map<string, FormSpec>()
  const meltSpecs = new Map<string, FormSpec>()
  // every struct form's declared fields, for a construction that leaves some out
  const recordFields = new Map<string, { name: string; type: Type }[]>(
    program
      .filter((n): n is Extract<Statement, { form: 'record-type' }> => n.form === 'record-type' && n.variants.length === 0)
      .map(n => [n.name, n.fields]),
  )
  // the `mark shared` forms: a reference by design, written in place
  const sharedForms = new Set(program.flatMap(n => (n.form === 'record-type' && n.shared ? [n.name] : [])))

  // a generic type parameter (`like t`), as opposed to a form the program declares
  const genericLetter = (type: Type | undefined): boolean =>
    type?.kind === 'variable' ||
    (type?.kind === 'named' && /^[a-z]$/.test(type.name) && !type.args?.length && !recordFields.has(type.name))
  // the value answered by an untyped SHIM: a call to a Term task, or to a `dock load` module, awaited or not. A built-in
  // collection operation is neither: its value is already the element type
  const nativeAliases = new Set(
    program.flatMap(n => (n.form === 'native' && n.kind !== 'type' ? [n.alias] : [])),
  )
  const isCallValue = (value: Expression): boolean => {
    const call = value.form === 'await' ? value.expr : value

    return (
      call.form === 'call' &&
      ((call.callee.form === 'variable' && !nativeAliases.has(call.callee.name)) ||
        (call.callee.form === 'member' &&
          call.callee.target.form === 'variable' &&
          nativeAliases.has(call.callee.target.name)))
    )
  }

  // generic tasks with a type parameter that no parameter mentions (`make-sorted-map` names `v` only in its result):
  // the call alone cannot tell Kotlin what it is
  const hiddenGeneric = new Set<string>(
    program
      .filter(
        (n): n is Extract<Statement, { form: 'function' }> =>
          n.form === 'function' && n.generics.length > 0,
      )
      .filter(n => {
        const seen = JSON.stringify(n.params.map(p => p.type ?? null))
        return n.generics.some(g => !seen.includes(`"name":"${g.name}"`))
      })
      .map(n => n.name),
  )

  // a `let` bound to a call that cannot name its own type arguments (no arguments at all, or a task with a hidden
  // type parameter) whose type the checker knows concretely as a generic application
  const uninferableCall = (node: Extract<Statement, { form: 'let' }>): boolean => {
    const call =
      node.init.form === 'call' ? node.init : node.init.form === 'await' && node.init.expr.form === 'call' ? node.init.expr : undefined

    return (
      call !== undefined &&
      (call.args.length === 0 || (call.callee.form === 'variable' && hiddenGeneric.has(call.callee.name))) &&
      node.type?.kind === 'named' &&
      (node.type.args?.length ?? 0) > 0 &&
      !node.type.args!.some(
        a => (a.kind === 'variable' && varNames.has(a.id)) || a.kind === 'unknown' || (a.kind !== 'variable' && genericLetter(a)),
      )
    )
  }

  // a binding's type with every type argument nothing constrains written `Nothing`: it is any type (a deque made and
  // only asked whether it is empty)
  const spellClosed = (type: Type): string => {
    const free = new Set<number>()
    collectVars(type, free)
    const saved = varNames
    varNames = new Map([...saved, ...[...free].filter(id => !saved.has(id)).map(id => [id, 'Nothing'] as const)])
    const text = kotlinType(type)
    varNames = saved

    return text
  }

  // a list whose element is an integer, known where it is built: held as `TermLongs`, one LongArray (the `longs` helper)
  const longList = (type: Type | undefined): boolean => type?.kind === 'array' && kotlinType(type.element) === 'Long'

  // the empty value of a type: what a left-out field holds
  const emptyOf = (type: Type | undefined): string => {
    switch (type?.kind) {
      case 'string':
        return '""'
      case 'boolean':
        return 'false'
      case 'number':
        return '0L'
      case 'float':
        return '0.0'
      case 'bytes':
        return 'ByteArray(0)'
      case 'array':
        return longList(type) ? need('longs', 'mutableLongListOf()') : 'mutableListOf()'
      case 'map':
        return 'mutableMapOf()'
      case 'named':
        if (type.name === 'text') {
          return '""'
        }

        if (type.name === 'boolean') {
          return 'false'
        }

        if (type.name === 'number' || type.name === 'integer') {
          return '0L'
        }

        if (type.name === 'decimal') {
          return '0.0'
        }

        if (type.name === 'maybe') {
          return 'MaybeNone'
        }

        if (type.name === 'list') {
          return 'mutableListOf()'
        }

        if (type.name === 'hash') {
          return 'mutableMapOf()'
        }

        return '0L'
      default:
        return '0L'
    }
  }
  // a label several enums share (`text` on both `token` and `data`): the class by owner, steered by the checked type
  const variantClassOf = new Map<string, Map<string, string>>()
  const classFor = (label: string, type: Type | undefined): string | undefined =>
    (type?.kind === 'named' ? variantClassOf.get(label)?.get(type.name) : undefined) ?? variantClass.get(label)

  // every form name's pascal spelling: a variant subclass (`Seed` + `text` -> `SeedText`) that lands on a
  // REAL form's name (`seed-text` -> `SeedText`) gets a `Case` suffix, or kotlin refuses the redeclaration
  const formPascals = new Set(
    program
      .filter((n): n is Extract<Statement, { form: 'record-type' }> => n.form === 'record-type')
      .map(n => pascal(n.name)),
  )

  for (const node of program) {
    if (node.form !== 'record-type') {
      continue
    }

    for (const v of node.variants) {
      const plain = `${pascal(node.name)}${pascal(v.name)}`
      const cls = formPascals.has(plain) ? `${plain}Case` : plain
      variantClass.set(v.name, cls)
      variantClassOf.set(
        v.name,
        (variantClassOf.get(v.name) ?? new Map<string, string>()).set(node.name, cls),
      )
      variantFieldNames.set(
        v.name,
        v.fields.map(f => f.name),
      )
    }
  }

  // traits (masks) emit as interfaces; a form that implements one declares it on its `data class` with override methods
  // that delegate to the free implementation functions; and a trait-bounded generic gains an interface bound so a
  // generic trait-method call lowers to `x.method(..)`. Kotlin has no `Self` type, so a method parameter or result
  // that is the receiver type is widened to the interface (with a downcast in the override, valid because trait
  // dispatch only reaches a method through the right instance). See note/seed/compiler/trait-dictionary-passing.md.
  const maskMethods = new Set<string>()

  for (const node of program) {
    if (node.form === 'mask') {
      for (const m of node.methods) {
        maskMethods.add(m)
      }
    }
  }

  // F1, the fixed-length slice (backend.ts, `fixedLists`): an integer list a task owns outright and never grows, or a
  // lent parameter every caller fills with one, is a plain `LongArray`, where every other list is a `MutableList<Long>`
  // reached through the interface. `xs[i]`, `xs.size` and a walk read the same on both
  // the primitive array a fixed list of this element is: `LongArray` for an integer, `DoubleArray` for a decimal,
  // `BooleanArray` for a flag (AWFY's Sieve: a `MutableList<Boolean>` read each flag through the interface and unboxed it)
  type ArrayKind = 'Long' | 'Double' | 'Boolean'
  // what a variant's array field holds: a primitive array, or `Object`, an `Array<T>` (`variantArrays`)
  type HeldKind = ArrayKind | 'Object'
  const arrayKind = (t: Type | undefined): ArrayKind | undefined =>
    t?.kind === 'number' || (t?.kind === 'named' && (t.name === 'number' || t.name === 'integer'))
      ? 'Long'
      : t?.kind === 'float' || (t?.kind === 'named' && t.name === 'decimal')
        ? 'Double'
        : t?.kind === 'boolean'
          ? 'Boolean'
          : undefined
  const listGates = gatedTasks(program, maskMethods)
  const { lend: lendParams, fresh: freshLists } = listFacts(program, listGates)
  provenSteps = provenArithmetic(program, lendParams, freshLists)
  // what a fixed list of this element is held as: its primitive array, or an `Array<T>` for any element whose type names
  // no type variable (an `Array<T>` of a type parameter cannot be made without reifying it). A fixed list is an owned
  // local or a lent parameter, mentioned only for its size, a slot, a walk or a lent argument (`ownedLocals`), so it is
  // never compared or printed, where an array would differ from the list by comparing by reference
  const concrete = (t: Type | undefined): boolean => {
    if (!t || t.kind === 'variable') return false
    // every type a type nests: an element, a key and a value, type arguments, a function's parameters and result
    const loose = t as unknown as { element?: Type; key?: Type; value?: Type; args?: Type[]; params?: Type[]; result?: Type }
    const nested = [loose.element, loose.key, loose.value, loose.result, ...(loose.args ?? []), ...(loose.params ?? [])].filter((x): x is Type => x !== undefined)

    return nested.every(concrete)
  }
  const fixedKind = (t: Type | undefined): HeldKind | undefined => arrayKind(t) ?? (concrete(t) ? 'Object' : undefined)
  // a generated list starts full (`listGenerator`), since this backend makes it in one construction
  const fixed = fixedLists(program, lendParams, freshLists, t => fixedKind(t) !== undefined, true)
  // the primitive-array names of the function being emitted, its fixed locals and parameters, each with its kind
  let arrayNames = new Map<string, HeldKind>()
  // the walks by position written so far, for their locals' names (`__walked0`, `__at0`)
  let walkCount = 0
  // the variants whose nodes are reused (`kotlinReuse`), and the match subjects of the task being emitted that were taken
  // from a list slot at their last read (backend.ts, `slotTakes`): a node so taken, of such a variant, is dead once its
  // arm has read its fields and written its slot back
  const reuseVariants = kotlinReuse(program)
  // the plain records' lists of `Long` the record owns (backend.ts, `ownedFields`), each typed `TermLongs` and read and
  // written through `getLong` and `setLong`: through the List interface every read and write of one boxed, Particle 391
  // ms to 307 (`tmp/kotlin-particle-ab.ts`). A form whose values cross into native code keeps the interface
  const ownedAll = ownedFields(program, freshLists, lendParams, privateForms(program, lendParams, freshLists))
  const fieldLists = new Set(
    [...ownedAll].filter(key => {
      const [formName, fieldName] = key.split('/') as [string, string]
      const form = program.find(n => n.form === 'record-type' && n.name === formName)
      const field = form?.form === 'record-type' && form.variants.length === 0 && !form.shared ? form.fields.find(f => f.name === fieldName) : undefined

      // a `number` element is the Long Kotlin holds as TermLongs (`kotlinType` is not defined yet here)
      return field?.type.kind === 'array' && field.type.element.kind === 'number'
    }),
  )
  // a variant's own list of a primitive element that is only ever read, held as the primitive array it is (`LongArray`,
  // `DoubleArray`, `BooleanArray`), keyed `variant/field` with its kind: a leaf one object lighter, Storage 305 ms to
  // 261 (`tmp/kotlin-storage-ab3.ts`). The variant owns it (`ownedFields`), so nothing else can see whether it is
  // copied, and every local an arm binds it to is only sized, indexed or walked, so its size never changes. Decided for
  // the program, since the field has one type: a local that does anything else, or whose name the task also binds
  // another way (the array names are kept per task, by name), leaves the field a list. The arm locals become array
  // names of their tasks (`armArrays`), read through the fixed-list paths that already exist
  // `Object` is a list of anything else, held as an `Array<T>`: taken only where every construction makes the array
  // directly (checked below, once `generatorAt` exists), so no copy is ever added
  const variantArrays = new Map<string, HeldKind>()
  const armArrays = new Map<string, Map<string, HeldKind>>()
  // the arms that bound each key, so a key dropped later takes its arm locals with it
  const armsOf = new Map<string, { fn: string; local: string }[]>()
  // each variant's fields with their types, for an `Array<T>` field's element
  const variantFieldTypes = new Map<string, { name: string; type: Type }[]>()
  {
    const variantsOf = new Map<string, { fields: { name: string; type: Type }[]; generic: boolean }>()

    for (const n of program) {
      if (n.form === 'record-type') {
        for (const v of n.variants) {
          variantsOf.set(v.name, { fields: v.fields, generic: n.params.length > 0 })
          variantFieldTypes.set(v.name, v.fields)
        }
      }
    }

    for (const key of ownedAll) {
      const [variant, field] = key.split('/') as [string, string]
      const shape = variantsOf.get(variant)
      const type = shape?.fields.find(f => f.name === field)?.type
      // a primitive element is its primitive array; anything concrete else an `Array<T>`, pending its constructions
      const kind = !shape?.generic && type?.kind === 'array' ? (arrayKind(type.element) ?? (type.element.kind === 'variable' ? undefined : 'Object')) : undefined

      if (kind) {
        variantArrays.set(key, kind)
      }
    }

    // whether every mention of `local` in an arm's body only sizes, indexes or walks it, outside any closure
    const onlyArrayUses = (body: unknown, local: string): boolean => {
      let ok = true
      const visit = (value: unknown, parent: Record<string, unknown> | undefined, key: string): void => {
        if (!ok || typeof value !== 'object' || value === null) {
          return
        }

        if (Array.isArray(value)) {
          value.forEach(v => visit(v, parent, key))

          return
        }

        const node = value as Record<string, unknown> & { form?: string; name?: string }

        if (node.form === 'variable' && node.name === local) {
          const sized = parent?.form === 'call' && key === 'args' && (parent.callee as { name?: string }).name === 'list_size' && (parent.args as unknown[])[0] === node
          // a slot by an index, or a literal one (`items/1`, a numeric name)
          const indexed = parent?.form === 'member' && key === 'target' && (parent.index !== undefined || /^\d+$/.test(parent.name as string))
          const counted = parent?.form === 'member' && key === 'target' && collectionRead(parent as unknown as Expression) !== undefined
          const walked = parent?.form === 'for-each' && key === 'iterable'

          if (!sized && !indexed && !counted && !walked) {
            ok = false
          }

          return
        }

        // a closure that reads it could hand it anywhere, later
        if (node.form === 'closure') {
          const reads = (inner: unknown): boolean => {
            if (typeof inner !== 'object' || inner === null) return false
            if (Array.isArray(inner)) return inner.some(reads)
            const n = inner as Record<string, unknown> & { form?: string; name?: string }
            if (n.form === 'variable' && n.name === local) return true
            return Object.entries(n).some(([k, child]) => k !== 'type' && k !== 'span' && reads(child))
          }

          if (reads(node.body)) {
            ok = false
          }

          return
        }

        for (const [k, child] of Object.entries(node)) {
          if (k !== 'type' && k !== 'span') {
            visit(child, node, k)
          }
        }
      }

      visit(body, undefined, '')

      return ok
    }

    // every name a task binds other than as an arm's field: its parameters, `let`s, walk items, closure parameters
    const otherNames = (fn: Extract<Statement, { form: 'function' }>): Set<string> => {
      const names = new Set(fn.params.map(p => p.name))
      const visit = (value: unknown): void => {
        if (typeof value !== 'object' || value === null) return
        if (Array.isArray(value)) return value.forEach(visit)
        const node = value as Record<string, unknown> & { form?: string; name?: string }
        if (node.form === 'let') names.add(node.name as string)
        if (node.form === 'for-each') {
          names.add(node.item as string)
          if (typeof node.index === 'string') names.add(node.index)
        }
        if (node.form === 'closure') for (const p of (node.params as { name: string }[]) ?? []) names.add(p.name)
        for (const [k, child] of Object.entries(node)) if (k !== 'type' && k !== 'span') visit(child)
      }
      visit(fn.body)

      return names
    }

    // each arm binding such a field, checked; one failure leaves the field a list everywhere
    const arms: { fn: string; local: string; key: string; others: Set<string>; armNames: Map<string, string> }[] = []

    for (const fn of program) {
      if (fn.form !== 'function') {
        continue
      }

      const others = otherNames(fn)
      // every arm local of the task by name, with the field key it is bound to (a local bound to two keys refuses)
      const armNames = new Map<string, string>()
      const visit = (value: unknown): void => {
        if (typeof value !== 'object' || value === null) return
        if (Array.isArray(value)) return value.forEach(visit)
        const node = value as Record<string, unknown> & { form?: string }

        if (node.form === 'match') {
          for (const c of node.cases as { label: string; binds?: string[]; body: Statement[] }[]) {
            const shape = variantsOf.get(c.label)

            for (const { field, local } of shape ? armLocals(shape.fields.map(f => f.name), c.binds ?? []) : []) {
              const key = `${c.label}/${field}`
              const before = armNames.get(local)

              armNames.set(local, before === undefined || before === key ? key : '')

              if (variantArrays.has(key)) {
                if (!onlyArrayUses(c.body, local)) {
                  variantArrays.delete(key)
                }

                arms.push({ fn: fn.name, local, key, others, armNames })
              }
            }
          }
        }

        for (const [k, child] of Object.entries(node)) if (k !== 'type' && k !== 'span') visit(child)
      }

      visit(fn.body)
    }

    for (const arm of arms) {
      if (arm.others.has(arm.local) || arm.armNames.get(arm.local) !== arm.key) {
        variantArrays.delete(arm.key)
      }
    }

    for (const arm of arms) {
      const kind = variantArrays.get(arm.key)

      if (kind) {
        armArrays.set(arm.fn, new Map([...(armArrays.get(arm.fn) ?? []), [arm.local, kind]]))
        armsOf.set(arm.key, [...(armsOf.get(arm.key) ?? []), { fn: arm.fn, local: arm.local }])
      }
    }
  }
  // a path `r/field` to a list of `Long` the record owns
  const ownedPath = (target: Expression): boolean =>
    target.form === 'member' &&
    target.index === undefined &&
    target.target.type?.kind === 'named' &&
    fieldLists.has(`${target.target.type.name}/${target.name}`)
  let takenSubjects = new WeakMap<object, unknown>()
  // the field-less case of a form, which `slotTakes` asks for
  const emptyCaseOf = (type: Type | undefined): { form: string; empty: string } | undefined => {
    const form = type?.kind === 'named' ? program.find(n => n.form === 'record-type' && n.name === type.name) : undefined
    const empty = form?.form === 'record-type' ? form.variants.find(v => v.fields.length === 0) : undefined

    return form && empty ? { form: form.name, empty: empty.name } : undefined
  }
  // a fixed list of this kind taken from a fresh task's result: one copy of the storage
  const toArray = (kind: HeldKind, list: string): string =>
    kind === 'Long' ? need('longs', `termLongArray(${list})`) : kind === 'Object' ? `(${list}).toTypedArray()` : `(${list}).to${kind}Array()`
  // the tasks that only fill a list (backend.ts, `fillTasks`), and the one-allocation form of a call to one: the
  // primitive array itself where a fixed list takes it, where the list was built boxed and then copied. Only for an
  // item that is a literal or a name, since the initializer runs once per element
  const fills = fillTasks(program)
  const filled = (node: Expression, kind?: HeldKind): string | undefined => {
    const fill = node.form === 'call' && node.callee.form === 'variable' && !localNames.has(node.callee.name) ? fillCall(node, fills) : undefined

    if (!fill || !['variable', 'integer', 'float', 'boolean', 'string'].includes(fill.item.form)) {
      return undefined
    }

    const size = fill.size.form === 'integer' ? `${Math.max(Number(fill.size.value), 0)}` : `Math.toIntExact(maxOf(${expr(fill.size)}, 0L))`
    // a primitive array starts at its kind's zero, so a fill with that zero is the array alone, with no initializer
    const zero =
      (fill.item.form === 'integer' && Number(fill.item.value) === 0) ||
      (fill.item.form === 'float' && Number(fill.item.value) === 0 && !Object.is(Number(fill.item.value), -0)) ||
      (fill.item.form === 'boolean' && fill.item.value === false)

    // an `Array<T>` has no zero of its own: every slot runs the initializer
    if (kind === 'Object') {
      return `Array(${size}) { ${expr(fill.item)} }`
    }

    if (kind && zero) {
      return `${kind}Array(${size})`
    }

    return kind ? `${kind}Array(${size}) { ${expr(fill.item)} }` : `MutableList(${size}) { ${expr(fill.item)} }`
  }

  // A list GENERATED by a counted loop (backend.ts, `listGenerator`) is written as one sized construction:
  // `MutableList(n) { e }`, which runs `e` for each index in the same order and makes the list at its size, where it grew
  // from capacity 10 (Storage's kids 271 ms to 258, `tmp/kotlin-storage-ab4.ts`); a fixed list's own array where the list
  // is fixed (`fixedLists`); and an `Array<T>` where its one use is a variant's array field (`arrayGenerators`). A list of
  // `Long` that is not fixed keeps its `TermLongs`
  const generatorAt = listGenerator
  // the generators whose list is written as an `Array<T>`, since its one use is a variant's array field (`variantArrays`)
  const arrayGenerators = new WeakSet<object>()

  // an `Object` array field is kept only where every construction makes the array directly: an empty list, a fill, or a
  // generator's list that nothing but its push and this construction mentions. Anything else leaves it a list, with its
  // arm locals, so no copy is ever added
  {
    const constructions = new Map<string, { fn: Extract<Statement, { form: 'function' }>; value: Expression }[]>()

    for (const fn of program) {
      if (fn.form !== 'function') continue
      const visit = (value: unknown): void => {
        if (typeof value !== 'object' || value === null) return
        if (Array.isArray(value)) return value.forEach(visit)
        const node = value as { form?: string; name?: string; fields?: { name: string; value: Expression }[] }
        if (node.form === 'record') {
          for (const f of node.fields ?? []) {
            const key = `${node.name}/${f.name}`
            if (variantArrays.get(key) === 'Object') constructions.set(key, [...(constructions.get(key) ?? []), { fn, value: f.value }])
          }
        }
        for (const [k, child] of Object.entries(node)) if (k !== 'type' && k !== 'span') visit(child)
      }
      visit(fn.body)
    }

    // the generator that makes `name` in `fn`, if any, found in whichever statement list declares it
    const generatorOf = (fn: Extract<Statement, { form: 'function' }>, name: string): Statement | undefined => {
      let found: Statement | undefined
      const visit = (value: unknown): void => {
        if (found || typeof value !== 'object' || value === null) return
        if (Array.isArray(value)) {
          value.forEach((s, at) => {
            const node = s as { form?: string; name?: string }
            if (!found && node?.form === 'let' && node.name === name && generatorAt(value as Statement[], at, fn)?.list === name) found = s as Statement
          })
          value.forEach(visit)
          return
        }
        for (const [k, child] of Object.entries(value)) if (k !== 'type' && k !== 'span') visit(child)
      }
      visit(fn.body)
      return found
    }
    const mentions = (fn: Extract<Statement, { form: 'function' }>, name: string): number => {
      let count = 0
      const visit = (value: unknown): void => {
        if (typeof value !== 'object' || value === null) return
        if (Array.isArray(value)) return value.forEach(visit)
        const node = value as { form?: string; name?: string }
        if (node.form === 'variable' && node.name === name) count++
        for (const [k, child] of Object.entries(node)) if (k !== 'type' && k !== 'span') visit(child)
      }
      visit(fn.body)
      return count
    }

    for (const [key, kind] of [...variantArrays]) {
      if (kind !== 'Object') continue
      const made: Statement[] = []
      const direct = (constructions.get(key) ?? []).every(({ fn, value }) => {
        if ((value.form === 'array' && value.items.length === 0) || (value.form === 'record' && value.name === 'list' && value.fields.length === 0)) return true
        if (value.form === 'call' && value.callee.form === 'variable' && fillCall(value, fills)) return true
        if (value.form !== 'variable') return false
        const generator = generatorOf(fn, value.name)
        // the push and this construction, and nothing else
        if (!generator || mentions(fn, value.name) !== 2) return false
        made.push(generator)
        return true
      })

      if (!direct) {
        variantArrays.delete(key)

        for (const { fn, local } of armsOf.get(key) ?? []) {
          armArrays.get(fn)?.delete(local)
        }

        continue
      }

      made.forEach(m => arrayGenerators.add(m))
    }
  }
  // the task being emitted, which a generator is checked against
  let currentFn: Extract<Statement, { form: 'function' }> | undefined

  type Instance = Extract<Statement, { form: 'instance' }>
  const conformances = new Map<string, Instance[]>()
  const instanceTargets = new Map<string, string[]>()

  for (const node of program) {
    if (node.form === 'instance') {
      const list = conformances.get(node.target) ?? []
      list.push(node)
      conformances.set(node.target, list)

      const targets = instanceTargets.get(node.mask) ?? []
      targets.push(node.target)
      instanceTargets.set(node.mask, targets)
    }
  }

  type Fn = Extract<Statement, { form: 'function' }>
  const implFn = new Map<string, Fn>()

  for (const node of program) {
    if (node.form === 'function' && node.method) {
      implFn.set(`${node.method.form}:${node.method.name}`, node)
    }
  }

  let varNames = new Map<number, string>()

  const kotlinType = (type: Type | undefined): string => {
    switch (type?.kind) {
      case 'boolean':
        return 'Boolean'
      case 'string':
        return 'String'
      case 'unit':
      case undefined:
        return 'Unit'
      case 'array':
        // the stdlib list mutates in place (push / pop), so it lowers to a mutable, reference-typed collection
        return `MutableList<${kotlinType(type.element)}>`
      case 'map':
        return `MutableMap<${kotlinType(type.key)}, ${kotlinType(
          type.value,
        )}>`

      case 'named': {
        const opaque = opaqueTypes.get(type.name)

        if (opaque) {
          return opaque
        }

        // the seed primitives written by name (`like text` on a module-level binding reaches here unseeded)
        const primitive = KOTLIN_PRIMITIVES[type.name]

        if (primitive) {
          return primitive
        }

        if (type.args && type.args.length > 0) {
          return `${pascal(type.name)}<${type.args.map(kotlinType).join(', ')}>`
        }

        // a generic form named without its arguments (`like maybe`): kotlin needs every parameter, so each is Any
        const arity = genericArity.get(type.name) ?? 0

        return arity > 0
          ? `${pascal(type.name)}<${Array.from({ length: arity }, () => 'Any').join(', ')}>`
          : pascal(type.name)
      }

      case 'function': {
        // an async function value is a `suspend` function type; calling it is a suspending call (no `.await`).
        const suspend = type.effects?.includes('async') ? 'suspend ' : ''

        return `${suspend}(${type.params
          .map(kotlinType)
          .join(', ')}) -> ${kotlinType(type.result)}`
      }
      case 'number':
        return 'Long'
      case 'float':
        return 'Double'
      case 'dynamic':
        return 'Any'
      case 'bytes':
        return 'ByteArray'
      case 'variable':
        // a free variable not in this function's scope: nothing concrete ever met it, only the gradual `unknown` /
        // `dynamic` (which unify without binding), so the faithful type is `Any`. It was `Long`, which made a
        // `make list` fed json items a `MutableList<Long>` where a declared `like list, like unknown` wanted `Any`
        return varNames.get(type.id) ?? 'Any'
      case 'unknown':
        // the declared dynamic (`like unknown` / `like any`): any value, so a hive entry's `base` can carry a record
        return 'Any'
      default:
        return 'Long'
    }
  }

  // the receiver type widened to the trait interface (Kotlin has no `Self`)
  const subSelfK = (
    t: Type | undefined,
    target: string,
    mask: string,
  ): Type | undefined => {
    if (!t) {
      return t
    }

    if (t.kind === 'named') {
      return t.name === target
        ? { kind: 'named', name: mask }
        : t.args
          ? { ...t, args: t.args.map(a => subSelfK(a, target, mask)!) }
          : t
    }

    if (t.kind === 'array') {
      return {
        kind: 'array',
        element: subSelfK(t.element, target, mask)!,
      }
    }

    if (t.kind === 'map') {
      return {
        kind: 'map',
        key: subSelfK(t.key, target, mask)!,
        value: subSelfK(t.value, target, mask)!,
      }
    }

    if (t.kind === 'function') {
      return {
        kind: 'function',
        params: t.params.map(p => subSelfK(p, target, mask)!),
        result: subSelfK(t.result, target, mask)!,
        effects: t.effects,
      }
    }

    return t
  }

  // an interface method requirement: `fun measure(): Long` (the receiver is the implicit `this`, so the first parameter
  // is dropped; remaining parameters keep their types, the receiver type widened to the interface)
  const interfaceMethod = (
    fn: Fn | undefined,
    target: string,
    mask: string,
  ): string => {
    if (!fn) {
      return ''
    }

    const rest = fn.params
      .slice(1)
      .map(
        p =>
          `${camel(p.name)}: ${kotlinType(subSelfK(p.type, target, mask))}`,
      )

    return `fun ${camel(fn.method!.name)}(${rest.join(', ')}): ${kotlinType(
      subSelfK(fn.result, target, mask),
    )}`
  }

  // an override that delegates to the free implementation function, downcasting any receiver-typed parameter back to
  // the concrete type the free function expects
  const overrideMethod = (
    fn: Fn | undefined,
    target: string,
    mask: string,
  ): string => {
    if (!fn) {
      return ''
    }

    const rest = fn.params
      .slice(1)
      .map(
        p =>
          `${camel(p.name)}: ${kotlinType(subSelfK(p.type, target, mask))}`,
      )

    const callArgs = [
      'this',
      ...fn.params
        .slice(1)
        .map(p =>
          p.type?.kind === 'named' && p.type.name === target
            ? `${camel(p.name)} as ${pascal(target)}`
            : camel(p.name),
        ),
    ]

    return `override fun ${camel(fn.method!.name)}(${rest.join(
      ', ',
    )}): ${kotlinType(subSelfK(fn.result, target, mask))} { return ${camel(
      fn.name,
    )}(${callArgs.join(', ')}) }`
  }

  const genericClause = (
    node: Extract<Statement, { form: 'function' }>,
  ): string => {
    const ids = new Set<number>()
    node.params.forEach(p => collectVars(p.type, ids))
    collectVars(node.result, ids)

    const declared = node.generics.map(g => g.name.toUpperCase())
    const pool = ['T', 'U', 'V', 'W', 'X', 'Y', 'Z', 'A', 'B', 'C']
    const used = new Set(declared)
    varNames = new Map()

    const fresh: string[] = []

    for (const id of ids) {
      const letter = pool.find(l => !used.has(l)) ?? `T${id}`
      used.add(letter)
      varNames.set(id, letter)
      // bounded `: Any`, so the letter is non-null and passes where a dynamic (Any) parameter is declared
      fresh.push(`${letter} : Any`)
    }

    const namedInSig = new Set<string>()

    const scan = (t: Type | undefined): void => {
      if (!t) {
        return
      }

      if (t.kind === 'named') {
        namedInSig.add(t.name.toUpperCase())
        t.args?.forEach(scan)
      } else if (t.kind === 'array') {
        scan(t.element)
      } else if (t.kind === 'map') {
        scan(t.key)
        scan(t.value)
      } else if (t.kind === 'function') {
        t.params.forEach(scan)
        scan(t.result)
      }
    }

    node.params.forEach(p => scan(p.type))
    scan(node.result)

    // a trait-bounded generic (`head t, need sizer`) adds its interface as a Kotlin upper bound (`T : Sizer`), so the
    // body's `x.measure()` resolves through it
    const needTrait = new Map<string, string>()

    for (const g of node.generics) {
      if (g.need) {
        needTrait.set(g.name.toUpperCase(), pascal(g.need))
      }
    }

    const kept = declared
      .filter(d => namedInSig.has(d))
      .map(d => (needTrait.has(d) ? `${d} : ${needTrait.get(d)}` : d))

    const all = [...kept, ...fresh]

    return all.length ? `<${all.join(', ')}> ` : ''
  }

  // an operand of a `Math.*Exact` call as a Long: an integer literal already is one (`5L`), anything else is
  // widened, which is free on an expression that is a Long already and picks the Long overload on one that is an Int
  // A variable of type `number` is declared Long, so it is written bare: kotlinc warned "redundant call of conversion
  // method" on every one
  // Known Long without a conversion: a variable or an element read of type `number`, integer arithmetic (a
  // `Math.*Exact` or a Long operator), and a call to a task this program defines with a body, whose emitted result
  // type is Long. A native call keeps the `.toLong()`, since its shim may answer an Int
  // a type a Double carries: the checker's float, or the `decimal` it was declared as
  const isDecimal = (type: Type | undefined): boolean =>
    type?.kind === 'float' || (type?.kind === 'named' && type.name === 'decimal')

  const longOf = (node: Expression): string => {
    const number = node.type?.kind === 'number'
    const defined = node.form === 'call' && node.callee.form === 'variable' && bodiedTasks.has(node.callee.name)
    const known =
      node.form === 'integer' ||
      (number && (node.form === 'variable' || (node.form === 'member' && node.index !== undefined) || node.form === 'binary' || defined))

    return known ? expr(node) : `(${expr(node)}).toLong()`
  }

  const expr = (node: Expression): string => {
    switch (node.form) {
      case 'integer':
        return `${node.value}L`
      case 'float':
        // a float literal needs a decimal point so it is a Double, not a Long
        // (JavaScript writes 1e21 and past as `1e+21`, already a float literal, which a `.0` would break)
        return Number.isInteger(node.value) && !/e/i.test(String(node.value))
          ? `${node.value}.0`
          : String(node.value)
      case 'boolean':
        return node.value ? 'true' : 'false'
      case 'string':
        // a `$` would open a Kotlin string template
        return JSON.stringify(node.value).replace(/\$/g, '\\$')
      case 'template':
        // one text value alone is that value, where the interpolation built a copy of it. Not a bare name, which
        // costs nothing to copy and would make `save t, text <{t}>` the self-assignment swiftc refuses
        if (node.parts.length === 1 && typeof node.parts[0] !== 'string' && node.parts[0]!.form !== 'variable' && textValued(node.parts[0]!)) {
          return expr(node.parts[0]!)
        }

        // `"a${x}b"`: chunks escaped as a Kotlin string with `$` escaped, expressions interpolated
        // a float interpolates as `termNumber` lays it out, the same text as every other backend
        return `"${node.parts
          .map(part =>
            typeof part === 'string'
              ? JSON.stringify(part).slice(1, -1).replace(/\$/g, '\\$')
              : part.type?.kind === 'float'
                ? need('number', `\${termNumber(${expr(part)})}`)
                : `\${${expr(part)}}`,
          )
          .join('')}"`
      case 'unit':
        return 'Unit'
      case 'null':
        return 'null'
      case 'variable':
        if (functionParams.has(node.name) && !localNames.has(node.name)) {
          return `::${camel(node.name)}`
        }

        // a text built by appending is a StringBuilder: read as its text
        if (builders.has(node.name)) {
          return `${camel(node.name)}.toString()`
        }

        return camel(node.name)
      case 'hole':
        return camel(node.name)
      case 'unary':
        // `-Long.MIN_VALUE` is MIN_VALUE again on the JVM, a different integer: negateExact stops instead
        if (node.op === '-' && node.operand.type?.kind === 'number') {
          return `Math.negateExact(${longOf(node.operand)})`
        }

        return `${node.op}${expr(node.operand)}`
      case 'binary': {
        // a sum, difference or product of two numbers is the integer one or the program stops: Kotlin's Long `+`
        // wraps in silence, a DIFFERENT integer. `Math.*Exact` throws instead. A literal operand is written as a
        // Long literal so two Int literals cannot pick the Int overload. note/term/proof-by-default/numbers.md
        const exact = { '+': 'addExact', '-': 'subtractExact', '*': 'multiplyExact' }[node.op as string]

        if (exact && node.left.type?.kind === 'number' && node.right.type?.kind === 'number' && !provenSteps.has(node) && !uncheckedInts) {
          return `Math.${exact}(${longOf(node.left)}, ${longOf(node.right)})`
        }

        // `Long.MIN_VALUE / -1` wraps to MIN_VALUE on the JVM; termDivide stops on it as every backend does. In a
        // task's unchecked copy the interval fact proved the divisor nonzero and every value inside the bound
        if (node.op === '/' && node.left.type?.kind === 'number' && node.right.type?.kind === 'number') {
          // the interval fact proved the divisor nonzero and the dividend known, which rules out `MIN / -1` too
          if (uncheckedInts || provenSteps.has(node)) {
            return `(${longOf(node.left)} / ${longOf(node.right)})`
          }

          return need('divide', `termDivide(${longOf(node.left)}, ${longOf(node.right)})`)
        }

        // two texts order by code point (note/term/stdlib/semantics.md). Kotlin's compareTo orders by UTF-16 unit,
        // which disagrees above the basic plane
        if (
          (node.op === '<' || node.op === '>' || node.op === '<=' || node.op === '>=') &&
          isText(node.left.type) &&
          isText(node.right.type)
        ) {
          return need('text', `(TermText.compare(${expr(node.left)}, ${expr(node.right)}) ${OP[node.op]} 0L)`)
        }

        return `(${expr(node.left)} ${OP[node.op]} ${expr(node.right)})`
      }

      case 'call': {
        // a call at a reuse site: the task's copy that builds its result in the object it is given
        if (reuse.sites.has(node) && node.callee.form === 'variable') {
          reuseTasks.add(node.callee.name)

          return expr({ ...node, callee: { ...node.callee, name: `${node.callee.name}-reuse` } } as Expression)
        }

        // a call to a task that only fills a list (`fillTasks`) is the one allocation, where the list was grown one push
        // at a time: AWFY's Storage, a list of 1 to 10 zeros per leaf, 349 ms to 301 (`tmp/kotlin-storage-ab.ts`)
        if (node.callee.form === 'variable' && !localNames.has(node.callee.name) && node.type?.kind === 'array') {
          const fill = fillCall(node, fills)

          if (fill && ['variable', 'integer', 'float', 'boolean', 'string'].includes(fill.item.form)) {
            return longList(node.type)
              ? need('longs', `termLongsFilled(${expr(fill.size)}, ${expr(fill.item)})`)
              : filled(node)!
          }
        }

        // a call the guarded loop copy may make unchecked (`LoopGuard.fast`): the task's copy with no overflow checks
        if (fastCalls.has(node) && node.callee.form === 'variable') {
          fastTasks.add(node.callee.name)

          return expr({ ...node, callee: { ...node.callee, name: `${node.callee.name}-fast` } } as Expression)
        }

        // whether this call sits directly under `wait true`, read before the arguments render their own calls
        const awaited = awaiting
        awaiting = false

        // `call fill / <data> / like <form>` and `call melt / <value> / like <form>`: a function per form, generated
        // from the form's fields at the end of the module (see kotlinFormWalk below)
        if (
          node.callee.form === 'variable' &&
          (node.callee.name === 'fill-form' || node.callee.name === 'melt-form') &&
          node.into
        ) {
          const spec = formSpec(node.into, recordFields)
          refuseAny(spec, 'Kotlin')
          const into = node.callee.name === 'fill-form' ? fillSpecs : meltSpecs
          specForms(spec, into)

          return node.callee.name === 'fill-form'
            ? `__fill${pascal(spec.form)}(${expr(node.args[0]!)}, "")`
            : `__melt${pascal(spec.form)}(${expr(node.args[0]!)})`
        }

        // a declarative native binding renders its `case kotlin` template
        if (
          node.callee.form === 'variable' &&
          binds.has(node.callee.name)
        ) {
          const bind = binds.get(node.callee.name)!

          // the code-point count of an ASCII text (ir/facts/text.ts) is its length, where `codePointCount` walked it
          if (node.callee.name === 'code-point-count' && node.args[0] && asciiNodes.has(node.args[0])) {
            return `${expr(node.args[0])}.length.toLong()`
          }

          return (
            renderBind(bind, 'kotlin', node.args.map(expr)) ??
            bindGap(bind.name)
          )
        }

        // a push onto a list of `Long` passes the value unboxed (`termPushLong`): through the generic `list_push` each
        // value was boxed for `add` (`tmp/kotlin-polygon-ab2.ts`)
        if (
          node.callee.form === 'variable' &&
          node.callee.name === 'list_push' &&
          node.args.length === 2 &&
          !(node.args[0]!.form === 'variable' && arrayNames.has(node.args[0]!.name)) &&
          longList(node.args[0]!.type)
        ) {
          return need('longs', `termPushLong(${expr(node.args[0]!)}, ${longOf(node.args[1]!)})`)
        }

        // the size of a fixed list (a LongArray) is its own; the stdlib's generic `list_size` takes a MutableList
        if (
          node.callee.form === 'variable' &&
          node.callee.name === 'list_size' &&
          node.args[0]?.form === 'variable' &&
          arrayNames.has(node.args[0].name)
        ) {
          return `${expr(node.args[0])}.size.toLong()`
        }

        // a native map / list operation lowers to kotlin's collection API
        const operation = collectionCall(node.callee)

        if (operation) {
          return collectionExpr(operation, node.args)
        }

        // a host string method (what `text.tree` delegates to) lowers to kotlin's String API
        const text = stringCall(node.callee)

        if (text) {
          // an ASCII text (ir/facts/text.ts) is read by index: a code point is one UTF-16 unit, where
          // `offsetByCodePoints` walked from the start
          // a read through the text's cursor (backend.ts, `textCursors`) steps from the last read
          const cursor = cursors.reads.get(node)

          if (cursor !== undefined && (text.op === 'substring' || text.op === 'slice')) {
            const to = node.args[1] ? expr(node.args[1]) : 'Long.MAX_VALUE'

            return need('text', `TermText.cursorSlice(${expr(text.target)}, ${expr(node.args[0]!)}, ${to}, __cursor${pascal(cursor)})`)
          }

          if (cursor !== undefined) {
            const read = text.op === 'charCodeAt' ? 'cursorCodeAt' : 'cursorCharAt'

            return need('text', `TermText.${read}(${expr(text.target)}, ${expr(node.args[0]!)}, __cursor${pascal(cursor)})`)
          }

          if (asciiNodes.has(text.target) && ['charAt', 'at', 'charCodeAt'].includes(text.op)) {
            const read = text.op === 'charCodeAt' ? 'asciiCodeAt' : 'asciiCharAt'

            return need('text', `TermText.${read}(${expr(text.target)}, ${expr(node.args[0]!)})`)
          }

          if (asciiNodes.has(text.target) && (text.op === 'substring' || text.op === 'slice')) {
            return need('text', `TermText.asciiSubstring(${[text.target, ...node.args].map(a => expr(a)).join(', ')})`)
          }

          // a search of an ASCII text answers a unit index, which is the code-point index
          if (asciiNodes.has(text.target) && text.op === 'indexOf') {
            const from = node.args[1] ? expr(node.args[1]) : '0L'

            if (from === '0L') {
              return `${expr(text.target)}.indexOf(${expr(node.args[0]!)}).toLong()`
            }

            return `${expr(text.target)}.let { h -> h.indexOf(${expr(node.args[0]!)}, (${from}).coerceIn(0L, h.length.toLong()).toInt()).toLong() }`
          }

          if (asciiNodes.has(text.target) && text.op === 'lastIndexOf') {
            return `${expr(text.target)}.lastIndexOf(${expr(node.args[0]!)}).toLong()`
          }

          return stringExpr(text.op, expr(text.target), node.args.map(a => expr(a)))
        }

        // a generic trait-method call lowers to an interface method call on the receiver: `x.measure(..)`. The receiver
        // is the first argument; concrete trait calls were already resolved to the free function by the checker.
        if (
          node.callee.form === 'variable' &&
          maskMethods.has(node.callee.name) &&
          node.args.length >= 1
        ) {
          const rest = node.args.slice(1).map(expr)

          return `${expr(node.args[0]!)}.${camel(node.callee.name)}(${rest.join(
            ', ',
          )})`
        }

        // a trailing `need false` parameter left out at the call site still exists in the native signature:
        // fill it with its type's empty value (Unit for an unknown)
        // a fixed list parameter (fixedLists) takes its LongArray as it is, and a fresh task's list converted once
        const fixedAt =
          node.callee.form === 'variable' && !localNames.has(node.callee.name) ? fixed.params.get(node.callee.name) : undefined
        // a record passed to a task that writes its fields is the task's own copy (D1, `recordCopies`): `.copy()`
        const recordWrites =
          node.callee.form === 'variable' && !localNames.has(node.callee.name) ? copies.params.get(node.callee.name) : undefined
        const rendered = node.args.map((a, i) => {
          const kind = fixedAt?.has(i) ? fixedKind(a.type?.kind === 'array' ? a.type.element : undefined) : undefined

          if (recordWrites?.has(i) && a.form !== 'record') {
            return `${expr(a)}.copy()`
          }

          return kind && !(a.form === 'variable' && arrayNames.has(a.name)) ? (filled(a, kind) ?? toArray(kind, expr(a))) : expr(a)
        })
        const declaredParams =
          node.callee.form === 'variable'
            ? functionParams.get(node.callee.name)
            : undefined

        if (declaredParams && declaredParams.length > rendered.length) {
          for (let i = rendered.length; i < declaredParams.length; i++) {
            const missing = declaredParams[i]

            rendered.push(
              missing === undefined || missing.kind === 'unknown'
                ? 'Unit'
                : emptyOf(missing),
            )
          }
        }

        // a generic value handed to an `unknown` parameter: a Kotlin `T` is nullable by default and `Any` is not, so
        // it crosses as `Any` explicitly. This is how a typed channel hands its message to the one untyped shim
        if (declaredParams) {
          node.args.forEach((arg, i) => {
            if (declaredParams[i]?.kind === 'unknown' && genericLetter(arg.type)) {
              rendered[i] = `(${rendered[i]} as Any)`
            }
          })
        }

        // a callee is called, never referenced: a bare name here, whatever `expr` would make of it as a value
        const callee = node.callee.form === 'variable' ? camel(node.callee.name) : expr(node.callee)

        // an async task called WITHOUT `wait true` from code that cannot suspend runs on its own and the caller goes on,
        // as a promise nobody awaits does on TypeScript: here a coroutine of its own (native-dom-0014: the blog's click
        // handler starting `add-post`). Inside a suspend body Kotlin awaits the call, as it always has
        if (
          node.callee.form === 'variable' &&
          asyncFns.has(node.callee.name) &&
          !localNames.has(node.callee.name) &&
          !awaited &&
          !suspendContext
        ) {
          return need('start', `termStart { ${callee}(${rendered.join(', ')}) }`)
        }

        return `${callee}(${rendered.join(', ')})`
      }

      case 'array': {
        // an empty collection literal gives kotlin nothing to infer from, so emit the element type explicitly. A full
        // one is left to Kotlin, which reads the element from the context: texts passed where a `like list, like
        // unknown` is taken are a `MutableList<Any>` there, which the checked `<String>` would not be (native-dom-0014)
        const args =
          node.items.length === 0 && node.type?.kind === 'array'
            ? `<${kotlinType(node.type.element)}>`
            : ''

        // an empty one spelled `<Long>` is committed to its element, so it is the LongArray list. A full one is not:
        // its element is read from the context, which may want `Any`
        if (args === '<Long>') {
          return need('longs', 'mutableLongListOf()')
        }

        return `mutableListOf${args}(${node.items.map(expr).join(', ')})`
      }

      case 'map': {
        const args =
          node.type?.kind === 'map'
            ? `<${kotlinType(node.type.key)}, ${kotlinType(
                node.type.value,
              )}>`
            : ''

        return `mutableMapOf${args}(${node.entries
          .map(e => `${expr(e.key)} to ${expr(e.value)}`)
          .join(', ')})`
      }

      case 'record': {
        // a build the reusing copy makes in the object it was given: every field computed first, since each may read
        // that object's old fields, then assigned on it
        // a carrier whose kept field is answered alone: its build made in place, then that field
        const build =
          reusing?.keep && reusing.carriers?.has(node) ? node.fields.find(f => reusing!.builds.has(f.value))?.value : reusing?.builds.has(node) ? node : undefined

        if (reusing && build?.form === 'record') {
          const temps = build.fields.map((f, i) => `val __reuse${i} = ${expr(f.value)}`)
          const sets = build.fields.map((f, i) => `${camel(reusing!.param)}.${camel(f.name)} = __reuse${i}`)
          const kept = build === node ? undefined : node.fields.find(f => f.name === reusing!.keep)?.value
          const answer = kept ? expr(kept) : camel(reusing.param)

          return `run { ${[...temps, ...sets, answer].join('; ')} }`
        }

        // `make hash` / `make list` with no binds are the native collections, not record constructions; the
        // checked type pins the element parameters where kotlin cannot infer them (a generic function body)
        if (node.name === 'hash' && node.fields.length === 0) {
          const args =
            node.type?.kind === 'map' &&
            node.type.key.kind !== 'variable' &&
            node.type.value.kind !== 'variable'
              ? `<${kotlinType(node.type.key)}, ${kotlinType(node.type.value)}>`
              : ''

          return `mutableMapOf${args}()`
        }

        if (node.name === 'list' && node.fields.length === 0) {
          // a still-FREE element stays unspelled, so kotlin infers it from the expected type at the use site
          const args =
            node.type?.kind === 'array' &&
            node.type.element.kind !== 'variable'
              ? `<${kotlinType(node.type.element)}>`
              : ''

          return args === '<Long>' ? need('longs', 'mutableLongListOf()') : `mutableListOf${args}()`
        }

        // `make void` is the absent value: kotlin's Unit, which an Any slot holds and `==` recognizes
        if (node.name === 'void' && node.fields.length === 0) {
          return 'Unit'
        }

        // an empty `make list` / `make hash` field value spells the DECLARED element type, since the
        // checker's gradual unify leaves it free and kotlin cannot infer it from a named argument
        const fieldValue = (name: string, value: Expression): string => {
          // a variant's own list held as a primitive array (`variantArrays`): a fill is the array itself, an empty list
          // an empty one, and anything else (a fresh list nothing else holds) its one copy
          const array = variantArrays.get(`${node.name}/${name}`)

          if (array) {
            const empty = (value.form === 'array' && value.items.length === 0) || (value.form === 'record' && value.name === 'list' && value.fields.length === 0)

            // an `Array<T>` is made directly by every construction (checked with `variantArrays`): empty, a fill, or a
            // generator's own array
            if (array === 'Object') {
              const declared = variantFieldTypes.get(node.name)?.find(f => f.name === name)?.type
              const element = declared?.kind === 'array' ? kotlinType(declared.element) : 'Any?'
              const fill = value.form === 'call' && value.callee.form === 'variable' ? fillCall(value, fills) : undefined

              if (empty) {
                return `emptyArray<${element}>()`
              }

              if (fill) {
                const size = fill.size.form === 'integer' ? `${Math.max(Number(fill.size.value), 0)}` : `Math.toIntExact(maxOf(${expr(fill.size)}, 0L))`

                return `Array<${element}>(${size}) { ${expr(fill.item)} }`
              }

              return expr(value)
            }

            return empty ? `${array}Array(0)` : (filled(value, array) ?? toArray(array, expr(value)))
          }

          // only for a non-generic form: a generic form's declared element is its own type parameter, which
          // the construction instantiates (spelling the letter literally would not resolve)
          if ((genericArity.get(node.name) ?? 0) > 0) {
            return expr(value)
          }

          const declaredType = recordFields
            .get(node.name)
            ?.find(f => f.name === name)?.type

          // a list of `Long` the record owns, as its field is typed (`fieldLists`)
          if (fieldLists.has(`${node.name}/${name}`)) {
            return need('longs', `termLongs(${expr(value)})`)
          }

          if (
            ((value.form === 'record' &&
              value.fields.length === 0 &&
              value.name === 'list') ||
              (value.form === 'array' && value.items.length === 0)) &&
            declaredType?.kind === 'array'
          ) {
            return longList(declaredType) ? need('longs', 'mutableLongListOf()') : `mutableListOf<${kotlinType(declaredType.element)}>()`
          }

          if (
            value.form === 'record' &&
            value.fields.length === 0 &&
            value.name === 'hash' &&
            declaredType?.kind === 'map'
          ) {
            return `mutableMapOf<${kotlinType(declaredType.key)}, ${kotlinType(declaredType.value)}>()`
          }

          // a whole-number literal in a field declared `decimal` is a Double: kotlin does not widen `1L` to one,
          // where Swift's literal adapts to its slot (native-text-0001, the font table's `scale 1`)
          if (value.form === 'integer' && isDecimal(declaredType)) {
            return `${value.value}.0`
          }

          return expr(value)
        }

        const cls = classFor(node.name, node.type)
        // a node of a reused variant is built in the spare a pop kept, when there is one (`reuseVariants`)
        const reusedVariant = cls ? reuseVariants.get(node.name) : undefined
        const builder = reusedVariant && node.fields.length === reusedVariant.fields.length ? `termReuse${cls}` : cls

        if (cls) {
          return node.fields.length > 0
            ? `${builder}(${node.fields
                .map(f => `${camel(f.name)} = ${fieldValue(f.name, f.value)}`)
                .join(', ')})`
            : cls
        }

        // a struct: a field the construction leaves out takes its type's empty value, so the data class is whole
        const declared = recordFields.get(node.name)

        if (declared) {
          const given = new Set(node.fields.map(f => f.name))
          // a list of `Long` the record owns left out is a new `TermLongs` (`fieldLists`)
          const missing = declared
            .filter(f => !given.has(f.name))
            .map(f => `${camel(f.name)} = ${fieldLists.has(`${node.name}/${f.name}`) ? need('longs', 'TermLongs(10)') : emptyOf(f.type)}`)
          const all = [...node.fields.map(f => `${camel(f.name)} = ${fieldValue(f.name, f.value)}`), ...missing]

          if (missing.length > 0) {
            return `${pascal(node.name)}(${all.join(', ')})`
          }
        }

        // a generic struct built from empty collections cannot infer its parameters; pin them from the checked type.
        // Not when an argument names a generic that is not in scope here: Kotlin infers those from the field values,
        // and naming them is an unresolved reference
        const strayGeneric = (t: Type): boolean =>
          t.kind === 'named'
            ? (!(t.args?.length) && !genericArity.has(t.name) && /^[a-z]$/.test(t.name) && !scopeGenerics.has(t.name.toUpperCase())) ||
              (t.args ?? []).some(strayGeneric)
            : t.kind === 'array'
              ? strayGeneric(t.element)
              : t.kind === 'map'
                ? strayGeneric(t.key) || strayGeneric(t.value)
                : false
        // nor when the checker left an argument open (unknown, dynamic, a free variable): pinned, it reads `Any`, and
        // `Pair<K, Any>` is refused where `Pair<K, V>` is wanted, which Kotlin would have inferred from the values
        const open = (t: Type): boolean => t.kind === 'unknown' || t.kind === 'dynamic' || t.kind === 'variable'
        const args =
          node.type?.kind === 'named' &&
          node.type.args?.length &&
          !node.type.args.some(strayGeneric) &&
          !node.type.args.some(open)
            ? `<${node.type.args.map(kotlinType).join(', ')}>`
            : ''

        return `${pascal(node.name)}${args}(${node.fields
          .map(f => `${camel(f.name)} = ${fieldValue(f.name, f.value)}`)
          .join(', ')})`
      }

      case 'member': {
        // the kept field of a carrier that holds it alone (compile/place.ts, `recordReuse`)
        if (node.target.form === 'variable' && node.index === undefined && carrierLocals.get(node.target.name) === node.name) {
          return camel(node.target.name)
        }

        // a list reached through a path that this loop copy read once before it
        if (hoisted.size > 0 && node.index === undefined && node.type?.kind === 'array') {
          const local = hoisted.get(listKey(node) ?? '')

          if (local) {
            return local
          }
        }

        // `map.size` / `array.length` lower to the platform's count property (as a Long, the seed number type)
        const read = collectionRead(node)

        if (read) {
          return `${expr(read.target)}.size.toLong()`
        }

        const textLength = stringRead(node)

        if (textLength) {
          return need('text', `TermText.length(${expr(textLength.target)})`)
        }

        if (node.index) {
          // a list subscript takes Int, and seed numbers are Long: an ARRAY target's index narrows; a map key
          // passes through as it is. toIntExact stops on an index past Int, where `toInt()` wrapped it to a
          // different, valid-looking slot
          // inside a guarded loop copy (ir/facts/bounds.ts) the index is proven inside the list, so inside Int, and
          // narrows plainly: fannkuch-redux at n = 11, 2,157 ms to 2,033 (`tmp/kotlin-toint-ab.ts`)
          const inside = intLists.size > 0 && intLists.has(listKey(node.target) ?? '')
          const index = expr(node.index)
          const narrowed =
            node.target.type?.kind === 'array'
              ? inside
                ? `${/^\w+$/.test(index) ? index : `(${index})`}.toInt()`
                : `Math.toIntExact(${index})`
              : index

          // a list of `Long` a record owns is read past the generic List signature (`fieldLists`), and inside a
          // guarded copy straight from its storage: the guard proved the index below the list's own count, which is
          // stricter than the storage's capacity (`tmp/kotlin-particle-ab2.ts`)
          if (ownedPath(node.target)) {
            return inside ? `${expr(node.target)}.data[${narrowed}]` : `${expr(node.target)}.getLong(${narrowed})`
          }

          return `${expr(node.target)}[${narrowed}]`
        }

        // a LITERAL index segment (`read parts/0`) on an array target subscripts it: `.0` is not a member
        if (/^\d+$/.test(node.name) && node.target.type?.kind === 'array') {
          return `${expr(node.target)}[${node.name}]`
        }

        return `${expr(node.target)}.${camel(node.name)}`
      }

      case 'await': {
        awaiting = true
        const operand = expr(node.expr)
        awaiting = false

        return operand
      }

      case 'closure': {
        node.params.forEach(p => localNames.add(p.name))
        // a closure's body suspends when the closure is `note async`, whatever the function around it does
        const outerSuspend = suspendContext
        suspendContext = node.async === true
        // a function literal as a Kotlin lambda. A lambda's value is its last expression, so the trailing `send back X`
        // becomes a bare `X` (an explicit `return` inside a lambda would non-locally return from the enclosing function).
        // A body with a return anywhere ELSE (inside a when arm, a loop) cannot be a lambda at all: Kotlin
        // prohibits non-local returns, so that closure lowers to an anonymous function, where return is legal.
        const deepReturn = (value: unknown): boolean => {
          if (!value || typeof value !== 'object') {
            return false
          }
          if (Array.isArray(value)) {
            return value.some(deepReturn)
          }
          const record = value as Record<string, unknown>
          if (record.form === 'closure') {
            return false
          }
          if (record.form === 'return') {
            return true
          }
          return Object.values(record).some(deepReturn)
        }
        const last = node.body[node.body.length - 1]
        const nonTailReturn =
          node.body.slice(0, -1).some(deepReturn) ||
          (last !== undefined && last.form !== 'return' && deepReturn(last))
        if (nonTailReturn) {
          const typed = node.params
            .map(p => `${camel(p.name)}: ${kotlinType(p.type)}`)
            .join(', ')
          const result =
            node.result ??
            (node.type?.kind === 'function' ? node.type.result : undefined)
          const resultText = result ? `: ${kotlinType(result)}` : ''
          const body = node.body.map(s => stmt(s, 1)).filter(Boolean)
          suspendContext = outerSuspend

          return `fun(${typed})${resultText} {\n${body.join('\n')}\n${'  '.repeat(0)}}`
        }
        const params = node.params.map(p => camel(p.name)).join(', ')
        const lead = node.body
          .slice(0, -1)
          .map(s => stmt(s, 0))
          .filter(Boolean)

        // a lambda answering the unknown whose value is a generic (`T` is nullable in Kotlin, `Any` is not) gives it
        // back as `Any`: the closure `spawn` hands a typed task's work to the one untyped job shim
        const closureResult = node.result ?? (node.type?.kind === 'function' ? node.type.result : undefined)
        const tail =
          last?.form === 'return' && last.value
            ? closureResult?.kind === 'unknown' && genericLetter(last.value.type)
              ? `(${expr(last.value)} as Any)`
              : expr(last.value)
            : last
              ? stmt(last, 0)
              : ''

        suspendContext = outerSuspend

        return `{ ${params} -> ${[...lead, tail]
          .filter(Boolean)
          .join('; ')} }`
      }

      case 'conditional': {
        // a value-position conditional lowers to a Kotlin if / else-if / else expression chain
        const tail = node.otherwise ? expr(node.otherwise) : 'Unit'

        return node.branches.reduceRight(
          (rest, branch) =>
            `if (${expr(branch.cond)}) ${expr(branch.value)} else ${rest}`,
          tail,
        )
      }

      default:
        return exhausted(node)
    }
  }

  // lower a native map / list operation to kotlin. The return shapes match the JS collection API the stdlib forms
  // expect: `set` yields the map, `delete` / `push` yield a boolean / the new length, sizes are Long (the number type).
  const collectionExpr = (
    op: CollectionOp,
    args: Expression[],
  ): string => {
    const target = expr(op.target)
    const arg = args.map(expr)
    // a copy of an integer list is one too, built once into a LongArray (a `TermLongs` source is a single arraycopy)
    const longs = op.kind !== 'map' && longList(op.target.type)
    const copy = (of: string): string => (longs ? need('longs', `mutableLongListOf(${of})`) : `${of}.toMutableList()`)

    if (op.kind === 'map') {
      switch (op.op) {
        case 'has':
          return `${target}.containsKey(${arg[0]})`
        case 'get':
          return `${target}.getValue(${arg[0]})`
        case 'set':
          // `also` with a named parameter, never `apply`: inside `apply` the map is the receiver, so a program variable
          // named `values`, `keys` or `size` read the MAP's member instead (render-native, device trait, 2026-10-02)
          return `${target}.also { __m -> __m.put(${arg[0]}, ${arg[1]}) }`
        case 'delete':
          return `(${target}.remove(${arg[0]}) != null)`
        case 'keys':
          return `${target}.keys.toMutableList()`
        case 'values':
          return `${target}.values.toMutableList()`
        default:
          return ''
      }
    }

    switch (op.op) {
      case 'push':
        return `${target}.also { __l -> __l.add(${arg[0]}) }.size.toLong()`
      case 'pop':
        // never `removeLast()`: compiled against android-36 it binds to JDK 21's List.removeLast, which throws
        // NoSuchMethodError on every device below API 35
        return `${target}.run { removeAt(lastIndex) }`
      case 'at':
      case 'get':
        return `${target}[Math.toIntExact(${arg[0]})]`
      case 'set':
        return `run { ${target}[Math.toIntExact(${arg[0]})] = ${arg[1]} }`
      case 'includes':
        return `${target}.contains(${arg[0]})`
      case 'indexOf':
        return `${target}.indexOf(${arg[0]}).toLong()`
      case 'lastIndexOf':
        return `${target}.lastIndexOf(${arg[0]}).toLong()`
      case 'concat':
        // one copy: the left side copied once, the right appended into it
        return `${copy(target)}.also { __l -> __l.addAll(${arg[0]}) }`
      case 'slice':
        // both bounds clamped to the length, empty when start reaches end, never counted from the end
        // (note/term/stdlib/semantics.md)
        return `${target}.let { d -> val x = (${arg[0]}).toInt().coerceIn(0, d.size); val y = (${arg[1] !== undefined ? `(${arg[1]}).toInt()` : 'd.size'}).coerceIn(0, d.size); if (x < y) ${copy('d.subList(x, y)')} else ${copy('d.subList(0, 0)')} }`
      case 'toReversed':
        // asReversed is a view, so the one copy is the list built from it
        return copy(`${target}.asReversed()`)
      case 'join':
        // each item as `to-text` renders it, so a float reads as on every backend
        return op.target.type?.kind === 'array' && op.target.type.element.kind === 'float'
          ? need('number', `${target}.joinToString(${arg[0]}) { termNumber(it) }`)
          : `${target}.joinToString(${arg[0]})`
      case 'map':
        // straight into a MutableList: `map(f).toMutableList()` built the list twice
        return `${target}.mapTo(ArrayList(), ${arg[0]})`
      case 'filter':
        return longs ? need('longs', `${target}.filterTo(mutableLongListOf(), ${arg[0]})`) : `${target}.filterTo(ArrayList(), ${arg[0]})`
      case 'some':
        return `${target}.any(${arg[0]})`
      case 'every':
        return `${target}.all(${arg[0]})`
      case 'reduce':
        return `${target}.fold(${arg[1]}, ${arg[0]})`
      case 'findIndex':
        return `${target}.indexOfFirst(${arg[0]}).toLong()`
      case 'flat':
        // one level of nesting removed when the items are lists; a copy otherwise (JS `[1,2,3].flat()` is `[1,2,3]`)
        return op.target.type?.kind === 'array' && op.target.type.element.kind === 'array'
          ? `${target}.flatMapTo(ArrayList()) { it }`
          : `${target}.toMutableList()`
      case 'unshift':
        return `${target}.also { __l -> __l.add(0, ${arg[0]}) }.size.toLong()`
      case 'shift':
        return `${target}.removeAt(0)`
      case 'splice':
        // JS `splice(start, deleteCount, ...items)`: remove the range, insert the items, in place
        // the start clamped to the length and the count to what remains (semantics.md)
        return `${target}.let { __l -> val s = (${arg[0]}).toInt().coerceIn(0, __l.size); val c = (${arg[1]}).toInt().coerceIn(0, __l.size - s); __l.subList(s, s + c).clear(); __l.addAll(s, listOf(${arg.slice(2).join(', ')})); 0L }`
      default:
        return ''
    }
  }

  // The text operations (see backend.ts, STRING_METHODS) mean what note/term/stdlib/semantics.md says, which counts
  // code points. Kotlin's String counts UTF-16 units, so each goes through `TermText` in the prelude rather than the
  // String method of the same name.
  const stringExpr = (op: string, t: string, a: string[]): string =>
    need('text', `TermText.${op === 'at' ? 'charAt' : op}(${[t, ...a].join(', ')})`)

  // the forms that are exceptions: a raise of one carries the record whole
  const exceptionForms = new Set(
    program
      .filter((n): n is Extract<Statement, { form: 'record-type' }> => n.form === 'record-type' && Boolean(n.chain?.includes('exception')))
      .map(n => n.name),
  )

  const block = (body: Statement[], d: number): string => {
    const lines: string[] = []

    for (let at = 0; at < body.length; at++) {
      // the three-statement swap of two slots is `Collections.swap`, which checks both indexes before it writes
      const swap = swapAt(body, at)

      // a LongArray has no Collections.swap: its own three statements, unboxed
      if (swap && swap.list.form === 'variable' && arrayNames.has(swap.list.name)) {
        lines.push(`${pad(d)}${stmt(body[at]!, d)}`)
        continue
      }

      if (swap) {
        lines.push(`${pad(d)}java.util.Collections.swap(${expr(swap.list)}, Math.toIntExact(${expr(swap.first)}), Math.toIntExact(${expr(swap.second)}))`)
        at += 2
        continue
      }

      // a list generated by a counted loop, made at its size in one construction (`generatorAt`), as an `Array<T>`
      // where its one use is a variant's array field (`arrayGenerators`)
      const found = generatorAt(body, at, currentFn)
      // a fixed list (`fixedLists`) is made as its own array; a list of `Long` that is not fixed keeps its `TermLongs`
      const fixedAs = found ? arrayNames.get(found.list) : undefined
      const generator = found && (fixedAs || !longList(found.type)) ? found : undefined

      if (generator) {
        const size =
          generator.bound.form === 'integer'
            ? `${Math.max(Number(generator.bound.value) - generator.base, 0)}`
            : `Math.toIntExact(maxOf(${expr(generator.bound)}${generator.base === 0 ? '' : ` - ${generator.base}L`}, 0L))`
        const counter = camel(generator.counter)
        const binds = namesIn(generator.item).has(generator.counter)
        localNames.add(generator.list)
        const item = expr(generator.item)
        const element = kotlinType((generator.type as Extract<Type, { kind: 'array' }>).element)
        const at0 = generator.base === 0 ? '__g.toLong()' : `__g.toLong() + ${generator.base}L`
        const lambda = binds ? `{ __g -> val ${counter} = ${at0}; ${item} }` : `{ ${item} }`
        const made =
          fixedAs && fixedAs !== 'Object'
            ? `${fixedAs}Array(${size}) ${lambda}`
            : fixedAs === 'Object' || arrayGenerators.has(body[at]!)
              ? `Array<${element}>(${size}) ${lambda}`
              : `MutableList<${element}>(${size}) ${lambda}`

        lines.push(`${pad(d)}val ${camel(generator.list)} = ${made}`)
        at += 2
        continue
      }

      // a list made empty and then filled by a counted loop is made at the size the loop fills it to (`reserveAt`)
      const reserve = reserveAt(body, at)

      if (reserve) {
        localNames.add(reserve.list)
        lines.push(`${pad(d)}val ${camel(reserve.list)}: MutableList<${reserve.element}> = ${reserve.made}`)
        continue
      }

      lines.push(`${pad(d)}${stmt(body[at]!, d)}`)
    }

    return lines.join('\n')
  }

  // A list made empty and then filled by a counted loop later in the same block, `while (i < n)` with `i` from a literal
  // and k pushes onto it among the loop's own statements, is made with room for k * (n - base): Polygon's corners grew
  // from 10 to 30 through three copies, 103 ms to 78 at that size (`tmp/kotlin-polygon-ab2.ts`). A capacity is a hint
  // and nothing reads it, so the estimate need only be safe to compute where the list is made: `n` a literal, a
  // parameter or a name this block declared before the list, clamped to [0, 2^20] since the loop may stop early. Only for
  // a list never assigned whole (it is a `val` of the interface type), outside every other `let` rule
  const reserveAt = (body: Statement[], at: number): { list: string; element: string; made: string } | undefined => {
    const made = body[at]
    const fn = currentFn

    if (!fn || made?.form !== 'let' || made.type?.kind !== 'array' || made.type.element.kind === 'variable') {
      return undefined
    }

    const empty =
      (made.init.form === 'array' && made.init.items.length === 0) || (made.init.form === 'record' && made.init.name === 'list' && made.init.fields.length === 0)

    if (!empty || redeclared.has(made) || arrayNames.has(made.name) || builders.has(made.name) || reuse.locals.has(made) || assignsName(fn.body, made.name)) {
      return undefined
    }

    const loopAt = body.findIndex((s, i) => i > at && s.form === 'while')
    const loop = body[loopAt]

    if (loop?.form !== 'while' || loop.cond.form !== 'binary' || loop.cond.op !== '<' || loop.cond.left.form !== 'variable') {
      return undefined
    }

    const counter = loop.cond.left.name
    const start = body.slice(at + 1, loopAt).find((s): s is Extract<Statement, { form: 'let' }> => s.form === 'let' && s.name === counter)
    const bound = loop.cond.right
    const declaredBefore = (name: string): boolean =>
      fn.params.some(p => p.name === name) || body.slice(0, at).some(s => s.form === 'let' && s.name === name)
    const pushes = loop.body.filter(
      s =>
        s.form === 'expression' &&
        s.expr.form === 'call' &&
        s.expr.callee.form === 'variable' &&
        s.expr.callee.name === 'list_push' &&
        s.expr.args[0]?.form === 'variable' &&
        s.expr.args[0].name === made.name,
    ).length

    if (!start || start.init.form !== 'integer' || pushes === 0 || !(bound.form === 'integer' || (bound.form === 'variable' && declaredBefore(bound.name)))) {
      return undefined
    }

    const base = Number(start.init.value)
    const turns =
      bound.form === 'integer'
        ? `${Math.min(Math.max(Number(bound.value) - base, 0), 1 << 20) * pushes}`
        : `Math.toIntExact(minOf(maxOf(${camel(bound.name)}${base === 0 ? '' : ` - ${base}L`}, 0L), ${1 << 20}L))${pushes === 1 ? '' : ` * ${pushes}`}`
    const element = kotlinType(made.type.element)

    return {
      list: made.name,
      element,
      made: longList(made.type) ? need('longs', `TermLongs(${turns})`) : `ArrayList<${element}>(${turns})`,
    }
  }

  const stmt = (node: Statement, d: number): string => {
    switch (node.form) {
      case 'let': {
        localNames.add(node.name)

        // a second declaration of a name the same statement list declared already is an assignment to it (backend.ts,
        // `redeclaredLets`): two counted walks over `i` in one task
        if (redeclared.has(node)) {
          return `${camel(node.name)} = ${expr(node.init)}`
        }

        // a carrier at a reuse site holds its kept field alone (compile/place.ts, `recordReuse`)
        const kept = reuse.locals.get(node)

        if (kept !== undefined) {
          carrierLocals.set(node.name, kept)

          return `val ${camel(node.name)} = ${expr(node.init)}`
        }

        // a text built only by appending (`textBuilders`) is a StringBuilder, its init read before it becomes one
        if (builders.has(node.name)) {
          return `val ${camel(node.name)} = StringBuilder(${expr(node.init)})`
        }

        // a fixed list local (fixedLists) is a `LongArray`, taken once from the fresh task that made it
        if (arrayNames.has(node.name) && node.init.form === 'call') {
          // a fixed local is its primitive array or an `Array<T>`, taken once from the fresh task's list
          const kind = arrayNames.get(node.name)!
          return `val ${camel(node.name)} = ${filled(node.init, kind) ?? toArray(kind, expr(node.init))}`
        }

        // a lambda binding is annotated with its full function type: Kotlin cannot infer a lambda's parameter types
        // without an expected type, and a suspend lambda only becomes suspend when the expected type says so.
        const ann =
          node.init.form === 'closure'
            ? `: ${kotlinType({
                kind: 'function',
                params: node.init.params.map(
                  (p): Type => p.type ?? { kind: 'unknown' },
                ),
                result: node.init.result ?? { kind: 'unknown' },
                ...(node.init.async ? { effects: ['async'] } : {}),
              })}`
            : node.init.form === 'record' &&
                node.init.type?.kind === 'named' &&
                variantClassOf.has(node.init.name)
              ? // a variant construction is bound as its sealed type, so the binding can later hold another variant
                `: ${kotlinType(node.init.type)}`
              : uninferableCall(node)
                ? // a call with no arguments to a generic task (`make-channel`): nothing at the call says what `T` is,
                  // so the binding says it, when the checker knows it concretely
                  `: ${spellClosed(node.type!)}`
                : ''

        // a valueless typed module slot (`host current, like context`, filled later by a `save`): kotlin's
        // lateinit var, so reads get the declared class type rather than Unit
        if (node.init.form === 'unit' && node.type?.kind === 'named') {
          return `lateinit var ${camel(node.name)}: ${kotlinType(node.type)}`
        }

        // the gradual boundary on a binding: a boxed dynamic re-typed at a declared FORM casts
        if (
          node.type?.kind === 'named' &&
          node.init.form === 'member' &&
          recordFields.has(node.type.name) &&
          (node.init.type?.kind === 'unknown' ||
            node.init.type?.kind === 'dynamic')
        ) {
          return `${node.mutable ? 'var' : 'val'} ${camel(node.name)} = ${expr(node.init)} as ${kotlinType(node.type)}`
        }

        // `var` only for a binding something reassigns: a `save` that is never written again, or a list only written
        // through, is a `val` (kotlinc warned "variable is never modified"). At module level, the declared mutability
        // a second name for a record one of the two is written through: its own copy (D1, `recordCopies`)
        const init = copies.lets.has(node) ? `${expr(node.init)}.copy()` : expr(node.init)

        return `${node.mutable && (fnAssigned === undefined || fnAssigned.has(node.name)) ? 'var' : 'val'} ${camel(
          node.name,
        )}${ann} = ${init}`
      }
      case 'assign': {
        // the write-back of a reuse site: the reusing copy built the record in the object this slot holds already
        if (reuse.writeBacks.has(node)) {
          return '// the slot holds the record its task built in place'
        }

        // an append to a text built only by appending is the StringBuilder's own, in place (`textBuilders`)
        const append = textAppend(node)

        if (append && builders.has(append.name)) {
          // one character of an ASCII text is appended as the Char, with no one-character String made for it
          const char = asciiCharAppend(append.rest, asciiNodes)

          if (char) {
            return need('text', `TermText.asciiAppend(${camel(append.name)}, ${expr(char.text)}, ${expr(char.index)})`)
          }

          return `${camel(append.name)}.append(${expr(append.rest)})`
        }

        // a builder reset to the empty text keeps its storage
        if (node.target.form === 'variable' && builders.has(node.target.name) && emptyText(node.value)) {
          return `${camel(node.target.name)}.setLength(0)`
        }

        // a slot of a list of `Long` a record owns, written past the generic List signature (`fieldLists`)
        if (node.op === '=' && node.target.form === 'member' && node.target.index && ownedPath(node.target.target)) {
          // inside a guarded copy, straight into its storage, the index proven below the list's count
          if (intLists.size > 0 && intLists.has(listKey(node.target.target) ?? '')) {
            const at = expr(node.target.index)

            return `${expr(node.target.target)}.data[${/^\w+$/.test(at) ? at : `(${at})`}.toInt()] = ${expr(node.value)}`
          }

          return `${expr(node.target.target)}.setLong(Math.toIntExact(${expr(node.target.index)}), ${expr(node.value)})`
        }

        const place = places.get(node)

        if (place) {
          const local = camel(place.local)

          if (!place.temps) {
            return place.fields.map(f => `${local}.${camel(f.name)} = ${expr(f.value)}`).join('; ')
          }

          const temps = place.fields.map((f, i) => `val __place${i} = ${expr(f.value)}`)
          const sets = place.fields.map((f, i) => `${local}.${camel(f.name)} = __place${i}`)

          return `run { ${[...temps, ...sets].join('; ')} }`
        }

        // a write two or more fields deep never changes the nested record in place: it may be another name's too (a
        // record built from a variable holds that variable's record), and a record is a value (D1). The path is rebuilt
        // from its first field instead, `p.inner = p.inner.copy(count = 99)` (codegen-performance-0028)
        const segments: string[] = []
        let base: Expression = node.target
        let rebuild = node.op === '='

        while (base.form === 'member') {
          const holder = base.target.type

          if (base.index || /^\d+$/.test(base.name) || holder?.kind !== 'named' || !recordFields.has(holder.name) || sharedForms.has(holder.name)) {
            rebuild = false
          }

          segments.unshift(base.name)
          base = base.target
        }

        if (rebuild && segments.length > 1) {
          const at = (k: number): string => `${expr(base)}.${segments.slice(0, k).map(camel).join('.')}`
          let value = expr(node.value)

          for (let k = segments.length - 1; k >= 1; k--) {
            value = `${at(k)}.copy(${camel(segments[k]!)} = ${value})`
          }

          return `${at(1)} = ${value}`
        }

        return node.op === '='
          ? `${expr(node.target)} = ${expr(node.value)}`
          : `${expr(node.target)} ${node.op} ${expr(node.value)}`
      }
      case 'expression': {
        // a map entry updated from its own value is one probe through `compute` (backend.ts, `mapUpdate`), the sum
        // still stopping past Long
        const update = mapUpdate(node)

        if (update && update.map.type?.kind === 'map' && (update.map.type.value.kind === 'number' || update.map.type.value.kind === 'float')) {
          const old = `(__v ?: ${expr(update.fallback)})`
          const sum = update.map.type.value.kind === 'number' ? `Math.addExact(${old}, ${expr(update.step)})` : `${old} + ${expr(update.step)}`

          return `${expr(update.map)}.compute(${expr(update.key)}) { _, __v -> ${sum} }`
        }

        return expr(node.expr)
      }
      case 'return': {
        if (!node.value) {
          return currentResult?.kind === 'unknown' ? 'return Unit' : 'return'
        }

        // the gradual boundary: an unknown-typed value returned at a DECLARED FORM type casts explicitly. A generic
        // letter (`like t`) is a cast target only for a CALL that answers the unknown, which is a typed channel's
        // `receive` or a typed task's `wait` taking its value back out of the one untyped shim
        const valueKind =
          node.value.form === 'await' ? (node.value.type ?? node.value.expr.type)?.kind : node.value.type?.kind
        const unknownValue = valueKind === 'unknown' || valueKind === 'dynamic'
        const cast =
          node.value.form === 'member' &&
          unknownValue &&
          currentResult?.kind === 'named' &&
          recordFields.has(currentResult.name)
            ? ` as ${kotlinType(currentResult)}`
            : unknownValue && isCallValue(node.value) && genericLetter(currentResult)
              ? ` as ${kotlinType(currentResult!)}`
              : ''

        return `return ${expr(node.value)}${cast}`
      }
      case 'throw': {
        // a raise carries the exception record whole in a TermException (the shared fields, the props as `link`, the
        // record as `base`), so a handler reads `note`, `form`, `code` the way it does on TypeScript. A text raises
        // `failure`; a value already caught is passed on as it is. When the program has the stdlib hive, a NEW
        // carrier tells it before unwinding (a pass-on re-raise does not re-tell).
        needs.add('exception')

        const tell = (built: string): string =>
          hasHiveTell
            ? `throw run { val told = ${built}; hiveTell(HiveEntry(host = told.host, kind = "exception", name = told.form, site = "", base = told)); told }`
            : `throw ${built}`

        // an interpolated text (a `template` node) is a text too, and raises `failure` like a plain one
        return node.value.form === 'string' || node.value.form === 'template'
          ? tell(`TermException("", "failure", ${expr(node.value)}, "", 0L, null, null)`)
          : node.value.form === 'record' && exceptionForms.has(node.value.name)
            ? tell(`run { val raised = ${expr(node.value)}; TermException(raised.host, raised.form, raised.note, raised.code, raised.time, raised.link, raised) }`)
            : `throw termException(${expr(node.value)})`
      }
      case 'while': {
        // a counted loop calling a task whose arithmetic is safe below a bound (ir/facts/bounds.ts): written twice, the
        // guard true running a copy that calls the task's unchecked copy. Only the call limits are asked: the list
        // checks stay, since stripping them measured nothing on Kotlin (codegen-performance-0030)
        const guard = loopGuards.get(node)
        const loop = (): string => `while (${expr(node.cond)}) {\n${block(node.body, d + 2)}\n${pad(d + 1)}}`

        // the list checks too: in the copy a guarded list's index narrows with `toInt()`, not `toIntExact`
        if (guard && (guard.fast?.length || guard.checks.length)) {
          const name = (id: string): string => camel(id)
          const outerLists = intLists
          // a list reached through a path reads its size through it, its own slots narrowed plainly: their checks come
          // earlier in this `&&` (bounds.ts bounds a path's prefix first)
          intLists = new Set([...outerLists, ...guard.checks.map(c => c.list)])
          const checks = guard.checks.map(c => {
            const value =
              c.base === undefined
                ? `${c.offset}L`
                : c.offset === 0
                  ? name(c.base)
                  : `(${name(c.base)} ${c.offset < 0 ? '-' : '+'} ${Math.abs(c.offset)}L)`

            return c.side === 'low' ? `${value} >= 0L` : `${value} < ${c.path ? expr(c.path as Expression) : name(c.list)}.size`
          })
          intLists = outerLists
          const limits = (guard.limits ?? []).map(l => (l.low ? `${name(l.name)} >= 0L` : `${name(l.name)} <= ${l.high}L`))
          const test = [...checks, ...limits].filter((t, i, all) => all.indexOf(t) === i).join(' && ')
          const outer = fastCalls
          const outerHoisted = hoisted
          fastCalls = new Set([...outer, ...(guard.fast ?? [])])
          intLists = new Set([...outerLists, ...guard.checks.map(c => c.list)])
          // each list reached through a path is read ONCE before the copy, which the guard makes safe and the loop
          // cannot change (bounds.ts: its root and indexes are not written in it, nor a field, nor a record's slot), and
          // the body indexes the local: Particle 308 ms to 187, the record read out of the list twice a turn
          // (`tmp/kotlin-particle-ab2.ts`). A record here is a reference, so the local is the record's own list
          const reads: string[] = []
          const paths = new Map<string, Expression>()

          for (const c of guard.checks) {
            if (c.path && !paths.has(c.list)) {
              paths.set(c.list, c.path as Expression)
            }
          }

          for (const [key, path] of paths) {
            const local = `__path${pathCount++}`
            reads.push(`val ${local} = ${expr(path)}`)
            hoisted = new Map([...hoisted, [key, local]])
          }

          const fast = [...reads, loop()].join(`\n${pad(d + 1)}`)
          fastCalls = outer
          intLists = outerLists
          hoisted = outerHoisted

          return `if (${test}) {\n${pad(d + 1)}${fast}\n${pad(d)}} else {\n${pad(d + 1)}${loop()}\n${pad(d)}}`
        }

        return `while (${expr(node.cond)}) {\n${block(
          node.body,
          d + 1,
        )}\n${pad(d)}}`
      }
      case 'guard': {
        // the caught value is a TermException: a raise passes through, and a foreign throw (a Kotlin runtime error) is
        // wrapped as `failure`, so the handler sees one shape on every path
        // a coroutine's cancellation and the VM's own failures (out of memory, stack overflow) pass through: catching
        // them kept a cancelled coroutine running, and on every other backend those end the program
        const passOn = `${pad(d + 1)}if (thrown is kotlin.coroutines.cancellation.CancellationException || thrown is VirtualMachineError) throw thrown`
        let handler = `catch (thrown: Throwable) {\n${passOn}\n${pad(d)}}`

        if (node.catch) {
          // the caught name is a local of the handler: without this a task parameter of the same name anywhere in
          // the program made `{{error/note}}` inside the handler emit as the function reference `::error.note`
          localNames.add(node.catch.name)
          needs.add('exception')
          handler = `catch (thrown: Throwable) {\n${passOn}\n${pad(d + 1)}val ${camel(node.catch.name)} = termException(thrown)\n${block(
            node.catch.body,
            d + 1,
          )}\n${pad(d)}}`
        }

        return `try {\n${block(node.body, d + 1)}\n${pad(d)}} ${handler}`
      }
      case 'for-each':
        // the item (and index) are locals: a top-level task of the same name (`length`) must not turn a read of the
        // item into a function reference
        localNames.add(node.item)

        if (node.index) {
          localNames.add(node.index)
        }

        // a walk by POSITION, the length read every turn, where the body may push onto the list it walks: the walk
        // then sees each pushed item, which is the Term meaning (TypeScript's `for...of`, Rust's walk by position),
        // where Kotlin's iterator threw ConcurrentModificationException (meaning-native `grow`). A list of `Long` is
        // walked by position always, reading the `TermLongs` storage where the list is one: its iterator boxed every
        // element, Graph 215 ms to 203 (`tmp/kotlin-graph-ab.ts`). Any other walk keeps `for (x in xs)`
        if (node.iterable.type?.kind === 'array' && !(node.iterable.form === 'variable' && arrayNames.has(node.iterable.name))) {
          const grows = node.iterable.form === 'variable' && namesIn(node.body).has(node.iterable.name)
          const longs = longList(node.iterable.type)

          if (grows || longs) {
            const n = walkCount++
            const walked = `__walked${n}`
            const at = `__at${n}`
            const read = longs ? `if (${walked}Longs != null) ${walked}Longs.data[${at}] else ${walked}[${at}]` : `${walked}[${at}]`
            const index = node.index ? `\n${pad(d + 1)}val ${camel(node.index)} = ${at}.toLong()` : ''

            return [
              `val ${walked} = ${expr(node.iterable)}`,
              ...(longs ? [`${pad(d)}${need('longs', `val ${walked}Longs = ${walked} as? TermLongs`)}`] : []),
              `${pad(d)}var ${at} = 0`,
              `${pad(d)}while (${at} < ${walked}.size) {`,
              `${pad(d + 1)}val ${camel(node.item)} = ${read}${index}`,
              `${pad(d + 1)}${at}++`,
              block(node.body, d + 1),
              `${pad(d)}}`,
            ].join('\n')
          }
        }

        // a walk that names its INDEX uses withIndex; `toLong` because that is what a Term number is. lean-0017
        return node.index
          ? `for ((__at, ${camel(node.item)}) in ${expr(
              node.iterable,
            )}.withIndex()) {\n${pad(d + 1)}val ${camel(node.index)} = __at.toLong()\n${block(
              node.body,
              d + 1,
            )}\n${pad(d)}}`
          : `for (${camel(node.item)} in ${expr(
              node.iterable,
            )}) {\n${block(node.body, d + 1)}\n${pad(d)}}`

      case 'match': {
        // a match whose labels are only true/false is a match over a NATIVE Boolean (booleans lower to `Boolean`
        // here, not a sealed class), so the arms are the literal conditions `true` / `false`, not `is` patterns.
        // a fork case over a caught TermException: `when` on `form`, the record recovered from `base` by its form
        if (node.exceptionArms) {
          const carrier = expr(node.subject)
          const arms = node.cases.map(b => {
            const arm = node.exceptionArms![b.label]!
            const bodyText = block(b.body, d + 2)
            const locals = armLocals([...arm.shared, ...arm.link], b.binds ?? [])
              .filter(({ local }) => new RegExp(`\\b${camel(local).replace(/[^\w$]/g, '\\$&')}\\b`).test(bodyText))
              .map(({ field, local }) =>
                arm.link.includes(field)
                  ? `${pad(d + 2)}val ${camel(local)} = (${carrier}.base as ${pascal(b.label)}).link.${camel(field)}`
                  : `${pad(d + 2)}val ${camel(local)} = ${carrier}.${camel(field)}`,
              )

            return `${pad(d + 1)}${JSON.stringify(b.label)} -> {\n${[...locals, bodyText].join('\n')}\n${pad(d + 1)}}`
          })
          // the checker holds the arms to the guarded body's raise set, so a form none matches cannot happen; the
          // else passes the carrier on, which also tells Kotlin every path answers
          arms.push(`${pad(d + 1)}else -> {${node.otherwise ? `\n${block(node.otherwise, d + 2)}\n${pad(d + 1)}` : ` throw ${carrier} `}}`)

          return `when (${carrier}.form) {\n${arms.join('\n')}\n${pad(d)}}`
        }

        const labels = node.cases.map(branch => branch.label)
        const booleans =
          labels.length > 0 &&
          labels.every(label => label === 'true' || label === 'false')

        // a `fork case` over a TEXT subject (`fork case, read kind` with `case home` arms): the labels are
        // string values, matched by literal
        if (node.subject.type?.kind === 'string') {
          const arms = node.cases.map(
            b =>
              `${pad(d + 1)}${JSON.stringify(b.label)} -> {\n${block(
                b.body,
                d + 2,
              )}\n${pad(d + 1)}}`,
          )

          arms.push(
            `${pad(d + 1)}else -> {${
              node.otherwise
                ? `\n${block(node.otherwise, d + 2)}\n${pad(d + 1)}`
                : ''
            }}`,
          )

          return `when (${expr(node.subject)}) {\n${arms.join('\n')}\n${pad(d)}}`
        }

        // an exhaustive `when` on the sealed type: each `is` arm smart-casts the subject, so its fields are directly
        // accessible in the body with no rewrite. A return-position match becomes `return when (...)`.
        // the subject is bound to a local first: a smart cast needs a stable value, and a `var` property (a field
        // read like `entry.base`) is not one
        const subjectExpr = expr(node.subject)
        const stable = node.subject.form === 'variable'
        const subject = stable ? subjectExpr : `subject${++matchCount}`
        // a case with no fields is declared an `object` (the sealed class below), the only value of it there is. Read
        // off the subject's own form, since two forms may name a case alike with different fields
        const subjectForm =
          node.subject.type?.kind === 'named'
            ? program.find((n): n is Extract<Statement, { form: 'record-type' }> => n.form === 'record-type' && n.name === (node.subject.type as { name: string }).name)
            : undefined
        const fieldless = (label: string): boolean => subjectForm?.variants.find(v => v.name === label)?.fields.length === 0
        const byIdentity = !booleans && node.subject.type?.kind === 'named' && node.cases.some(b => fieldless(b.label))
        const arms = node.cases.map(b => {
          if (booleans) {
            return `${pad(d + 1)}${b.label} -> {\n${block(
              b.body,
              d + 2,
            )}\n${pad(d + 1)}}`
          }

          const cls = classFor(b.label, node.subject.type) ?? pascal(b.label)
          // a node taken from its slot, of a reused variant (`reuseVariants`): once the arm's first statement has
          // written the slot back (`slotTakes` makes it the first), nothing holds the node, so its links are cleared
          // and it is kept as the variant's spare for the next construction
          const reused =
            stable && takenSubjects.has(node.subject) && node.subject.type?.kind === 'named' && b.body.length > 0
              ? reuseVariants.get(b.label)
              : undefined
          const spare =
            reused && reused.form === (node.subject.type as { name: string }).name
              ? [
                  ...reused.recursive.map(
                    f => `${pad(d + 2)}${subject}.${camel(f)} = ${classFor(reused.empty, node.subject.type) ?? pascal(reused.empty)}`,
                  ),
                  `${pad(d + 2)}termSpare${cls} = ${subject}`,
                ]
              : []
          // the arm's fields (renamed or not, see check/arm.ts) become locals read off the smart-cast subject, the
          // ones the body reads
          const bodyText = spare.length
            ? [block(b.body.slice(0, 1), d + 2), ...spare, block(b.body.slice(1), d + 2)].filter(Boolean).join('\n')
            : block(b.body, d + 2)
          const locals = armLocals(variantFieldNames.get(b.label) ?? [], b.binds ?? [])
            .filter(({ local }) => new RegExp(`\\b${camel(local).replace(/[^\w$]/g, '\\$&')}\\b`).test(bodyText))
            .map(({ field, local }) => `${pad(d + 2)}val ${camel(local)} = ${subject}.${camel(field)}`)
          // a field-less case is one `object`, so it is that object by identity (`subject === ChainEnd`), one compare
          // where `is` is a type check: List's empty-list tests, 176 ms to 143 against the hand version's `null` at 135
          // (`tmp/kotlin-list-ab.ts`). Every other case keeps `is` and its smart cast, in a `when` with no subject
          const test = byIdentity ? (fieldless(b.label) ? `${subject} === ${cls}` : `${subject} is ${cls}`) : `is ${cls}`

          return `${pad(d + 1)}${test} -> {\n${[...locals, bodyText].join('\n')}\n${pad(d + 1)}}`
        })

        if (node.otherwise) {
          arms.push(
            `${pad(d + 1)}else -> {\n${block(
              node.otherwise,
              d + 2,
            )}\n${pad(d + 1)}}`,
          )
        }

        const when = `when${byIdentity ? '' : ` (${subject})`} {\n${arms.join('\n')}\n${pad(d)}}`

        return stable ? when : `val ${subject} = ${subjectExpr}\n${pad(d)}${when}`
      }

      case 'if': {
        let out = ''
        node.branches.forEach((b, i) => {
          out += `${i ? ' else ' : ''}if (${expr(b.cond)}) {\n${block(
            b.body,
            d + 1,
          )}\n${pad(d)}}`
        })

        if (node.otherwise) {
          out += ` else {\n${block(node.otherwise, d + 1)}\n${pad(d)}}`
        }

        return out
      }

      case 'break':
        return 'break'
      case 'continue':
        return 'continue'
      case 'exit':
        return 'kotlin.system.exitProcess(0)'
      case 'debug':
        return '// breakpoint'

      case 'function': {
        const generics = genericClause(node)
        currentFn = node
        scopeGenerics = new Set(node.generics.map(g => g.name.toUpperCase()))
        localNames.clear()
        node.params.forEach(p => localNames.add(p.name))
        // a fixed list parameter or local is a `LongArray` or a `DoubleArray`, by its element (fixedLists)
        const fixedAt = fixed.params.get(node.name)
        const outerArrays = arrayNames
        const letTypes = new Map<string, Type | undefined>()
        const collectLets = (value: unknown): void => {
          if (typeof value !== 'object' || value === null) return
          if (Array.isArray(value)) return value.forEach(collectLets)
          const s = value as { form?: string; name?: string; type?: Type }
          if (s.form === 'let' && typeof s.name === 'string') letTypes.set(s.name, s.type)
          for (const [key, child] of Object.entries(s)) if (key !== 'type' && key !== 'span') collectLets(child)
        }
        collectLets(node.body)
        const elementKind = (t: Type | undefined): HeldKind | undefined => fixedKind(t?.kind === 'array' ? t.element : undefined)
        // a fixed list's Kotlin type: its primitive array, or `Array<T>`
        const arrayType = (t: Type | undefined, kind: HeldKind): string =>
          kind === 'Object' && t?.kind === 'array' ? `Array<${kotlinType(t.element)}>` : `${kind}Array`
        arrayNames = new Map([
          ...node.params.flatMap((p, i) => {
            const kind = fixedAt?.has(i) ? elementKind(p.type) : undefined

            return kind ? [[p.name, kind] as const] : []
          }),
          ...[...(fixed.locals.get(node.name) ?? [])].flatMap(name => {
            const kind = elementKind(letTypes.get(name))

            return kind ? [[name, kind] as const] : []
          }),
          // the arm locals bound to a variant's primitive array field (`variantArrays`)
          ...(armArrays.get(node.name) ?? []),
        ])
        const params = node.params
          .map((p, i) => {
            const kind = fixedAt?.has(i) ? elementKind(p.type) : undefined

            return `${camel(p.name)}: ${kind ? arrayType(p.type, kind) : kotlinType(p.type)}`
          })
          .join(', ')

        const suspend = node.async ? 'suspend ' : ''
        suspendContext = node.async === true
        // a reassigned parameter is shadowed by a mutable local (Kotlin parameters are immutable)
        const mutated = new Set<string>()
        reassigned(node.body, mutated)
        // and a local nothing reassigns is a `val` (see the `let` case)
        const outerAssigned = fnAssigned
        fnAssigned = mutated
        // the text locals only ever built by appending, held as StringBuilders (backend.ts, `textBuilders`)
        const outerBuilders = builders
        builders = textBuilders(node)
        const outerCursors = cursors
        cursors = textCursors(node, asciiNodes)
        const outerCarriers = carrierLocals
        carrierLocals = new Map()
        const outerRedeclared = redeclared
        redeclared = redeclaredLets(node)
        const outerTaken = takenSubjects
        takenSubjects = reuseVariants.size ? slotTakes(node.body, () => true, lastReads(node.body), emptyCaseOf, new Set()).takes : new WeakMap()

        const shadows = node.params
          .filter(p => mutated.has(p.name))
          .map(
            p => `${pad(d + 1)}var ${camel(p.name)} = ${camel(p.name)}`,
          )

        // a task with no declared result but a valued `send back` (a dock forward) is Any, not Unit
        const result =
          node.result && node.result.kind !== 'unit'
            ? node.result
            : hasValuedReturn(node.body)
              ? ({ kind: 'unknown' } as Type)
              : node.result

        currentResult = result

        // a valued task whose body ends in branching that returns from every live path: kotlin cannot always
        // see the coverage (an if chain with no else), so the fall-through throws
        const last = node.body[node.body.length - 1]
        const unreachable =
          (last?.form === 'if' ||
            last?.form === 'while' ||
            last?.form === 'match') &&
          node.result &&
          node.result.kind !== 'unit'
            ? `${pad(d + 1)}throw IllegalStateException("unreachable")`
            : ''

        // a signature-only stub (a public module whose impl arrives from the platform module in a fuller closure)
        // still compiles: its body is the not-implemented panic
        const bodyText =
          node.body.length === 0
            ? `${pad(d + 1)}TODO(${JSON.stringify(`stub: ${node.name}`)})`
            : [
                ...shadows,
                ...cursors.names.map(name => `${pad(d + 1)}val __cursor${pascal(name)} = LongArray(2)`),
                block(node.body, d + 1),
                unreachable,
              ]
                .filter(Boolean)
                .join('\n')

        fnAssigned = outerAssigned
        arrayNames = outerArrays
        builders = outerBuilders
        cursors = outerCursors
        carrierLocals = outerCarriers
        redeclared = outerRedeclared
        takenSubjects = outerTaken

        // a task whose every self call is a tail call is `tailrec`: Kotlin's compiler makes it the loop it is (backend.ts,
        // `tailTasks`), where the JVM ran a call per step
        const tailrec = tailCalls.has(node.name) && !inlineTasks.has(node.name) ? 'tailrec ' : ''

        return `${inlineTasks.has(node.name) ? 'inline ' : ''}${tailrec}${suspend}fun ${generics}${camel(
          node.name,
        )}(${params}): ${kotlinType(result)} {\n${bodyText}\n${pad(
          d,
        )}}`
      }

      case 'record-type': {
        if (node.variants.length > 0) {
          const generics = node.params.length
            ? `<${node.params
                .map(p => `out ${p.toUpperCase()}`)
                .join(', ')}>`
            : ''

          const head = `sealed class ${pascal(node.name)}${generics}`
          const subclasses = node.variants.map(v => {
            const cls =
              variantClassOf.get(v.name)?.get(node.name) ??
              `${pascal(node.name)}${pascal(v.name)}`
            // the variant carries only the generics its own fields mention; the rest of the type's params are Nothing
            const usesGeneric = (name: string) =>
              v.fields.some(f => mentions(f.type, name))

            const ownGenerics = node.params.filter(usesGeneric)
            const genericDecl = ownGenerics.length
              ? `<${ownGenerics
                  .map(p => `out ${p.toUpperCase()}`)
                  .join(', ')}>`
              : ''

            const superArgs = node.params.length
              ? `<${node.params
                  .map(p =>
                    usesGeneric(p) ? p.toUpperCase() : 'Nothing',
                  )
                  .join(', ')}>`
              : ''

            if (v.fields.length > 0) {
              // a reused variant's fields are written when its spare is rebuilt (`reuseVariants`)
              const held = reuseVariants.has(v.name) ? '@JvmField var' : 'val'
              const arrayOf = (f: { name: string }): HeldKind | undefined => variantArrays.get(`${v.name}/${f.name}`)
              const typeOf = (f: { name: string; type: Type }): string => {
                const kind = arrayOf(f)

                return kind === 'Object' && f.type.kind === 'array' ? `Array<${kotlinType(f.type.element)}>` : kind ? `${kind}Array` : kotlinType(f.type)
              }
              const fields = v.fields
                .map(f => `${held} ${camel(f.name)}: ${typeOf(f)}`)
                .join(', ')
              // a primitive array field (`variantArrays`) compares, hashes and prints by its contents, as the list it
              // stands for does: a data class would compare the arrays by reference
              const body = v.fields.some(arrayOf)
                ? ` {\n${pad(1)}override fun equals(other: Any?): Boolean = other is ${cls} && ${v.fields
                    .map(f => (arrayOf(f) ? `${camel(f.name)}.contentEquals(other.${camel(f.name)})` : `${camel(f.name)} == other.${camel(f.name)}`))
                    .join(' && ')}\n${pad(1)}override fun hashCode(): Int = ${v.fields
                    .map(f => (arrayOf(f) ? `${camel(f.name)}.contentHashCode()` : `${camel(f.name)}.hashCode()`))
                    .reduce((sum, h) => `31 * (${sum}) + ${h}`)}\n${pad(1)}override fun toString(): String = "${cls}(${v.fields
                    .map(f => `${camel(f.name)}=\${${arrayOf(f) ? `${camel(f.name)}.contentToString()` : camel(f.name)}}`)
                    .join(', ')})"\n}`
                : ''

              return `data class ${cls}${genericDecl}(${fields}) : ${pascal(
                node.name,
              )}${superArgs}()${body}`
            }

            const objectSuper = node.params.length
              ? `<${node.params.map(() => 'Nothing').join(', ')}>`
              : ''

            return `object ${cls} : ${pascal(
              node.name,
            )}${objectSuper}()`
          })

          return [`${head}`, ...subclasses].join('\n')
        }

        // a field nothing in the program reassigns is a `val`: the class says what the program does, and a form used
        // as a map key cannot have its hash changed under the map. Every field was a `var` until 2026-10-02
        // (note/term/codegen/android.md, K4)
        // a list of `Long` the record owns is typed the `TermLongs` it is (`fieldLists`), read and written past the
        // generic List signature
        const fields = node.fields
          .map(
            f =>
              `${assignedFields.has(f.name) ? 'var' : 'val'} ${camel(f.name)}: ${
                fieldLists.has(`${node.name}/${f.name}`) ? need('longs', 'TermLongs') : kotlinType(f.type)
              }`,
          )
          .join(', ')

        const generics = node.params.length
          ? `<${node.params.map(p => p.toUpperCase()).join(', ')}>`
          : ''

        // a data class needs a constructor parameter; a form with no fields (a method-only interface form) is a
        // plain class. `is-equal` compares records by their fields on every backend (note/term/optimize/meaning.md,
        // question 4): a data class does that, and a field-less class gets the same answer (every two are equal) from
        // the members below. A `note shared` form is a reference by design, so it is a plain class compared by
        // identity, as it is on TypeScript and Swift.
        const fieldless = node.fields.length === 0 && !node.shared
        const decl = node.shared
          ? `class ${pascal(node.name)}${generics}${node.fields.length > 0 ? `(${fields})` : ''}`
          : node.fields.length > 0
            ? `data class ${pascal(node.name)}${generics}(${fields})`
            : `class ${pascal(node.name)}${generics}`
        const fieldlessEquality = [
          `${pad(d + 1)}override fun equals(other: Any?): Boolean = other is ${pascal(node.name)}${node.params.length ? `<${node.params.map(() => '*').join(', ')}>` : ''}`,
          `${pad(d + 1)}override fun hashCode(): Int = ${JSON.stringify(node.name)}.hashCode()`,
        ]
        // a form that implements traits declares them on the data class with overrides delegating to the free functions
        const impls = conformances.get(node.name) ?? []

        if (impls.length === 0) {
          return fieldless ? `${decl} {\n${fieldlessEquality.join('\n')}\n${pad(d)}}` : decl
        }

        const supers = impls.map(i => pascal(i.mask)).join(', ')
        const overrides = impls.flatMap(i =>
          i.methods
            .map(m =>
              overrideMethod(
                implFn.get(`${node.name}:${m}`),
                node.name,
                i.mask,
              ),
            )
            .filter(Boolean)
            .map(line => `${pad(d + 1)}${line}`),
        )

        return `${decl} : ${supers} {\n${[...(fieldless ? fieldlessEquality : []), ...overrides].join('\n')}\n${pad(d)}}`
      }

      case 'mask': {
        // an interface whose method requirements are derived from any implementing instance's signature
        const target = instanceTargets.get(node.name)?.[0]
        const methods = target
          ? node.methods
              .map(
                m =>
                  `${pad(d + 1)}${interfaceMethod(
                    implFn.get(`${target}:${m}`),
                    target,
                    node.name,
                  )}`,
              )
              .filter(line => line.trim())
          : []

        return `interface ${pascal(node.name)} {${
          methods.length ? `\n${methods.join('\n')}\n${pad(d)}` : ''
        }}`
      }

      case 'instance':
        // conformance is declared on the data class (see record-type), so nothing is emitted here
        return ''
      case 'hold':
        return '// hold: verified at compile time'
      case 'native':
        return ''
      case 'bind':
      case 'view':
      case 'dock':
      case 'tell':
      case 'roll':
        return '' // view / routing DSLs are lowered by the dedicated zone compiler, not this backend
      default:
        return exhausted(node)
    }
  }

  // a `<global:X>` binding (e.g. the linked `io` runtime object) needs no import: it is already in scope. A `type` dock
  // is an inline type reference (a fully-qualified handle type), not an importable module.
  const imports = program
    .filter(
      (n): n is Extract<Statement, { form: 'native' }> =>
        n.form === 'native' &&
        n.kind !== 'type' &&
        !n.module.startsWith('global:'),
    )
    .map(
      n =>
        `import ${n.module
          .replace(/^[a-z]+:/, '')
          .replace(/\//g, '.')}`,
    )

  // plus the import each rendered `bind` needs (e.g. `import kotlin.math.pow` for a `case kotlin` that calls `pow`).
  // Only binds actually called contribute, matching the other backends.
  for (const need of bindImports(
    referencedBinds(program, binds),
    'kotlin',
  )) {
    const path = need.module.replace(/^[a-z]+:/, '').replace(/\//g, '.')
    const line = need.alias
      ? `import ${path} as ${camel(need.alias)}`
      : `import ${path}`

    if (!imports.includes(line)) {
      imports.push(line)
    }
  }

  // a module-level `host` data tree is an ANONYMOUS nested record: with no form to name it the construction
  // has nothing to reference. Synthesize one data class per record node, named by the binding and the field
  // path (HostRange, HostRangeH), and rename the record nodes so the construction uses it.
  const hostClassDefs: string[] = []
  const kotlinHostLeaf = (v: Expression): string =>
    v.form === 'integer'
      ? 'Long'
      : v.form === 'float'
        ? 'Double'
        : v.form === 'string'
          ? 'String'
          : v.form === 'boolean'
            ? 'Boolean'
            : 'Long'
  const nameHostRecord = (
    node: Extract<Expression, { form: 'record' }>,
    base: string,
  ): string => {
    node.name = base

    const fields = node.fields.map(f => {
      const type =
        f.value.form === 'record' && f.value.name === ''
          ? nameHostRecord(f.value, `${base}${pascal(f.name)}`)
          : kotlinHostLeaf(f.value)

      return `val ${camel(f.name)}: ${type}`
    })

    hostClassDefs.push(`data class ${base}(${fields.join(', ')})`)

    return base
  }

  for (const node of program) {
    if (
      node.form === 'let' &&
      node.init.form === 'record' &&
      node.init.name === ''
    ) {
      nameHostRecord(node.init, `Host${pascal(node.name)}`)
    }
  }

  // an abstract module's signature-only declaration and the platform module's implementation share a name by
  // design (platform dispatch): the stub yields to the implementation instead of redeclaring it
  const implemented = new Set(
    program
      .filter(
        (n): n is Extract<Statement, { form: 'function' }> =>
          n.form === 'function' && n.body.length > 0,
      )
      .map(n => n.name),
  )


  // a form declared in an abstract module AND its platform module lands twice in the closure: the empty
  // declaration yields to the full one, and an exact repeat keeps only its first appearance
  const fullForms = new Set(
    program
      .filter(
        (n): n is Extract<Statement, { form: 'record-type' }> =>
          n.form === 'record-type' &&
          (n.fields.length > 0 || n.variants.length > 0),
      )
      .map(n => n.name),
  )
  const seenForms = new Set<string>()
  // a module collected twice (two import spellings of one file) emits its functions twice: keep the first
  const seenFns = new Set<string>()
  const keepStatement = (n: Statement): boolean => {
    if (n.form === 'function') {
      const key = `${n.name}/${n.params.length}`

      if (seenFns.has(key)) {
        return false
      }

      seenFns.add(key)
    }

    if (n.form !== 'record-type') {
      return true
    }

    if (
      n.fields.length === 0 &&
      n.variants.length === 0 &&
      fullForms.has(n.name)
    ) {
      return false
    }

    if (seenForms.has(n.name)) {
      return false
    }

    seenForms.add(n.name)

    return true
  }

  const body = [
    ...hostClassDefs,
    ...program
      .filter(n => n.form !== 'native')
      .filter(
        n =>
          !(
            n.form === 'function' &&
            n.body.length === 0 &&
            implemented.has(n.name)
          ),
      )
      .filter(keepStatement)
      .map(n => stmt(n, 0))
      .filter(Boolean),
    ...kotlinFormWalk(fillSpecs, meltSpecs),
  ]

  // each reused variant's spare and the construction that rebuilds it (`reuseVariants`): the fields are computed by the
  // caller as arguments, so the spare is written only once all of them are in hand
  for (const [label, reused] of reuseVariants) {
    const form = program.find(n => n.form === 'record-type' && n.name === reused.form)
    const variant = form?.form === 'record-type' ? form.variants.find(v => v.name === label) : undefined
    const cls = classFor(label, { kind: 'named', name: reused.form } as Type) ?? `${pascal(reused.form)}${pascal(label)}`

    if (!variant) {
      continue
    }

    const params = variant.fields.map(f => `${camel(f.name)}: ${kotlinType(f.type)}`).join(', ')
    const sets = variant.fields.map(f => `held.${camel(f.name)} = ${camel(f.name)}`).join('; ')
    const args = variant.fields.map(f => camel(f.name)).join(', ')

    body.push(
      `@JvmField var termSpare${cls}: ${cls}? = null\n\nfun termReuse${cls}(${params}): ${cls} {\n    val held = termSpare${cls} ?: return ${cls}(${args})\n    termSpare${cls} = null\n    ${sets}\n    return held\n}`,
    )
  }

  // each task a guarded loop calls unchecked, once more with no overflow checks (`aValueFast`), behind the bound the
  // guard proved its arguments inside (ir/facts/bounds.ts, `integerBounds`)
  for (const name of fastTasks) {
    const fn = program.find((n): n is Extract<Statement, { form: 'function' }> => n.form === 'function' && n.name === name)

    if (fn) {
      uncheckedInts = true
      body.push(stmt({ ...fn, name: `${name}-fast` }, 0))
      uncheckedInts = false
    }
  }

  // each task a reuse site calls, once more building its result in the object it was given (`recordReuse`)
  for (const name of reuseTasks) {
    const fn = program.find((n): n is Extract<Statement, { form: 'function' }> => n.form === 'function' && n.name === name)
    const task = reuse.tasks.get(name)

    if (fn && task) {
      reusing = { param: fn.params[task.param]!.name, builds: task.builds, keep: task.keep?.field, carriers: task.carriers }
      // with a kept field, the copy answers that field alone
      body.push(stmt({ ...fn, name: `${name}-reuse`, ...(task.keep ? { result: task.keep.type } : {}) }, 0))
      reusing = undefined
    }
  }

  // the form walkers raise SeedError on a mismatch
  if (fillSpecs.size > 0 || meltSpecs.size > 0) {
    needs.add('error')
  }

  const prelude = (Object.keys(KOTLIN_HELPERS) as KotlinHelper[]).filter(h => needs.has(h)).map(h => KOTLIN_HELPERS[h])

  // the wake chain: one `hiveWake` per deck with its static entries, when the program has the stdlib hive and
  // the compile driver handed over the roll. A static entry's `base` is the declaration as JSON text; an entry
  // with a `ref` (a declared kind's constant) binds the live module constant. See note/term/hive/05-hive.md.
  const wake: string[] = []

  if (
    options?.wake?.length &&
    program.some(n => n.form === 'function' && n.name === 'hive-wake')
  ) {
    const entryText = (entry: Record<string, unknown>): string => {
      const { ref, base, ...own } = entry
      const boxed =
        typeof ref === 'string'
          ? camel(ref)
          : JSON.stringify(JSON.stringify(base ?? {}))

      return `HiveEntry(host = ${JSON.stringify(String(own.host ?? ''))}, kind = ${JSON.stringify(String(own.kind ?? ''))}, name = ${JSON.stringify(String(own.name ?? ''))}, site = ${JSON.stringify(String(own.site ?? ''))}, base = ${boxed})`
    }

    const calls = options.wake
      .map(
        group =>
          `    hiveWake(${JSON.stringify(group.deck)}, mutableListOf(${group.entries.map(entryText).join(', ')}))`,
      )
      .join('\n')

    wake.push(`fun wakeHive(): Unit {\n${calls}\n}`)
  }

  return [...imports, ...prelude, ...body, ...wake].join('\n\n') + '\n'
}

// The tasks emitted as `inline fun` (note/term/codegen/android.md, K3). A task that takes a function and only calls it
// is inlined by kotlinc at each call site: the lambda's body is copied in, so no `Function1` is allocated and nothing
// is boxed through it. Every function parameter must be non-escaping (escapingParams, shared with Swift's
// `@escaping`), since an inline function may not store or pass on a lambda it was given; the body is at most 120 nodes,
// since each call copies it; and the task must not reach itself through other inline tasks, since kotlinc refuses a
// recursive inline function
function inlinable(program: Program): Set<string> {
  type Fn = Extract<Statement, { form: 'function' }>
  const size = (value: unknown): number => {
    if (typeof value !== 'object' || value === null) {
      return 0
    }

    if (Array.isArray(value)) {
      return value.reduce((n: number, v) => n + size(v), 0)
    }

    const node = value as Record<string, unknown>
    let n = typeof node.form === 'string' ? 1 : 0

    for (const [key, child] of Object.entries(node)) {
      if (key !== 'type' && key !== 'span') {
        n += size(child)
      }
    }

    return n
  }
  const candidates = new Map<string, Fn>()

  for (const node of program) {
    if (
      node.form === 'function' &&
      node.body.length > 0 &&
      node.params.some(p => p.type?.kind === 'function') &&
      escapingParams(node).size === 0 &&
      size(node.body) <= 120
    ) {
      candidates.set(node.name, node)
    }
  }

  // the candidates each one names (as a callee or a value), and every candidate that can reach itself through them
  const named = (fn: Fn): Set<string> => {
    const out = new Set<string>()
    const visit = (value: unknown): void => {
      if (typeof value !== 'object' || value === null) {
        return
      }

      if (Array.isArray(value)) {
        value.forEach(visit)

        return
      }

      const node = value as Record<string, unknown>

      if (node.form === 'variable' && typeof node.name === 'string' && candidates.has(node.name)) {
        out.add(node.name)
      }

      for (const [key, child] of Object.entries(node)) {
        if (key !== 'type' && key !== 'span') {
          visit(child)
        }
      }
    }

    visit(fn.body)

    return out
  }
  const edges = new Map([...candidates].map(([name, fn]) => [name, named(fn)]))
  const reaches = (start: string): boolean => {
    const seen = new Set<string>()
    const stack = [...(edges.get(start) ?? [])]

    while (stack.length) {
      const next = stack.pop()!

      if (next === start) {
        return true
      }

      if (!seen.has(next)) {
        seen.add(next)
        stack.push(...(edges.get(next) ?? []))
      }
    }

    return false
  }

  return new Set([...candidates.keys()].filter(name => !reaches(name)))
}

// the field names an assignment writes anywhere in the program: `save a/b/c, ...` reassigns `c` (and nothing else, since
// `b` is read and then written through). By name rather than by form, which can only keep a field `var` that need not
// be, never make one `val` that some write reaches
function fieldsAssigned(program: Program): Set<string> {
  type Loose = { form?: string; [key: string]: unknown }
  const names = new Set<string>()
  const seen = new Set<object>()
  const visit = (value: unknown): void => {
    if (typeof value !== 'object' || value === null || seen.has(value)) {
      return
    }

    seen.add(value)

    if (Array.isArray(value)) {
      value.forEach(visit)

      return
    }

    const node = value as Loose

    // every field along the path: a nested write is rebuilt from its first field (`p.inner = p.inner.copy(count = 9)`)
    if (node.form === 'assign' && (node.target as Loose).form === 'member') {
      for (let at = node.target as Loose; at.form === 'member'; at = at.target as Loose) {
        names.add(at.name as string)
      }
    }

    for (const [key, child] of Object.entries(node)) {
      if (key !== 'type' && key !== 'span') {
        visit(child)
      }
    }
  }

  visit(program)

  return names
}

// does a type mention a given generic parameter name?
// REUSE OF A NODE (note/term/codegen/readme.md, Kotlin Towers): the variants whose node a pop may keep as a spare and the
// next construction rebuild in place, where it made a new object per push (Towers 204 ms to 161, measured by hand,
// `tmp/kotlin-towers-reuse-ab.ts`). Sound only where every node has one owner, and the fact that says so is Rust's: a
// recursive form no Rust emission ever clones (`rustBoxing`) is one whose values are never duplicated, since Rust copies
// exactly where a value is wanted twice. A variant of such a form that holds the form itself takes part, with the form's
// field-less case to clear the spare's links; the program must run nothing concurrently (no native module, no async
// task), since one spare per variant is shared by the whole program. Answers each variant with its form and empty case
export type KotlinReuse = Map<string, { form: string; empty: string; fields: string[]; recursive: string[] }>

function kotlinReuse(program: Program): KotlinReuse {
  const out: KotlinReuse = new Map()
  const recursive = program.some(
    n => n.form === 'record-type' && n.variants.some(v => v.fields.some(f => f.type.kind === 'named' && f.type.name === n.name)),
  )

  if (!recursive || program.some(n => n.form === 'native' || (n.form === 'function' && n.async))) {
    return out
  }

  let boxed: string[]

  try {
    boxed = rustBoxing(program).boxed
  } catch {
    return out
  }

  for (const name of boxed) {
    const form = program.find(n => n.form === 'record-type' && n.name === name)

    if (form?.form !== 'record-type' || form.params.length > 0) {
      continue
    }

    const empty = form.variants.find(v => v.fields.length === 0)

    if (!empty) {
      continue
    }

    for (const v of form.variants) {
      const links = v.fields.filter(f => f.type.kind === 'named' && f.type.name === name).map(f => f.name)

      if (links.length) {
        out.set(v.name, { form: name, empty: empty.name, fields: v.fields.map(f => f.name), recursive: links })
      }
    }
  }

  return out
}

function mentions(type: Type | undefined, name: string): boolean {
  switch (type?.kind) {
    case 'named':
      return (
        type.name === name ||
        (type.args?.some(a => mentions(a, name)) ?? false)
      )
    case 'array':
      return mentions(type.element, name)
    case 'map':
      return mentions(type.key, name) || mentions(type.value, name)
    case 'function':
      return (
        type.params.some(p => mentions(p, name)) ||
        mentions(type.result, name)
      )
    default:
      return false
  }
}

// ---- filling a form from data on kotlin ----

// the walkers a module's `fill` / `melt` with a form need: helpers over the package's `Data` sealed class, then a
// function per form. A value that does not fit throws, the way a raise does on this backend, with the path and
// reason of the package's `data-mismatch`.
function kotlinFormWalk(fills: Map<string, FormSpec>, melts: Map<string, FormSpec>): string[] {
  if (fills.size === 0 && melts.size === 0) {
    return []
  }

  const out: string[] = [KOTLIN_FORM_HELPERS]

  const fillOf = (kind: FormKind, value: string, path: string, optional: boolean): string => {
    switch (kind.kind) {
      case 'text':
        return `__termText(${value}, ${path}, ${optional})`
      case 'number':
        return `__termNumber(${value}, ${path}, ${optional})`
      case 'decimal':
        return `__termDecimal(${value}, ${path}, ${optional})`
      case 'flag':
        return `__termFlag(${value}, ${path}, ${optional})`
      case 'data':
        return `__termData(${value}, ${path}, ${optional})`
      case 'list':
        return `__termList(${value}, ${path}, ${optional}) { d, p -> ${fillOf(kind.item, 'd', 'p', false)} }`
      case 'form':
        return `__fill${pascal(kind.spec.form)}(__termData(${value}, ${path}, ${optional}), ${path})`
      default:
        return '0L'
    }
  }

  for (const spec of fills.values()) {
    const known = spec.fields.map(f => JSON.stringify(f.name)).join(', ')
    const fields = spec.fields
      .map(f => `${camel(f.name)} = ${fillOf(f.kind, `find(${JSON.stringify(f.name)})`, `__termPath(path, ${JSON.stringify(f.name)})`, f.optional)}`)
      .join(', ')

    out.push(
      `fun __fill${pascal(spec.form)}(value: Data, path: String): ${pascal(spec.form)} {\n` +
        `    val entries = __termEntries(value, path)\n` +
        `    val known = setOf(${known})\n` +
        `    for (e in entries) { if (!known.contains(e.name)) __termMismatch(__termPath(path, e.name), "is not in the form") }\n` +
        `    fun find(name: String): Data? = entries.firstOrNull { it.name == name }?.base\n` +
        `    return ${pascal(spec.form)}(${fields})\n}`,
    )
  }

  const meltOf = (kind: FormKind, value: string): string => {
    switch (kind.kind) {
      case 'text':
        return `DataText(value = ${value})`
      case 'number':
        return `DataNumber(value = ${value})`
      case 'decimal':
        return `DataDecimal(value = ${value})`
      case 'flag':
        return `DataFlag(value = ${value})`
      case 'data':
        return value
      case 'list':
        return `DataArray(list = (${value}).mapTo(ArrayList()) { x -> ${meltOf(kind.item, 'x')} })`
      case 'form':
        return `__melt${pascal(kind.spec.form)}(${value})`
      default:
        return 'DataBlank'
    }
  }

  const emptyTest = (kind: FormKind, value: string): string | undefined => {
    switch (kind.kind) {
      case 'text':
        return `(${value}).isEmpty()`
      case 'list':
        return `(${value}).isEmpty()`
      case 'data':
        return `(${value} is DataBlank)`
      default:
        return undefined
    }
  }

  for (const spec of melts.values()) {
    const lines = spec.fields.map(f => {
      const value = `value.${camel(f.name)}`
      const entry = `list.add(DataEntry(name = ${JSON.stringify(f.name)}, base = ${meltOf(f.kind, value)}))`
      const empty = f.optional ? emptyTest(f.kind, value) : undefined

      return empty ? `    if (!${empty}) { ${entry} }` : `    ${entry}`
    })

    out.push(
      `fun __melt${pascal(spec.form)}(value: ${pascal(spec.form)}): Data {\n    val list = mutableListOf<DataEntry>()\n${lines.join('\n')}\n    return DataHash(list = list)\n}`,
    )
  }

  return out
}

const KOTLIN_FORM_HELPERS = `fun __termMismatch(path: String, reason: String): Nothing =
    throw SeedError("data-mismatch: Data does not fit the shape: " + (if (path.isEmpty()) "." else path) + " " + reason)
fun __termPath(path: String, key: String): String = if (path.isEmpty()) key else path + "/" + key
fun __termKind(value: Data): String = when (value) {
    is DataHash -> "a map"; is DataArray -> "a list"; is DataBlank -> "void"; is DataText -> "text"; is DataNumber -> "number"; is DataDecimal -> "decimal"; is DataFlag -> "flag"; is DataGraft -> "a fuse"
}
fun __termEntries(value: Data, path: String): MutableList<DataEntry> = when (value) {
    is DataHash -> value.list
    else -> __termMismatch(path, "is " + __termKind(value) + " where a map belongs")
}
fun __termText(value: Data?, path: String, optional: Boolean): String = when (value) {
    is DataText -> value.value
    null, is DataBlank -> if (optional) "" else __termMismatch(path, "is missing")
    else -> __termMismatch(path, "is " + __termKind(value) + " where text belongs")
}
fun __termNumber(value: Data?, path: String, optional: Boolean): Long = when (value) {
    is DataNumber -> value.value
    null, is DataBlank -> if (optional) 0L else __termMismatch(path, "is missing")
    else -> __termMismatch(path, "is " + __termKind(value) + " where number belongs")
}
fun __termDecimal(value: Data?, path: String, optional: Boolean): Double = when (value) {
    is DataDecimal -> value.value
    is DataNumber -> value.value.toDouble()
    null, is DataBlank -> if (optional) 0.0 else __termMismatch(path, "is missing")
    else -> __termMismatch(path, "is " + __termKind(value) + " where decimal belongs")
}
fun __termFlag(value: Data?, path: String, optional: Boolean): Boolean = when (value) {
    is DataFlag -> value.value
    null, is DataBlank -> if (optional) false else __termMismatch(path, "is missing")
    else -> __termMismatch(path, "is " + __termKind(value) + " where flag belongs")
}
fun __termData(value: Data?, path: String, optional: Boolean): Data = value ?: (if (optional) DataBlank else __termMismatch(path, "is missing"))
fun <T> __termList(value: Data?, path: String, optional: Boolean, item: (Data, String) -> T): MutableList<T> = when (value) {
    is DataArray -> value.list.mapIndexedTo(ArrayList()) { i, d -> item(d, __termPath(path, i.toString())) }
    null, is DataBlank -> if (optional) mutableListOf() else __termMismatch(path, "is missing")
    else -> __termMismatch(path, "is " + __termKind(value) + " where a list belongs")
}`
