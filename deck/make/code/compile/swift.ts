// The Swift backend: emit the language as idiomatic, type-static Swift. Parity with the TypeScript backend across
// every AST form. Algebraic data types lower to NATIVE generic enums (`enum Maybe<T> { case some(value: T); case none }`),
// `match` to native `if case let` pattern binding (a matched variant's fields bind to locals, and field access on the
// subject rewrites to those locals), and struct forms to `struct`s. Construction uses leading-dot syntax so Swift
// infers the type parameter from context (return type, annotated binding, argument position) — no monomorphization
// needed. Generic functions emit `<T>`. Pure, browser-safe. See note/research/vibe/computation/plans/07-codegen.md.


import { raiseSetsOf } from '@term/make/code/check/effects'
import { keepDocksApart } from '@term/make/code/compile/dock-apart'
import { markUnit, unmarked } from '@term/make/code/compile/unit-split'
import { provenIncrements } from '@term/make/code/ir/facts/range'
import { provenArithmetic, type Proven } from '@term/make/code/compile/proven'
import { boundedLoops } from '@term/make/code/ir/facts/bounds'
import { asciiTexts } from '@term/make/code/ir/facts/text'
import { taggedForms, tagText } from '@term/make/code/compile/tag'
import { privateForms, valuePlaces } from '@term/make/code/compile/place'
import type {
  Expression,
  Program,
  Statement,
  Type,
} from '@term/make/code/compile/node'
import { reassigned } from '@term/make/code/compile/backend'
import type { FormSpec } from '@term/make/code/compile/backend'
import {
  fillTasks,
  redeclaredLets,
  textCursors,
  gatedTasks,
  listFacts,
  ownedLocals,
  ownedElements,
  ownedFields,
  lastReads,
} from '@term/make/code/compile/backend'
import type { OwnedElements, TextCursors } from '@term/make/code/compile/backend'
import {
  collectBinds,
  bindImports,
  referencedBinds,
} from '@term/make/code/compile/bind'
import * as swiftNames from '@term/make/code/compile/swift-names'
import * as swiftEmit from '@term/make/code/compile/swift-emit'

// The Swift emitter is Term in two parts (self-hosting, 2026-10-06): compile/swift-names.tree, the helpers that read no
// emitter state (a name as a Swift identifier, an input's label and literal default, a form's PascalCase name, the
// inference variables of a type, whether a body raises, the `fill` / `melt` walkers), and compile/swift-emit.tree, the
// emitter itself (`emitSwift` below drives it). This file keeps the preludes, the analyses whose answers the emitter
// asks for, and the assembly of the module: imports, host structs, the statements in order, the conformances, the wake
// chain.
type Maybe<T> = { form: 'some'; value: T } | { form: 'none' }
const boxed = <T>(value: T | undefined): Maybe<T> => (value === undefined ? { form: 'none' } : { form: 'some', value })
const flags = (names: Iterable<string>): Map<string, boolean> => new Map([...names].map(name => [name, true]))

function camel(name: string): string {
  return swiftNames.camel(name)
}

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

// The prelude helpers a Swift program may use, each written once, in the order they are emitted. The emitter records a
// helper in `needs` where it writes a use of it, and a list or map type anywhere in the program records the wrapper.
// It used to be chosen by searching the emitted text for each helper's name.
const SWIFT_HELPERS = {
  text: SWIFT_TEXT,
  number: SWIFT_NUMBER,
  // the result of a call whose type the build cannot see (a native runtime's function), let go in statement position.
  // `_ =` warns when the function answers Void and saying nothing warns when it answers a value; a generic parameter
  // takes either in silence
  discard: '@inline(__always) func termDiscard<T>(_ value: T) {}',
  // fire and forget (`tick f(x)`): the work starts NOW, on this thread, and runs to its first wait, as an async
  // function called on TypeScript does and a coroutine started on Kotlin does (`Task.immediate`, SE-0472). What is still
  // waiting then is counted, and `run-pending` (`__termDrain`) waits until none is. A `Task { }` started it later on
  // another thread, and a terminal app's `run-pending` returned before a key's work had run (tick-native)
  spawn: [
    'let __termOutstanding = DispatchGroup()',
    'func __termSpawn(_ work: @escaping () async -> Void) {',
    '    __termOutstanding.enter()',
    '    if #available(macOS 26, iOS 26, tvOS 26, watchOS 26, visionOS 26, *) {',
    '        Task.immediate { await work(); __termOutstanding.leave() }',
    '    } else {',
    '        Task { await work(); __termOutstanding.leave() }',
    '    }',
    '}',
    'func __termDrain() -> Bool { __termOutstanding.wait(); return true }',
  ].join('\n'),
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
    // the KEY rule, the one TypeScript keeps (__termKeyText): one NaN, `-0.0` the same key as `0.0`, and a record or
    // a list by its parts under the same rule. A value compares by IEEE (`==`), so it cannot be the key rule, and
    // the index below hashes and compares through `TermKeyBox` instead
    'protocol TermKeyed { func termHash(into h: inout Hasher); func termEq(_ other: Any) -> Bool }',
    'func termKeyHash<T: Hashable>(_ k: T, into h: inout Hasher) {',
    '    if T.self == String.self || T.self == Int.self || T.self == Bool.self { h.combine(k); return }',
    '    if let d = k as? Double { h.combine(d.isNaN ? Double.nan.bitPattern : d == 0 ? 0 : d.bitPattern); return }',
    '    if let f = k as? Float { termKeyHash(Double(f), into: &h); return }',
    '    if let t = k as? TermKeyed { t.termHash(into: &h); return }',
    '    h.combine(k)',
    '}',
    'func termKeyEq<T: Hashable>(_ a: T, _ b: T) -> Bool {',
    '    if T.self == String.self || T.self == Int.self || T.self == Bool.self { return a == b }',
    '    if let x = a as? Double, let y = b as? Double { return (x.isNaN && y.isNaN) || x == y }',
    '    if let x = a as? Float, let y = b as? Float { return (x.isNaN && y.isNaN) || x == y }',
    '    if let t = a as? TermKeyed { return t.termEq(b) }',
    '    return a == b',
    '}',
    'struct TermKeyBox<K: Hashable>: Hashable {',
    '    let key: K',
    '    init(_ key: K) { self.key = key }',
    '    static func == (a: TermKeyBox<K>, b: TermKeyBox<K>) -> Bool { termKeyEq(a.key, b.key) }',
    '    func hash(into h: inout Hasher) { termKeyHash(key, into: &h) }',
    '}',
    'extension Array: TermKeyed where Element: Hashable {',
    '    func termHash(into h: inout Hasher) { h.combine(count); for x in self { termKeyHash(x, into: &h) } }',
    '    func termEq(_ other: Any) -> Bool { guard let o = other as? [Element], o.count == count else { return false }; return zip(self, o).allSatisfy { termKeyEq($0, $1) } }',
    '}',
    'struct SeedOrdered<K: Hashable, V>: Sequence {',
    '    private var slot: [TermKeyBox<K>: Int] = [:]',
    '    private var ks: [K] = []',
    '    private var vs: [V] = []',
    '    private var live: [Bool] = []',
    '    private var dead = 0',
    '    init() {}',
    '    init(_ data: [K: V]) { for (k, v) in data { self[k] = v } }',
    '    var count: Int { slot.count }',
    '    var isEmpty: Bool { slot.isEmpty }',
    '    subscript(key: K) -> V? {',
    '        get { if let i = slot[TermKeyBox(key)] { return vs[i] }; return nil }',
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
    '        let i = { (at: inout Int) -> Int in if at < 0 { at = n; fresh = true }; return at }(&slot[TermKeyBox(key), default: -1])',
    '        if fresh { ks.append(key); vs.append(fallback); live.append(true) }',
    '        return i',
    '    }',
    '    // a value changed from itself in one probe (backend.ts, mapUpdate)',
    '    mutating func update(_ key: K, _ fallback: V, _ change: (V) -> V) { let i = place(key, fallback); vs[i] = change(vs[i]) }',
    '    @discardableResult mutating func removeValue(forKey key: K) -> V? {',
    '        guard let i = slot.removeValue(forKey: TermKeyBox(key)) else { return nil }',
    '        let out = vs[i]',
    '        live[i] = false',
    '        dead += 1',
    '        if dead > 16 && dead * 2 > ks.count { compact() }',
    '        return out',
    '    }',
    '    private mutating func compact() {',
    '        var k2: [K] = []; var v2: [V] = []',
    '        k2.reserveCapacity(slot.count); v2.reserveCapacity(slot.count)',
    '        for i in 0..<ks.count where live[i] { slot[TermKeyBox(ks[i])] = k2.count; k2.append(ks[i]); v2.append(vs[i]) }',
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
    // a map as a key, or a field of one: by its entries in any order, so its hash is the sum of each entry's own
    'extension SeedMap: Hashable where V: Hashable {',
    '    func hash(into h: inout Hasher) { var sum = 0; for (k, v) in data { var one = Hasher(); termKeyHash(k, into: &one); termKeyHash(v, into: &one); sum = sum &+ one.finalize() }; h.combine(data.count); h.combine(sum) }',
    '}',
    'extension SeedMap: TermKeyed where V: Hashable {',
    '    func termHash(into h: inout Hasher) { hash(into: &h) }',
    '    func termEq(_ other: Any) -> Bool { guard let o = other as? SeedMap<K, V>, o.data.count == data.count else { return false }; return data.allSatisfy { e in o.data[e.key].map { termKeyEq($0, e.value) } ?? false } }',
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

// `TermKeyed` for every hashable form that can hold a float, so a map keyed by one follows the key rule (see the map
// runtime): each field hashed and compared by `termKeyHash` / `termKeyEq`, an enum's case first
function swiftKeyConformances(
  formDecls: Map<string, Extract<Program[number], { form: 'record-type' }>>,
  declaredForms: { has(name: string): boolean },
  hashableForms: Set<string>,
  equatableForms: Set<string>,
  nodeClasses: Map<string, { label: string; name: string; fields: { name: string; type: Type }[] }>,
): string[] {
  const floaty = new Set<string>()
  const holdsFloat = (type: Type, params: Set<string>): boolean => {
    switch (type.kind) {
      case 'float':
      case 'array':
      case 'map':
        return true
      case 'named':
        return (
          type.name === 'float' ||
          type.name === 'list' ||
          type.name === 'hash' ||
          params.has(type.name) ||
          floaty.has(type.name) ||
          (type.args ?? []).some(a => holdsFloat(a, params))
        )
      default:
        return false
    }
  }
  let changed = true

  while (changed) {
    changed = false

    for (const [name, node] of formDecls) {
      const params = new Set(node.params)

      if (!floaty.has(name) && [...node.fields, ...node.variants.flatMap(v => v.fields)].some(f => holdsFloat(f.type, params))) {
        floaty.add(name)
        changed = true
      }
    }
  }

  const out: string[] = []
  const hashOf = (value: string): string => `termKeyHash(${value}, into: &h)`
  const eqOf = (a: string, b: string): string => `termKeyEq(${a}, ${b})`

  for (const name of floaty) {
    const node = formDecls.get(name)!

    if (!declaredForms.has(name) || !hashableForms.has(name) || !equatableForms.has(name) || node.shared) {
      continue
    }

    const where = node.params.length ? ` where ${node.params.map(p => `${p.toUpperCase()}: Hashable`).join(', ')}` : ''
    const held = nodeClasses.get(name)

    if (node.variants.length === 0) {
      const fields = node.fields.map(f => camel(f.name))

      out.push(
        `extension ${pascal(name)}: TermKeyed${where} {\n  func termHash(into h: inout Hasher) { ${fields.map(f => hashOf(f)).join('; ')} }\n  func termEq(_ other: Any) -> Bool { guard let o = other as? Self else { return false }; return ${fields.map(f => eqOf(f, `o.${f}`)).join(' && ') || 'true'} }\n}`,
      )

      continue
    }

    // one payload per field, or the node class alone for the case it holds
    const payload = (v: (typeof node.variants)[number]): number => (held && v.name === held.label ? 1 : v.fields.length)
    const bound = (prefix: string, n: number): string => (n > 0 ? `(${Array.from({ length: n }, (_, i) => `let ${prefix}${i}`).join(', ')})` : '')
    const hashArms = node.variants.map((v, at) => {
      const n = payload(v)

      return `case .${camel(v.name)}${bound('a', n)}: h.combine(${at})${Array.from({ length: n }, (_, i) => `; ${hashOf(`a${i}`)}`).join('')}`
    })
    const eqArms = node.variants.map(v => {
      const n = payload(v)
      const test = Array.from({ length: n }, (_, i) => eqOf(`a${i}`, `b${i}`)).join(' && ') || 'true'

      return `case (.${camel(v.name)}${bound('a', n)}, .${camel(v.name)}${bound('b', n)}): return ${test}`
    })

    out.push(
      `extension ${pascal(name)}: TermKeyed${where} {\n  func termHash(into h: inout Hasher) { switch self { ${hashArms.join('; ')} } }\n  func termEq(_ other: Any) -> Bool { guard let o = other as? Self else { return false }; switch (self, o) { ${eqArms.join('; ')}${node.variants.length > 1 ? '; default: return false' : ''} } }\n}`,
    )

    if (held) {
      const fields = held.fields.map(f => camel(f.name))

      out.push(
        `extension ${held.name}: TermKeyed {\n  func termHash(into h: inout Hasher) { ${fields.map(f => hashOf(f)).join('; ')} }\n  func termEq(_ other: Any) -> Bool { guard let o = other as? ${held.name} else { return false }; return self === o || (${fields.map(f => eqOf(f, `o.${f}`)).join(' && ') || 'true'}) }\n}`,
      )
    }
  }

  return out
}

function pascal(name: string): string {
  return swiftNames.pascal(name)
}

// the roll grouped by deck, for the generated wake chain (the same shape emitTypeScript takes)
export type WakeGroup = {
  deck: string
  entries: Record<string, unknown>[]
}

export function emitSwift(
  written: Program,
  options?: { wake?: WakeGroup[]; units?: boolean },
): string {
  // a task named like a docked module is renamed, since Swift refuses `enum log` beside `func log` (dock-apart.ts)
  const program = keepDocksApart(written)
  // the `+`, `-` and `*` nodes proven not to overflow (compile/proven.ts): written as the wrapping `&+`, `&-`, `&*`.
  // The counted steps here, joined below by the interval fact once the list facts it reads are known
  let provenSteps: Proven = provenIncrements(program)
  // the counted loops whose calls to a bounded task may run its wrapping copy (ir/facts/bounds.ts)
  // no lend facts: a fast copy of a task that takes a list is emitted under its own name, which this backend's list
  // facts (the lent, fixed and borrowed parameters, all keyed by task) do not reach, so only tasks that take no list
  // run unchecked here. TypeScript keys no list representation by task and passes them
  const loopGuards = boundedLoops(program)
  // the text expressions proven ASCII, read in place by byte offset (ir/facts/text.ts)
  const asciiNodes = asciiTexts(program)
  // the tasks that only fill a list (backend.ts, `fillTasks`)
  const fills = fillTasks(program)
  // the prelude helpers this program uses (SWIFT_HELPERS), recorded by the emitter where each is written. A list or a
  // map value carries a list or map type somewhere in the program even when no annotation is written for it (the result
  // of a `map`, a temporary), so the program's types decide the two wrappers, and the type spelling records them as well
  const needs = new Map<string, boolean>(
    typeKindsIn(program).flatMap((kind): [string, boolean][] => (kind === 'array' ? [['list', true]] : kind === 'map' ? [['map', true]] : [])),
  )
  // the enums that must be `indirect` because they can contain themselves
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
  // when the stdlib hive is in the program, every new raise tells it (the throw lowering), and the compiler can
  // emit the wake chain (`wakeHive`) from the roll the driver hands over
  const hasHiveTell = program.some(
    n => n.form === 'function' && n.name === 'hive-tell',
  )
  // every known function's declared parameters, for filling a left-out trailing `need false` argument
  const functionParams = new Map(
    program
      .filter(
        (n): n is Extract<Statement, { form: 'function' }> =>
          n.form === 'function',
      )
      .map(n => [n.name, n.params]),
  )
  // each task's input names, which label its arguments at every call
  const functionLabels = new Map<string, string[]>(
    program
      .filter(
        (n): n is Extract<Statement, { form: 'function' }> =>
          n.form === 'function',
      )
      .map(n => [n.name, n.params.map(p => p.name)]),
  )

  // generic tasks with a type parameter that no parameter mentions (`make-sorted-map` names `v` only in its result):
  // the call alone cannot tell Swift what it is, so a binding of one says it
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

  // each variant's field names (for construction and match binding)
  const variantFields = new Map<string, string[]>()
  // the same, by FORM and case (`rope/leaf`): two forms may name a case alike, and an arm reads its own form's
  const caseFieldNames = new Map<string, string[]>()
  const variantSet = new Set<string>()
  // the `note shared` forms, emitted as classes and compared by identity
  const sharedForms = new Set(
    program.flatMap(n => (n.form === 'record-type' && n.shared ? [n.name] : [])),
  )
  // every struct form's declared fields (in order: swift's memberwise init takes them so), and the exception forms,
  // whose structs conform to Error so a raise can `throw` them
  const recordFields = new Map<string, { name: string; type: Type }[]>(
    program
      .filter((n): n is Extract<Statement, { form: 'record-type' }> => n.form === 'record-type' && n.variants.length === 0)
      .map(n => [n.name, n.fields]),
  )
  const exceptionForms = new Set(
    program
      .filter((n): n is Extract<Statement, { form: 'record-type' }> => n.form === 'record-type' && Boolean(n.chain?.includes('exception')))
      .map(n => n.name),
  )
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

  // native dock module aliases (`dns`, `fs`): a call to one returning a list yields a plain Array that must be wrapped,
  // and the value one answers is untyped
  const aliases = new Set<string>()

  for (const node of program) {
    if (node.form === 'native' && node.kind !== 'type') {
      aliases.add(node.alias)
    }
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

  // the functions whose body throws directly: their signatures carry `throws`, and every CALL to one is `try` or `try!`
  const throwingFns = new Set<string>()

  for (const node of program) {
    if (node.form === 'function' && swiftNames.bodyThrows(node.body as never)) {
      throwingFns.add(node.name)
    }
  }

  // the raise sets (note/term/hive/04-reach.md): a function that can raise, through its callees too, is `throws`, a
  // call to one is `try` where the caller is itself `throws` or the call sits in a guarded body, and `try!` elsewhere
  // (a raise nothing handles ends the program, as on every backend)
  const sets = raiseSetsOf(program, [...exceptionForms])

  for (const [name, raises] of sets.raises) {
    if (raises.length > 0) {
      throwingFns.add(name)
    }
  }

  // the `note async` tasks
  const asyncFns = new Set(
    program.flatMap(node => (node.form === 'function' && node.async ? [node.name] : [])),
  )
  // each free task's parameter count, for a throwing task passed as a value (methods are reached by dispatch, not named)
  const taskArity = new Map(
    program.flatMap(node => (node.form === 'function' && !node.method ? [[node.name, node.params.length] as const] : [])),
  )
  // the mask each method requirement belongs to: a requirement throws when any conforming task does
  const maskOf = new Map<string, string>()

  for (const node of program) {
    if (node.form === 'mask') {
      node.methods.forEach(m => maskOf.set(m, node.name))
    }
  }

  // F1 (note/term/codegen/shared.md), the same facts Rust reads: a list parameter a task takes lent is a plain `[T]`
  // (read) or `inout [T]` (written) where every list is otherwise a `SeedList` class, a list local the task owns is a
  // plain `var [T]`, and a task answering a fresh list answers `[T]`. Swift's arrays are values with copy-on-write, so
  // a read-only `[T]` copies nothing, and an `inout` argument's write access begins only after every other argument is
  // evaluated, so `flip(&perm.data, perm.data[0])` reads before it lends
  const gated = gatedTasks(program, maskMethods)
  const { lend: lendParams, fresh: freshLists } = listFacts(program, gated)
  provenSteps = provenArithmetic(program, lendParams, freshLists)
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
  // F4 on Swift (compile/place.ts, `valuePlaces`): the record writes narrowed to their changed fields, and the slot
  // locals read through their slot
  const { writes: placed, locals: slotLocals } = valuePlaces(program)
  // the lists of lists that own their inner lists, each inner list a plain `[E]` (backend.ts, `ownedElements`): Graph's
  // adjacency lists, 432 ms to 336 against the hand version's 318 (`tmp/swift-graph-ab.ts`). Decided below, once the
  // emitter can spell a type
  let elementLists: OwnedElements | undefined
  const ownsInner = (at: 'lets' | 'walks' | 'items', node: object): boolean => {
    const key = elementLists?.[at].get(node)

    return key !== undefined && elementLists!.keys.has(key)
  }
  // each task's text cursors and redeclared `let`s, asked once per task
  const cursorsOf = new WeakMap<object, TextCursors>()
  const cursorsFor = (fn: object): TextCursors => {
    let found = cursorsOf.get(fn)

    if (!found) {
      found = textCursors(fn as Fn, asciiNodes)
      cursorsOf.set(fn, found)
    }

    return found
  }
  const redeclaredOf = new WeakMap<object, WeakSet<Statement>>()
  const redeclaredFor = (fn: object): WeakSet<Statement> => {
    let found = redeclaredOf.get(fn)

    if (!found) {
      found = redeclaredLets(fn as Fn)
      redeclaredOf.set(fn, found)
    }

    return found
  }
  // the fill tasks as compile/backend-names.tree reads them: a parameter position, or the literal item
  const fillTable = new Map(
    [...fills].map(([name, fill]) => [
      name,
      typeof fill.item === 'number' ? { size: fill.size, itemAt: fill.item } : { size: fill.size, itemAt: -1, item: fill.item },
    ]),
  )
  const facts = {
    variantSet: flags(variantSet),
    variantFields,
    caseFieldNames,
    recordFields,
    sharedForms: flags(sharedForms),
    exceptionForms: flags(exceptionForms),
    unionForms: flags(unionForms),
    genericArity,
    opaque: opaqueTypes,
    formKeyIndices: new Map([...formKeyIndices].map(([name, at]) => [name, [...at]])),
    functionParams,
    functionLabels,
    taskArity,
    hiddenGeneric: flags(hiddenGeneric),
    binds,
    fills: fillTable,
    throwing: flags(throwingFns),
    asyncTasks: flags(asyncFns),
    maskMethods: flags(maskMethods),
    maskOf,
    instanceTargets,
    implFn,
    aliases: flags(aliases),
    lendParams,
    freshLists: flags(freshLists),
    fieldLists: flags(fieldLists),
    nodeClasses,
    nodeCases: nodeCase,
    spareTasks: new Map([...spareTasks].map(([name, forms]) => [name, [...forms]])),
    recursive: flags(recursive),
    hasHiveTell,
    assignedAnywhere: flags(assignedAnywhere),
    isProven: (node: object) => provenSteps.has(node as Expression),
    loopGuardOf: (node: object) => {
      const guard = loopGuards.get(node as Statement)

      return boxed(guard ? { fast: (guard.fast?.length ?? 0) > 0, limits: guard.limits ?? [] } : undefined)
    },
    isFastIn: (node: object, loop: object) => loopGuards.get(loop as Statement)?.fast?.includes(node) ?? false,
    isASCII: (node: object) => asciiNodes.has(node),
    cursorNames: (fn: object) => cursorsFor(fn).names,
    cursorOf: (fn: object, node: object) => boxed(cursorsFor(fn).reads.get(node)),
    isRedeclared: (fn: object, node: object) => redeclaredFor(fn).has(node as Statement),
    ownsInnerLet: (node: object) => ownsInner('lets', node),
    ownsInnerWalk: (node: object) => ownsInner('walks', node),
    ownsInnerItem: (node: object) => ownsInner('items', node),
    isConsumed: (node: object) => consumedSubjects.has(node),
    slotLocalOf: (node: object) => boxed(slotLocals.get(node as Statement)),
    placeOf: (node: object) => boxed(placed.get(node as Statement)),
    ownedLocalsOf: (fn: object) => ownedLocals(fn as Fn, freshLists, lendParams, fieldLists, elementLists?.moves),
    sameNode: (left: object, right: object) => left === right,
  }
  const st = swiftEmit.newSwiftState(needs)
  const swiftType = (type: Type | undefined): string => swiftEmit.swiftTypeOf(boxed(type) as never, st, facts as never)
  const stmt = (node: Statement, depth: number): string => swiftEmit.emitStatement(node as never, depth, st, facts as never)
  elementLists = ownedElements(program, freshLists, lendParams, t => swiftType(t))
  st.innerKeys = flags(elementLists.keys)

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
  //
  // The head is compared in the spelling EMITTED, not as written. A two-word alias is kebab in the source
  // (`name watch-file`) and a native call writes it `watchFile.watchOpen(`, so a type `<watchFile.Watcher>` names
  // that same namespace; compared as written, `watch-file` never matched and `import watchFile` was emitted
  // (`no such module`, D026, item 0211). `camelize` is the function every emitted name, a call's namespace
  // included, comes from (`vname` is it plus the keyword escape, which a head typed by hand never carries).
  const shimNames = new Set(
    program
      .filter(
        (n): n is Extract<Statement, { form: 'native' }> =>
          n.form === 'native' && n.module.startsWith('global:'),
      )
      .map(n => swiftNames.camelize(n.alias)),
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
      // each marked with its module, so the program can be written one file per module (compile/unit-split.ts)
      .map(n => markUnit(n.span.file ?? '', stmt(n, 0))),
  ].filter(Boolean)

  // each task a guarded loop calls unchecked, once more with wrapping arithmetic (`aValueFast`), behind the bound the
  // guard proved its arguments inside (ir/facts/bounds.ts, `integerBounds`)
  for (const name of st.fastTasks) {
    const fn = program.find((n): n is Extract<Statement, { form: 'function' }> => n.form === 'function' && n.name === name)

    if (fn) {
      body.push(markUnit(fn.span.file ?? '', swiftEmit.emitUnchecked({ ...fn, name: `${name}-fast` } as never, st, facts as never)))
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
      // a map hashes by its entries in any order (`SeedMap: Hashable`), so it may sit in a key
      case 'map':
        return fieldTypeQualifies(type.value, params, forms, hash)
      case 'named': {
        const args = type.args ?? []

        if (type.name === 'text' || type.name === 'boolean') {
          return true
        }

        if (type.name === 'list') {
          return args.every(a => fieldTypeQualifies(a, params, forms, hash))
        }

        if (type.name === 'hash') {
          return args[1] === undefined || fieldTypeQualifies(args[1], params, forms, hash)
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
    if (!st.declaredForms.has(name)) {
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

      // in the form's own module: Swift synthesizes a conformance only in the file that declares the type, which is the
      // form's own file once the program is written one file per module (compile/unit-split.ts)
      conformances.push(markUnit(node.span.file ?? '', `extension ${swiftName}: ${protocol}${where} {}`))

      // a node class (`nodeClasses`) compares and hashes by its fields, as the case it holds did, so the enum's
      // synthesized conformance means what it meant
      const held = nodeClasses.get(name)

      if (held) {
        const fields = held.fields.map(f => camel(f.name))

        conformances.push(
          markUnit(
            node.span.file ?? '',
            protocol === 'Equatable'
              ? `extension ${held.name}: Equatable { static func == (a: ${held.name}, b: ${held.name}) -> Bool { a === b || (${fields.map(f => `a.${f} == b.${f}`).join(' && ')}) } }`
              : `extension ${held.name}: Hashable { func hash(into hasher: inout Hasher) { ${fields.map(f => `hasher.combine(${f})`).join('; ')} } }`,
          ),
        )
      }
    }
  }

  // a `mark shared` form is a class, one object seen through every binding, so it is equal to itself alone and hashes
  // by its identity: then a record holding one compares that field by identity, and it can be a map key, as on the
  // other backends
  for (const name of sharedForms) {
    const swiftName = pascal(name)

    // read through the unit marks (compile/unit-split.ts), which open each statement: tested against the marked text,
    // no class matched, none got its conformance, and every form holding one failed `Equatable` (2026-10-05)
    if (!body.some(b => new RegExp(`^final class ${swiftName}\\b`).test(unmarked(b)))) {
      continue
    }

    conformances.push(
      `extension ${swiftName}: Equatable { static func == (a: ${swiftName}, b: ${swiftName}) -> Bool { a === b } }`,
      `extension ${swiftName}: Hashable { func hash(into hasher: inout Hasher) { hasher.combine(ObjectIdentifier(self)) } }`,
    )
  }

  // the key rule for a record (`TermKeyed`, in the map runtime): a map index hashes and compares a key by it, so a
  // record holding a float is one key with NaN in it however often it is set, and `-0.0` is `0.0`. Only a form that
  // can hold a float somewhere (a decimal, a list, a generic, or such a form) gets one, since every other key's own
  // `==` already is the rule
  if (st.needs.has('map')) {
    conformances.push(...swiftKeyConformances(formDecls, st.declaredForms, hashableForms, equatableForms, nodeClasses))

    if (st.needs.has('list')) {
      conformances.push(
        'extension SeedList: TermKeyed where T: Hashable {\n  func termHash(into h: inout Hasher) { data.termHash(into: &h) }\n  func termEq(_ other: Any) -> Bool { guard let o = other as? SeedList<T> else { return false }; return data.termEq(o.data) }\n}',
      )
    }
  }

  // the tag, for a form whose tag the program reads as a field: the case's name as text (compile/tag.ts)
  for (const name of taggedForms(program)) {
    const node = formDecls.get(name)

    if (node && st.declaredForms.has(name) && node.variants.length > 0) {
      conformances.push(
        `extension ${pascal(name)} {\n  var termTag: String { switch self { ${node.variants.map(v => `case .${camel(v.name)}: return ${JSON.stringify(tagText(v.name))}`).join('; ')} } }\n}`,
      )
    }
  }

  body.push(...conformances)

  // `run-pending` drains through the spawn runtime, written by its binding (deck/base/code/pending.tree)
  if (body.some(line => line.includes('__termDrain('))) {
    st.needs.set('spawn', true)
  }

  const prelude = (Object.keys(SWIFT_HELPERS) as SwiftHelper[]).filter(h => st.needs.has(h)).map(h => SWIFT_HELPERS[h])

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
          `  hiveWake(name: ${JSON.stringify(group.deck)}, roll: SeedList<HiveEntry>([${group.entries.map(entryText).join(', ')}]))`,
      )
      .join('\n')

    wake.push(`func wakeHive() -> Void {\n${calls}\n}`)
  }

  const text = [...imports, ...prelude, ...body, ...swiftNames.swiftFormWalk([...st.fillSpecs.values()] as never, [...st.meltSpecs.values()] as never, SWIFT_FORM_HELPERS), ...wake].join('\n\n') + '\n'

  // with `units`, each module's statements still marked, for the caller to write one file per module
  return options?.units ? text : unmarked(text)
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