// The Kotlin backend: emit the language as idiomatic, type-static Kotlin. Parity with the TypeScript backend across
// every AST form. Algebraic data types lower to NATIVE sealed-class hierarchies (`sealed class Maybe<out T>` with a
// subclass per variant), `match` to an exhaustive `when (subject) { is MaybeSome -> ... }` whose smart-casts make a
// variant's fields directly accessible (no rewrite needed), and struct forms to `data class`es. A variant subclass
// carries only the generics its own fields use, filling the rest with `Nothing` (valid under `out` variance), so
// construction infers cleanly. Pure, browser-safe. See note/research/vibe/computation/plans/07-codegen.md.
//
// The emitter is Term in three parts (self-hosting, 2026-10-06): compile/kotlin-names.tree, the helpers that read no
// emitter state (the names, a type's inference variables, a float literal, the form walkers), compile/kotlin-facts.tree,
// the analyses `emitKotlin` computed inside itself (the forms that hold a float, the reused variants, the inline tasks,
// the variant fields held as arrays, a task's spares), and compile/kotlin-emit.tree, the emitter itself. This file keeps
// the runtime texts, the analyses other modules answer, and `emitKotlin`, which hands the emitter the program's tables
// and the node-keyed answers as tests, and assembles the module.

import { keepDocksApart } from '@term/make/code/compile/dock-apart'
import { markUnit, unmarked } from '@term/make/code/compile/unit-split'
import { provenIncrements } from '@term/make/code/ir/facts/range'
import { provenArithmetic, type Proven } from '@term/make/code/compile/proven'
import { boundedLoops } from '@term/make/code/ir/facts/bounds'
import { asciiTexts } from '@term/make/code/ir/facts/text'
import { taggedForms } from '@term/make/code/compile/tag'
import type { Expression, Program, Statement, Type } from '@term/make/code/compile/node'
import { fillTasks, lastReads, ownedFields, slotTakes, tailTasks, recordCopies, redeclaredLets, textCursors } from '@term/make/code/compile/backend'
import type { FormSpec, TextCursors } from '@term/make/code/compile/backend'
import { rustBoxing } from '@term/make/code/compile/rust'
import { privateForms, recordPlaces, recordReuse } from '@term/make/code/compile/place'
import { gatedTasks, listFacts, fixedLists } from '@term/make/code/compile/backend'
import { collectBinds, bindImports, referencedBinds } from '@term/make/code/compile/bind'
import * as kotlinNames from '@term/make/code/compile/kotlin-names'
import * as kotlinFacts from '@term/make/code/compile/kotlin-facts'
import * as kotlinEmit from '@term/make/code/compile/kotlin-emit'

type Maybe<T> = { form: 'some'; value: T } | { form: 'none' }
const boxed = <T>(value: T | undefined): Maybe<T> => (value === undefined ? { form: 'none' } : { form: 'some', value })

function camel(name: string): string {
  return kotlinNames.kotlinCamel(name)
}

function pascal(name: string): string {
  return kotlinNames.kotlinPascal(name)
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
  // an integer step past i64 is a STOP (D15): TermStop is an Error, not a TermException, so no guard hands it to a
  // handler (the guard's pass-on rethrows it) and the process ends naming excess or shortage. The JVM's own
  // ArithmeticException from `Math.*Exact` is turned into it here. The sign of the overflowed result names the side
  stop: [
    'class TermStop(message: String) : Error(message)',
    'fun termAdd(a: Long, b: Long): Long = try { Math.addExact(a, b) } catch (e: ArithmeticException) { throw TermStop(if (a < 0L) "shortage: a number past -9223372036854775808" else "excess: a number past 9223372036854775807") }',
    'fun termSubtract(a: Long, b: Long): Long = try { Math.subtractExact(a, b) } catch (e: ArithmeticException) { throw TermStop(if (a < 0L) "shortage: a number past -9223372036854775808" else "excess: a number past 9223372036854775807") }',
    'fun termMultiply(a: Long, b: Long): Long = try { Math.multiplyExact(a, b) } catch (e: ArithmeticException) { throw TermStop(if ((a < 0L) != (b < 0L)) "shortage: a number past -9223372036854775808" else "excess: a number past 9223372036854775807") }',
    'fun termNegate(a: Long): Long = try { Math.negateExact(a) } catch (e: ArithmeticException) { throw TermStop("excess: a number past 9223372036854775807") }',
  ].join('\n\n'),
  // integer division that stops where the JVM wraps (`Long.MIN_VALUE / -1`, a stop through termNegate). A zero divisor
  // raises the `defect` TypeScript raises (`__termIntStop`), so a guard catches the same exception on both. The JVM's
  // own ArithmeticException reached a guard as `failure`
  divide: [
    'fun termDivide(a: Long, b: Long): Long = if (b == 0L) throw termByZero() else if (b == -1L) termNegate(a) else a / b',
    'fun termByZero(): TermException = TermException("@term/base", "defect", "Invalid", "", System.currentTimeMillis(), null, null)',
  ].join('\n\n'),
  // an integer remainder, raising the same `defect` on a zero divisor
  remainder: 'fun termRemainder(a: Long, b: Long): Long = if (b == 0L) throw termByZero() else a % b',
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
  // THE EVENT LOOP: every coroutine of the program runs on one thread, interleaved only where each one waits, which is
  // node's model. A wait that is not done resumes by posting to the loop's queue (a timer from its own daemon thread),
  // and whatever drives the program, `termLoop.block` for an asynchronous entry or `run-pending` between turns, runs
  // what was posted. kotlinx is not a dependency, so this is the standard library's coroutine machinery alone
  start: [
    'import kotlin.coroutines.startCoroutine',
    'import kotlin.coroutines.suspendCoroutine',
    'import kotlin.coroutines.resume',
    'fun termStart(body: suspend () -> Unit) {\n    body.startCoroutine(object : kotlin.coroutines.Continuation<Unit> {\n        override val context: kotlin.coroutines.CoroutineContext = kotlin.coroutines.EmptyCoroutineContext\n        override fun resumeWith(result: Result<Unit>) {\n            result.getOrThrow()\n        }\n    })\n}',
    [
      'object termLoop {',
      '    private val queue = java.util.concurrent.LinkedBlockingQueue<() -> Unit>()',
      '    private val timers = java.util.concurrent.atomic.AtomicInteger()',
      '    private val clock = java.util.concurrent.Executors.newSingleThreadScheduledExecutor { r -> Thread(r).apply { isDaemon = true } }',
      '    fun post(work: () -> Unit) { queue.put(work) }',
      '    // `work` on the loop once `ms` have passed',
      '    fun after(ms: Long, work: () -> Unit) {',
      '        timers.incrementAndGet()',
      '        clock.schedule({ post { timers.decrementAndGet(); work() } }, maxOf(ms, 0L), java.util.concurrent.TimeUnit.MILLISECONDS)',
      '    }',
      '    // run an asynchronous entry to its answer on this thread, running what is posted meanwhile. With nothing posted',
      '    // and no timer due, the program waits on work that nothing can finish, and it stops rather than hanging',
      '    fun <T> block(body: suspend () -> T): T {',
      '        var outcome: Result<T>? = null',
      '        body.startCoroutine(object : kotlin.coroutines.Continuation<T> {',
      '            override val context: kotlin.coroutines.CoroutineContext = kotlin.coroutines.EmptyCoroutineContext',
      '            override fun resumeWith(result: Result<T>) { outcome = result }',
      '        })',
      '        // `kotlin.error`, qualified: a program that loads @term/base/log defines its own `error`, which answers Unit',
      '        // and made `work` an Any that cannot be called (device-layer-0013, the Android cask)',
      '        while (outcome == null) {',
      '            val work = queue.poll() ?: if (timers.get() == 0) kotlin.error("defect: the program waits on work that nothing can finish") else queue.take()',
      '            work()',
      '        }',
      '        return outcome!!.getOrThrow()',
      '    }',
      '    // run what is posted until nothing is (`run-pending`)',
      '    fun drain() { while (true) { val work = queue.poll() ?: return; work() } }',
      '}',
    ].join('\n'),
    '// a wait that blocks nothing: the coroutine resumes on the loop once `ms` have passed\nsuspend fun termSleep(ms: Long) { suspendCoroutine<Unit> { waiting -> termLoop.after(ms) { waiting.resume(Unit) } } }',
  ].join('\n\n'),
  // the two equalities a float needs told apart, as TypeScript tells them (`__termEqual`, `__termKeyText`). A KEY
  // has one NaN and `-0.0` is `0.0`: a record that holds a float compares and hashes by it (its `equals`), and a
  // float key is folded by `termKey` where a map is read or written. A VALUE compares by IEEE, NaN unequal to itself:
  // `is-equal` over anything holding a float is `termEqual`, which a record answers through `TermValued`. Kotlin's
  // own `Double.equals` is neither, NaN equal and the two zeros apart
  key: [
    'interface TermValued { fun termValueEq(other: Any?): Boolean }',
    'fun termFolds(v: Any?): Boolean = when (v) {\n    is Double -> { val d: Double = v; d == 0.0 && 1.0 / d < 0.0 }\n    is List<*> -> v.any { termFolds(it) }\n    else -> false\n}',
    '@Suppress("UNCHECKED_CAST")\nfun <T> termKey(v: T): T = when (v) {\n    is Double -> { val d: Double = v; (if (d == 0.0) 0.0 else d) as T }\n    is List<*> -> if (v.any { termFolds(it) }) v.map { termKey(it) }.toMutableList() as T else v\n    else -> v\n}',
    'fun termKeyEq(a: Any?, b: Any?): Boolean = when {\n    a is Double && b is Double -> { val x: Double = a; val y: Double = b; x == y || (x.isNaN() && y.isNaN()) }\n    a is DoubleArray && b is DoubleArray -> a.size == b.size && a.indices.all { termKeyEq(a[it], b[it]) }\n    a is Array<*> && b is Array<*> -> a.size == b.size && a.indices.all { termKeyEq(a[it], b[it]) }\n    a is List<*> && b is List<*> -> a.size == b.size && a.indices.all { termKeyEq(a[it], b[it]) }\n    a is LongArray && b is LongArray -> a.contentEquals(b)\n    else -> a == b\n}',
    'fun termKeyHash(a: Any?): Int = when (a) {\n    null -> 0\n    is Double -> { val d: Double = a; if (d == 0.0) 0 else d.hashCode() }\n    is DoubleArray -> a.fold(1) { h, x -> 31 * h + termKeyHash(x) }\n    is Array<*> -> a.fold(1) { h, x -> 31 * h + termKeyHash(x) }\n    is List<*> -> a.fold(1) { h, x -> 31 * h + termKeyHash(x) }\n    is LongArray -> a.contentHashCode()\n    else -> a.hashCode()\n}',
    'fun termEqual(a: Any?, b: Any?): Boolean = when {\n    a is Double && b is Double -> { val x: Double = a; val y: Double = b; x == y }\n    a is DoubleArray && b is DoubleArray -> a.size == b.size && a.indices.all { val x: Double = a[it]; val y: Double = b[it]; x == y }\n    a is Array<*> && b is Array<*> -> a.size == b.size && a.indices.all { termEqual(a[it], b[it]) }\n    a is List<*> && b is List<*> -> a.size == b.size && a.indices.all { termEqual(a[it], b[it]) }\n    a is Map<*, *> && b is Map<*, *> -> a.size == b.size && a.all { (k, v) -> b.containsKey(k) && termEqual(v, b[k]) }\n    a is LongArray && b is LongArray -> a.contentEquals(b)\n    a is TermValued -> a.termValueEq(b)\n    else -> a == b\n}',
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

// the roll grouped by deck, for the generated wake chain (the same shape emitTypeScript takes)
export type WakeGroup = {
  deck: string
  entries: Record<string, unknown>[]
}

// The reflective count of nodes in a task's body (every object with a `form`, past `type` and `span`), as the original
// measured an inline task: it counts the maybe wrappers and the template parts too, which a Term walk cannot see
function nodeSize(value: unknown): number {
  if (typeof value !== 'object' || value === null) {
    return 0
  }

  if (Array.isArray(value)) {
    return value.reduce((n: number, v) => n + nodeSize(v), 0)
  }

  const node = value as Record<string, unknown>
  let n = typeof node.form === 'string' ? 1 : 0

  for (const [key, child] of Object.entries(node)) {
    if (key !== 'type' && key !== 'span') {
      n += nodeSize(child)
    }
  }

  return n
}

export function emitKotlin(
  written: Program,
  options?: { wake?: WakeGroup[]; units?: boolean },
): string {
  // a task named like a docked module is renamed, since Kotlin reads `log.writeInfo` on a function `log` (dock-apart.ts)
  const program = keepDocksApart(written)
  // the `+`, `-` and `*` nodes proven not to overflow (compile/proven.ts): the counted steps here, then the interval
  // fact once the list facts it reads are known
  let provenSteps: Proven = provenIncrements(program)
  // the counted loops whose calls to a bounded task may run its unchecked copy (ir/facts/bounds.ts)
  const loopGuards = boundedLoops(program)
  // where a record is copied so a write through one name cannot reach another (backend.ts, `recordCopies`)
  const copies = recordCopies(program)
  // the text expressions proven ASCII, read by index (ir/facts/text.ts)
  const asciiNodes = asciiTexts(program)
  // the field names some assignment writes, the fields a place write or a reuse writes: every other field is a `val`
  const assignedFields = new Map(kotlinFacts.fieldsAssigned(program as never).map(name => [name, true]))
  const places = recordPlaces(program).writes

  for (const place of places.values()) {
    place.fields.forEach(f => assignedFields.set(f.name, true))
  }

  const reuse = recordReuse(program)
  const tailCalls = tailTasks(program)

  for (const n of program) {
    if (n.form === 'record-type' && reuse.forms.has(n.name)) {
      n.fields.forEach(f => assignedFields.set(f.name, true))
    }
  }

  const flags = (names: Iterable<string>): Map<string, boolean> => new Map([...names].map(name => [name, true]))
  const bodiedTasks = flags(program.flatMap(n => (n.form === 'function' && n.body.length > 0 ? [n.name] : [])))
  const inlineTasks = flags(kotlinFacts.inlineTasks(program as never, body => nodeSize(body)))
  const hiveTell = program.some(n => n.form === 'function' && n.name === 'hive-tell')
  const opaque = new Map<string, string>(
    program
      .filter((n): n is Extract<Statement, { form: 'native' }> => n.form === 'native' && n.kind === 'type')
      .map(n => [n.alias, n.module === 'any' ? 'Any' : n.module]),
  )
  const tagged = flags(taggedForms(program))
  const genericArity = new Map<string, number>(
    program
      .filter((n): n is Extract<Statement, { form: 'record-type' }> => n.form === 'record-type')
      .map(n => [n.name, n.params?.length ?? 0]),
  )
  const functionParams = new Map(
    program
      .filter((n): n is Extract<Statement, { form: 'function' }> => n.form === 'function')
      .map(n => [n.name, n.params.map(p => ({ type: p.type }))]),
  )
  const asyncFns = flags(program.flatMap(node => (node.form === 'function' && node.async ? [node.name] : [])))
  const binds = collectBinds(program)
  const recordFields = new Map(
    program
      .filter((n): n is Extract<Statement, { form: 'record-type' }> => n.form === 'record-type' && n.variants.length === 0)
      .map(n => [n.name, n.fields]),
  )
  const sharedForms = flags(program.flatMap(n => (n.form === 'record-type' && n.shared ? [n.name] : [])))
  const unionForms = flags(program.flatMap(n => (n.form === 'record-type' && n.variants.length > 0 ? [n.name] : [])))
  const floatForms = kotlinFacts.floatForms(program as never)
  const nativeAliases = flags(program.flatMap(n => (n.form === 'native' && n.kind !== 'type' ? [n.alias] : [])))
  const hiddenGeneric = kotlinFacts.hiddenGenerics(program as never)
  const classes = kotlinFacts.variantClassesOf(program as never)
  const maskMethods = new Set<string>()
  const selfResults = new Set<string>()

  for (const node of program) {
    if (node.form === 'mask') {
      node.methods.forEach(m => maskMethods.add(m))

      for (const task of node.tasks ?? []) {
        if (task.signature.result?.kind === 'named' && task.signature.result.name === 'self') {
          selfResults.add(task.name)
        }
      }
    }
  }

  // F1, the fixed-length slice (backend.ts, `fixedLists`): a primitive array, or an `Array<T>` for any element whose
  // type names no type variable
  const listGates = gatedTasks(program, maskMethods)
  const { lend: lendParams, fresh: freshLists } = listFacts(program, listGates)
  provenSteps = provenArithmetic(program, lendParams, freshLists)
  const typeParameters = flags(
    program.flatMap(n => (n.form === 'function' ? n.generics.map(g => g.name) : n.form === 'record-type' ? n.params : [])),
  )
  const fixedKind = (t: Type | undefined): string => kotlinFacts.fixedKind(boxed(t) as never, typeParameters)
  const fixed = fixedLists(program, lendParams, freshLists, t => fixedKind(t) !== '', true)
  // the variants whose nodes are reused, from Rust's boxing, none where Rust's analysis throws
  const reuseVariants = kotlinFacts.kotlinReuse(program as never, () => {
    try {
      return boxed(rustBoxing(program).boxed)
    } catch {
      return { form: 'none' }
    }
  })
  // the lists a record or a variant owns (backend.ts, `ownedFields`)
  const ownedAll = [...ownedFields(program, freshLists, lendParams, privateForms(program, lendParams, freshLists))]
  const fieldLists = kotlinFacts.fieldLists(program as never, ownedAll)
  const fills = fillTasks(program)
  const fillTable = new Map(
    [...fills].map(([name, fill]) => [
      name,
      typeof fill.item === 'number' ? { size: fill.size, itemAt: fill.item } : { size: fill.size, itemAt: -1, item: fill.item },
    ]),
  )
  const arrays = kotlinFacts.variantArrays(program as never, ownedAll, fillTable as never)
  const conformances = new Map<string, Extract<Statement, { form: 'instance' }>[]>()
  const instanceTargets = new Map<string, string[]>()
  const implFns = new Map<string, Statement>()

  for (const node of program) {
    if (node.form === 'instance') {
      conformances.set(node.target, [...(conformances.get(node.target) ?? []), node])
      instanceTargets.set(node.mask, [...(instanceTargets.get(node.mask) ?? []), node.target])
    }

    if (node.form === 'function' && node.method) {
      implFns.set(`${node.method.form}:${node.method.name}`, node)
    }
  }

  const exceptionForms = flags(
    program.flatMap(n => (n.form === 'record-type' && Boolean(n.chain?.includes('exception')) ? [n.name] : [])),
  )
  // the field-less case of a form, which `slotTakes` asks for
  const emptyCaseOf = (type: Type | undefined): { form: string; empty: string } | undefined => {
    const form =
      type?.kind === 'named'
        ? program.find((n): n is Extract<Statement, { form: 'record-type' }> => n.form === 'record-type' && n.name === type.name)
        : undefined
    const empty = form?.variants.find(v => v.fields.length === 0)

    return form && empty ? { form: form.name, empty: empty.name } : undefined
  }
  // each task's text cursors, redeclared `let`s and slot takes, asked once per task
  const cursorsOf = new WeakMap<object, TextCursors>()
  const cursorsFor = (fn: object): TextCursors => {
    let found = cursorsOf.get(fn)

    if (!found) {
      found = textCursors(fn as Extract<Statement, { form: 'function' }>, asciiNodes)
      cursorsOf.set(fn, found)
    }

    return found
  }
  const redeclaredOf = new WeakMap<object, WeakSet<Statement>>()
  const redeclaredFor = (fn: object): WeakSet<Statement> => {
    let found = redeclaredOf.get(fn)

    if (!found) {
      found = redeclaredLets(fn as Extract<Statement, { form: 'function' }>)
      redeclaredOf.set(fn, found)
    }

    return found
  }
  const takesOf = new WeakMap<object, WeakMap<object, unknown>>()
  const takesFor = (fn: object): WeakMap<object, unknown> => {
    let found = takesOf.get(fn)

    if (!found) {
      const body = (fn as Extract<Statement, { form: 'function' }>).body
      found = slotTakes(body, () => true, lastReads(body), emptyCaseOf, new Set()).takes
      takesOf.set(fn, found)
    }

    return found
  }
  const facts = {
    program,
    opaque,
    tagged,
    genericArity,
    functionParams,
    binds,
    recordFields,
    sharedForms,
    unionForms,
    floatForms,
    assignedFields,
    variantClass: classes.variantClass,
    variantClassOf: classes.variantClassOf,
    variantFieldNames: classes.variantFieldNames,
    ownedFieldNames: classes.ownedFieldNames,
    maskMethods: flags(maskMethods),
    selfResults: flags(selfResults),
    typeParameters,
    fixedParams: new Map([...fixed.params].map(([name, at]) => [name, [...at]])),
    fixedLocals: new Map([...fixed.locals].map(([name, locals]) => [name, [...locals]])),
    reuseVariants,
    fieldLists,
    arrays,
    fills: fillTable,
    conformances,
    instanceTargets,
    implFns,
    exceptionForms,
    nativeAliases,
    hiddenGeneric,
    asyncFns,
    bodiedTasks,
    inlineTasks,
    tailCalls: flags(tailCalls.keys()),
    copyParams: copies.params,
    hiveTell,
    isProven: (node: object) => provenSteps.has(node as Expression),
    loopGuardOf: (node: object) => {
      const guard = loopGuards.get(node as Statement)

      return boxed(guard ? { ...guard, fastCount: guard.fast?.length ?? 0 } : undefined)
    },
    isFastIn: (node: object, loop: object) => loopGuards.get(loop as Statement)?.fast?.includes(node as never) ?? false,
    copyOfLet: (node: object) => copies.lets.has(node as Statement),
    isASCII: (node: object) => asciiNodes.has(node),
    isReuseSite: (node: object) => reuse.sites.has(node),
    reuseKeptOf: (node: object) => boxed(reuse.locals.get(node)),
    isWriteBack: (node: object) => reuse.writeBacks.has(node),
    isBuild: (task: string, node: object) => reuse.tasks.get(task)?.builds.has(node) ?? false,
    isCarrier: (task: string, node: object) => reuse.tasks.get(task)?.carriers?.has(node) ?? false,
    placeOf: (node: object) => boxed(places.get(node as Statement)),
    isRedeclared: (fn: object, node: object) => redeclaredFor(fn).has(node as Statement),
    cursorNames: (fn: object) => cursorsFor(fn).names,
    cursorOf: (fn: object, node: object) => boxed(cursorsFor(fn).reads.get(node)),
    isTaken: (fn: object, node: object) => takesFor(fn).has(node),
    sameStatement: (left: object, right: object) => left === right,
  }
  const st = kotlinEmit.newKotlinState()
  const stmt = (node: Statement, d: number): string => kotlinEmit.emitStatement(node as never, d, st, facts as never)

  // a `<global:X>` binding needs no import: it is already in scope. A `type` dock is an inline type reference
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

  // plus the import each rendered `bind` needs. Only binds actually called contribute, matching the other backends.
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

  // a module-level `host` data tree is an ANONYMOUS nested record: one data class per record node, named by the
  // binding and the field path (HostRange, HostRangeH), and the record nodes renamed so the construction uses it
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

  // an abstract module's signature-only declaration yields to the platform module's implementation
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
      // each marked with its module, so the program can be written one file per module (compile/unit-split.ts)
      .map(n => markUnit(n.span.file ?? '', stmt(n, 0)))
      .filter(Boolean),
  ]
  const fillSpecs = st.fillSpecs as Map<string, FormSpec>
  const meltSpecs = st.meltSpecs as Map<string, FormSpec>

  if (fillSpecs.size > 0 || meltSpecs.size > 0) {
    body.push(KOTLIN_FORM_HELPERS, ...kotlinNames.kotlinFormWalkers([...fillSpecs.values()] as never, [...meltSpecs.values()] as never))
  }

  // each reused variant's spare and the construction that rebuilds it: the fields are computed by the caller as
  // arguments, so the spare is written only once all of them are in hand
  for (const [label, reused] of reuseVariants) {
    const form = program.find(n => n.form === 'record-type' && n.name === reused.form)
    const variant = form?.form === 'record-type' ? form.variants.find(v => v.name === label) : undefined
    const cls = kotlinEmit.reuseClass(label, facts as never)

    if (!variant) {
      continue
    }

    const params = variant.fields.map(f => `${camel(f.name)}: ${kotlinEmit.kotlinTypeOf(f.type as never, st, facts as never)}`).join(', ')
    const sets = variant.fields.map(f => `held.${camel(f.name)} = ${camel(f.name)}`).join('; ')
    const args = variant.fields.map(f => camel(f.name)).join(', ')

    body.push(
      `@JvmField var termSpare${cls}: ${cls}? = null\n\nfun termReuse${cls}(${params}): ${cls} {\n    val held = termSpare${cls} ?: return ${cls}(${args})\n    termSpare${cls} = null\n    ${sets}\n    return held\n}`,
    )
  }

  // each task a guarded loop calls unchecked, once more with no overflow checks (`aValueFast`), behind the bound the
  // guard proved its arguments inside. A copy may reach another, which is written after it
  for (let at = 0; at < st.fastTasks.length; at++) {
    const name = st.fastTasks[at]!
    const fn = program.find((n): n is Extract<Statement, { form: 'function' }> => n.form === 'function' && n.name === name)

    if (fn) {
      st.uncheckedInts = true
      body.push(markUnit(fn.span.file ?? '', stmt({ ...fn, name: `${name}-fast` }, 0)))
      st.uncheckedInts = false
    }
  }

  // each task a reuse site calls, once more building its result in the object it was given (`recordReuse`)
  for (let at = 0; at < st.reuseTasks.length; at++) {
    const name = st.reuseTasks[at]!
    const fn = program.find((n): n is Extract<Statement, { form: 'function' }> => n.form === 'function' && n.name === name)
    const task = reuse.tasks.get(name)

    if (fn && task) {
      st.reusing = { form: 'some', value: { param: fn.params[task.param]!.name, task: name, keep: task.keep?.field ?? '' } }
      // with a kept field, the copy answers that field alone
      body.push(markUnit(fn.span.file ?? '', stmt({ ...fn, name: `${name}-reuse`, ...(task.keep ? { result: task.keep.type } : {}) }, 0)))
      st.reusing = { form: 'none' }
    }
  }

  const needs = new Set<string>(st.needs.keys())

  // termDivide stops through termNegate
  if (needs.has('divide')) {
    needs.add('stop')
  }

  // the form walkers raise SeedError on a mismatch
  if (fillSpecs.size > 0 || meltSpecs.size > 0) {
    needs.add('error')
  }

  // the event loop, for a program that waits, drains, spawns a job, or has a suspending task an entry may drive
  if (body.some(line => /termSleep\(|termLoop\b|\bjob\.spawn\(|\bsuspend fun\b/.test(line))) {
    needs.add('start')
  }

  const prelude = (Object.keys(KOTLIN_HELPERS) as KotlinHelper[]).filter(h => needs.has(h)).map(h => KOTLIN_HELPERS[h])

  // the wake chain: one `hiveWake` per deck with its static entries, when the program has the stdlib hive and
  // the compile driver handed over the roll. See note/term/hive/05-hive.md.
  const wake: string[] = []

  if (
    options?.wake?.length &&
    program.some(n => n.form === 'function' && n.name === 'hive-wake')
  ) {
    const entryText = (entry: Record<string, unknown>): string => {
      const { ref, base, ...own } = entry
      const boxedBase =
        typeof ref === 'string'
          ? camel(ref)
          : JSON.stringify(JSON.stringify(base ?? {}))

      return `HiveEntry(host = ${JSON.stringify(String(own.host ?? ''))}, kind = ${JSON.stringify(String(own.kind ?? ''))}, name = ${JSON.stringify(String(own.name ?? ''))}, site = ${JSON.stringify(String(own.site ?? ''))}, base = ${boxedBase})`
    }

    const calls = options.wake
      .map(
        group =>
          `    hiveWake(${JSON.stringify(group.deck)}, mutableListOf(${group.entries.map(entryText).join(', ')}))`,
      )
      .join('\n')

    wake.push(`fun wakeHive(): Unit {\n${calls}\n}`)
  }

  const text = [...imports, ...prelude, ...body, ...wake].join('\n\n') + '\n'

  // with `units`, each module's statements still marked, for the caller to write one file per module
  return options?.units ? text : unmarked(text)
}

// A value that does not fit throws `data-mismatch`, the package's own exception, as the `TermException` every raise on
// this backend is, with the fields TypeScript gives it (`@term/host`, `Data does not fit the shape`, and the path and
// reason under `link`), so a guard catches it by its form. It was a `SeedError` carrying all of it in one message,
// which a guard read as a `failure` (guides: language/data, 2026-10-05).
const KOTLIN_FORM_HELPERS = `fun __termMismatch(path: String, reason: String): Nothing =
    throw TermException("@term/host", "data-mismatch", "Data does not fit the shape", "", System.currentTimeMillis(), mapOf("thing" to "data", "path" to (if (path.isEmpty()) "." else path), "reason" to reason), null)
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
