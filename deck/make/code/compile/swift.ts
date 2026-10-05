// The Swift backend: emit the language as idiomatic, type-static Swift. Parity with the TypeScript backend across
// every AST form. Algebraic data types lower to NATIVE generic enums (`enum Maybe<T> { case some(value: T); case none }`),
// `match` to native `if case let` pattern binding (a matched variant's fields bind to locals, and field access on the
// subject rewrites to those locals), and struct forms to `struct`s. Construction uses leading-dot syntax so Swift
// infers the type parameter from context (return type, annotated binding, argument position) — no monomorphization
// needed. Generic functions emit `<T>`. Pure, browser-safe. See note/research/vibe/computation/plans/07-codegen.md.

import { armLocals } from '@term/make/code/check/arm'
import { raiseSets } from '@term/make/code/check/effects'
import { keepDocksApart } from '@term/make/code/compile/dock-apart'
import { provenIncrements } from '@term/make/code/ir/facts/range'
import { provenArithmetic, type Proven } from '@term/make/code/compile/proven'
import { boundedLoops } from '@term/make/code/ir/facts/bounds'
import { asciiTexts } from '@term/make/code/ir/facts/text'
import { privateForms, valuePlaces } from '@term/make/code/compile/place'
import type { SlotLocal } from '@term/make/code/compile/place'
import type {
  Expression,
  Program,
  Statement,
  Type,
} from '@term/make/code/compile/node'
import {
  ARRAY_OP_BOUND,
  collectionCall,
  collectionRead,
  exhausted,
  reassigned,
  stringCall,
  stringRead,
  isText,
  textValued,
  textAppend,
  emptyText,
} from '@term/make/code/compile/backend'
import type { CollectionOp, FormKind, FormSpec } from '@term/make/code/compile/backend'
import {
  asciiCharAppend,
  escapingParams,
  mapUpdate,
  swapAt,
  fillTasks,
  fillCall,
  redeclaredLets,
  declaredLater,
  textCursors,
  formSpec,
  hasValuedReturn,
  refuseAny,
  specForms,
  gatedTasks,
  listFacts,
  ownedLocals,
  ownedElements,
  ownedFields,
  namesIn,
  lastReads,
} from '@term/make/code/compile/backend'
import type { Lend, TextCursors } from '@term/make/code/compile/backend'
import {
  collectBinds,
  renderBind,
  bindGap,
  bindImports,
  referencedBinds,
} from '@term/make/code/compile/bind'

// Swift reserved keywords. When one is used as an identifier (a function / parameter / member named `repeat`,
// `default`, etc.) it must be backtick-escaped, in both the declaration and every reference.
const SWIFT_KEYWORDS = new Set([
  'associatedtype',
  'class',
  'deinit',
  'enum',
  'extension',
  'fileprivate',
  'func',
  'import',
  'init',
  'inout',
  'internal',
  'let',
  'open',
  'operator',
  'private',
  'protocol',
  'public',
  'rethrows',
  'static',
  'struct',
  'subscript',
  'typealias',
  'var',
  'break',
  'case',
  'continue',
  'default',
  'defer',
  'do',
  'else',
  'fallthrough',
  'for',
  'guard',
  'if',
  'in',
  'repeat',
  'return',
  'switch',
  'where',
  'while',
  'as',
  'catch',
  'false',
  'is',
  'nil',
  'super',
  'self',
  'throw',
  'throws',
  'true',
  'try',
  'async',
  'await',
  'actor',
  'any',
  'some',
])

// whether an emitted operand holds a `try` that no parenthesis of its own closes over, so an operator beside it needs
// the `try` in front of the whole expression
function openTry(text: string): boolean {
  return /(^|[^(])\btry /.test(text)
}

function escape(identifier: string): string {
  return SWIFT_KEYWORDS.has(identifier)
    ? `\`${identifier}\``
    : identifier
}

function camelize(name: string): string {
  // strip every hyphen, including one before a digit (`sha-256` -> `sha256`), so the result is a valid identifier
  return name.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())
}

// `self` is reserved in Swift; every other name is camelCased, then keyword-escaped
function vname(name: string): string {
  return name === 'self' ? 'slf' : escape(camelize(name))
}

function camel(name: string): string {
  return escape(camelize(name))
}

// type / variant names are capitalized, so they can never collide with a (lowercase) keyword
// The text operations by code point (note/term/stdlib/semantics.md), over unicodeScalars. Swift's String counts
// grapheme clusters and its `range(of:)` and `==` match canonically equivalent text, so nothing here uses either:
// every search compares scalar arrays, which is the literal match every other backend makes.
export const SWIFT_TEXT = `enum TermText {
    // Positions count Unicode scalars (code points), as on every backend (note/term/stdlib/semantics.md), and each is
    // found by stepping the String's own views where the text lies: a search runs over its UTF-8 bytes, which match only
    // at scalar boundaries because UTF-8 is self-synchronizing, and an order compares UTF-8 bytes, which IS code point
    // order. Nothing is copied into an array, so a loop reading a text by position is no longer quadratic in allocation.
    // It copied every text into [Unicode.Scalar] on almost every call until 2026-10-02.
    static func at(_ s: String, _ i: Int) -> String.Index? {
        i < 0 ? nil : s.unicodeScalars.index(s.unicodeScalars.startIndex, offsetBy: i, limitedBy: s.unicodeScalars.endIndex)
    }
    static func clamped(_ s: String, _ i: Int) -> String.Index { at(s, max(i, 0)) ?? s.endIndex }
    static func scalarsTo(_ s: String, _ i: String.Index) -> Int { s.unicodeScalars.distance(from: s.unicodeScalars.startIndex, to: i) }
    static func find(_ s: String, _ n: String, _ from: String.Index) -> String.Index? {
        let h = s.utf8
        let m = n.utf8
        if m.isEmpty { return from }
        var i = from
        while i < h.endIndex {
            var a = i
            var b = m.startIndex
            while b < m.endIndex && a < h.endIndex && h[a] == m[b] { a = h.index(after: a); b = m.index(after: b) }
            if b == m.endIndex { return i }
            i = h.index(after: i)
        }
        return nil
    }
    static func white(_ c: Unicode.Scalar) -> Bool { c.properties.isWhitespace }
    static func length(_ s: String) -> Int { s.unicodeScalars.count }
    static func charAt(_ s: String, _ i: Int) -> String {
        guard let x = at(s, i), x < s.unicodeScalars.endIndex else { return "" }
        return String(s.unicodeScalars[x])
    }
    static func charCodeAt(_ s: String, _ i: Int) -> Int {
        guard let x = at(s, i), x < s.unicodeScalars.endIndex else { return -1 }
        return Int(s.unicodeScalars[x].value)
    }
    // an ASCII text (ir/facts/text.ts): a code point is one UTF-8 byte, read in place by its offset
    // one byte through the UTF-8 view, whose offset is constant time on a native text: a withUTF8 per read, which
    // must copy the text into a local to call, measured 3% slower on fasta (2026-10-03)
    static func asciiByte(_ s: String, _ i: Int) -> UInt8? {
        let u = s.utf8
        return i >= 0 && i < u.count ? u[u.index(u.startIndex, offsetBy: i)] : nil
    }
    static func asciiCodeAt(_ s: String, _ i: Int) -> Int { asciiByte(s, i).map { Int($0) } ?? -1 }
    static func asciiCharAt(_ s: String, _ i: Int) -> String { asciiByte(s, i).map { String(Unicode.Scalar($0)) } ?? "" }
    // appended as the scalar, with no one-character String made for it
    static func asciiAppend(_ out: inout String, _ s: String, _ i: Int) {
        if let c = asciiByte(s, i) { out.unicodeScalars.append(Unicode.Scalar(c)) }
    }
    // both ends clamped to the text and swapped when reversed (the Term meaning), as byte offsets
    static func asciiSubstring(_ s: String, _ a: Int, _ e: Int? = nil) -> String {
        var s = s
        return s.withUTF8 { b in
            let n = b.count
            var x = min(max(a, 0), n)
            var y = min(max(e ?? n, 0), n)
            if x > y { swap(&x, &y) }
            return String(decoding: b[x..<y], as: UTF8.self)
        }
    }
    // a search of an ASCII text answers its UTF-8 offset, which is the code-point index: no scalar count back from it
    static func asciiIndexOf(_ s: String, _ n: String, _ from: Int = 0) -> Int {
        let h = s.utf8
        guard let found = find(s, n, h.index(h.startIndex, offsetBy: min(max(from, 0), h.count))) else { return -1 }
        return h.distance(from: h.startIndex, to: found)
    }
    static func asciiLastIndexOf(_ s: String, _ n: String) -> Int {
        let h = s.utf8
        var last: String.Index? = nil
        var from = h.startIndex
        while let found = find(s, n, from) {
            last = found
            if found == h.endIndex { break }
            from = h.index(after: found)
        }
        return last.map { h.distance(from: h.startIndex, to: $0) } ?? -1
    }
    // a scalar read through a cursor (backend.ts, textCursors): the scalar index and UTF-8 offset of the last read,
    // stepped forward or back from, or restarted at the start when that is nearer. A read past the end leaves it there
    // the UTF-8 offset of scalar i, the end past the last
    static func cursorTo(_ s: String, _ i: Int, _ c: inout (Int, Int)) -> Int {
        let u = s.utf8
        let n = u.count
        var (k, b) = c
        let byte = { (o: Int) -> UInt8 in u[u.index(u.startIndex, offsetBy: o)] }
        if i < k {
            if i <= k - i {
                (k, b) = (0, 0)
            } else {
                while k > i {
                    b -= 1
                    while byte(b) & 0xC0 == 0x80 { b -= 1 }
                    k -= 1
                }
            }
        }
        while k < i && b < n {
            let x = byte(b)
            b += x < 0x80 ? 1 : x < 0xE0 ? 2 : x < 0xF0 ? 3 : 4
            k += 1
        }
        c = (k, b)
        return b
    }
    static func cursorAt(_ s: String, _ i: Int, _ c: inout (Int, Int)) -> Unicode.Scalar? {
        if i < 0 { return nil }
        let b = cursorTo(s, i, &c)
        let u = s.utf8
        return c.0 == i && b < u.count ? s.unicodeScalars[u.index(u.startIndex, offsetBy: b)] : nil
    }
    // the scalars from a to e through the cursor, both clamped and swapped when reversed: the cursor moves to the start,
    // and the end is counted on from it
    static func cursorSlice(_ s: String, _ a: Int, _ e: Int, _ c: inout (Int, Int)) -> String {
        let (x, y) = a <= e ? (max(a, 0), max(e, 0)) : (max(e, 0), max(a, 0))
        let u = s.utf8
        let n = u.count
        let from = cursorTo(s, x, &c)
        var to = from
        var k = c.0
        while k < y && to < n {
            let b = u[u.index(u.startIndex, offsetBy: to)]
            to += b < 0x80 ? 1 : b < 0xE0 ? 2 : b < 0xF0 ? 3 : 4
            k += 1
        }
        return String(s[u.index(u.startIndex, offsetBy: from)..<u.index(u.startIndex, offsetBy: to)])
    }
    static func cursorCodeAt(_ s: String, _ i: Int, _ c: inout (Int, Int)) -> Int { cursorAt(s, i, &c).map { Int($0.value) } ?? -1 }
    static func cursorCharAt(_ s: String, _ i: Int, _ c: inout (Int, Int)) -> String { cursorAt(s, i, &c).map { String($0) } ?? "" }
    static func indexOf(_ s: String, _ n: String, _ from: Int = 0) -> Int {
        guard let found = find(s, n, clamped(s, from)) else { return -1 }
        return scalarsTo(s, found)
    }
    static func lastIndexOf(_ s: String, _ n: String) -> Int {
        var last: String.Index? = nil
        var from = s.startIndex
        while let found = find(s, n, from) {
            last = found
            if found == s.endIndex { break }
            from = s.utf8.index(after: found)
        }
        return last.map { scalarsTo(s, $0) } ?? -1
    }
    static func split(_ s: String, _ d: String) -> [String] {
        if d.isEmpty { return s.unicodeScalars.map { String($0) } }
        var out: [String] = []
        var start = s.startIndex
        while let found = find(s, d, start) {
            out.append(String(s[start..<found]))
            start = s.utf8.index(found, offsetBy: d.utf8.count)
        }
        out.append(String(s[start...]))
        return out
    }
    static func substring(_ s: String, _ a: Int, _ b: Int? = nil) -> String {
        var x = clamped(s, a)
        var y = b.map { clamped(s, $0) } ?? s.endIndex
        if x > y { swap(&x, &y) }
        return String(s.unicodeScalars[x..<y])
    }
    static func slice(_ s: String, _ a: Int, _ b: Int? = nil) -> String { substring(s, a, b) }
    // Unicode's default lowercase mapping with its one context rule, Final_Sigma, which JavaScript, Rust and the JDK
    // apply and Swift's lowercased() does not: a capital sigma after a cased letter and before none becomes final
    static func toLowerCase(_ s: String) -> String {
        if !s.unicodeScalars.contains(where: { $0.value == 0x3A3 }) { return s.lowercased() }
        let h = Array(s.unicodeScalars)
        var out = String.UnicodeScalarView()
        for (i, c) in h.enumerated() {
            if c.value != 0x3A3 { out.append(contentsOf: String(c).lowercased().unicodeScalars); continue }
            var j = i - 1
            while j >= 0 && h[j].properties.isCaseIgnorable { j -= 1 }
            var k = i + 1
            while k < h.count && h[k].properties.isCaseIgnorable { k += 1 }
            let final = j >= 0 && h[j].properties.isCased && !(k < h.count && h[k].properties.isCased)
            out.append(Unicode.Scalar(final ? 0x3C2 : 0x3C3)!)
        }
        return String(out)
    }
    static func toUpperCase(_ s: String) -> String { s.uppercased() }
    static func trimStart(_ s: String) -> String {
        let v = s.unicodeScalars
        var i = v.startIndex
        while i < v.endIndex && white(v[i]) { i = v.index(after: i) }
        return String(v[i...])
    }
    static func trimEnd(_ s: String) -> String {
        let v = s.unicodeScalars
        var j = v.endIndex
        while j > v.startIndex && white(v[v.index(before: j)]) { j = v.index(before: j) }
        return String(v[..<j])
    }
    static func trim(_ s: String) -> String { trimEnd(trimStart(s)) }
    static func pad(_ s: String, _ w: Int, _ f: String, _ front: Bool) -> String {
        let n = length(s)
        if n >= w || f.isEmpty { return s }
        var out = String.UnicodeScalarView()
        var fill = f.unicodeScalars.makeIterator()
        for _ in 0..<(w - n) {
            if let c = fill.next() { out.append(c) } else { fill = f.unicodeScalars.makeIterator(); out.append(fill.next()!) }
        }
        return front ? String(out) + s : s + String(out)
    }
    static func padStart(_ s: String, _ w: Int, _ f: String) -> String { pad(s, w, f, true) }
    static func padEnd(_ s: String, _ w: Int, _ f: String) -> String { pad(s, w, f, false) }
    static func replace(_ s: String, _ a: String, _ b: String) -> String {
        guard let found = find(s, a, s.startIndex) else { return s }
        return String(s[..<found]) + b + String(s[s.utf8.index(found, offsetBy: a.utf8.count)...])
    }
    static func replaceAll(_ s: String, _ a: String, _ b: String) -> String {
        if !a.isEmpty { return split(s, a).joined(separator: b) }
        return b + s.unicodeScalars.map { String($0) + b }.joined()
    }
    static func includes(_ s: String, _ n: String) -> Bool { find(s, n, s.startIndex) != nil }
    static func startsWith(_ s: String, _ n: String) -> Bool { s.utf8.starts(with: n.utf8) }
    static func endsWith(_ s: String, _ n: String) -> Bool { s.utf8.count >= n.utf8.count && s.utf8.suffix(n.utf8.count).elementsEqual(n.utf8) }
    static func repeated(_ s: String, _ n: Int) -> String { n > 0 ? String(repeating: s, count: n) : "" }
    static func concat(_ s: String, _ b: String) -> String { s + b }
    // by code point, never Swift's canonical equivalence (which makes a precomposed and a decomposed é equal)
    static func equal(_ a: String, _ b: String) -> Bool { a.utf8.elementsEqual(b.utf8) }
    static func compare(_ a: String, _ b: String) -> Int {
        var x = a.utf8.makeIterator()
        var y = b.utf8.makeIterator()
        while true {
            switch (x.next(), y.next()) {
            case (nil, nil): return 0
            case (nil, _): return -1
            case (_, nil): return 1
            case let (p?, q?): if p != q { return p < q ? -1 : 1 }
            }
        }
    }
}`

// A float as text, the same on every backend (note/term/stdlib/semantics.md, "Numbers as text"): the shortest digits
// that read back as the same float (Swift's `description` gives them), laid out as ECMAScript's Number::toString
// lays them out. Swift's own rendering prints two as `2.0` and NaN as `nan`.
const SWIFT_NUMBER = `func termNumber(_ x: Double) -> String {
    if x.isNaN { return "NaN" }
    if x.isInfinite { return x > 0 ? "Infinity" : "-Infinity" }
    if x == 0 { return "0" }
    let shortest = abs(x).description.lowercased()
    let halves = shortest.split(separator: "e", omittingEmptySubsequences: false)
    let exponent = halves.count > 1 ? (Int(halves[1]) ?? 0) : 0
    let pieces = halves[0].split(separator: ".", omittingEmptySubsequences: false)
    let whole = String(pieces[0])
    var all = Array(whole + (pieces.count > 1 ? String(pieces[1]) : ""))
    var n = whole.count + exponent
    while all.count > 1 && all.first == "0" { all.removeFirst(); n -= 1 }
    while all.count > 1 && all.last == "0" { all.removeLast() }
    let k = all.count
    let digits = String(all)
    var body: String
    if k <= n && n <= 21 {
        body = digits + String(repeating: "0", count: n - k)
    } else if 0 < n && n <= 21 {
        body = String(all[0..<n]) + "." + String(all[n...])
    } else if -6 < n && n <= 0 {
        body = "0." + String(repeating: "0", count: -n) + digits
    } else {
        let e = n - 1
        let sign = e < 0 ? "-" : "+"
        body = (k == 1 ? digits : String(all[0..<1]) + "." + String(all[1...])) + "e" + sign + String(abs(e))
    }
    return x < 0 ? "-" + body : body
}`

// Foundation and standard-library type names a seed form must not shadow: `form data` would hide `Foundation.Data`
// from every shim that uses it, so such a form is spelled with a `Form` suffix throughout the emit
const SWIFT_TAKEN = new Set([
  'Data',
  'Date',
  'URL',
  'Error',
  'Result',
  'Optional',
  'Character',
  'Set',
  'Array',
  'Dictionary',
  'String',
  'Int',
  'Double',
  'Bool',
  'Task',
  'Thread',
  'Process',
  'Bundle',
  'Timer',
  'Locale',
  'Decimal',
  'Stream',
  'Host',
  'Pipe',
  'Scanner',
  'Operation',
  'Notification',
  'Range',
  'Unit',
])

// The prelude helpers a Swift program may use, each written once, in the order they are emitted. The emitter records a
// helper in `needs` where it writes a use of it, and a list or map type anywhere in the program records the wrapper.
// It used to be chosen by searching the emitted text for each helper's name.
const SWIFT_HELPERS = {
  text: SWIFT_TEXT,
  number: SWIFT_NUMBER,
  // the one exception value of a Term program on this backend (note/term/hive/11-native-exceptions.md)
  exception: [
    'struct TermException: Error { let host: String; let form: String; let note: String; let code: String; let time: Int; let link: Any?; let base: Any? }',
    'func termException(_ thrown: Any) -> TermException { if let e = thrown as? TermException { return e }; return TermException(host: "", form: "failure", note: "\\(thrown)", code: "", time: 0, link: nil, base: thrown) }',
  ].join('\n'),
  // the reference wrapper for maps (a class so mutation persists across a struct copy). `data` is insertion-ordered
  // (SeedOrdered), so a walk over a map's keys visits them in the order they were first set, as TypeScript's Map and
  // Kotlin's LinkedHashMap do. A Swift Dictionary is seeded per process, and the same binary walked one map in a
  // different order on every run (note/term/optimize/meaning.md, question 1). Keys and values live in two dense
  // arrays beside an index, so a walk, `keys` and `values` allocate nothing while no entry has been removed. A
  // removal marks its slot dead, and the arrays are compacted once half the slots are dead.
  map: [
    'struct SeedOrdered<K: Hashable, V>: Sequence {',
    '    private var slot: [K: Int] = [:]',
    '    private var ks: [K] = []',
    '    private var vs: [V] = []',
    '    private var live: [Bool] = []',
    '    private var dead = 0',
    '    init() {}',
    '    init(_ data: [K: V]) { for (k, v) in data { self[k] = v } }',
    '    var count: Int { slot.count }',
    '    var isEmpty: Bool { slot.isEmpty }',
    '    subscript(key: K) -> V? {',
    '        get { if let i = slot[key] { return vs[i] }; return nil }',
    '        set {',
    '            guard let value = newValue else { removeValue(forKey: key); return }',
    '            vs[place(key, value)] = value',
    '        }',
    '    }',
    '    // the entry of a key, made with fallback when it is absent: the dictionary hashes the key once, through its',
    '    // default subscript modified in place, where a read and then a write hashed it twice',
    '    mutating func place(_ key: K, _ fallback: V) -> Int {',
    '        let n = ks.count',
    '        var fresh = false',
    '        let i = { (at: inout Int) -> Int in if at < 0 { at = n; fresh = true }; return at }(&slot[key, default: -1])',
    '        if fresh { ks.append(key); vs.append(fallback); live.append(true) }',
    '        return i',
    '    }',
    '    // a value changed from itself in one probe (backend.ts, mapUpdate)',
    '    mutating func update(_ key: K, _ fallback: V, _ change: (V) -> V) { let i = place(key, fallback); vs[i] = change(vs[i]) }',
    '    @discardableResult mutating func removeValue(forKey key: K) -> V? {',
    '        guard let i = slot.removeValue(forKey: key) else { return nil }',
    '        let out = vs[i]',
    '        live[i] = false',
    '        dead += 1',
    '        if dead > 16 && dead * 2 > ks.count { compact() }',
    '        return out',
    '    }',
    '    private mutating func compact() {',
    '        var k2: [K] = []; var v2: [V] = []',
    '        k2.reserveCapacity(slot.count); v2.reserveCapacity(slot.count)',
    '        for i in 0..<ks.count where live[i] { slot[ks[i]] = k2.count; k2.append(ks[i]); v2.append(vs[i]) }',
    '        ks = k2; vs = v2; live = Array(repeating: true, count: k2.count); dead = 0',
    '    }',
    '    var keys: [K] { dead == 0 ? ks : ks.indices.compactMap { live[$0] ? ks[$0] : nil } }',
    '    var values: [V] { dead == 0 ? vs : vs.indices.compactMap { live[$0] ? vs[$0] : nil } }',
    '    struct Iterator: IteratorProtocol {',
    '        let map: SeedOrdered<K, V>',
    '        var at = 0',
    '        mutating func next() -> (key: K, value: V)? {',
    '            while at < map.ks.count { let i = at; at += 1; if map.live[i] { return (key: map.ks[i], value: map.vs[i]) } }',
    '            return nil',
    '        }',
    '    }',
    '    func makeIterator() -> Iterator { Iterator(map: self) }',
    '}',
    'final class SeedMap<K: Hashable, V> {',
    '    var data: SeedOrdered<K, V>',
    '    init(_ data: [K: V] = [:]) { self.data = SeedOrdered(data) }',
    '    init(pairs: [(K, V)]) { var d = SeedOrdered<K, V>(); for (k, v) in pairs { d[k] = v }; self.data = d }',
    '    @discardableResult func setting(_ key: K, _ value: V) -> SeedMap<K, V> { data[key] = value; return self }',
    '    @discardableResult func removing(_ key: K) -> Bool { let had = data[key] != nil; data.removeValue(forKey: key); return had }',
    '}',
    "// two maps are equal when they hold the same keys with equal values, in any order (Kotlin's Map.equals)",
    'extension SeedMap: Equatable where V: Equatable {',
    '    static func == (a: SeedMap<K, V>, b: SeedMap<K, V>) -> Bool { a.data.count == b.data.count && a.data.allSatisfy { b.data[$0.key] == $0.value } }',
    '}',
  ].join('\n'),
  // the reference wrapper for lists (a class so an in-place `push` persists across a copy)
  list: [
    'final class SeedList<T> {',
    '    var data: [T]',
    '    init(_ data: [T] = []) { self.data = data }',
    '    @discardableResult func appending(_ item: T) -> Int { data.append(item); return data.count }',
    '    @discardableResult func popping() -> T { return data.removeLast() }',
    '    func storing(_ index: Int, _ item: T) { data[index] = item }',
    '    @discardableResult func unshifting(_ item: T) -> Int { data.insert(item, at: 0); return data.count }',
    '    @discardableResult func shifting() -> T { return data.removeFirst() }',
    // a splice and a slice clamp their bounds and never count from the end (note/term/stdlib/semantics.md)
    '    @discardableResult func splicing(_ start: Int, _ count: Int, _ items: [T]) -> Int { let s = min(max(start, 0), data.count); let c = min(max(count, 0), data.count - s); data.replaceSubrange(s..<(s + c), with: items); return data.count }',
    '    func slicing(_ start: Int, _ end: Int? = nil) -> SeedList<T> { let x = min(max(start, 0), data.count); let y = min(max(end ?? data.count, 0), data.count); return SeedList(x < y ? Array(data[x..<y]) : []) }',
    '}',
    '// a list compares and hashes by its items, as on every other backend (note/term/optimize/meaning.md, question 4)',
    'extension SeedList: Equatable where T: Equatable {',
    '    static func == (a: SeedList<T>, b: SeedList<T>) -> Bool { a.data == b.data }',
    '}',
    'extension SeedList: Hashable where T: Hashable {',
    '    func hash(into hasher: inout Hasher) { hasher.combine(data) }',
    '}',
  ].join('\n'),
} as const

type SwiftHelper = keyof typeof SWIFT_HELPERS

// every type kind the program's nodes carry, found by walking the program's objects: a list or map value has a list
// or map type on some node even where the emitter writes no annotation for it
function typeKindsIn(program: Program): string[] {
  const kinds = new Set<string>()
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

    const kind = (value as { kind?: unknown }).kind

    if (typeof kind === 'string') {
      kinds.add(kind)
    }

    for (const [key, inner] of Object.entries(value)) {
      if (key !== 'span') {
        visit(inner)
      }
    }
  }

  visit(program)

  return [...kinds]
}

// The enums that must be `indirect`: those on a cycle of forms that hold each other BY VALUE. A list, a map and a
// function are references, and a `shared` form is a class, so none of them carries a cycle. A generic form applied to
// arguments holds them (`maybe node` holds a `node`), so the edge runs from the holder to the generic and from the
// generic to each argument, and an enum such as `maybe` that sits on someone's cycle is marked as well. Swift refuses a
// value type that contains itself without an `indirect` somewhere on the cycle, and that refusal is what this keeps away.
function recursiveEnums(program: Program): Set<string> {
  const forms = new Map<string, Extract<Statement, { form: 'record-type' }>>()

  for (const node of program) {
    if (node.form === 'record-type') {
      forms.set(node.name, node)
    }
  }

  const edges = new Map<string, Set<string>>()
  const edge = (from: string, to: string): void => {
    if (forms.has(to) && !forms.get(to)!.shared) {
      edges.set(from, (edges.get(from) ?? new Set()).add(to))
    }
  }
  const held = (from: string, type: Type | undefined): void => {
    if (type?.kind !== 'named') {
      return
    }

    edge(from, type.name)

    for (const arg of type.args ?? []) {
      held(type.name, arg)
      held(from, arg)
    }
  }

  for (const [name, node] of forms) {
    if (node.shared) {
      continue
    }

    for (const field of node.fields) {
      held(name, field.type)
    }

    for (const variant of node.variants) {
      for (const field of variant.fields) {
        held(name, field.type)
      }
    }
  }

  // an enum is on a cycle when it reaches itself
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

  return new Set([...forms].filter(([name, node]) => node.variants.length > 0 && reaches(name)).map(([name]) => name))
}

function pascal(name: string): string {
  const c = camelize(name)
  const spelled = c.charAt(0).toUpperCase() + c.slice(1)

  return SWIFT_TAKEN.has(spelled) ? `${spelled}Form` : spelled
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

// gather the inference-variable ids appearing in a type (each is an implicit generic parameter of its function)
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

// the generic variable ids and names that sit at the element position of an array used with `includes` / `indexOf`,
// which need an `Equatable` bound (Array.contains / firstIndex(of:) require it). Walks the function body's calls.
function collectArrayEq(body: Statement[]): {
  ids: Set<number>
  names: Set<string>
} {
  const ids = new Set<number>()
  const names = new Set<string>()

  const record = (callee: Expression): void => {
    const op = collectionCall(callee)

    if (op?.kind !== 'array') {
      return
    }

    if (ARRAY_OP_BOUND[op.op] !== 'eq') {
      return
    }

    const element =
      op.target.type?.kind === 'array'
        ? op.target.type.element
        : undefined

    if (element?.kind === 'variable') {
      ids.add(element.id)
    } else if (element?.kind === 'named') {
      names.add(element.name.toUpperCase())
    }
  }

  const visitExpr = (e: Expression | undefined): void => {
    if (!e) {
      return
    }

    switch (e.form) {
      case 'call':
        record(e.callee)
        visitExpr(e.callee)
        e.args.forEach(visitExpr)
        break
      case 'binary':
        visitExpr(e.left)
        visitExpr(e.right)
        break
      case 'unary':
        visitExpr(e.operand)
        break
      case 'member':
        visitExpr(e.target)
        break
      case 'array':
        e.items.forEach(visitExpr)
        break
      case 'map':
        e.entries.forEach(en => {
          visitExpr(en.key)
          visitExpr(en.value)
        })
        break
      case 'record':
        e.fields.forEach(f => visitExpr(f.value))
        break
      case 'await':
        visitExpr(e.expr)
        break
      case 'closure':
        visitStmts(e.body)
        break
      default:
        break
    }
  }

  const visitStmts = (stmts: Statement[]): void => {
    for (const s of stmts) {
      switch (s.form) {
        case 'let':
          visitExpr(s.init)
          break
        case 'assign':
          visitExpr(s.target)
          visitExpr(s.value)
          break
        case 'expression':
          visitExpr(s.expr)
          break
        case 'return':
          visitExpr(s.value)
          break
        case 'throw':
          visitExpr(s.value)
          break
        case 'hold':
          visitExpr(s.expr)
          break
        case 'guard':
          visitStmts(s.body)

          if (s.catch) {
            visitStmts(s.catch.body)
          }

          break
        case 'while':
          visitExpr(s.cond)
          visitStmts(s.body)
          break
        case 'for-each':
          visitExpr(s.iterable)
          visitStmts(s.body)
          break
        case 'if':
          s.branches.forEach(b => {
            visitExpr(b.cond)
            visitStmts(b.body)
          })

          if (s.otherwise) {
            visitStmts(s.otherwise)
          }

          break
        case 'match':
          visitExpr(s.subject)
          s.cases.forEach(c => visitStmts(c.body))

          if (s.otherwise) {
            visitStmts(s.otherwise)
          }

          break
        default:
          break
      }
    }
  }

  visitStmts(body)

  return { ids, names }
}

// the seed primitive forms by name, for a `named` reference the checker did not seed (a module-level binding's
// annotation)
const SWIFT_PRIMITIVES: Record<string, string> = {
  text: 'String',
  boolean: 'Bool',
  number: 'Int',
  integer: 'Int',
  decimal: 'Double',
}

// the roll grouped by deck, for the generated wake chain (the same shape emitTypeScript takes)
export type WakeGroup = {
  deck: string
  entries: Record<string, unknown>[]
}

export function emitSwift(
  written: Program,
  options?: { wake?: WakeGroup[] },
): string {
  // a task named like a docked module is renamed, since Swift refuses `enum log` beside `func log` (dock-apart.ts)
  const program = keepDocksApart(written)
  const pad = (d: number) => '  '.repeat(d)
  // the `+`, `-` and `*` nodes proven not to overflow (compile/proven.ts): written as the wrapping `&+`, `&-`, `&*`.
  // The counted steps here, joined below by the interval fact once the list facts it reads are known
  let provenSteps: Proven = provenIncrements(program)
  // the counted loops whose calls to a bounded task may run its wrapping copy (ir/facts/bounds.ts), the calls in the
  // copy being emitted, the tasks some such call reached, and whether the body being emitted is such a copy
  // no lend facts: a fast copy of a task that takes a list is emitted under its own name, which this backend's list
  // facts (the lent, fixed and borrowed parameters, all keyed by task) do not reach, so only tasks that take no list
  // run unchecked here. TypeScript keys no list representation by task and passes them
  const loopGuards = boundedLoops(program)
  // the text expressions proven ASCII, read in place by byte offset (ir/facts/text.ts)
  const asciiNodes = asciiTexts(program)
  // the tasks that only fill a list (backend.ts, `fillTasks`)
  const fills = fillTasks(program)
  let fastCalls = new Set<object>()
  const fastTasks = new Set<string>()
  let uncheckedInts = false
  // the prelude helpers this program uses (SWIFT_HELPERS), recorded where each is written. A list or a map value
  // carries a list or map type somewhere in the program even when no annotation is written for it (the result of a
  // `map`, a temporary), so the program's types decide the two wrappers, and `swiftType` records them as well
  const needs = new Set<SwiftHelper>(typeKindsIn(program).flatMap(kind => (kind === 'array' ? ['list' as const] : kind === 'map' ? ['map' as const] : [])))
  const need = (helper: SwiftHelper, code: string): string => {
    needs.add(helper)

    return code
  }
  // the forms written as a struct or an enum, for the conformances emitted after them, and the enums that must be
  // `indirect` because they can contain themselves
  const declaredForms = new Set<string>()
  const recursive = recursiveEnums(program)
  // NODES REUSED (Swift's side of rust.ts `reusable`). An `indirect` case allocates a box per value and cannot be
  // reused: Towers' every move freed one node and allocated the next. A recursive form whose case that holds the form
  // is opened at a local's last read and built again in one task keeps that case's fields in a final class instead
  // (`case disk(StackDisk)`), and the task keeps a node its match opened in a spare of its own and builds the next
  // node in it. Only when `isKnownUniquelyReferenced` says nothing else holds the node, so no binding the program can
  // still read ever sees a field change: a value stays a value. The class alone measured slower than `indirect` (708 ms
  // against 657), and the reuse with it 306, against the hand version's 344 (`tmp/swift-towers-payload-ab.ts`), so a
  // form takes it only where some task does both. Keyed by form: its payload case and the class's name
  const nodeClasses = new Map<string, { label: string; name: string; fields: { name: string; type: Type }[] }>()
  // per task, the forms it keeps a spare node of; and the match subjects that are a task's local at its last read,
  // matched with `consume` so the node a case binds is held by that binding alone
  const spareTasks = new Map<string, Set<string>>()
  const consumedSubjects = new WeakSet<object>()

  {
    const taken = new Set(program.flatMap(n => (n.form === 'record-type' ? [pascal(n.name)] : [])))
    const candidates = new Map<string, { label: string; name: string; fields: { name: string; type: Type }[] }>()

    for (const n of program) {
      if (n.form !== 'record-type' || !recursive.has(n.name) || n.params.length > 0 || !n.variants.some(v => v.fields.length === 0)) {
        continue
      }

      const holding = n.variants.filter(v => v.fields.some(f => f.type.kind === 'named' && f.type.name === n.name))
      const name = holding.length === 1 ? `${pascal(n.name)}${pascal(holding[0]!.name)}` : ''

      if (holding.length === 1 && !taken.has(name)) {
        candidates.set(n.name, { label: holding[0]!.name, name, fields: holding[0]!.fields })
      }
    }

    for (const fn of program) {
      if (fn.form !== 'function' || candidates.size === 0) {
        continue
      }

      const last = lastReads(fn.body)
      const lets = new Set<string>()
      const opened = new Map<string, object[]>()
      const built = new Set<string>()
      // outside closures: a spare is the task's own local
      const visit = (value: unknown): void => {
        if (typeof value !== 'object' || value === null) return
        if (Array.isArray(value)) return value.forEach(visit)
        const s = value as { form?: string; name?: string; subject?: Expression; cases?: { label: string }[]; type?: Type }
        if (s.form === 'closure') return
        if (s.form === 'let' && s.name) lets.add(s.name)

        if (s.form === 'match' && s.subject?.form === 'variable' && s.subject.type?.kind === 'named' && last.has(s.subject)) {
          const form = candidates.get(s.subject.type.name)

          if (form && s.cases?.some(c => c.label === form.label)) {
            opened.set(s.subject.type.name, [...(opened.get(s.subject.type.name) ?? []), s.subject])
          }
        }

        if (s.form === 'record' && s.type?.kind === 'named' && candidates.get(s.type.name)?.label === s.name) {
          built.add(s.type.name)
        }

        for (const [key, child] of Object.entries(s)) if (key !== 'type' && key !== 'span') visit(child)
      }

      visit(fn.body)

      for (const [form, subjects] of opened) {
        // a subject the task binds itself, never a parameter or a global, which `consume` cannot take
        const own = subjects.filter(subject => lets.has((subject as { name: string }).name))

        if (built.has(form) && own.length > 0) {
          nodeClasses.set(form, candidates.get(form)!)
          spareTasks.set(fn.name, (spareTasks.get(fn.name) ?? new Set()).add(form))
          own.forEach(subject => consumedSubjects.add(subject))
        }
      }
    }
  }

  // the payload case of a form held by node class, by its label
  const nodeCase = new Map([...nodeClasses].map(([form, c]) => [c.label, { form, ...c }]))
  // the forms the task being emitted keeps a spare of (`spareTasks`), none inside a closure
  let spares = new Set<string>()
  const spareName = (form: string): string => `__spare${pascal(form)}`
  // when the stdlib hive is in the program, every new raise tells it (the throw lowering), and the compiler can
  // emit the wake chain (`wakeHive`) from the roll the driver hands over
  const hasHiveTell = program.some(
    n => n.form === 'function' && n.name === 'hive-tell',
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

  // generic tasks with a type parameter that no parameter mentions (`make-sorted-map` names `v` only in its result):
  // the call alone cannot tell Swift what it is, so a binding of one says it (below)
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

  // declarative native bindings render their `case swift` template at call sites
  const binds = collectBinds(program)

  // every name assigned anywhere (whole, or through a member path): a module-level binding one of these targets must
  // be a `var` (`hive.roll = kept` in hive-clear writes through the module's `host hive`)
  const assignedAnywhere = new Set<string>()

  for (const node of program) {
    if (node.form === 'function') {
      reassigned(node.body, assignedAnywhere)
    }
  }

  // the names the function being emitted reassigns, for its own locals; undefined at the module level, where a binding
  // any task writes must be a `var`
  let currentAssigned: Set<string> | undefined
  const assignedHere = (name: string): boolean => (currentAssigned ?? assignedAnywhere).has(name)

  // a function's free inference variables become named generic parameters; this maps each to its letter for the
  // duration of that function's emission, so `(t) -> ?5` prints as `(T) -> U` with `U` declared, not an unused `S`.
  let varNames = new Map<number, string>()

  // the labels of the loops being emitted, innermost last: `break` and `continue` name theirs
  const loopLabels: string[] = []
  let loopCount = 0
  const openLoop = (): string => {
    loopCount += 1
    const label = `loop${loopCount}`
    loopLabels.push(label)

    return label
  }

  // opaque per-backend handle types (`dock type / load <Foundation.Process>, name child-handle`): seed name -> concrete
  // swift type, so a `like child-handle` field emits the real handle type rather than a nonexistent struct.
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

  // the element types E whose lists of lists own their inner lists (backend.ts, `ownedElements`), decided once the list
  // facts are known: an inner list of one is a plain `[E]`, where every list is otherwise a `SeedList`
  let innerKeys = new Set<string>()
  // how the element of a list type is held: an inner list a list of lists owns is the plain array
  const swiftElement = (list: Extract<Type, { kind: 'array' }>): string =>
    list.element.kind === 'array' && innerKeys.has(swiftType(list.element.element))
      ? `[${swiftType(list.element.element)}]`
      : swiftType(list.element)
  const swiftType = (type: Type | undefined): string => {
    switch (type?.kind) {
      case 'boolean':
        return 'Bool'
      case 'string':
        return 'String'
      case 'unit':
      case undefined:
        return 'Void'
      case 'array':
        // a reference class wrapping an Array, so a list mutated in place (`push`) through one binding is seen through
        // every binding. A bare Swift Array is a value type and would not carry the mutation across a copy.
        needs.add('list')

        return `SeedList<${swiftElement(type)}>`
      case 'map':
        // a reference class wrapping a Dictionary, so a map mutated through one binding (a `set.insert`) is seen
        // through every binding. A bare Swift Dictionary is a value type and would not carry the mutation across a copy.
        // a key nothing constrained is any Hashable value, not `Any`, which Swift cannot hash: the free-variable
        // default is `Any`, and a map key needs the hashable form of it
        const key =
          (type.key?.kind === 'variable' && !varNames.has(type.key.id)) || type.key?.kind === 'unknown' || type.key?.kind === 'dynamic'
            ? 'AnyHashable'
            : swiftType(type.key)

        needs.add('map')

        return `SeedMap<${key}, ${swiftType(type.value)}>`

      case 'named': {
        const opaque = opaqueTypes.get(type.name)

        if (opaque) {
          return opaque
        }

        // the seed primitives written by name (`like text` on a module-level binding reaches here unseeded)
        const primitive = SWIFT_PRIMITIVES[type.name]

        if (primitive) {
          return primitive
        }

        if (type.args && type.args.length > 0) {
          return `${pascal(type.name)}<${type.args.map(swiftType).join(', ')}>`
        }

        // a generic form named without its arguments (`like maybe`): swift needs every parameter, so each is Any
        const arity = genericArity.get(type.name) ?? 0

        return arity > 0
          ? `${pascal(type.name)}<${Array.from({ length: arity }, () => 'Any').join(', ')}>`
          : pascal(type.name)
      }

      case 'function': {
        // an async function value is an `async` function type; the call site `await`s it.
        const marker = type.effects?.includes('async') ? ' async' : ''

        return `(${type.params
          .map(swiftType)
          .join(', ')})${marker} -> ${swiftType(type.result)}`
      }
      case 'number':
        return 'Int'
      case 'float':
        return 'Double'
      case 'dynamic':
        return 'Any'
      case 'bytes':
        return 'Data'
      case 'variable':
        // a free variable not in this function's scope: nothing concrete ever met it, only the gradual `unknown` /
        // `dynamic` (which unify without binding), so the faithful type is `Any`. It was `Int`, which made a `make
        // list` fed json items a `SeedList<Int>` returned where a declared `like list, like unknown` wanted
        // `SeedList<Any>` (the cask dispatcher's items-of)
        return varNames.get(type.id) ?? 'Any'
      case 'unknown':
        // the declared dynamic (`like unknown` / `like any`): any value, so a hive entry's `base` can carry a record
        return 'Any'
      default:
        return 'Int'
    }
  }

  // the `<...>` clause for a function: its declared generics that survive, plus a fresh letter for each free
  // inference variable in the signature. Sets `varNames` for the rest of this function's emission.
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

    // which generics sit in a map-KEY position (a Dictionary key must be Hashable), following form args transitively so
    // a `Set<U>` marks U even though its map is hidden inside the struct
    const keyIds = new Set<number>()
    const keyNames = new Set<string>()

    const markKeys = (t: Type | undefined, isKey: boolean): void => {
      if (!t) {
        return
      }

      if (t.kind === 'variable') {
        if (isKey) {
          keyIds.add(t.id)
        }
      } else if (t.kind === 'map') {
        markKeys(t.key, true)
        markKeys(t.value, false)
      } else if (t.kind === 'array') {
        markKeys(t.element, false)
      } else if (t.kind === 'function') {
        t.params.forEach(p => markKeys(p, false))
        markKeys(t.result, false)
      } else if (t.kind === 'named') {
        if (isKey) {
          keyNames.add(t.name.toUpperCase())
        }

        const keyArgs = formKeyIndices.get(t.name)
        t.args?.forEach((a, i) => markKeys(a, keyArgs?.has(i) ?? false))
      }
    }

    node.params.forEach(p => markKeys(p.type, false))
    markKeys(node.result, false)

    // generics used as an array element with `includes` / `indexOf` need `Equatable` (a map key's `Hashable` implies it)
    const arrayEq = collectArrayEq(node.body)
    const bound = (
      name: string,
      isKey: boolean,
      isEq: boolean,
    ): string =>
      isKey ? `${name}: Hashable` : isEq ? `${name}: Equatable` : name

    const fresh: string[] = []

    for (const id of ids) {
      const letter = pool.find(l => !used.has(l)) ?? `T${id}`
      used.add(letter)
      varNames.set(id, letter)
      fresh.push(bound(letter, keyIds.has(id), arrayEq.ids.has(id)))
    }

    // declared generics that actually appear in the signature (as named types) are kept; the rest are dropped
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

    // a trait-bounded generic (`head t, need sizer`) adds its protocol to the bound (Swift joins bounds with `&`),
    // so the body's `x.measure()` resolves through it
    const needTrait = new Map<string, string>()

    for (const g of node.generics) {
      if (g.need) {
        needTrait.set(g.name.toUpperCase(), pascal(g.need))
      }
    }

    const keptDeclared = declared
      .filter(d => namedInSig.has(d))
      .map(d => {
        const base = bound(d, keyNames.has(d), arrayEq.names.has(d))

        if (!needTrait.has(d)) {
          return base
        }

        return base.includes(':')
          ? `${base} & ${needTrait.get(d)}`
          : `${base}: ${needTrait.get(d)}`
      })

    const all = [...keptDeclared, ...fresh]

    return all.length ? `<${all.join(', ')}>` : ''
  }

  // variant label -> the owning enum, and each variant's field names (for construction and match binding)
  const variantFields = new Map<string, string[]>()
  // the same, by FORM and case (`rope/leaf`): two forms may name a case alike, and an arm reads its own form's
  const caseFieldNames = new Map<string, string[]>()
  const variantSet = new Set<string>()
  // the `note shared` forms, emitted as classes and compared by identity
  const sharedForms = new Set(
    program.flatMap(n => (n.form === 'record-type' && n.shared ? [n.name] : [])),
  )
  // the forms a `fill` / `melt` with a form walks, gathered while the bodies are emitted
  const fillSpecs = new Map<string, FormSpec>()
  const meltSpecs = new Map<string, FormSpec>()
  // every struct form's declared fields (in order: swift's memberwise init takes them so), and the exception forms,
  // whose structs conform to Error so a raise can `throw` them
  const recordFields = new Map<string, { name: string; type: Type }[]>(
    program
      .filter((n): n is Extract<Statement, { form: 'record-type' }> => n.form === 'record-type' && n.variants.length === 0)
      .map(n => [n.name, n.fields]),
  )
  // the value answered by an untyped SHIM: a call to a Term task, or to a `dock load` module, awaited or not. A built-in
  // collection operation is neither, since `SeedList.popping()` is already typed and a cast there only warns
  const nativeAliases = new Set(
    program.flatMap(n => (n.form === 'native' && n.kind !== 'type' ? [n.alias] : [])),
  )
  const shimCall = (value: Expression): boolean => {
    const call = value.form === 'await' ? value.expr : value

    return (
      call.form === 'call' &&
      ((call.callee.form === 'variable' && !nativeAliases.has(call.callee.name)) ||
        (call.callee.form === 'member' &&
          call.callee.target.form === 'variable' &&
          nativeAliases.has(call.callee.target.name)))
    )
  }
  const exceptionForms = new Set(
    program
      .filter((n): n is Extract<Statement, { form: 'record-type' }> => n.form === 'record-type' && Boolean(n.chain?.includes('exception')))
      .map(n => n.name),
  )

  // the empty value of a type: what a left-out field holds
  const emptyOf = (type: Type | undefined): string => {
    switch (type?.kind) {
      case 'string':
        return '""'
      case 'boolean':
        return 'false'
      case 'number':
        return '0'
      case 'float':
        return '0.0'
      case 'bytes':
        return 'Data()'
      case 'array':
        return 'SeedList()'
      case 'map':
        return 'SeedMap()'
      case 'named':
        if (type.name === 'text') {
          return '""'
        }

        if (type.name === 'boolean') {
          return 'false'
        }

        if (type.name === 'number' || type.name === 'integer') {
          return '0'
        }

        if (type.name === 'decimal') {
          return '0.0'
        }

        if (type.name === 'maybe') {
          return '.none'
        }

        if (type.name === 'list') {
          return 'SeedList()'
        }

        if (type.name === 'hash') {
          return 'SeedMap()'
        }

        return '0'
      default:
        return '0'
    }
  }
  // for each form, which generic parameters (by index) flow into a map KEY position inside its fields. A `set<t>` stores
  // `items: hash<t, bool>`, so index 0 is a key; a method generic filling that slot must be `Hashable` (a Dictionary key).
  const formKeyIndices = new Map<string, Set<number>>()

  for (const node of program) {
    if (node.form !== 'record-type') {
      continue
    }

    for (const v of node.variants) {
      variantSet.add(v.name)
      variantFields.set(
        v.name,
        v.fields.map(f => f.name),
      )
      caseFieldNames.set(`${node.name}/${v.name}`, v.fields.map(f => f.name))
    }

    if (node.params.length > 0) {
      const keyParams = new Set<string>()

      const findKeys = (t: Type | undefined): void => {
        if (!t) {
          return
        }

        if (t.kind === 'map') {
          if (t.key.kind === 'named') {
            keyParams.add(t.key.name)
          }

          findKeys(t.key)
          findKeys(t.value)
        } else if (t.kind === 'array') {
          findKeys(t.element)
        } else if (t.kind === 'named') {
          t.args?.forEach(findKeys)
        }
      }

      const fields =
        node.variants.length > 0
          ? node.variants.flatMap(v => v.fields)
          : node.fields

      fields.forEach(f => findKeys(f.type))

      const indices = new Set<number>()
      node.params.forEach((p, i) => {
        if (keyParams.has(p)) {
          indices.add(i)
        }
      })

      if (indices.size > 0) {
        formKeyIndices.set(node.name, indices)
      }
    }
  }

  // native dock module aliases (`dns`, `fs`): a call to one returning a list yields a plain Array that must be wrapped
  const aliases = new Set<string>()

  for (const node of program) {
    if (node.form === 'native' && node.kind !== 'type') {
      aliases.add(node.alias)
    }
  }

  const rootName = (node: Expression): string | undefined =>
    node.form === 'variable'
      ? node.name
      : node.form === 'member'
        ? rootName(node.target)
        : undefined

  // true while emitting a list-returning function: a native dock call returned directly (a plain Array from the shim,
  // which has no access to the SeedList class) is wrapped in the seed list's SeedList handle to match the return type
  let fnReturnsArray = false
  // the enclosing function's declared result, so a `return <unknown-typed value>` casts at the gradual
  // boundary (`read mock/dock` returned as `like mock-data`)
  let currentResult: Type | undefined

  const isNativeCall = (node: Expression): boolean => {
    // SEE THROUGH AN AWAIT. `send back / call shim/list-them / wait true` is an `await` node wrapping the call,
    // and it is the same call: an asynchronous shim returns a plain `[T]` exactly as a synchronous one does. Not
    // looking through it meant a list-returning `note async` task emitted `return await shim.listThem(..)` with
    // no `SeedList(..)` around it, which swiftc rejects with `cannot convert return expression of type '[String]'
    // to return type 'SeedList<String>'`. The synchronous form of the very same task compiled clean, which is
    // what made it look like a shim problem rather than an emitter one.
    const call = node.form === 'await' ? node.expr : node

    if (call.form !== 'call' || call.callee.form !== 'member') {
      return false
    }

    const root = rootName(call.callee)

    return root !== undefined && aliases.has(root)
  }

  // traits (masks) emit as protocols, instances as conformance extensions, and a trait-bounded generic gains a protocol
  // bound on its type parameter so a generic trait-method call lowers to `x.method(..)`. Method signatures are derived
  // from the instance implementations (each desugared to a `<target>_<method>` free function tagged with `method`),
  // with the receiver type replaced by `Self`. See note/seed/compiler/trait-dictionary-passing.md.
  const maskMethods = new Set<string>()

  for (const node of program) {
    if (node.form === 'mask') {
      for (const m of node.methods) {
        maskMethods.add(m)
      }
    }
  }

  const instanceTargets = new Map<string, string[]>()

  for (const node of program) {
    if (node.form === 'instance') {
      const list = instanceTargets.get(node.mask) ?? []
      list.push(node.target)
      instanceTargets.set(node.mask, list)
    }
  }

  type Fn = Extract<Statement, { form: 'function' }>
  const implFn = new Map<string, Fn>()

  for (const node of program) {
    if (node.form === 'function' && node.method) {
      implFn.set(`${node.method.form}:${node.method.name}`, node)
    }
  }

  // the functions whose body throws directly: their signatures carry `throws`, and every CALL to one is emitted as
  // `try!`. The language has no catch construct, so a thrown SeedError is always fatal -- exactly what `try!` does --
  // and no caller has to propagate `throws` through its own signature (which would cascade through the whole program).
  // This matches the other targets: an uncaught JS Error, a Rust `panic!`, an uncaught Kotlin RuntimeException.
  const throwingFns = new Set<string>()

  for (const node of program) {
    if (node.form === 'function' && bodyThrows(node.body)) {
      throwingFns.add(node.name)
    }
  }

  // the raise sets (note/term/hive/04-reach.md): a function that can raise, through its callees too, is `throws`, a
  // call to one is `try` where the caller is itself `throws` or the call sits in a guarded body, and `try!` elsewhere
  // (a raise nothing handles ends the program, as on every backend)
  const sets = raiseSets(program, exceptionForms)

  for (const [name, raises] of sets.raises) {
    if (raises.size > 0) {
      throwingFns.add(name)
    }
  }

  let currentThrows = false
  let guardDepth = 0
  // the `note async` tasks, and whether the expression being emitted is the operand of a `wait true`
  const asyncFns = new Set(
    program.flatMap(node => (node.form === 'function' && node.async ? [node.name] : [])),
  )
  let awaiting = false
  // the names bound in scope (the function's and every enclosing closure's parameters, and each let and walk item as it
  // is emitted): one named like a task shadows it
  let boundNames = new Set<string>()
  // each free task's parameter count, for a throwing task passed as a value (methods are reached by dispatch, not named)
  const taskArity = new Map(
    program.flatMap(node => (node.form === 'function' && !node.method ? [[node.name, node.params.length] as const] : [])),
  )
  const tryWord = (): string => (currentThrows || guardDepth > 0 ? 'try' : 'try!')

  // F1 (note/term/codegen/shared.md), the same facts Rust reads: a list parameter a task takes lent is a plain `[T]`
  // (read) or `inout [T]` (written) where every list is otherwise a `SeedList` class, a list local the task owns is a
  // plain `var [T]`, and a task answering a fresh list answers `[T]`. Swift's arrays are values with copy-on-write, so
  // a read-only `[T]` copies nothing, and an `inout` argument's write access begins only after every other argument is
  // evaluated, so `flip(&perm.data, perm.data[0])` reads before it lends
  const gated = gatedTasks(program, maskMethods)
  const { lend: lendParams, fresh: freshLists } = listFacts(program, gated)
  provenSteps = provenArithmetic(program, lendParams, freshLists)
  // the lists of lists that own their inner lists, each inner list a plain `[E]` (backend.ts, `ownedElements`): Graph's
  // adjacency lists, 432 ms to 336 against the hand version's 318 (`tmp/swift-graph-ab.ts`)
  const elementLists = ownedElements(program, freshLists, lendParams, t => swiftType(t))
  innerKeys = elementLists.keys
  // the plain records' list fields the record owns (backend.ts, `ownedFields`), a plain `[T]` where every list field
  // was a `SeedList`: read and written in place through the path (Particle, 720 ms to 328 measured by hand,
  // `tmp/swift-particle-ab.ts`). And a variant's, keyed by the variant: `ownedFields` holds one only where every arm
  // that binds it only reads it, so the arm's local is the plain array too (Storage's leaf items and node kids, 1368 ms
  // to 1225 against the hand version's 1221, `tmp/swift-storage-ab.ts`). Not a generic form's, and not a variant held
  // in a node class (`nodeClasses`), whose class keeps its fields as declared
  const structForms = new Set(program.flatMap(n => (n.form === 'record-type' && n.variants.length === 0 && !n.shared ? [n.name] : [])))
  // the forms with cases: a list literal of them names its element, since `[.int, .int]` alone gives Swift no enum
  // to find the cases in
  const unionForms = new Set(program.flatMap(n => (n.form === 'record-type' && n.variants.length > 0 ? [n.name] : [])))
  const plainVariants = new Set(
    program.flatMap(n =>
      n.form === 'record-type' && n.variants.length > 0 && !n.shared && n.params.length === 0 && !nodeClasses.has(n.name) ? n.variants.map(v => v.name) : [],
    ),
  )
  const fieldLists = new Set(
    [...ownedFields(program, freshLists, lendParams, privateForms(program, lendParams, freshLists))].filter(key => {
      const owner = key.split('/')[0]!

      return structForms.has(owner) || plainVariants.has(owner)
    }),
  )
  // a path `r/field` to a list field the record owns
  const ownedPath = (target: Expression): boolean =>
    target.form === 'member' &&
    target.index === undefined &&
    target.target.type?.kind === 'named' &&
    fieldLists.has(`${target.target.type.name}/${target.name}`)
  const ownsInner = (at: WeakMap<object, string>, node: object): boolean => {
    const key = at.get(node)

    return key !== undefined && elementLists.keys.has(key)
  }
  // the plain-array names of the function being emitted: its lent parameters, and its owned locals as 'write'
  let plainNames = new Map<string, Lend>()
  // the walks by position written so far, for their counters' names (`__at0`)
  let walkCount = 0
  // its owned locals, with whether anything writes them (`var` against `let`)
  let ownedNames = new Map<string, boolean>()
  // F4 on Swift (compile/place.ts, `valuePlaces`): the record writes narrowed to their changed fields, the slot locals
  // read through their slot, and the slot locals of the function being emitted, by name
  const { writes: placed, locals: slotLocals } = valuePlaces(program)
  let slotNames = new Map<string, SlotLocal>()
  // the texts this task reads through a cursor (backend.ts, `textCursors`)
  let cursors: TextCursors = { names: [], reads: new Map() }
  let redeclared = new WeakSet<Statement>()
  // set while an owned local's init is emitted, so a fresh task's `[T]` is taken as it is
  let rawFresh = false
  // whether the function being emitted answers a fresh list
  let emittingFresh = false
  // a list's storage: the plain array itself, or the SeedList's `.data`
  const view = (target: Expression, bind: Bindings): string =>
    (target.form === 'variable' && plainNames.has(target.name)) || ownedPath(target) ? expr(target, bind) : `${expr(target, bind)}.data`

  const subSelf = (
    t: Type | undefined,
    target: string,
  ): Type | undefined => {
    if (!t) {
      return t
    }

    if (t.kind === 'named') {
      return t.name === target
        ? { kind: 'named', name: 'Self' }
        : t.args
          ? { ...t, args: t.args.map(a => subSelf(a, target)!) }
          : t
    }

    if (t.kind === 'array') {
      return { kind: 'array', element: subSelf(t.element, target)! }
    }

    if (t.kind === 'map') {
      return {
        kind: 'map',
        key: subSelf(t.key, target)!,
        value: subSelf(t.value, target)!,
      }
    }

    if (t.kind === 'function') {
      return {
        kind: 'function',
        params: t.params.map(p => subSelf(p, target)!),
        result: subSelf(t.result, target)!,
        effects: t.effects,
      }
    }

    return t
  }

  // a protocol method requirement: `func measure() -> Int` (the receiver is implicit `self`, so the first parameter is
  // dropped; remaining parameters keep their types with the receiver type as `Self`)
  const protocolMethod = (
    fn: Fn | undefined,
    target: string,
  ): string => {
    if (!fn) {
      return ''
    }

    const rest = fn.params
      .slice(1)
      .map(
        p =>
          `_ ${camel(p.name)}: ${swiftType(subSelf(p.type, target))}`,
      )

    return `func ${camel(fn.method!.name)}(${rest.join(', ')}) -> ${swiftType(
      subSelf(fn.result, target),
    )}`
  }

  // a conformance method that delegates to the free implementation function: `func measure() -> Int { return boxMeasure(self) }`
  const extensionMethod = (
    fn: Fn | undefined,
    target: string,
  ): string => {
    if (!fn) {
      return ''
    }

    const restNames = fn.params.slice(1).map(p => camel(p.name))
    const rest = fn.params
      .slice(1)
      .map(
        p =>
          `_ ${camel(p.name)}: ${swiftType(subSelf(p.type, target))}`,
      )

    const callArgs = ['self', ...restNames].join(', ')
    const invoke = throwingFns.has(fn.name)
      ? `try! ${camel(fn.name)}(${callArgs})`
      : `${camel(fn.name)}(${callArgs})`

    return `${protocolMethod0(fn, target, rest)} { return ${invoke} }`
  }

  // shared header builder so the extension method matches the protocol method exactly
  const protocolMethod0 = (
    fn: Fn,
    target: string,
    rest: string[],
  ): string =>
    `func ${camel(fn.method!.name)}(${rest.join(', ')}) -> ${swiftType(
      subSelf(fn.result, target),
    )}`

  // within a matched branch, a subject variable's fields are bound to locals; `subject/field` reads that local
  type Bindings = Map<string, Set<string>>

  // the inner lists put into a list of lists that owns them (`ownedElements`), rendering now
  const innerRendering = new WeakSet<object>()
  const expr = (node: Expression, bind: Bindings): string => {
    // an inner list put into a list of lists that owns it is the plain array: an owned local as it is, a fresh task's
    // answer taken as it is, an empty list `[]`
    if (ownsInner(elementLists.items, node) && !innerRendering.has(node)) {
      if (node.form === 'call') {
        innerRendering.add(node)
        rawFresh = true
        const made = expr(node, bind)
        rawFresh = false
        innerRendering.delete(node)

        return made
      }

      if (node.form !== 'variable') {
        return '[]'
      }
    }

    switch (node.form) {
      case 'integer':
        return String(node.value)
      case 'float':
        // a float literal needs a decimal point so it is a Double, not an Int
        // (JavaScript writes 1e21 and past as `1e+21`, already a float literal, which a `.0` would break)
        return Number.isInteger(node.value) && !/e/i.test(String(node.value))
          ? `${node.value}.0`
          : String(node.value)
      case 'boolean':
        return node.value ? 'true' : 'false'
      case 'string':
        return JSON.stringify(node.value)
      case 'template':
        // one text value alone is that value, where the interpolation built a copy of it. Not a bare name, which
        // costs nothing to copy and would make `save t, text <{t}>` the self-assignment swiftc refuses
        if (node.parts.length === 1 && typeof node.parts[0] !== 'string' && node.parts[0]!.form !== 'variable' && textValued(node.parts[0]!)) {
          return expr(node.parts[0]!, bind)
        }

        // `"a\\(x)b"`: chunks escaped as a Swift string, expressions interpolated
        // a float interpolates as `termNumber` lays it out, the same text as every other backend
        return `"${node.parts
          .map(part =>
            typeof part === 'string'
              ? JSON.stringify(part).slice(1, -1)
              : part.type?.kind === 'float'
                ? need('number', `\\(termNumber(${expr(part, bind)}))`)
                : `\\(${expr(part, bind)})`,
          )
          .join('')}"`
      case 'unit':
        return '()'
      case 'null':
        // null in the dynamic currency (`Any`) is Foundation's null object, the JSON-null representation
        return 'NSNull()'
      case 'variable':
      case 'hole': {
        // a throwing task passed as a VALUE goes where a Term task type is taken, which is a non-throwing Swift
        // function type, so it is wrapped in a closure whose call is `try!`, as a raise in any closure body is
        // (native-dom-0014: the blog's `keep` handed to the view as its store)
        // The arity is the task's own, read off its definition: the reference does not always carry a function type
        const defined = node.form === 'variable' && !boundNames.has(node.name) ? taskArity.get(node.name) : undefined

        if (node.form === 'variable' && throwingFns.has(node.name) && defined !== undefined) {
          const names = Array.from({ length: defined }, (_, i) => `p${i}`)
          const isAsync = asyncFns.has(node.name)

          return `{ (${names.join(', ')})${isAsync ? ' async' : ''} in try! ${isAsync ? 'await ' : ''}${vname(node.name)}(${names.join(', ')}) }`
        }

        return vname(node.name)
      }
      case 'unary': {
        // an operator over a throwing call needs the `try` in front of the whole expression, not the call alone
        const operand = expr(node.operand, bind)

        // and an operator over an awaited call wraps it: `!await f()` is refused, `!(await f())` is not
        if (operand.startsWith('await ')) {
          return `${node.op}(${operand})`
        }

        return openTry(operand) ? `(try ${node.op}${operand})` : `${node.op}${operand}`
      }
      case 'binary': {
        if (
          node.op === '%' &&
          (node.left.type?.kind === 'float' || node.right.type?.kind === 'float' || node.type?.kind === 'float')
        ) {
          return `(${expr(node.left, bind)}).truncatingRemainder(dividingBy: ${expr(node.right, bind)})`
        }

        // comparing an unknown slot to `make void` is a presence check: Any has no `==`, so it asks whether
        // the slot holds the unit
        const voidSide =
          node.right.form === 'record' && node.right.name === 'void'
            ? node.left
            : node.left.form === 'record' && node.left.name === 'void'
              ? node.right
              : undefined

        if (voidSide && (node.op === '==' || node.op === '!=')) {
          const check = `(${expr(voidSide, bind)} is Void)`

          return node.op === '==' ? check : `!${check}`
        }

        // an enum variant built right inside a comparison has no type from context, so `.circle(radius: 2)` is
        // spelled `Shape.circle(radius: 2)` there
        const operand = (side: Expression): string => {
          const text = expr(side, bind)

          return (node.op === '==' || node.op === '!=') &&
            side.form === 'record' &&
            variantSet.has(side.name) &&
            side.type?.kind === 'named' &&
            text.startsWith('.')
            ? `${pascal(side.type.name)}${text}`
            : text
        }

        const left = operand(node.left)
        const right = operand(node.right)
        // a `try` to the right of an operator with no parenthesis of its own is refused by Swift ("'try' cannot appear
        // to the right of a non-assignment operator"): the `try` goes in front of the operator. A call writes its own
        // `(try f())`, which Swift takes as it is, and a second `try` over it warns that it covers nothing. Except under
        // `&&`, `||` and `??`, whose right side is an autoclosure: a `try` inside one is refused ("call can throw, but it
        // is executed in a non-throwing autoclosure"), so the `try` covers the whole expression there
        const autoclosed = node.op === '&&' || node.op === '||' || node.op === '??'
        const mark = (autoclosed ? left.includes('try ') || right.includes('try ') : openTry(left) || openTry(right)) ? 'try ' : ''

        // a `note shared` form is a class, a reference by design, so `is-equal` on two of them is identity, as it is on
        // TypeScript and Kotlin (note/term/optimize/meaning.md, question 4)
        const shared = [node.left.type, node.right.type].some(
          t => t?.kind === 'named' && sharedForms.has(t.name),
        )

        if (shared && (node.op === '==' || node.op === '!=')) {
          return `(${mark}${left} ${node.op === '==' ? '===' : '!=='} ${right})`
        }

        // two texts are equal when their code points are, and order by code point (note/term/stdlib/semantics.md).
        // Swift's `==` and `<` on String use canonical equivalence, so `"é" == "e\u{301}"` is true here only
        if (isText(node.left.type) && isText(node.right.type)) {
          if (node.op === '==' || node.op === '!=') {
            return need('text', `(${node.op === '!=' ? '!' : ''}${mark}TermText.equal(${left}, ${right}))`)
          }

          if (node.op === '<' || node.op === '>' || node.op === '<=' || node.op === '>=') {
            return need('text', `(${mark}TermText.compare(${left}, ${right}) ${OP[node.op]} 0)`)
          }
        }

        // a counted step the range fact proved cannot overflow (ir/facts/range.ts) is the wrapping `&+`, which carries
        // no trap: n-body's eight steps, 213 ms to 202 (`tmp/swift-step-ab.ts`, 2026-10-03)
        if ((node.op === '+' || node.op === '-' || node.op === '*') && node.left.type?.kind === 'number' && node.right.type?.kind === 'number' && provenSteps.has(node)) {
          return `(${mark}${left} &${OP[node.op]} ${right})`
        }

        // in a task's unchecked copy (`integerBounds`) every integer `+`, `-` and `*` is proven inside the bound
        if (uncheckedInts && (node.op === '+' || node.op === '-' || node.op === '*') && node.left.type?.kind === 'number' && node.right.type?.kind === 'number') {
          return `(${mark}${left} &${OP[node.op]} ${right})`
        }

        return `(${mark}${left} ${OP[node.op]} ${right})`
      }

      case 'call': {
        // a call the guarded loop copy may make to the task's wrapping copy (`LoopGuard.fast`)
        if (fastCalls.has(node) && node.callee.form === 'variable') {
          fastTasks.add(node.callee.name)

          return expr({ ...node, callee: { ...node.callee, name: `${node.callee.name}-fast` } } as Expression, bind)
        }

        // whether this call sits directly under `wait true`, read before the arguments render their own calls
        const awaited = awaiting
        awaiting = false
        // read once and cleared, so the call's own arguments never take a fresh array raw
        const raw = rawFresh
        rawFresh = false

        // a push onto, or the size of, an owned list local is the array's own (F1)
        if (
          node.callee.form === 'variable' &&
          (node.callee.name === 'list_push' || node.callee.name === 'list_size') &&
          node.args[0]?.form === 'variable' &&
          ownedNames.has(node.args[0].name)
        ) {
          const list = expr(node.args[0], bind)

          return node.callee.name === 'list_size'
            ? `${list}.count`
            : `({ () -> Int in ${list}.append(${expr(node.args[1]!, bind)}); return ${list}.count })()`
        }

        // `call fill / <data> / like <form>` and `call melt / <value> / like <form>`: a function per form, generated
        // from the form's fields at the end of the module (see swiftFormWalk below)
        if (
          node.callee.form === 'variable' &&
          (node.callee.name === 'fill-form' || node.callee.name === 'melt-form') &&
          node.into
        ) {
          const spec = formSpec(node.into, recordFields)
          refuseAny(spec, 'Swift')
          const into = node.callee.name === 'fill-form' ? fillSpecs : meltSpecs
          specForms(spec, into)

          // a fill throws `data-mismatch`, tried the way any throwing call is, and brings the exception it throws
          if (node.callee.name === 'fill-form') {
            needs.add('exception')

            return `(${tryWord()} __fill${pascal(spec.form)}(${expr(node.args[0]!, bind)}, ""))`
          }

          return `__melt${pascal(spec.form)}(${expr(node.args[0]!, bind)})`
        }

        // a declarative native binding renders its `case swift` template
        if (
          node.callee.form === 'variable' &&
          binds.has(node.callee.name)
        ) {
          const found = binds.get(node.callee.name)!

          // the code-point count of an ASCII text (ir/facts/text.ts) is its UTF-8 length, where the scalar view walked
          if (node.callee.name === 'code-point-count' && node.args[0] && asciiNodes.has(node.args[0])) {
            return `${expr(node.args[0], bind)}.utf8.count`
          }

          return (
            renderBind(
              found,
              'swift',
              node.args.map(a => expr(a, bind)),
            ) ?? bindGap(found.name)
          )
        }

        // a native map / list operation lowers to swift's collection API (a map goes through the SeedMap wrapper)
        const operation = collectionCall(node.callee)

        if (operation) {
          return collectionExpr(operation, node.args, bind)
        }

        // a host string method (what `text.tree` delegates to) lowers to swift's String API
        const text = stringCall(node.callee)

        if (text) {
          // an ASCII text (ir/facts/text.ts) is read in place by byte offset: a code point is one UTF-8 byte, where the
          // scalar view walked from the start
          // a read through the text's cursor (backend.ts, `textCursors`) steps from the last read
          const cursor = cursors.reads.get(node)

          if (cursor !== undefined && (text.op === 'substring' || text.op === 'slice')) {
            const to = node.args[1] ? expr(node.args[1], bind) : 'Int.max'

            return need('text', `TermText.cursorSlice(${expr(text.target, bind)}, ${expr(node.args[0]!, bind)}, ${to}, &__cursor${camelize(`-${cursor}`)})`)
          }

          if (cursor !== undefined) {
            const read = text.op === 'charCodeAt' ? 'cursorCodeAt' : 'cursorCharAt'

            return need('text', `TermText.${read}(${expr(text.target, bind)}, ${expr(node.args[0]!, bind)}, &__cursor${camelize(`-${cursor}`)})`)
          }

          if (asciiNodes.has(text.target) && ['charAt', 'at', 'charCodeAt'].includes(text.op)) {
            const read = text.op === 'charCodeAt' ? 'asciiCodeAt' : 'asciiCharAt'

            return need('text', `TermText.${read}(${expr(text.target, bind)}, ${expr(node.args[0]!, bind)})`)
          }

          if (asciiNodes.has(text.target) && (text.op === 'substring' || text.op === 'slice')) {
            return need('text', `TermText.asciiSubstring(${[text.target, ...node.args].map(a => expr(a, bind)).join(', ')})`)
          }

          if (asciiNodes.has(text.target) && (text.op === 'indexOf' || text.op === 'lastIndexOf')) {
            const helper = text.op === 'indexOf' ? 'asciiIndexOf' : 'asciiLastIndexOf'

            return need('text', `TermText.${helper}(${[text.target, ...node.args].map(a => expr(a, bind)).join(', ')})`)
          }

          return stringExpr(text.op, expr(text.target, bind), node.args.map(a => expr(a, bind)))
        }

        // a generic trait-method call lowers to a protocol method call on the receiver: `x.measure(..)`. The receiver
        // is the first argument; concrete trait calls were already resolved to the free function by the checker.
        if (
          node.callee.form === 'variable' &&
          maskMethods.has(node.callee.name) &&
          node.args.length >= 1
        ) {
          const rest = node.args.slice(1).map(a => expr(a, bind))

          return `${expr(node.args[0]!, bind)}.${camel(
            node.callee.name,
          )}(${rest.join(', ')})`
        }

        // a trailing `need false` parameter left out at the call site still exists in the native signature:
        // fill it with its type's empty value (the unit tuple for an unknown)
        // a list the callee takes lent (F1): `&` the storage for one it writes, the storage itself for one it reads
        const lending =
          node.callee.form === 'variable' && !boundNames.has(node.callee.name) ? lendParams.get(node.callee.name) : undefined
        const renderedArgs = node.args.map((a, i) => {
          const how = lending?.get(i)

          if (!how) {
            return expr(a, bind)
          }

          // a fresh task's array read straight from the call, with no SeedList around it to unwrap again
          if (how === 'read' && a.form === 'call' && a.callee.form === 'variable' && freshLists.has(a.callee.name)) {
            rawFresh = true
            const made = expr(a, bind)
            rawFresh = false

            return made
          }

          return `${how === 'write' ? '&' : ''}${view(a, bind)}`
        })
        // a fresh task answers a plain array: into a SeedList here, unless an owned local takes it as it is
        const fresh =
          !raw && node.callee.form === 'variable' && !boundNames.has(node.callee.name) && freshLists.has(node.callee.name)
        const wrap = (call: string): string => (fresh ? `SeedList(${call})` : call)

        // a call to a task that only fills a list is the array made at its size (backend.ts, `fillTasks`)
        const fill =
          node.callee.form === 'variable' && !boundNames.has(node.callee.name) && node.type?.kind === 'array' ? fillCall(node, fills) : undefined

        if (fill && node.type?.kind === 'array') {
          const count = fill.size.form === 'integer' ? `${Math.max(Number(fill.size.value), 0)}` : `max(${expr(fill.size, bind)}, 0)`
          const made = `[${swiftElement(node.type)}](repeating: ${expr(fill.item, bind)}, count: ${count})`

          return raw ? made : `SeedList(${made})`
        }
        // a parameter or local shadows a task of its name, whose arity must not pad its calls (rust.ts, the same rule)
        const declaredParams =
          node.callee.form === 'variable' && !boundNames.has(node.callee.name)
            ? functionParams.get(node.callee.name)
            : undefined

        if (declaredParams && declaredParams.length > renderedArgs.length) {
          for (let i = renderedArgs.length; i < declaredParams.length; i++) {
            const missing = declaredParams[i]

            renderedArgs.push(
              missing === undefined || missing.kind === 'unknown'
                ? '()'
                : emptyOf(missing),
            )
          }
        }

        // an async task called WITHOUT `wait true` runs on its own and the caller goes on, as a promise nobody awaits
        // does on TypeScript: on Swift that is a Task, whose body is the awaited call (native-dom-0014: the blog's
        // click handler starting `add-post`). A raise in it ends the program, as any unhandled raise does
        // a callee is CALLED, never passed: a bare name, not the closure a throwing task becomes as a value
        const callee = node.callee.form === 'variable' ? vname(node.callee.name) : expr(node.callee, bind)

        if (
          node.callee.form === 'variable' &&
          asyncFns.has(node.callee.name) &&
          !boundNames.has(node.callee.name) &&
          !awaited
        ) {
          const raise = throwingFns.has(node.callee.name) ? 'try! ' : ''

          return `Task { ${raise}await ${callee}(${renderedArgs.join(', ')}) }`
        }

        // a call to a throwing function is `try!`: fatal on error (there is no catch construct), and the caller's own
        // signature stays clean. Parenthesized so the call composes inside any surrounding expression.
        if (
          node.callee.form === 'variable' &&
          throwingFns.has(node.callee.name)
        ) {
          return wrap(`(${tryWord()} ${callee}(${renderedArgs.join(', ')}))`)
        }

        return wrap(`${callee}(${renderedArgs.join(', ')})`)
      }

      case 'array': {
        // an empty literal gives Swift nothing to infer the element from, so name it explicitly. A full one is left to
        // Swift, which reads the element from the context: texts passed where a `like list, like unknown` is taken
        // are a `SeedList<Any>` there, where the checked `SeedList<String>` would not convert (native-dom-0014)
        // A list of a UNION's cases is named too: `SeedList([.int, .int])` is "reference to member 'int' cannot be
        // resolved without a contextual type", since a case written `.int` needs its enum, and the cases of a call
        // inlined in place reach here bare (deck/test/test/property-check.tree's shapes, 2026-10-05)
        const element = node.type?.kind === 'array' ? node.type.element : undefined
        const arg =
          element && (node.items.length === 0 || (element.kind === 'named' && unionForms.has(element.name)))
            ? `<${swiftElement(node.type!)}>`
            : ''

        return `SeedList${arg}([${node.items
          .map(i => expr(i, bind))
          .join(', ')}])`
      }

      case 'map': {
        const arg =
          node.type?.kind === 'map'
            ? `<${swiftType(node.type.key)}, ${swiftType(
                node.type.value,
              )}>`
            : ''

        return node.entries.length === 0
          ? `SeedMap${arg}()`
          : // pairs, not a Dictionary literal: a Dictionary forgets the order the entries were written in
            `SeedMap${arg}(pairs: [${node.entries
              .map(e => `(${expr(e.key, bind)}, ${expr(e.value, bind)})`)
              .join(', ')}])`
      }

      case 'record': {
        // `make hash` / `make list` with no binds are the native collections, not record constructions; the
        // checked type pins the element parameters where swift cannot infer them (a generic function body)
        if (node.name === 'hash' && node.fields.length === 0) {
          const args =
            node.type?.kind === 'map' &&
            node.type.key.kind !== 'variable' &&
            node.type.value.kind !== 'variable'
              ? `<${swiftType(node.type.key)}, ${swiftType(node.type.value)}>`
              : ''

          return `SeedMap${args}()`
        }

        if (node.name === 'list' && node.fields.length === 0) {
          // a still-FREE element stays unspelled, so swift infers it from the expected type at the use site
          const args =
            node.type?.kind === 'array' &&
            node.type.element.kind !== 'variable'
              ? `<${swiftElement(node.type)}>`
              : ''

          return `SeedList${args}()`
        }

        // `make void` is the absent value: the unit tuple, recognized on an Any slot with `is Void`
        if (node.name === 'void' && node.fields.length === 0) {
          return '()'
        }

        // a variable put into a field the record owns (`fieldLists`, a plain array): as it is when it is a plain array
        // itself (an owned local or a lent parameter, `plainNames`), else the array inside its `SeedList`. An async
        // function owns no locals (`ownedLocals` is skipped for one), so `host none, make list` there is a `SeedList`,
        // and was passed whole: "cannot convert value of type 'SeedList<Int>'" (deck/test/code/smt-query.tree's
        // `check-sat`, 2026-10-05, test/compile/swift-owned-field.ts)
        const plainOrData = (value: Expression): string =>
          value.form === 'variable' && !plainNames.has(value.name) ? `${expr(value, bind)}.data` : expr(value, bind)

        // leading-dot construction: Swift infers the enum/struct type from context
        if (variantSet.has(node.name)) {
          // a list the variant owns (`fieldLists`) is the plain array, as a struct's is: an owned local as it is, a
          // fresh task's answer taken as it is, an empty list `[]`
          const owned = (value: Expression): string => {
            if (value.form === 'call') {
              rawFresh = true
              const made = expr(value, bind)
              rawFresh = false

              return made
            }

            return value.form === 'variable' ? plainOrData(value) : '[]'
          }
          const labelled = node.fields.map(
            f => `${camel(f.name)}: ${fieldLists.has(`${node.name}/${f.name}`) ? owned(f.value) : expr(f.value, bind)}`,
          )

          // a case held by node class (`nodeClasses`) builds its node: in the spare a match kept, in a task that keeps
          // one, and new otherwise
          const held = nodeCase.get(node.name)

          if (held && node.type?.kind === 'named' && node.type.name === held.form) {
            const made = spares.has(held.form)
              ? `termNode${held.name}(&${spareName(held.form)}, ${labelled.join(', ')})`
              : `${held.name}(${labelled.join(', ')})`

            return `.${camel(node.name)}(${made})`
          }

          // a type argument nothing constrains (the error type of `make okay` handed straight to a generic task)
          // leaves Swift nothing to infer from: it is any type, so it is named `Never`, the others left as `_`
          const args = node.type?.kind === 'named' ? (node.type.args ?? []) : []
          const free = (a: Type): boolean => a.kind === 'variable' && !varNames.has(a.id)
          const owner = args.some(free)
            ? `${swiftType(node.type!).replace(/<.*$/, '')}<${args.map(a => (free(a) ? 'Never' : '_')).join(', ')}>`
            : ''

          return labelled.length > 0
            ? `${owner}.${camel(node.name)}(${labelled.join(', ')})`
            : `${owner}.${camel(node.name)}`
        }

        // a struct: name the type and pass the fields, in declared order (the memberwise init), a field the
        // construction leaves out taking its type's empty value
        const declared = recordFields.get(node.name)

        // an empty collection field value spells the DECLARED element type, since the checker's gradual
        // unify leaves it free and the zonked default (Int) would not fit an Any-elemented field
        const fieldValue = (name: string, value: Expression): string => {
          // only for a non-generic form: a generic form's declared element is its own type parameter
          if ((genericArity.get(node.name) ?? 0) > 0) {
            return expr(value, bind)
          }

          const declaredType = declared?.find(f => f.name === name)?.type

          // a list the record owns (`fieldLists`) is the plain array: an owned local as it is, a fresh task's answer
          // taken as it is, an empty list `[]`
          if (fieldLists.has(`${node.name}/${name}`)) {
            if (value.form === 'call') {
              rawFresh = true
              const made = expr(value, bind)
              rawFresh = false

              return made
            }

            return value.form === 'variable' ? plainOrData(value) : '[]'
          }

          if (
            ((value.form === 'record' &&
              value.fields.length === 0 &&
              value.name === 'list') ||
              (value.form === 'array' && value.items.length === 0)) &&
            declaredType?.kind === 'array'
          ) {
            return `SeedList<${swiftElement(declaredType)}>([])`
          }

          if (
            ((value.form === 'record' &&
              value.fields.length === 0 &&
              value.name === 'hash') ||
              (value.form === 'map' && value.entries.length === 0)) &&
            declaredType?.kind === 'map'
          ) {
            return `SeedMap<${swiftType(declaredType.key)}, ${swiftType(declaredType.value)}>()`
          }

          return expr(value, bind)
        }

        if (declared) {
          const given = new Map(node.fields.map(f => [f.name, f.value]))

          return `${pascal(node.name)}(${declared
            // a list the record owns (`fieldLists`) left out is a new plain array, where its empty value was a `SeedList`
            .map(f => `${camel(f.name)}: ${given.has(f.name) ? fieldValue(f.name, given.get(f.name)!) : fieldLists.has(`${node.name}/${f.name}`) ? '[]' : emptyOf(f.type)}`)
            .join(', ')})`
        }

        return `${pascal(node.name)}(${node.fields
          .map(f => `${camel(f.name)}: ${expr(f.value, bind)}`)
          .join(', ')})`
      }

      case 'member': {
        // a field of a slot local is read off its slot (`valuePlaces`)
        const slot = node.target.form === 'variable' && !node.index ? slotNames.get(node.target.name) : undefined

        if (slot) {
          return `${view(slot.list, bind)}[${expr(slot.index, bind)}].${camel(node.name)}`
        }

        // a DYNAMIC segment (`read table/{key}`) subscripts the wrapper's storage
        if (node.index) {
          return `${view(node.target, bind)}[${expr(node.index, bind)}]`
        }

        // `map.size` / `array.length` read the count (a map goes through its wrapper's `data`; an array is plain)
        const read = collectionRead(node)

        if (read) {
          // both a map and an array (SeedMap / SeedList) read their length through the wrapper's `.data`
          return `${view(read.target, bind)}.count`
        }

        const textLength = stringRead(node)

        if (textLength) {
          return need('text', `TermText.length(${expr(textLength.target, bind)})`)
        }

        // a LITERAL index segment (`read parts/0`) on an array target subscripts the SeedList's storage
        if (/^\d+$/.test(node.name) && node.target.type?.kind === 'array') {
          return `${view(node.target, bind)}[${node.name}]`
        }

        // a matched variant's field reads the bound local; otherwise a normal field access
        if (
          node.target.form === 'variable' &&
          bind.get(node.target.name)?.has(node.name)
        ) {
          return camel(node.name)
        }

        return `${expr(node.target, bind)}.${camel(node.name)}`
      }

      case 'await':
      {
        awaiting = true
        const operand = expr(node.expr, bind)
        awaiting = false

        return `await ${operand}`
      }

      case 'closure': {
        // a function literal as a Swift closure. The trailing `send back X` becomes the closure's value
        // expression when it stands alone; with statements before it the implicit-return rule no longer
        // applies, so the `return` stays explicit.
        // A Term task type is a NON-throwing Swift function type, so a raise in a closure's body is `try!` (it ends
        // the program, as a raise nothing handles does) even when the function around the closure is `throws`; a
        // guard inside the closure still makes its own body `try` (native-dom-0014: `make-effect`'s body)
        const outerThrows = currentThrows
        const outerGuard = guardDepth
        const outerBound = boundNames
        // a closure keeps no spare of the task's: `spareTasks` counted nothing inside one
        const outerSpares = spares
        spares = new Set()
        currentThrows = false
        guardDepth = 0
        boundNames = new Set([...outerBound, ...node.params.map(p => p.name)])
        const last = node.body[node.body.length - 1]
        const lead = node.body
          .slice(0, -1)
          .map(s => stmt(s, 0, bind))
          .filter(Boolean)

        const tail =
          last?.form === 'return' && last.value
            ? lead.length > 0
              ? `return ${expr(last.value, bind)}`
              : expr(last.value, bind)
            : last
              ? stmt(last, 0, bind)
              : ''

        spares = outerSpares
        currentThrows = outerThrows
        guardDepth = outerGuard
        boundNames = outerBound

        // an async closure carries an explicit `(params) async -> Ret in` signature: Swift closures express async in
        // the signature (there is no async-block form), and the explicit types let `let f = { ... }` infer the async
        // function type without a separate annotation. The call site `await`s the result.
        // A sync closure with a DECLARED result gets an explicit `-> Ret` too: a leading-dot value
        // (`.some(value: x)`) in its body has no context to resolve against otherwise. Its params stay
        // BARE names: a param the source never annotated has no recorded type (it would print `Void`),
        // and Swift infers bare params from the expected function type.
        const signature = node.async
          ? `(${node.params
              .map(p => `${camel(p.name)}: ${swiftType(p.type)}`)
              .join(', ')}) async -> ${swiftType(node.result)} in `
          : node.result
            ? `(${node.params
                .map(p => camel(p.name))
                .join(', ')}) -> ${swiftType(node.result)} in `
            : `(${node.params.map(p => camel(p.name)).join(', ')}) in `

        return `{ ${signature}${[...lead, tail]
          .filter(Boolean)
          .join('; ')} }`
      }

      case 'conditional': {
        // a value-position conditional lowers to a ternary chain
        const tail = node.otherwise ? expr(node.otherwise, bind) : '()'

        return node.branches.reduceRight(
          (rest, branch) =>
            `(${expr(branch.cond, bind)} ? ${expr(
              branch.value,
              bind,
            )} : ${rest})`,
          tail,
        )
      }

      default:
        return exhausted(node)
    }
  }

  // lower a native map / list operation to swift. A map goes through the SeedMap wrapper (`.data` is its Dictionary,
  // `.setting` / `.removing` mutate and return). The return shapes match the JS collection API the stdlib forms expect.
  const collectionExpr = (
    op: CollectionOp,
    args: Expression[],
    bind: Bindings,
  ): string => {
    const target = expr(op.target, bind)
    const arg = args.map(a => expr(a, bind))

    if (op.kind === 'map') {
      switch (op.op) {
        case 'has':
          return `(${target}.data[${arg[0]}] != nil)`
        case 'get':
          return `${target}.data[${arg[0]}]!`
        case 'set':
          return `${target}.setting(${arg[0]}, ${arg[1]})`
        case 'delete':
          return `${target}.removing(${arg[0]})`
        case 'keys':
          return `SeedList(Array(${target}.data.keys))`
        case 'values':
          return `SeedList(Array(${target}.data.values))`
        default:
          return ''
      }
    }

    // arrays go through the SeedList wrapper (`.data` is its Array, `.appending` / `.popping` mutate). An op returning a
    // list wraps a new SeedList; `String(describing:)` renders any element for `join` with no bound. A lent list or an
    // owned local is the plain array already, so a read goes to it directly (the lend analysis refuses every op that
    // would change the length of one)
    const data = view(op.target, bind)

    switch (op.op) {
      case 'push':
        // an owned local is the array itself (ownedLocals): appended in place, answering the new count
        if (op.target.form === 'variable' && ownedNames.has(op.target.name)) {
          return `({ () -> Int in ${target}.append(${arg[0]}); return ${target}.count })()`
        }

        return `${target}.appending(${arg[0]})`
      case 'pop':
        return `${target}.popping()`
      case 'at':
      case 'get':
        return `${data}[${arg[0]}]`
      case 'set':
        // a method call, so two in a row cannot parse as a trailing closure (it was a closure called in place, which
        // could not carry the `try` or `await` a value read through a throwing or async call needs)
        return `${target}.storing(${arg[0]}, ${arg[1]})`
      case 'includes':
        return `${data}.contains(${arg[0]})`
      case 'indexOf':
        return `Int(${data}.firstIndex(of: ${arg[0]}) ?? -1)`
      case 'lastIndexOf':
        return `Int(${data}.lastIndex(of: ${arg[0]}) ?? -1)`
      case 'concat':
        return `SeedList(${data} + ${arg[0]}.data)`
      case 'slice':
        // both bounds clamped to the length, empty when start reaches end, never counted from the end
        // (note/term/stdlib/semantics.md)
        return `${target}.slicing(${arg[0]}${arg[1] !== undefined ? `, ${arg[1]}` : ''})`
      case 'toReversed':
        return `SeedList(${data}.reversed())`
      case 'join':
        // each item as `to-text` renders it, so a float reads as on every backend
        return op.target.type?.kind === 'array' && op.target.type.element.kind === 'float'
          ? need('number', `${data}.map { termNumber($0) }.joined(separator: ${arg[0]})`)
          : `${data}.map { String(describing: $0) }.joined(separator: ${arg[0]})`
      case 'map':
        return `SeedList(${data}.map(${arg[0]}))`
      case 'filter':
        return `SeedList(${data}.filter(${arg[0]}))`
      case 'some':
        return `${data}.contains(where: ${arg[0]})`
      case 'every':
        return `${data}.allSatisfy(${arg[0]})`
      case 'reduce':
        return `${data}.reduce(${arg[1]}, ${arg[0]})`
      case 'findIndex':
        return `Int(${data}.firstIndex(where: ${arg[0]}) ?? -1)`
      case 'flat':
        // one level of nesting removed when the items are lists; a copy otherwise (JS `[1,2,3].flat()` is `[1,2,3]`)
        return op.target.type?.kind === 'array' && op.target.type.element.kind === 'array'
          ? `SeedList(${data}.flatMap { $0.data })`
          : `SeedList(${data})`
      case 'unshift':
        return `${target}.unshifting(${arg[0]})`
      case 'shift':
        return `${target}.shifting()`
      case 'splice':
        return `${target}.splicing(${arg[0]}, ${arg[1]}, [${arg.slice(2).join(', ')}])`
      default:
        return ''
    }
  }

  // The text operations (see backend.ts, STRING_METHODS) mean what note/term/stdlib/semantics.md says, which counts
  // code points. Swift's String counts grapheme clusters and matches by canonical equivalence (`"é" == "e\u{301}"`),
  // so each goes through `TermText` in the prelude, over unicodeScalars, rather than the String method.
  const stringExpr = (op: string, t: string, a: string[]): string => {
    // `repeat` is a Swift keyword, so the helper spells it `repeated`
    const name = op === 'at' ? 'charAt' : op === 'repeat' ? 'repeated' : op
    const call = need('text', `TermText.${name}(${[t, ...a].join(', ')})`)

    return name === 'split' ? `SeedList(${call})` : call
  }

  const block = (
    body: Statement[],
    d: number,
    bind: Bindings,
  ): string => {
    // the three-statement swap (backend.ts, swapAt) is `swapAt` on a PLAIN array, a lent parameter or an owned local
    // (`plainNames`): one uniqueness check where two element writes through an `inout` array paid two (AWFY's
    // Permute, 328 ms to 191, the hand version 215, tmp/swift-permute-ab.ts). Never through a SeedList: there
    // `perm.data.swapAt(low, high)` measured a median 1,329 ms against 865 for the three statements on
    // fannkuch-redux, 7 alternating rounds (tmp/swift-swap-ab.ts, 2026-10-02)
    const lines: string[] = []

    for (let at = 0; at < body.length; at++) {
      const swap = swapAt(body, at)

      if (swap && swap.list.form === 'variable' && plainNames.has(swap.list.name)) {
        lines.push(`${pad(d)}${vname(swap.list.name)}.swapAt(${expr(swap.first, bind)}, ${expr(swap.second, bind)})`)
        at += 2
        continue
      }

      const line = stmt(body[at]!, d, bind)

      if (line) {
        lines.push(`${pad(d)}${line}`)
      }

      const reserve = reserveAt(body, at)

      if (reserve) {
        lines.push(`${pad(d)}${vname(reserve.list)}.reserveCapacity(${reserve.room})`)
      }
    }

    return lines.join('\n')
  }

  // An owned list local (a plain array, `ownedNames`) made empty and then filled by a counted loop later in the same
  // block, `while i < n` with `i` from a literal and k pushes onto it among the loop's own statements, is given room for
  // k * (n - base) first, as Kotlin's `reserveAt` does: Storage's kids, four a node, 1225 ms to 924 measured by hand
  // against the hand version's 1221 (`tmp/swift-storage-ab.ts`). A capacity is a hint nothing reads, so the estimate
  // need only be safe to compute where the list is made: `n` a literal, or a name no statement between the list and the
  // loop declares, clamped to [0, 2^20] since the loop may stop early
  const reserveAt = (body: Statement[], at: number): { list: string; room: string } | undefined => {
    const made = body[at]

    if (made?.form !== 'let' || made.type?.kind !== 'array' || !ownedNames.get(made.name)) {
      return undefined
    }

    const empty =
      (made.init.form === 'array' && made.init.items.length === 0) || (made.init.form === 'record' && made.init.name === 'list' && made.init.fields.length === 0)
    const loopAt = body.findIndex((s, i) => i > at && s.form === 'while')
    const loop = body[loopAt]

    if (!empty || loop?.form !== 'while' || loop.cond.form !== 'binary' || loop.cond.op !== '<' || loop.cond.left.form !== 'variable') {
      return undefined
    }

    const counter = loop.cond.left.name
    const between = body.slice(at + 1, loopAt)
    const start = between.find((s): s is Extract<Statement, { form: 'let' }> => s.form === 'let' && s.name === counter)
    const bound = loop.cond.right
    const pushes = loop.body.filter(
      s =>
        s.form === 'expression' &&
        s.expr.form === 'call' &&
        s.expr.callee.form === 'variable' &&
        s.expr.callee.name === 'list_push' &&
        s.expr.args[0]?.form === 'variable' &&
        s.expr.args[0].name === made.name,
    ).length
    const declaredBetween = (name: string): boolean => between.some(s => s.form === 'let' && s.name === name)

    if (!start || start.init.form !== 'integer' || pushes === 0 || !(bound.form === 'integer' || (bound.form === 'variable' && !declaredBetween(bound.name)))) {
      return undefined
    }

    const base = Number(start.init.value)
    const room =
      bound.form === 'integer'
        ? `${Math.min(Math.max(Number(bound.value) - base, 0), 1 << 20) * pushes}`
        : `min(max(${vname(bound.name)}${base === 0 ? '' : ` - ${base}`}, 0), ${1 << 20})${pushes === 1 ? '' : ` * ${pushes}`}`

    return { list: made.name, room }
  }

  // a `switch` case with no statement in its body (Term's `fork case, ... / case none` with nothing under it, a
  // real and common shape: `maybe`'s `none` arm, an ignored variant) is a Swift compile error --
  // "'case' label in a 'switch' must have at least one executable statement" -- unlike `if`/`while`, which accept
  // an empty `{ }` block fine. `block` alone can't tell an arm from an ordinary block, so every match-arm body
  // goes through this instead, which falls back to an explicit `break` only when the arm itself is empty.
  const armBlock = (body: Statement[], d: number, bind: Bindings): string =>
    block(body, d, bind) || `${pad(d)}break`

  const stmt = (node: Statement, d: number, bind: Bindings): string => {
    switch (node.form) {
      case 'let': {
        boundNames.add(node.name)

        // an inner list read out of a list of lists that owns it (`ownedElements`) is a plain array, read as one
        if (ownsInner(elementLists.lets, node)) {
          plainNames.set(node.name, 'read')
        }

        // a second declaration of a name the same statement list declared already is an assignment to it (backend.ts,
        // `redeclaredLets`): two counted walks over `i` in one task
        if (redeclared.has(node)) {
          return `${vname(node.name)} = ${expr(node.init, bind)}`
        }

        // a bare `save x`, given its value by a later assignment: declared with its type and no value, which Swift's
        // definite initialization takes when every path assigns before a read. It was `var x = ()` (2026-10-05)
        if (declaredLater(node)) {
          return `var ${vname(node.name)}: ${swiftType(node.type)}`
        }

        // a record read from a slot and only ever read through it after (compile/place.ts, `valuePlaces`): no copy is
        // made, and each field is read off the slot itself
        const slot = slotLocals.get(node)

        if (slot) {
          slotNames.set(node.name, slot)

          return ''
        }

        // an owned list local is a plain array (F1): made empty, or taken as it is from a fresh task
        if (ownedNames.has(node.name) && node.type?.kind === 'array') {
          const keyword = ownedNames.get(node.name) ? 'var' : 'let'

          if (node.init.form === 'call') {
            rawFresh = true
            const made = expr(node.init, bind)
            rawFresh = false

            return `${keyword} ${vname(node.name)} = ${made}`
          }

          return `${keyword} ${vname(node.name)}: [${swiftElement(node.type)}] = []`
        }

        // a valueless typed module slot (`host current, like context`, filled later by a `save`): an
        // implicitly-unwrapped optional, so reads carry the declared class type
        if (node.init.form === 'unit' && node.type?.kind === 'named' && node.type.name) {
          return `var ${vname(node.name)}: ${swiftType(node.type)}!`
        }

        // the gradual boundary on a binding: a boxed dynamic re-typed at a declared FORM casts
        if (
          node.type?.kind === 'named' &&
          node.init.form === 'member' &&
          recordFields.has(node.type.name) &&
          (node.init.type?.kind === 'unknown' ||
            node.init.type?.kind === 'dynamic')
        ) {
          return `${(node.mutable && currentAssigned === undefined) || assignedHere(node.name) ? 'var' : 'let'} ${vname(node.name)} = ${expr(node.init, bind)} as! ${swiftType(node.type)}`
        }

        // annotate an ADT binding so leading-dot construction has a type to infer from. An anonymous record's
        // type is `named ''` (a nested `host` constant) and cannot be spelled: no annotation, Swift infers.
        // A call (or awaited call) carries its own type, so no annotation there either: inside a nested
        // closure the checker can lose an enclosing generic and record a defaulted argument (`Maybe<Int>`
        // for `Maybe<T>`), and the call's native type is the correct one.
        const initCall =
          node.init.form === 'call' ? node.init : node.init.form === 'await' && node.init.expr.form === 'call' ? node.init.expr : undefined
        const carriesOwnType = initCall !== undefined
        // except a call with NO arguments to a generic task (`make-channel`): nothing at the call says what `T` is, so
        // the binding says it, when the checker knows it concretely
        // A type argument nothing ever constrains (a deque made and only asked whether it is empty) is any type, so it
        // is written `Never`, which every constraint a form puts on its argument accepts
        const uninferable =
          initCall !== undefined &&
          (initCall.args.length === 0 ||
            (initCall.callee.form === 'variable' && hiddenGeneric.has(initCall.callee.name))) &&
          node.type?.kind === 'named' &&
          (node.type.args?.length ?? 0) > 0 &&
          !node.type.args!.some(
            a => (a.kind === 'variable' && varNames.has(a.id)) || a.kind === 'unknown' || (a.kind === 'named' && /^[a-z]$/.test(a.name)),
          )
        const spell = (type: Type): string => {
          const free = new Set<number>()
          collectVars(type, free)
          const saved = varNames
          varNames = new Map([...saved, ...[...free].filter(id => !saved.has(id)).map(id => [id, 'Never'] as const)])
          const text = swiftType(type)
          varNames = saved

          return text
        }
        const annotation =
          node.type?.kind === 'named' && node.type.name && (!carriesOwnType || uninferable)
            ? `: ${uninferable ? spell(node.type) : swiftType(node.type)}`
            : ''

        return `${(node.mutable && currentAssigned === undefined) || assignedHere(node.name) ? 'var' : 'let'} ${vname(
          node.name,
        )}${annotation} = ${expr(node.init, bind)}`
      }

      case 'assign': {
        // an append to a text variable is `s += ..`, which appends in place while the text is uniquely held, where
        // `s = "\(s)ab"` built a new text with a copy of the old one every time (backend.ts, `textAppend`)
        const append = textAppend(node)

        if (append) {
          // one character of an ASCII text is appended as the scalar, with no one-character String made for it
          const char = asciiCharAppend(append.rest, asciiNodes)

          if (char) {
            return need('text', `TermText.asciiAppend(&${expr(node.target, bind)}, ${expr(char.text, bind)}, ${expr(char.index, bind)})`)
          }

          return `${expr(node.target, bind)} += ${expr(append.rest, bind)}`
        }

        // a text variable reset to the empty text keeps its storage for the next build (a copy-on-write value, so a
        // copy another name holds is untouched)
        if (node.op === '=' && node.target.form === 'variable' && node.target.type?.kind === 'string' && emptyText(node.value)) {
          return `${expr(node.target, bind)}.removeAll(keepingCapacity: true)`
        }

        // a record written back to the slot it was read from: only its changed fields
        const place = placed.get(node)

        if (place && node.target.form === 'member') {
          const slot = `${view(node.target.target, bind)}[${node.target.index ? expr(node.target.index, bind) : node.target.name}]`

          if (!place.temps) {
            return place.fields.map(f => `${slot}.${camel(f.name)} = ${expr(f.value, bind)}`).join('; ')
          }

          const temps = place.fields.map((f, i) => `let __place${i} = ${expr(f.value, bind)}`)
          const sets = place.fields.map((f, i) => `${slot}.${camel(f.name)} = __place${i}`)

          return `do { ${[...temps, ...sets].join('; ')} }`
        }

        return node.op === '='
          ? `${expr(node.target, bind)} = ${expr(node.value, bind)}`
          : `${expr(node.target, bind)} ${node.op} ${expr(
              node.value,
              bind,
            )}`
      }
      case 'expression': {
        // a map entry updated from its own value is one probe through the ordered map's `update` (backend.ts,
        // `mapUpdate`). `+` traps on overflow, the Term meaning
        const update = mapUpdate(node)

        if (update && update.map.type?.kind === 'map' && (update.map.type.value.kind === 'number' || update.map.type.value.kind === 'float')) {
          return `${expr(update.map, bind)}.data.update(${expr(update.key, bind)}, ${expr(update.fallback, bind)}) { $0 + ${expr(update.step, bind)} }`
        }

        // a push onto an owned list whose new length nothing reads is the array's `append`
        if (
          node.expr.form === 'call' &&
          node.expr.callee.form === 'variable' &&
          node.expr.callee.name === 'list_push' &&
          node.expr.args[0]?.form === 'variable' &&
          ownedNames.has(node.expr.args[0].name)
        ) {
          return `${expr(node.expr.args[0], bind)}.append(${expr(node.expr.args[1]!, bind)})`
        }

        // the same through the collection operation `list_push` inlines to, `out.push(v)`
        if (node.expr.form === 'call' && node.expr.callee.form === 'member') {
          const op = collectionCall(node.expr.callee)

          if (op?.kind === 'array' && op.op === 'push' && op.target.form === 'variable' && ownedNames.has(op.target.name)) {
            return `${expr(op.target, bind)}.append(${expr(node.expr.args[0]!, bind)})`
          }
        }

        const rendered = expr(node.expr, bind)

        // a VALUED call in statement position discards explicitly, or swiftc warns (and the gates treat
        // warnings as failures)
        if (
          node.expr.form === 'call' &&
          node.expr.type &&
          node.expr.type.kind !== 'unit'
        ) {
          return `_ = ${rendered}`
        }

        return rendered
      }
      case 'return':
        if (!node.value) {
          return currentResult?.kind === 'unknown' ? 'return ()' : 'return'
        }

        // an owned list local leaves whole: the array itself from a fresh task, otherwise into a SeedList
        if (node.value.form === 'variable' && ownedNames.has(node.value.name)) {
          return emittingFresh ? `return ${expr(node.value, bind)}` : `return SeedList(${expr(node.value, bind)})`
        }

        // a list-returning function that returns a native dock call directly wraps the shim's plain Array
        if (fnReturnsArray && isNativeCall(node.value)) {
          return `return SeedList(${expr(node.value, bind)})`
        }

        // the gradual boundary: an unknown-typed value returned at a DECLARED FORM type casts explicitly. A generic
        // letter (`like t`) is a cast target only for a CALL that answers the unknown, which is a typed channel's
        // `receive` or a typed task's `wait` taking its value back out of the one untyped shim
        const valueKind =
          node.value.form === 'await' ? (node.value.type ?? node.value.expr.type)?.kind : node.value.type?.kind
        const unknownValue = valueKind === 'unknown' || valueKind === 'dynamic'
        const callValue = shimCall(node.value)
        const generic =
          currentResult?.kind === 'variable' ||
          (currentResult?.kind === 'named' &&
            /^[a-z]$/.test(currentResult.name) &&
            !currentResult.args?.length &&
            !recordFields.has(currentResult.name))
        const cast =
          node.value.form === 'member' &&
          unknownValue &&
          currentResult?.kind === 'named' &&
          currentResult.name &&
          recordFields.has(currentResult.name)
            ? ` as! ${swiftType(currentResult)}`
            : unknownValue && callValue && generic
              ? ` as! ${swiftType(currentResult!)}`
              : ''

        return `return ${expr(node.value, bind)}${cast}`
      case 'throw': {
        // a raise carries the record whole in a TermException; a text raises `failure`; a caught value passes on.
        // When the program has the stdlib hive, a NEW carrier tells it before unwinding (a pass-on does not re-tell).
        needs.add('exception')

        const tellPart = hasHiveTell
          ? '; hiveTell(HiveEntry(host: told.host, kind: "exception", name: told.form, site: "", base: told))'
          : ''

        // an interpolated text (a `template` node) is a text too, and raises `failure` like a plain one
        const isText = node.value.form === 'string' || node.value.form === 'template'

        // a text raise with nothing to tell is the carrier itself, with no closure around it
        if (isText && !hasHiveTell) {
          return `throw TermException(host: "", form: "failure", note: ${expr(node.value, bind)}, code: "", time: 0, link: nil, base: nil)`
        }

        return isText
          ? `throw ({ () -> TermException in let told = TermException(host: "", form: "failure", note: ${expr(node.value, bind)}, code: "", time: 0, link: nil, base: nil)${tellPart}; return told })()`
          : node.value.form === 'record' && exceptionForms.has(node.value.name)
            ? `throw try ({ () throws -> TermException in let raised = ${expr(node.value, bind)}; let told = TermException(host: raised.host, form: raised.form, note: raised.note, code: raised.code, time: raised.time, link: raised.link, base: raised)${tellPart}; return told })()`
            : `throw termException(${expr(node.value, bind)})`
      }
      case 'while': {
        // a counted loop calling a task whose arithmetic is safe below a bound (ir/facts/bounds.ts): written twice, the
        // guard true running a copy that calls the task's wrapping copy (`aValueFast`). Only the call limits are asked
        const guard = loopGuards.get(node)
        const loop = (depth: number): string => {
          const label = openLoop()
          const body = block(node.body, depth + 1, bind)
          loopLabels.pop()

          return `${label}: while ${expr(node.cond, bind)} {\n${body}\n${pad(depth)}}`
        }

        if (guard?.fast?.length && guard.limits?.length) {
          const test = guard.limits.map(l => (l.low ? `${vname(l.name)} >= 0` : `${vname(l.name)} <= ${l.high}`)).join(' && ')
          const outer = fastCalls
          fastCalls = new Set([...outer, ...guard.fast])
          const fast = loop(d + 1)
          fastCalls = outer

          return `if ${test} {\n${pad(d + 1)}${fast}\n${pad(d)}} else {\n${pad(d + 1)}${loop(d + 1)}\n${pad(d)}}`
        }

        return loop(d)
      }
      case 'guard': {
        // `note unsafe` / `halt take`: a do with its catch. Calls in the body are `try`, and the caught value is a
        // TermException: a raise passes through, a foreign error is wrapped as `failure`
        guardDepth++
        const body = block(node.body, d + 1, bind)
        guardDepth--

        if (node.catch) {
          needs.add('exception')
        }

        // the caught value is bound only where the handler reads it: an unread `let` is a warning
        const binding =
          node.catch && namesIn(node.catch.body).has(node.catch.name)
            ? `${pad(d + 1)}let ${camel(node.catch.name)} = termException(error)\n`
            : ''
        const handler = node.catch
          ? `catch {\n${binding}${block(
              node.catch.body,
              d + 1,
              bind,
            )}\n${pad(d)}}`
          : 'catch {}'

        return `do {\n${body}\n${pad(d)}} ${handler}`
      }

      case 'for-each': {
        boundNames.add(node.item)

        if (node.index) {
          boundNames.add(node.index)
        }

        // an inner list of a list of lists that owns it (`ownedElements`) is a plain array, read as one
        if (ownsInner(elementLists.walks, node)) {
          plainNames.set(node.item, 'read')
        }

        // a list is a SeedList; iterate its backing `.data` Array (or the plain array, F1)
        const iterable =
          node.iterable.type?.kind === 'array'
            ? view(node.iterable, bind)
            : expr(node.iterable, bind)

        // a walk by POSITION, the length read every turn, where the body may push onto the list it walks: the walk then
        // sees each pushed item, the Term meaning (TypeScript's `for...of`, Rust's walk by position), where `for x in`
        // walked a copy of the array taken at the start and missed them (meaning-native `grow`)
        if (node.iterable.type?.kind === 'array' && node.iterable.form === 'variable' && namesIn(node.body).has(node.iterable.name)) {
          const at = `__at${walkCount++}`
          const label = openLoop()
          const body = block(node.body, d + 1, bind)
          loopLabels.pop()
          const index = node.index ? ` let ${vname(node.index)} = ${at};` : ''

          return `var ${at} = 0\n${pad(d)}${label}: while ${at} < ${iterable}.count {\n${pad(d + 1)}let ${vname(node.item)} = ${iterable}[${at}];${index} ${at} += 1\n${body}\n${pad(d)}}`
        }

        // a walk that names its INDEX enumerates, lazily: the offset is an `Int`, which is what a Term number is here.
        // It mapped every pair into an array of `(Int64, T)` first, an allocation per walk and a second integer type.
        // lean-0017
        const label = openLoop()
        const body = block(node.body, d + 1, bind)
        loopLabels.pop()

        return node.index
          ? `${label}: for (${vname(node.index)}, ${vname(node.item)}) in ${iterable}.enumerated() {\n${body}\n${pad(d)}}`
          : `${label}: for ${vname(node.item)} in ${iterable} {\n${body}\n${pad(d)}}`
      }

      case 'match': {
        // a native `switch`: the compiler checks exhaustiveness, so no fallthrough-return is needed. Each variant's
        // fields bind to locals; field access on the subject inside the branch rewrites to those locals.
        const subject = expr(node.subject, bind)
        // a fork case over a caught TermException: switch on `form`, the record recovered from `base` by its form
        if (node.exceptionArms) {
          const arms = node.cases.map(b => {
            const arm = node.exceptionArms![b.label]!
            const bodyText = armBlock(b.body, d + 2, bind)
            // only the fields the arm READS, asked of the program and not of the emitted text: `time` matched inside
            // an inlined `time.now()`, bound the caught exception's `time` and shadowed the clock module
            const read = namesIn(b.body)
            const locals = armLocals([...arm.shared, ...arm.link], b.binds ?? [])
              .filter(({ local }) => read.has(local))
              .map(({ field, local }) =>
                arm.link.includes(field)
                  ? `${pad(d + 2)}let ${camel(local)} = (${subject}.base as! ${pascal(b.label)}).link.${camel(field)}`
                  : `${pad(d + 2)}let ${camel(local)} = ${subject}.${camel(field)}`,
              )

            return `${pad(d + 1)}case ${JSON.stringify(b.label)}:\n${[...locals, bodyText].join('\n')}`
          })
          // the checker holds the arms to the guarded body's raise set, so the default cannot be reached; it ends the
          // program with the form and note, which also tells Swift every path answers
          arms.push(`${pad(d + 1)}default:${node.otherwise ? `\n${block(node.otherwise, d + 2, bind)}` : `\n${pad(d + 2)}fatalError("\\(${subject}.form): \\(${subject}.note)")`}`)

          return `switch ${subject}.form {\n${arms.join('\n')}\n${pad(d)}}`
        }

        // a `fork case` over a TEXT subject (`fork case, read kind` with `case home` arms): the labels are
        // string values, matched by literal (a `default` keeps the switch exhaustive)
        if (node.subject.type?.kind === 'string') {
          const arms = node.cases.map(
            b =>
              `${pad(d + 1)}case ${JSON.stringify(b.label)}:\n${armBlock(
                b.body,
                d + 2,
                bind,
              )}`,
          )

          arms.push(
            `${pad(d + 1)}default:${
              node.otherwise
                ? `\n${block(node.otherwise, d + 2, bind)}`
                : '\n' + pad(d + 2) + 'break'
            }`,
          )

          return `switch ${subject} {\n${arms.join('\n')}\n${pad(d)}}`
        }

        const subjectVar =
          node.subject.form === 'variable'
            ? node.subject.name
            : undefined

        // a match whose labels are only true/false is a switch over a NATIVE Bool (booleans lower to `Bool` here,
        // not an enum), so the patterns are the literals `true` / `false`, not leading-dot cases.
        const labels = node.cases.map(branch => branch.label)
        const booleans =
          labels.length > 0 &&
          labels.every(label => label === 'true' || label === 'false')
        // whether this match keeps a node of `form` in the task's spare: its subject a local at its last read
        // (`consumedSubjects`), matched with `consume` so the case's binding is the only one the program has
        const keeps = (form: string): boolean => spares.has(form) && consumedSubjects.has(node.subject)
        const consumes = node.subject.type?.kind === 'named' && keeps(node.subject.type.name)

        const arms = node.cases.map(b => {
          if (booleans) {
            return `${pad(d + 1)}case ${b.label}:\n${armBlock(
              b.body,
              d + 2,
              bind,
            )}`
          }

          // the case of the subject's own form, where two forms name a case alike (engine/value port, 2026-10-04)
          const fields =
            (node.subject.type?.kind === 'named' ? caseFieldNames.get(`${node.subject.type.name}/${b.label}`) : undefined) ??
            variantFields.get(b.label) ??
            []
          const branchBind: Bindings = new Map(bind)

          if (subjectVar && fields.length > 0) {
            branchBind.set(subjectVar, new Set(fields))
          }

          // every field binds, positionally, under the local name the arm's `link` lines give it (see check/arm.ts)
          const locals = new Map(
            armLocals(fields, b.binds ?? []).map(({ field, local }) => [field, local]),
          )
          // a field the arm never reads binds as `_` (swiftc: "immutable value was never used"), and an arm that reads
          // none is the bare case. A field is read by its local name, or as `subject/field`, which resolves to it
          const named = namesIn(b.body)
          const throughSubject = new Set<string>()
          const collect = (value: unknown): void => {
            if (typeof value !== 'object' || value === null) {
              return
            }

            if (Array.isArray(value)) {
              value.forEach(collect)

              return
            }

            const n = value as { form?: string; name?: string; target?: { form?: string; name?: string } }

            if (n.form === 'member' && n.target?.form === 'variable' && n.target.name === subjectVar && typeof n.name === 'string') {
              throughSubject.add(n.name)
            }

            for (const [key, child] of Object.entries(n)) {
              if (key !== 'type' && key !== 'span') {
                collect(child)
              }
            }
          }

          if (subjectVar) {
            collect(b.body)
          }

          const read = (field: string): boolean => named.has(locals.get(field) ?? field) || throughSubject.has(field)

          // a case held by node class (`nodeClasses`) binds its node and reads the fields the arm reads off it. Where the
          // task keeps a spare and the subject is consumed, the node goes to the spare as the case's block ends, after
          // the arm has moved what it needs out of the slot it came from, if nothing else holds it then
          const held = nodeCase.get(b.label)

          if (held && node.subject.type?.kind === 'named' && node.subject.type.name === held.form) {
            const keep = keeps(held.form)
            const reads = fields.filter(read)
            const body = armBlock(b.body, d + 2, branchBind)

            if (!keep && reads.length === 0) {
              return `${pad(d + 1)}case .${camel(b.label)}:\n${body}`
            }

            const lines = [
              ...(keep ? [`${pad(d + 2)}defer { if isKnownUniquelyReferenced(&__node) { ${spareName(held.form)} = __node } }`] : []),
              ...reads.map(field => `${pad(d + 2)}let ${camel(locals.get(field) ?? field)} = __node.${camel(field)}`),
            ]

            return `${pad(d + 1)}case ${keep ? 'var' : 'let'} .${camel(b.label)}(__node):\n${[...lines, body].join('\n')}`
          }

          const pattern =
            fields.length > 0 && fields.some(read)
              ? `case let .${camel(b.label)}(${fields
                  .map(field => (read(field) ? camel(locals.get(field) ?? field) : '_'))
                  .join(', ')}):`
              : `case .${camel(b.label)}:`

          // a field the variant owns as a plain array (`fieldLists`) binds a plain array, which the arm only reads
          // (`ownedFields` held every arm to that): its local is read as one for the arm's body alone
          const outerPlain = plainNames
          const ownedLocals = fields.filter(field => read(field) && fieldLists.has(`${b.label}/${field}`)).map(field => locals.get(field) ?? field)

          if (ownedLocals.length > 0) {
            plainNames = new Map([...outerPlain, ...ownedLocals.map(local => [local, 'read'] as [string, Lend])])
          }

          const armText = armBlock(b.body, d + 2, branchBind)
          plainNames = outerPlain

          return `${pad(d + 1)}${pattern}\n${armText}`
        })

        if (node.otherwise) {
          arms.push(
            `${pad(d + 1)}default:\n${armBlock(
              node.otherwise,
              d + 2,
              bind,
            )}`,
          )
        } else if (booleans && node.cases.length < 2) {
          // a Bool switch with a single literal arm still has to be exhaustive
          arms.push(`${pad(d + 1)}default:\n${pad(d + 2)}break`)
        }

        return `switch ${consumes ? 'consume ' : ''}${subject} {\n${arms.join('\n')}\n${pad(d)}}`
      }

      case 'if': {
        let out = ''
        node.branches.forEach((b, i) => {
          out += `${i ? ' else ' : ''}if ${expr(
            b.cond,
            bind,
          )} {\n${block(b.body, d + 1, bind)}\n${pad(d)}}`
        })

        if (node.otherwise) {
          out += ` else {\n${block(node.otherwise, d + 1, bind)}\n${pad(
            d,
          )}}`
        }

        return out
      }

      // labelled, because a bare `break` inside a `switch` arm leaves the switch and not the loop, so a walk that
      // stopped on `none` went round forever
      case 'break':
        return loopLabels.length > 0 ? `break ${loopLabels[loopLabels.length - 1]}` : 'break'
      case 'continue':
        return loopLabels.length > 0 ? `continue ${loopLabels[loopLabels.length - 1]}` : 'continue'
      case 'exit':
        return 'exit(0)'
      case 'debug':
        return '// breakpoint'

      case 'function': {
        const generics = genericClause(node) // sets varNames for the param/result/body emission that follows
        // a function-typed parameter is `@escaping` when the task may keep it past the call: stored, returned, passed
        // on, captured by a closure, or copied into a variable (escapingParams). One the task only calls is left
        // non-escaping, so Swift can keep the closure's context on the stack and inline the call. Every one was
        // `@escaping` until 2026-10-02 (note/term/codegen/ios.md, S3)
        const escaping = escapingParams(node)
        // F1: a list parameter taken lent is a plain array, `inout` where the task writes it
        const lend = lendParams.get(node.name)
        const params = node.params
          .map((p, i) => {
            const how = lend?.get(i)

            if (how && p.type?.kind === 'array') {
              return `_ ${vname(p.name)}: ${how === 'write' ? 'inout ' : ''}[${swiftElement(p.type)}]`
            }

            return `_ ${vname(p.name)}: ${p.type?.kind === 'function' && escaping.has(p.name) ? '@escaping ' : ''}${swiftType(p.type)}`
          })
          .join(', ')
        const previousPlain = plainNames
        const previousOwned = ownedNames
        const previousFresh = emittingFresh
        const previousSlots = slotNames
        const previousCursors = cursors
        const previousRedeclared = redeclared
        slotNames = new Map()
        cursors = textCursors(node, asciiNodes)
        redeclared = redeclaredLets(node)
        ownedNames = node.async ? new Map() : ownedLocals(node, freshLists, lendParams, fieldLists, elementLists.moves)
        emittingFresh = freshLists.has(node.name)
        plainNames = new Map([
          ...node.params.flatMap((p, i) => (lend?.has(i) ? [[p.name, lend.get(i)!] as const] : [])),
          ...[...ownedNames.keys()].map(name => [name, 'write'] as const),
        ])

        const asyncMark = node.async ? ' async' : ''
        const throwsMark = throwingFns.has(node.name) || bodyThrows(node.body) ? ' throws' : ''
        currentThrows = throwsMark !== ''
        boundNames = new Set(node.params.map(p => p.name))
        // a reassigned parameter is shadowed by a mutable local (Swift parameters are immutable)
        const mutated = new Set<string>()
        reassigned(node.body, mutated)

        const shadows = node.params
          .filter(p => mutated.has(p.name))
          .map(
            p => `${pad(d + 1)}var ${vname(p.name)} = ${vname(p.name)}`,
          )

        const previousReturnsArray = fnReturnsArray
        fnReturnsArray = node.result?.kind === 'array'

        // a task with no declared result but a valued `send back` (a dock forward) is Any, not Void
        const result =
          node.result && node.result.kind !== 'unit'
            ? node.result
            : hasValuedReturn(node.body)
              ? ({ kind: 'unknown' } as Type)
              : node.result

        currentResult = result

        // a valued task whose body ends in branching that returns from every live path: swift cannot always
        // see the coverage (an if chain with no else), so the fall-through traps
        const last = node.body[node.body.length - 1]
        // not when every path of the last statement already returns or throws: an exhaustive `switch` whose every arm
        // returns, or an `if` with an `else` whose every branch does. swiftc sees those and warned "will never be
        // executed" on the trap
        const terminates = (body: Statement[] | undefined): boolean => {
          const end = body?.[body.length - 1]

          if (!end) return false
          if (end.form === 'return' || end.form === 'throw') return true
          if (end.form === 'if') return end.otherwise !== undefined && end.branches.every(b => terminates(b.body)) && terminates(end.otherwise)
          if (end.form === 'match') return end.cases.every(c => terminates(c.body)) && (end.otherwise === undefined || terminates(end.otherwise))

          return false
        }
        const unreachable =
          (last?.form === 'if' ||
            last?.form === 'while' ||
            last?.form === 'match') &&
          node.result &&
          node.result.kind !== 'unit' &&
          !terminates(node.body)
            ? `${pad(d + 1)}fatalError("unreachable")`
            : ''

        // a local is a `var` only when THIS function reassigns it: the program-wide set made every `count` a `var`
        // because some other task reassigns a `count` of its own, and swiftc warns on each (warnings fail the gates)
        const previousAssigned = currentAssigned
        currentAssigned = mutated
        // the nodes this task keeps for reuse (`spareTasks`), each an empty spare until a match opens one
        const previousSpares = spares
        spares = spareTasks.get(node.name) ?? new Set()

        // a signature-only stub compiles: its body is the not-implemented trap
        const bodyText =
          node.body.length === 0
            ? `${pad(d + 1)}fatalError(${JSON.stringify(`stub: ${node.name}`)})`
            : [
                ...shadows,
                ...cursors.names.map(name => `${pad(d + 1)}var __cursor${camelize(`-${name}`)} = (0, 0)`),
                ...[...spares].map(form => `${pad(d + 1)}var ${spareName(form)}: ${nodeClasses.get(form)!.name}? = nil`),
                block(node.body, d + 1, new Map()),
                unreachable,
              ]
                .filter(Boolean)
                .join('\n')

        spares = previousSpares
        currentAssigned = previousAssigned
        fnReturnsArray = previousReturnsArray
        plainNames = previousPlain
        ownedNames = previousOwned
        slotNames = previousSlots
        cursors = previousCursors
        redeclared = previousRedeclared
        const fresh = emittingFresh
        emittingFresh = previousFresh

        // a task answering a fresh list answers the plain array
        const resultType = fresh && result?.kind === 'array' ? `[${swiftElement(result)}]` : swiftType(result)

        return `func ${camel(
          node.name,
        )}${generics}(${params})${asyncMark}${throwsMark} -> ${resultType} {\n${bodyText}\n${pad(d)}}`
      }

      case 'record-type': {
        // an ALIAS form (a base and nothing of its own) is its base: `typealias`, never an empty struct
        if (node.alias && node.fields.length === 0 && node.variants.length === 0) {
          return `typealias ${pascal(node.name)} = ${swiftType(node.alias)}`
        }

        // a generic that flows into a map key inside the fields must be `Hashable` (the SeedMap wrapper requires it)
        const keys = formKeyIndices.get(node.name)
        const generics = node.params.length
          ? `<${node.params
              .map((p, i) =>
                keys?.has(i)
                  ? `${p.toUpperCase()}: Hashable`
                  : p.toUpperCase(),
              )
              .join(', ')}>`
          : ''

        if (node.variants.length > 0) {
          // a native enum: each variant a case, its fields the associated values
          const cases = node.variants.map(v => {
            // a list the variant owns is a plain array (`fieldLists`)
            const fields = v.fields.map(
              f => `${camel(f.name)}: ${fieldLists.has(`${v.name}/${f.name}`) && f.type.kind === 'array' ? `[${swiftElement(f.type)}]` : swiftType(f.type)}`,
            )

            return `${pad(d + 1)}case ${camel(v.name)}${
              fields.length > 0 ? `(${fields.join(', ')})` : ''
            }`
          })

          // `indirect` lets a variant hold its own enum (a linked list's `next`). It boxes every value of the enum on
          // the heap, so it goes only on an enum that can contain itself (recursiveEnums). It was on every enum until
          // 2026-10-02, and a `maybe` or a field-less tag paid an allocation per value
          declaredForms.add(node.name)

          // a form held by node class (`nodeClasses`): its payload case holds the class, which holds the form, so the
          // enum itself needs no `indirect`. The class is final, its fields `var` only so a spare node can be built
          // again, and `termNode` builds in the spare when there is one
          const held = nodeClasses.get(node.name)

          if (held) {
            const own = cases.map(c => (c.trimStart().startsWith(`case ${camel(held.label)}(`) ? `${pad(d + 1)}case ${camel(held.label)}(${held.name})` : c))
            const fields = held.fields.map(f => `${pad(d + 1)}var ${camel(f.name)}: ${swiftType(f.type)}`)
            const params = held.fields.map(f => `${camel(f.name)}: ${swiftType(f.type)}`).join(', ')
            const assigns = held.fields.map(f => `self.${camel(f.name)} = ${camel(f.name)}`).join('; ')
            const builds = held.fields.map(f => `${pad(d + 1)}node.${camel(f.name)} = ${camel(f.name)}`)

            return [
              `enum ${pascal(node.name)} {\n${own.join('\n')}\n${pad(d)}}`,
              `final class ${held.name} {\n${fields.join('\n')}\n${pad(d + 1)}init(${params}) { ${assigns} }\n${pad(d)}}`,
              `// a node built in the one a match kept (\`spare\`), which nothing else holds, or a new one\n${pad(d)}@inline(__always) func termNode${held.name}(_ spare: inout ${held.name}?, ${params}) -> ${held.name} {\n${pad(d + 1)}guard let node = spare else { return ${held.name}(${held.fields.map(f => `${camel(f.name)}: ${camel(f.name)}`).join(', ')}) }\n${pad(d + 1)}spare = nil\n${builds.join('\n')}\n${pad(d + 1)}return node\n${pad(d)}}`,
            ].join(`\n\n${pad(d)}`)
          }

          return `${recursive.has(node.name) ? 'indirect ' : ''}enum ${pascal(node.name)}${generics} {\n${cases.join(
            '\n',
          )}\n${pad(d)}}`
        }

        // a list the record owns is a plain array (`fieldLists`)
        const fields = node.fields.map(
          f =>
            `${pad(d + 1)}var ${camel(f.name)}: ${
              fieldLists.has(`${node.name}/${f.name}`) && f.type.kind === 'array' ? `[${swiftElement(f.type)}]` : swiftType(f.type)
            }`,
        )

        // `note shared`: a reference type, so a write through one binding is seen through every other. A class gets
        // no memberwise init, so one is written with the same labels in the same order, and every construction site
        // stays exactly what it is for a struct.
        if (node.shared) {
          // a closure stored in a field outlives the init, which Swift requires a parameter to say
          const params = node.fields.map(
            f =>
              `${camel(f.name)}: ${f.type.kind === 'function' ? '@escaping ' : ''}${swiftType(f.type)}`,
          )
          const assigns = node.fields.map(
            f => `${pad(d + 2)}self.${camel(f.name)} = ${camel(f.name)}`,
          )

          return `final class ${pascal(node.name)}${generics}${exceptionForms.has(node.name) ? ': Error' : ''} {\n${fields.join(
            '\n',
          )}\n${pad(d + 1)}init(${params.join(', ')}) {\n${assigns.join('\n')}\n${pad(d + 1)}}\n${pad(d)}}`
        }

        declaredForms.add(node.name)

        return `struct ${pascal(node.name)}${generics}${exceptionForms.has(node.name) ? ': Error' : ''} {\n${fields.join(
          '\n',
        )}\n${pad(d)}}`
      }

      case 'mask': {
        // a protocol whose method requirements are derived from any implementing instance's signature
        const target = instanceTargets.get(node.name)?.[0]
        const methods = target
          ? node.methods
              .map(
                m =>
                  `${pad(d + 1)}${protocolMethod(
                    implFn.get(`${target}:${m}`),
                    target,
                  )}`,
              )
              .filter(line => line.trim())
          : []

        return `protocol ${pascal(node.name)} {${
          methods.length ? `\n${methods.join('\n')}\n${pad(d)}` : ''
        }}`
      }

      case 'instance': {
        // a conformance extension whose methods delegate to the free implementation functions
        const methods = node.methods
          .map(m =>
            extensionMethod(
              implFn.get(`${node.target}:${m}`),
              node.target,
            ),
          )
          .filter(Boolean)
          .map(line => `${pad(d + 1)}${line}`)

        return `extension ${pascal(node.target)}: ${pascal(node.mask)} {${
          methods.length ? `\n${methods.join('\n')}\n${pad(d)}` : ''
        }}`
      }

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

  // a `<global:X>` binding (e.g. the linked `io` runtime namespace) needs no import: it is already in scope. A `type`
  // dock is an inline type reference, not an importable module.
  const imports = program
    .filter(
      (n): n is Extract<Statement, { form: 'native' }> =>
        n.form === 'native' &&
        n.kind !== 'type' &&
        !n.module.startsWith('global:'),
    )
    .map(n => `import ${n.module.replace(/^[a-z]+:/, '')}`)

  // a DOTTED opaque handle type (`dock type / load <SwiftUI.AnyView>`) names its module, which must be
  // imported for the type to resolve.
  //
  // UNLESS the first segment is a SHIM NAMESPACE. `dock type / load <runtime.Running>` beside
  // `dock load / load <global:server>, name runtime` names a type inside the prepended shim's `enum runtime`,
  // which is already in scope and is not a module: importing it is `no such module 'runtime'` on a file whose
  // prelude defines it 190 lines above. Every handle type a runtime shim owns is dotted this way, so the whole
  // asynchronous file and server surface tripped it at once.
  const shimNames = new Set(
    program
      .filter(
        (n): n is Extract<Statement, { form: 'native' }> =>
          n.form === 'native' && n.module.startsWith('global:'),
      )
      .map(n => n.alias),
  )

  for (const n of program) {
    if (n.form === 'native' && n.kind === 'type' && n.module.includes('.')) {
      const head = n.module.split('.')[0]!

      if (shimNames.has(head)) {
        continue
      }

      const importLine = `import ${head}`

      if (!imports.includes(importLine)) {
        imports.push(importLine)
      }
    }
  }

  // a declarative binding's swift expression may need a module imported (e.g. `Foundation.pow`)
  for (const need of bindImports(
    referencedBinds(program, binds),
    'swift',
  )) {
    const line = `import ${need.module.replace(/^[a-z]+:/, '')}`

    if (!imports.includes(line)) {
      imports.push(line)
    }
  }

  // the string API lowers to Foundation methods (`range(of:)`, case transforms): import it always, rather than
  // relying on a prelude shim to have done so (a module with no shim got no Foundation and failed on its first
  // string search). A duplicate import is harmless.
  if (!imports.includes('import Foundation')) {
    imports.unshift('import Foundation')
  }

  // a module-level `host` data tree is an ANONYMOUS nested record: with no name it emits as a labelled tuple,
  // and a single-field tuple is not valid Swift. Synthesize one struct per record node, named by the binding
  // and the field path (HostRange, HostRangeH), and rename the record nodes so the construction uses the
  // memberwise init.
  const hostStructDefs: string[] = []
  const swiftHostLeaf = (v: Expression): string =>
    v.form === 'integer'
      ? 'Int'
      : v.form === 'float'
        ? 'Double'
        : v.form === 'string'
          ? 'String'
          : v.form === 'boolean'
            ? 'Bool'
            : 'Int'
  const nameHostRecord = (
    node: Extract<Expression, { form: 'record' }>,
    base: string,
  ): string => {
    node.name = base

    const fields = node.fields.map(f => {
      const type =
        f.value.form === 'record' && f.value.name === ''
          ? nameHostRecord(f.value, `${base}${pascal(f.name)}`)
          : swiftHostLeaf(f.value)

      return `var ${camel(f.name)}: ${type}`
    })

    hostStructDefs.push(`struct ${base} { ${fields.join('; ')} }`)

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
    ...hostStructDefs,
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
      .map(n => stmt(n, 0, new Map())),
  ].filter(Boolean)

  // each task a guarded loop calls unchecked, once more with wrapping arithmetic (`aValueFast`), behind the bound the
  // guard proved its arguments inside (ir/facts/bounds.ts, `integerBounds`)
  for (const name of fastTasks) {
    const fn = program.find((n): n is Extract<Statement, { form: 'function' }> => n.form === 'function' && n.name === name)

    if (fn) {
      uncheckedInts = true
      body.push(stmt({ ...fn, name: `${name}-fast` }, 0, new Map()))
      uncheckedInts = false
    }
  }

  // `is-equal` on two records compares their fields, on every backend (note/term/optimize/meaning.md, question 4). A
  // struct or enum whose every field can be compared gets a synthesized `Equatable`, and `Hashable` too when every
  // field can be hashed (which is what lets a record be a map key). A closure or an `Any` keeps the form out, and a
  // `note shared` form is a class, so it stays a reference compared by identity. A generic form conforms where its
  // parameters do. Decided as a greatest fixpoint so a recursive form qualifies unless something else disqualifies it.
  const formDecls = new Map<string, Extract<Program[number], { form: 'record-type' }>>()

  for (const node of program) {
    if (node.form === 'record-type' && !node.shared) {
      formDecls.set(node.name, node)
    }
  }

  const equatableForms = new Set(formDecls.keys())
  const hashableForms = new Set(formDecls.keys())

  const fieldTypeQualifies = (
    type: Type,
    params: Set<string>,
    forms: Set<string>,
    hash: boolean,
  ): boolean => {
    switch (type.kind) {
      case 'number':
      case 'float':
      case 'boolean':
      case 'string':
      case 'bytes':
        return true
      case 'array':
        return fieldTypeQualifies(type.element, params, forms, hash)
      case 'map':
        return !hash && fieldTypeQualifies(type.value, params, forms, false)
      case 'named': {
        const args = type.args ?? []

        if (type.name === 'text' || type.name === 'boolean') {
          return true
        }

        if (type.name === 'list') {
          return args.every(a => fieldTypeQualifies(a, params, forms, hash))
        }

        if (type.name === 'hash') {
          return !hash && (args[1] === undefined || fieldTypeQualifies(args[1], params, forms, false))
        }

        if (params.has(type.name)) {
          return true
        }

        // a `mark shared` class is Equatable and Hashable by identity (below), wherever it sits
        if (sharedForms.has(type.name)) {
          return true
        }

        return forms.has(type.name) && args.every(a => fieldTypeQualifies(a, params, forms, hash))
      }
      default:
        return false
    }
  }

  for (const [forms, hash] of [
    [equatableForms, false],
    [hashableForms, true],
  ] as const) {
    let changed = true

    while (changed) {
      changed = false

      for (const name of [...forms]) {
        const node = formDecls.get(name)!
        const params = new Set(node.params)
        const fields = [...node.fields, ...node.variants.flatMap(v => v.fields)]

        if (!fields.every(f => fieldTypeQualifies(f.type, params, forms, hash))) {
          forms.delete(name)
          changed = true
        }
      }
    }
  }

  const conformances: string[] = []

  for (const [name, node] of formDecls) {
    const swiftName = pascal(name)

    // only a form this program actually declares as a struct or an enum
    if (!declaredForms.has(name)) {
      continue
    }

    for (const [protocol, forms] of [
      ['Equatable', equatableForms],
      ['Hashable', hashableForms],
    ] as const) {
      if (!forms.has(name) || (protocol === 'Hashable' && !equatableForms.has(name))) {
        continue
      }

      const where = node.params.length
        ? ` where ${node.params.map(p => `${p.toUpperCase()}: ${protocol}`).join(', ')}`
        : ''

      conformances.push(`extension ${swiftName}: ${protocol}${where} {}`)

      // a node class (`nodeClasses`) compares and hashes by its fields, as the case it holds did, so the enum's
      // synthesized conformance means what it meant
      const held = nodeClasses.get(name)

      if (held) {
        const fields = held.fields.map(f => camel(f.name))

        conformances.push(
          protocol === 'Equatable'
            ? `extension ${held.name}: Equatable { static func == (a: ${held.name}, b: ${held.name}) -> Bool { a === b || (${fields.map(f => `a.${f} == b.${f}`).join(' && ')}) } }`
            : `extension ${held.name}: Hashable { func hash(into hasher: inout Hasher) { ${fields.map(f => `hasher.combine(${f})`).join('; ')} } }`,
        )
      }
    }
  }

  // a `mark shared` form is a class, one object seen through every binding, so it is equal to itself alone and hashes
  // by its identity: then a record holding one compares that field by identity, and it can be a map key, as on the
  // other backends
  for (const name of sharedForms) {
    const swiftName = pascal(name)

    if (!body.some(b => new RegExp(`^final class ${swiftName}\\b`).test(b))) {
      continue
    }

    conformances.push(
      `extension ${swiftName}: Equatable { static func == (a: ${swiftName}, b: ${swiftName}) -> Bool { a === b } }`,
      `extension ${swiftName}: Hashable { func hash(into hasher: inout Hasher) { hasher.combine(ObjectIdentifier(self)) } }`,
    )
  }

  body.push(...conformances)

  const prelude = (Object.keys(SWIFT_HELPERS) as SwiftHelper[]).filter(h => needs.has(h)).map(h => SWIFT_HELPERS[h])

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

      return `HiveEntry(host: ${JSON.stringify(String(own.host ?? ''))}, kind: ${JSON.stringify(String(own.kind ?? ''))}, name: ${JSON.stringify(String(own.name ?? ''))}, site: ${JSON.stringify(String(own.site ?? ''))}, base: ${boxed})`
    }

    const calls = options.wake
      .map(
        group =>
          `  hiveWake(${JSON.stringify(group.deck)}, SeedList<HiveEntry>([${group.entries.map(entryText).join(', ')}]))`,
      )
      .join('\n')

    wake.push(`func wakeHive() -> Void {\n${calls}\n}`)
  }

  return [...imports, ...prelude, ...body, ...swiftFormWalk(fillSpecs, meltSpecs), ...wake].join('\n\n') + '\n'
}

// does a function body contain a throw? (then its Swift signature needs `throws`)
function bodyThrows(body: Statement[]): boolean {
  return body.some(s => {
    switch (s.form) {
      case 'throw':
        return true
      case 'if':
        return (
          s.branches.some(b => bodyThrows(b.body)) ||
          (s.otherwise ? bodyThrows(s.otherwise) : false)
        )
      case 'match':
        return (
          s.cases.some(c => bodyThrows(c.body)) ||
          (s.otherwise ? bodyThrows(s.otherwise) : false)
        )
      case 'while':
      case 'for-each':
        return bodyThrows(s.body)
      default:
        return false
    }
  })
}

// ---- filling a form from data on swift ----

// the walkers a module's `fill` / `melt` with a form need: helpers over the package's data enum (spelled
// `DataForm` here, since `Data` is Foundation's), then a function per form. A value that does not fit throws the
// package's `data-mismatch` as a `TermException`, with its path and reason (SWIFT_FORM_HELPERS).
function swiftFormWalk(fills: Map<string, FormSpec>, melts: Map<string, FormSpec>): string[] {
  if (fills.size === 0 && melts.size === 0) {
    return []
  }

  const out: string[] = [SWIFT_FORM_HELPERS]

  const fillOf = (kind: FormKind, value: string, path: string, optional: boolean): string => {
    switch (kind.kind) {
      case 'text':
        return `try __termText(${value}, ${path}, ${optional})`
      case 'number':
        return `try __termNumber(${value}, ${path}, ${optional})`
      case 'decimal':
        return `try __termDecimal(${value}, ${path}, ${optional})`
      case 'flag':
        return `try __termFlag(${value}, ${path}, ${optional})`
      case 'data':
        return `try __termData(${value}, ${path}, ${optional})`
      case 'list':
        return `try __termList(${value}, ${path}, ${optional}) { d, p in ${fillOf(kind.item, 'd', 'p', false)} }`
      case 'form':
        return `try __fill${pascal(kind.spec.form)}(try __termData(${value}, ${path}, ${optional}), ${path})`
      default:
        return '0'
    }
  }

  for (const spec of fills.values()) {
    const known = spec.fields.map(f => JSON.stringify(f.name)).join(', ')
    const fields = spec.fields
      .map(f => `${camel(f.name)}: ${fillOf(f.kind, `find(${JSON.stringify(f.name)})`, `__termPath(path, ${JSON.stringify(f.name)})`, f.optional)}`)
      .join(', ')

    out.push(
      `func __fill${pascal(spec.form)}(_ value: DataForm, _ path: String) throws -> ${pascal(spec.form)} {\n` +
        `  let entries = try __termEntries(value, path)\n` +
        `  let known: Set<String> = [${known}]\n` +
        `  for e in entries.data { if !known.contains(e.name) { throw __termMismatch(__termPath(path, e.name), "is not in the form") } }\n` +
        `  func find(_ name: String) -> DataForm? { return entries.data.first { $0.name == name }?.base }\n` +
        `  return ${pascal(spec.form)}(${fields})\n}`,
    )
  }

  const meltOf = (kind: FormKind, value: string): string => {
    switch (kind.kind) {
      case 'text':
        return `.text(value: ${value})`
      case 'number':
        return `.number(value: ${value})`
      case 'decimal':
        return `.decimal(value: ${value})`
      case 'flag':
        return `.flag(value: ${value})`
      case 'data':
        return value
      case 'list':
        return `.array(list: SeedList((${value}).data.map { x in ${meltOf(kind.item, 'x')} }))`
      case 'form':
        return `__melt${pascal(kind.spec.form)}(${value})`
      default:
        return '.blank'
    }
  }

  const emptyTest = (kind: FormKind, value: string): string | undefined => {
    switch (kind.kind) {
      case 'text':
        return `(${value}).isEmpty`
      case 'list':
        return `(${value}).data.isEmpty`
      case 'data':
        return `__termIsBlank(${value})`
      default:
        return undefined
    }
  }

  for (const spec of melts.values()) {
    const lines = spec.fields.map(f => {
      const value = `value.${camel(f.name)}`
      const entry = `list.append(DataEntry(name: ${JSON.stringify(f.name)}, base: ${meltOf(f.kind, value)}))`
      const empty = f.optional ? emptyTest(f.kind, value) : undefined

      return empty ? `  if !${empty} { ${entry} }` : `  ${entry}`
    })

    out.push(
      `func __melt${pascal(spec.form)}(_ value: ${pascal(spec.form)}) -> DataForm {\n  var list: [DataEntry] = []\n${lines.join('\n')}\n  return .hash(list: SeedList(list))\n}`,
    )
  }

  return out
}

// A value that does not fit THROWS `data-mismatch`, the package's own exception, with the fields TypeScript gives it
// (`@term/host`, `Data does not fit the shape`, and the path and reason under `link`), so a guard catches it as it does
// there. It was a `fatalError`, which nothing catches (guides: language/data, 2026-10-05).
const SWIFT_FORM_HELPERS = `func __termMismatch(_ path: String, _ reason: String) -> TermException {
  let link: [String: String] = ["thing": "data", "path": path.isEmpty ? "." : path, "reason": reason]
  return TermException(host: "@term/host", form: "data-mismatch", note: "Data does not fit the shape", code: "", time: Int(Date().timeIntervalSince1970 * 1000), link: link, base: nil)
}
func __termPath(_ path: String, _ key: String) -> String { return path.isEmpty ? key : path + "/" + key }
func __termKind(_ value: DataForm) -> String {
  switch value { case .hash: return "a map"; case .array: return "a list"; case .blank: return "void"; case .text: return "text"; case .number: return "number"; case .decimal: return "decimal"; case .flag: return "flag"; case .graft: return "a fuse" }
}
func __termIsBlank(_ value: DataForm) -> Bool { if case .blank = value { return true }; return false }
func __termEntries(_ value: DataForm, _ path: String) throws -> SeedList<DataEntry> {
  if case .hash(let list) = value { return list }
  throw __termMismatch(path, "is \\(__termKind(value)) where a map belongs")
}
func __termText(_ value: DataForm?, _ path: String, _ optional: Bool) throws -> String {
  switch value { case .some(.text(let value)): return value; case .none, .some(.blank): if optional { return "" }; throw __termMismatch(path, "is missing"); case .some(let other): throw __termMismatch(path, "is \\(__termKind(other)) where text belongs") }
}
func __termNumber(_ value: DataForm?, _ path: String, _ optional: Bool) throws -> Int {
  switch value { case .some(.number(let value)): return value; case .none, .some(.blank): if optional { return 0 }; throw __termMismatch(path, "is missing"); case .some(let other): throw __termMismatch(path, "is \\(__termKind(other)) where number belongs") }
}
func __termDecimal(_ value: DataForm?, _ path: String, _ optional: Bool) throws -> Double {
  switch value { case .some(.decimal(let value)): return value; case .some(.number(let value)): return Double(value); case .none, .some(.blank): if optional { return 0.0 }; throw __termMismatch(path, "is missing"); case .some(let other): throw __termMismatch(path, "is \\(__termKind(other)) where decimal belongs") }
}
func __termFlag(_ value: DataForm?, _ path: String, _ optional: Bool) throws -> Bool {
  switch value { case .some(.flag(let value)): return value; case .none, .some(.blank): if optional { return false }; throw __termMismatch(path, "is missing"); case .some(let other): throw __termMismatch(path, "is \\(__termKind(other)) where flag belongs") }
}
func __termData(_ value: DataForm?, _ path: String, _ optional: Bool) throws -> DataForm {
  if let value = value { return value }
  if optional { return .blank }
  throw __termMismatch(path, "is missing")
}
func __termList<T>(_ value: DataForm?, _ path: String, _ optional: Bool, _ item: (DataForm, String) throws -> T) throws -> SeedList<T> {
  switch value {
  case .some(.array(let list)): return SeedList(try list.data.enumerated().map { (i, d) in try item(d, __termPath(path, String(i))) })
  case .none, .some(.blank): if optional { return SeedList() }; throw __termMismatch(path, "is missing")
  case .some(let other): throw __termMismatch(path, "is \\(__termKind(other)) where a list belongs")
  }
}`
