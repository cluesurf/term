// The Kotlin backend: emit the language as idiomatic, type-static Kotlin. Parity with the TypeScript backend across
// every AST form. Algebraic data types lower to NATIVE sealed-class hierarchies (`sealed class Maybe<out T>` with a
// subclass per variant), `match` to an exhaustive `when (subject) { is MaybeSome -> ... }` whose smart-casts make a
// variant's fields directly accessible (no rewrite needed), and struct forms to `data class`es. A variant subclass
// carries only the generics its own fields use, filling the rest with `Nothing` (valid under `out` variance), so
// construction infers cleanly. Pure, browser-safe. See note/research/vibe/computation/plans/07-codegen.md.

import { armLocals } from '@term/make/code/check/arm'
import { provenIncrements } from '@term/make/code/ir/facts/range'
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
} from '@term/make/code/compile/backend'
import type { CollectionOp, FormKind, FormSpec } from '@term/make/code/compile/backend'
import { escapingParams, formSpec, hasValuedReturn, refuseAny, specForms } from '@term/make/code/compile/backend'
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
        if (d.isNotEmpty()) return s.split(d).toMutableList()
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
  // the `+` nodes proven not to overflow (ir/facts/range.ts): written as a plain `+`
  const provenSteps = provenIncrements(program)
  // the field names some assignment in the program writes (`save p/x, ...`): every other field is a `val`
  const assignedFields = fieldsAssigned(program)
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

        if (exact && node.left.type?.kind === 'number' && node.right.type?.kind === 'number' && !provenSteps.has(node)) {
          return `Math.${exact}(${longOf(node.left)}, ${longOf(node.right)})`
        }

        // `Long.MIN_VALUE / -1` wraps to MIN_VALUE on the JVM; termDivide stops on it as every backend does
        if (node.op === '/' && node.left.type?.kind === 'number' && node.right.type?.kind === 'number') {
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

          return (
            renderBind(bind, 'kotlin', node.args.map(expr)) ??
            bindGap(bind.name)
          )
        }

        // a native map / list operation lowers to kotlin's collection API
        const operation = collectionCall(node.callee)

        if (operation) {
          return collectionExpr(operation, node.args)
        }

        // a host string method (what `text.tree` delegates to) lowers to kotlin's String API
        const text = stringCall(node.callee)

        if (text) {
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
        const rendered = node.args.map(expr)
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
          // only for a non-generic form: a generic form's declared element is its own type parameter, which
          // the construction instantiates (spelling the letter literally would not resolve)
          if ((genericArity.get(node.name) ?? 0) > 0) {
            return expr(value)
          }

          const declaredType = recordFields
            .get(node.name)
            ?.find(f => f.name === name)?.type

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

          return expr(value)
        }

        const cls = classFor(node.name, node.type)

        if (cls) {
          return node.fields.length > 0
            ? `${cls}(${node.fields
                .map(f => `${camel(f.name)} = ${fieldValue(f.name, f.value)}`)
                .join(', ')})`
            : cls
        }

        // a struct: a field the construction leaves out takes its type's empty value, so the data class is whole
        const declared = recordFields.get(node.name)

        if (declared) {
          const given = new Set(node.fields.map(f => f.name))
          const missing = declared.filter(f => !given.has(f.name)).map(f => `${camel(f.name)} = ${emptyOf(f.type)}`)
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
          const narrowed =
            node.target.type?.kind === 'array'
              ? `Math.toIntExact(${expr(node.index)})`
              : expr(node.index)

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

  const block = (body: Statement[], d: number): string =>
    body
      .map(s => `${pad(d)}${stmt(s, d)}`)
      .filter(Boolean)
      .join('\n')

  const stmt = (node: Statement, d: number): string => {
    switch (node.form) {
      case 'let': {
        localNames.add(node.name)
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
        return `${node.mutable && (fnAssigned === undefined || fnAssigned.has(node.name)) ? 'var' : 'val'} ${camel(
          node.name,
        )}${ann} = ${expr(node.init)}`
      }
      case 'assign':
        return node.op === '='
          ? `${expr(node.target)} = ${expr(node.value)}`
          : `${expr(node.target)} ${node.op} ${expr(node.value)}`
      case 'expression':
        return expr(node.expr)
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

        return node.value.form === 'string'
          ? tell(`TermException("", "failure", ${expr(node.value)}, "", 0L, null, null)`)
          : node.value.form === 'record' && exceptionForms.has(node.value.name)
            ? tell(`run { val raised = ${expr(node.value)}; TermException(raised.host, raised.form, raised.note, raised.code, raised.time, raised.link, raised) }`)
            : `throw termException(${expr(node.value)})`
      }
      case 'while':
        return `while (${expr(node.cond)}) {\n${block(
          node.body,
          d + 1,
        )}\n${pad(d)}}`
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
        const arms = node.cases.map(b => {
          if (booleans) {
            return `${pad(d + 1)}${b.label} -> {\n${block(
              b.body,
              d + 2,
            )}\n${pad(d + 1)}}`
          }

          const cls = classFor(b.label, node.subject.type) ?? pascal(b.label)
          // the arm's fields (renamed or not, see check/arm.ts) become locals read off the smart-cast subject, the
          // ones the body reads
          const bodyText = block(b.body, d + 2)
          const locals = armLocals(variantFieldNames.get(b.label) ?? [], b.binds ?? [])
            .filter(({ local }) => new RegExp(`\\b${camel(local).replace(/[^\w$]/g, '\\$&')}\\b`).test(bodyText))
            .map(({ field, local }) => `${pad(d + 2)}val ${camel(local)} = ${subject}.${camel(field)}`)

          return `${pad(d + 1)}is ${cls} -> {\n${[...locals, bodyText].join('\n')}\n${pad(d + 1)}}`
        })

        if (node.otherwise) {
          arms.push(
            `${pad(d + 1)}else -> {\n${block(
              node.otherwise,
              d + 2,
            )}\n${pad(d + 1)}}`,
          )
        }

        const when = `when (${subject}) {\n${arms.join('\n')}\n${pad(d)}}`

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
        scopeGenerics = new Set(node.generics.map(g => g.name.toUpperCase()))
        localNames.clear()
        node.params.forEach(p => localNames.add(p.name))
        const params = node.params
          .map(p => `${camel(p.name)}: ${kotlinType(p.type)}`)
          .join(', ')

        const suspend = node.async ? 'suspend ' : ''
        suspendContext = node.async === true
        // a reassigned parameter is shadowed by a mutable local (Kotlin parameters are immutable)
        const mutated = new Set<string>()
        reassigned(node.body, mutated)
        // and a local nothing reassigns is a `val` (see the `let` case)
        const outerAssigned = fnAssigned
        fnAssigned = mutated

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
            : [...shadows, block(node.body, d + 1), unreachable]
                .filter(Boolean)
                .join('\n')

        fnAssigned = outerAssigned

        return `${inlineTasks.has(node.name) ? 'inline ' : ''}${suspend}fun ${generics}${camel(
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
              const fields = v.fields
                .map(f => `val ${camel(f.name)}: ${kotlinType(f.type)}`)
                .join(', ')

              return `data class ${cls}${genericDecl}(${fields}) : ${pascal(
                node.name,
              )}${superArgs}()`
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
        const fields = node.fields
          .map(f => `${assignedFields.has(f.name) ? 'var' : 'val'} ${camel(f.name)}: ${kotlinType(f.type)}`)
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

    if (node.form === 'assign' && (node.target as Loose).form === 'member') {
      names.add((node.target as Loose).name as string)
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
        return `DataArray(list = (${value}).map { x -> ${meltOf(kind.item, 'x')} }.toMutableList())`
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
    is DataArray -> value.list.mapIndexed { i, d -> item(d, __termPath(path, i.toString())) }.toMutableList()
    null, is DataBlank -> if (optional) mutableListOf() else __termMismatch(path, "is missing")
    else -> __termMismatch(path, "is " + __termKind(value) + " where a list belongs")
}`
