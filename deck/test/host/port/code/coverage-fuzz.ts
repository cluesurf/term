;
// Bitwise integer operations over the node host, 64-bit like the compiled backends: the answer is the signed
// 64-bit one, so a mask such as 0xffffffff is a mask and not the JavaScript 32-bit coercion to -1. The result rides a
// plain number, so it is exact within the 53-bit safe-integer range (the same bound every number on this host lives
// under). Reached only through the public bit API.
//
// Each op takes JavaScript's own operator where that IS the 64-bit answer, and goes through BigInt only past it:
//   - two values in the signed 32-bit range sign-extend to 64 bits, and and, or, xor and not on sign-extended values are
//     the sign extension of the 32-bit result, which is what `a & b` gives
//   - two values in the unsigned 32-bit range have zero upper bits, so the 64-bit result is the 32-bit one read
//     unsigned, which is what `(a & b) >>> 0` gives
//   - a shift of a safe integer whose result is still safe is multiplication or floored division by a power of two
// Every BigInt allocated three objects per operation, and hash and digest loops spent most of their time there
// (note/term/codegen/browser.md, B4).
const __bitSigned32 = (x: number): boolean => (x | 0) === x
const __bitUnsigned32 = (x: number): boolean => x >>> 0 === x
const __bitShiftable = (value: number, count: number): boolean =>
  Number.isSafeInteger(value) && Number.isInteger(count) && count >= 0 && count < 64
const __bitWide = (op: (a: bigint, b: bigint) => bigint, left: number, right: number): number =>
  Number(BigInt.asIntN(64, op(BigInt(Math.trunc(left)), BigInt(Math.trunc(right)))))
const bit = {
  and: (left: number, right: number): number =>
    __bitSigned32(left) && __bitSigned32(right)
      ? left & right
      : __bitUnsigned32(left) && __bitUnsigned32(right)
        ? (left & right) >>> 0
        : __bitWide((a, b) => a & b, left, right),
  or: (left: number, right: number): number =>
    __bitSigned32(left) && __bitSigned32(right)
      ? left | right
      : __bitUnsigned32(left) && __bitUnsigned32(right)
        ? (left | right) >>> 0
        : __bitWide((a, b) => a | b, left, right),
  exclusiveOr: (left: number, right: number): number =>
    __bitSigned32(left) && __bitSigned32(right)
      ? left ^ right
      : __bitUnsigned32(left) && __bitUnsigned32(right)
        ? (left ^ right) >>> 0
        : __bitWide((a, b) => a ^ b, left, right),
  not: (value: number): number =>
    __bitSigned32(value) ? ~value : Number(BigInt.asIntN(64, ~BigInt(Math.trunc(value)))),
  shiftLeft: (value: number, count: number): number => {
    if (__bitShiftable(value, count)) {
      const shifted = value * 2 ** count
      if (Number.isSafeInteger(shifted)) return shifted + 0
    }
    return __bitWide((a, b) => a << b, value, count)
  },
  // arithmetic (sign-preserving), matching the compiled backends
  shiftRight: (value: number, count: number): number =>
    __bitShiftable(value, count) ? Math.floor(value / 2 ** count) + 0 : __bitWide((a, b) => a >> b, value, count),
  shiftRightUnsigned: (value: number, count: number): number =>
    __bitShiftable(value, count) && value >= 0
      ? Math.floor(value / 2 ** count)
      : Number(BigInt.asUintN(64, BigInt(Math.trunc(value))) >> BigInt(Math.trunc(count))),
  // A SIGNED 32-BIT MULTIPLY WITH WRAPAROUND. `Math.imul` exactly: the high bits are DISCARDED, which is what
  // the classic string hashes are defined in terms of. The other ops here are 64-bit; this one is deliberately not,
  // because a 64-bit product would give a different number and cyrb53 would stop being cyrb53.
  multiply32: (left: number, right: number): number =>
    Math.imul(Math.trunc(left), Math.trunc(right)),
}

declare const Math: any
const math: any = typeof Math === "undefined" ? undefined : Math

function __termInt(x: number): number {
  if (!(x <= 9007199254740991 && x >= -9007199254740991)) __termIntStop(x)
  return x
}
function __termIntStop(x: number): never {
  const base = !Number.isFinite(x)
    ? { host: "@term/base", form: "defect", note: "Invalid", code: "", time: Date.now(), link: { thing: "a division or remainder by zero" } }
    : { host: "@term/base", form: x > 0 ? "excess" : "shortage", note: x > 0 ? "Too large" : "Too small", code: "", time: Date.now(), link: { thing: "number", limit: x > 0 ? 9007199254740991 : -9007199254740991, actual: x } }
  throw Object.assign(new Error(base.note), base, { name: "TermException" })
}

const __termShared = Symbol.for('term.shared')
function __termShare<T extends object>(value: T): T {
  Object.defineProperty(value, __termShared, { value: true })
  return value
}
function __termEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a == null || b == null) return a == b
  if (typeof a !== 'object' || typeof b !== 'object') return false
  if (__termShared in (a as object) || __termShared in (b as object)) return false
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!__termEqual(a[i], b[i])) return false
    return true
  }
  if (a instanceof Map) {
    if (!(b instanceof Map) || a.size !== b.size) return false
    for (const [k, v] of a) if (!b.has(k) || !__termEqual(v, b.get(k))) return false
    return true
  }
  if (a instanceof Uint8Array) {
    if (!(b instanceof Uint8Array) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
    return true
  }
  if (Object.getPrototypeOf(a) !== Object.prototype || Object.getPrototypeOf(b) !== Object.prototype) return false
  const ka = Object.keys(a as object)
  if (ka.length !== Object.keys(b as object).length) return false
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false
    if (!__termEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false
  }
  return true
}
function __termKeyText(v: unknown): string {
  if (v === undefined) return 'u'
  if (v === null) return 'z'
  switch (typeof v) {
    case 'number': return 'n' + (Object.is(v, -0) ? '0' : String(v))
    case 'string': return 's' + JSON.stringify(v)
    case 'boolean': return v ? 't' : 'f'
    case 'bigint': return 'b' + String(v)
    case 'object': break
    default: return 'i' + __termIdentity(v as object)
  }
  if (__termShared in (v as object)) return 'i' + __termIdentity(v as object)
  if (Array.isArray(v)) return '[' + v.map(__termKeyText).join(',') + ']'
  if (v instanceof Map) return '{' + Array.from(v, ([k, x]) => __termKeyText(k) + ':' + __termKeyText(x)).sort().join(',') + '}'
  if (v instanceof Uint8Array) return 'y' + Array.from(v).join('.')
  if (Object.getPrototypeOf(v) !== Object.prototype) return 'i' + __termIdentity(v as object)
  const o = v as Record<string, unknown>
  return '(' + Object.keys(o).sort().map(k => JSON.stringify(k) + ':' + __termKeyText(o[k])).join(',') + ')'
}
function __termIdentity(v: object): number {
  const g = globalThis as { __termIdentities?: WeakMap<object, number>; __termIdentityNext?: number }
  const ids = (g.__termIdentities ??= new WeakMap())
  let id = ids.get(v)
  if (id === undefined) { id = g.__termIdentityNext = (g.__termIdentityNext ?? 0) + 1; ids.set(v, id) }
  return id
}
function __termKey<T>(k: T): T {
  if (typeof k !== 'object' || k === null) return k
  const g = globalThis as { __termKeys?: Map<string, WeakRef<object>>; __termKeysGone?: FinalizationRegistry<string> }
  const keys = (g.__termKeys ??= new Map())
  const gone = (g.__termKeysGone ??= new FinalizationRegistry(text => { if (keys.get(text)?.deref() === undefined) keys.delete(text) }))
  const text = __termKeyText(k)
  const seen = keys.get(text)?.deref()
  if (seen !== undefined) return seen as T
  keys.set(text, new WeakRef(k as object))
  gone.register(k as object, text)
  return k
}

function __termStop(thing: string): never {
  const base = { host: "@term/base", form: "defect", note: "Invalid", code: "", time: Date.now(), link: { thing } }
  throw Object.assign(new Error(base.note), base, { name: "TermException" })
}
function __termAt<T>(a: T[], i: number): T {
  if (!(i >= 0 && i < a.length)) __termStop("a list read at " + i + " of " + a.length)
  return a[i]!
}
function __termReadPast(a: unknown[], i: number): never {
  return __termStop("a list read at " + i + " of " + a.length)
}
function __termWritePast(a: unknown[], i: number): never {
  return __termStop("a list write at " + i + " of " + a.length)
}
function __termPut<T>(a: T[], i: number, v: T): T {
  if (!(i >= 0 && i < a.length)) __termStop("a list write at " + i + " of " + a.length)
  return (a[i] = v)
}
function __termPop<T>(a: T[]): T {
  if (a.length === 0) __termStop("a pop of an empty list")
  return a.pop()!
}
function __termShift<T>(a: T[]): T {
  if (a.length === 0) __termStop("a shift of an empty list")
  return a.shift()!
}
function __termSlice<T>(a: T[], s: number, e?: number): T[] {
  const n = a.length
  const x = Math.min(Math.max(s, 0), n)
  const y = Math.min(Math.max(e === undefined ? n : e, 0), n)
  return x < y ? a.slice(x, y) : []
}
function __termSplice<T>(a: T[], s: number, d: number, ...items: T[]): T[] {
  const x = Math.min(Math.max(s, 0), a.length)
  return a.splice(x, Math.min(Math.max(d, 0), a.length - x), ...items)
}

const __termVariantNone = Object.freeze({ form: "none" as const })

export type Maybe<T = any> =
  | { form: "some"; value: T }
  | { form: "none" }

export type Side =
  | { form: "start" }
  | { form: "end" }
  | { form: "both" }

export function hashGet<K, V>(self: Map<K, V>, key: K): Maybe<V> {
  if (self.has(__termKey(key))) {
    return { form: "some", value: self.get(__termKey(key))! }
  } else {
    return __termVariantNone
  }
}

export function hashSet<K, V>(self: Map<K, V>, key: K, value: V): Map<K, V> {
  return self.set(__termKey(key), value)
}

export function hashHas<K, V>(self: Map<K, V>, key: K): boolean {
  return self.has(__termKey(key))
}

export function listGet<T>(self: T[], index: number): T {
  return (index >= 0 && index < self.length ? self[index]! : __termReadPast(self, index))
}

export function listSet<T>(self: T[], index: number, item: T): T[] {
  __termSplice(self, index, 1, item)
  return self
}

export function listCopy<T>(self: T[]): T[] {
  return __termSlice(self, 0)
}

export function listSlice<T>(self: T[], start: number, end: number): T[] {
  return __termSlice(self, start, end)
}

export function round(value: number): number {
  return math.round(value)
}

const wordMask: number = 4294967295

export function low32(value: number): number {
  return bit.and(value, wordMask)
}

export function seedState(seed: number): number[] {
  return [bit.and(seed, wordMask)]
}

export function nextRandom(state: number[]): number {
  const stepped: number = low32((0 < state.length ? state[0]! : __termReadPast(state, 0)) + 1831565813)
  __termPut(state, 0, stepped)
  const mixed: number = low32(bit.multiply32(low32(bit.exclusiveOr(stepped, bit.shiftRightUnsigned(bit.and(stepped, wordMask), 15))), low32(bit.or(stepped, 1))))
  const folded: number = low32(bit.multiply32(low32(bit.exclusiveOr(mixed, bit.shiftRightUnsigned(bit.and(mixed, wordMask), 7))), low32(bit.or(mixed, 61))))
  const spread: number = low32(bit.exclusiveOr(mixed, bit.and(__termInt(mixed + folded), wordMask)))
  const out: number = low32(bit.exclusiveOr(spread, bit.shiftRightUnsigned(bit.and(spread, wordMask), 14)))
  return out / 4294967296
}

export interface CoverageSink {
  hits: number[]
  sites: number[]
}

export interface FuzzResult {
  crashed: boolean
  crash: number[]
  execs: number
  edgesFound: number
  corpusSize: number
}

export function freshSink(): CoverageSink {
  const hits: number[] = ([] as number[])
  const sites: number[] = [0]
  return { hits: hits, sites: sites }
}

export function coverEdge(sink: CoverageSink, id: number): void {
  sink.hits.push(id)
}

export function matchingBits(a: number, b: number): number {
  let x: number = low32(bit.exclusiveOr(a, b))
  if (x === 0) {
    return 32
  }
  let n: number = 0
  while (bit.and(x, 2147483648) === 0) {
    const __n0 = n + 1; if (!(__n0 <= 9007199254740991 && __n0 >= -9007199254740991)) __termIntStop(__n0); n = __n0
    x = low32(bit.shiftLeft(x, 1))
  }
  return n
}

export function coverCompare(sink: CoverageSink, a: number, b: number): void {
  const site: number = listGet(sink.sites, 0)
  sink.hits.push(__termInt(__termInt(1073741824 + __termInt(site * 64)) + matchingBits(a, b)))
  __termPut(sink.sites, 0, __termInt(site + 1))
}

const interesting: number[] = [0, 1, -1, 2, 7, 8, 13, 16, 32, 42, 64, 100, 127, 128, 255, 256, -128, 1000, -1000]

export function drawUnder(state: number[], count: number): number {
  return Math.trunc(math.floor(nextRandom(state) * count))
}

export function mutate(parent: number[], corpus: number[][], state: number[]): number[] {
  const child: number[] = listCopy(parent)
  const __n1 = 1 + Math.trunc(math.floor(nextRandom(state) * 4)); if (!(__n1 <= 9007199254740991 && __n1 >= -9007199254740991)) __termIntStop(__n1); const rounds: number = __n1
  let round: number = 0
  while (round < rounds) {
    const at: number = Math.trunc(math.floor(nextRandom(state) * child.length))
    const op: number = Math.trunc(math.floor(nextRandom(state) * 5))
    if (op === 0) {
      __termPut(child, at, bit.exclusiveOr(listGet(child, at), bit.shiftLeft(1, Math.trunc(math.floor(nextRandom(state) * 16)))))
    }
    if (op === 1) {
      __termPut(child, at, __termInt(listGet(child, at) + __termInt(Math.trunc(math.floor(nextRandom(state) * 7)) - 3)))
    }
    if (op === 2) {
      __termPut(child, at, listGet(interesting, Math.trunc(math.floor(nextRandom(state) * interesting.length))))
    }
    if (op === 3) {
      __termPut(child, at, __termInt(0 - listGet(child, at)))
    }
    if (op === 4 && corpus.length > 1) {
      const other: number[] = listGet(corpus, Math.trunc(math.floor(nextRandom(state) * corpus.length)))
      __termPut(child, at, listGet(other, __termInt(at % other.length)))
    }
    round = round + 1
  }
  return child
}

export function pickEntry(novelty: number[], chosen: number[], state: number[]): number {
  let best: number = 0
  let bestKey: number = -1
  let at: number = 0
  for (const each of novelty) {
    let weight: number = each / __termInt(listGet(chosen, at) + 1)
    if (weight < 0.01) {
      weight = 0.01
    }
    const key: number = math.pow(nextRandom(state), 1 / weight)
    if (key > bestKey) {
      bestKey = key
      best = at
    }
    const __n2 = at + 1; if (!(__n2 <= 9007199254740991 && __n2 >= -9007199254740991)) __termIntStop(__n2); at = __n2
  }
  return best
}

export function minimizeCrash(target: (a0: number[], a1: CoverageSink) => boolean, crash: number[]): number[] {
  let current: number[] = listCopy(crash)
  let at: number = 0
  while (at < current.length) {
    const tries: number[] = [0, 1, -1]
    let done: boolean = false
    for (const value of tries) {
      if (!done) {
        const trial: number[] = listCopy(current)
        __termPut(trial, at, value)
        if (target(trial, freshSink())) {
          current = trial
          done = true
        }
      }
    }
    at = at + 1
  }
  return current
}

export function fuzz(target: (a0: number[], a1: CoverageSink) => boolean, arity: number, seeds: number[][], iterations: number, seed: number): FuzzResult {
  const state: number[] = seedState(seed)
  const seen: Map<number, boolean> = new Map()
  const corpus: number[][] = ([] as number[][])
  const novelty: number[] = ([] as number[])
  const chosen: number[] = ([] as number[])
  let execs: number = 0
  let edges: number = 0
  const starts: number[][] = ([] as number[][])
  for (const each of seeds) {
    starts.push(each)
  }
  if (starts.length === 0) {
    const zeros: number[] = ([] as number[])
    let at: number = 0
    while (at < arity) {
      zeros.push(0)
      at = at + 1
    }
    starts.push(zeros)
  }
  let crashed: boolean = false
  let crash: number[] = ([] as number[])
  for (const start of starts) {
    if (!crashed) {
      const sink: CoverageSink = freshSink()
      const __n3 = execs + 1; if (!(__n3 <= 9007199254740991 && __n3 >= -9007199254740991)) __termIntStop(__n3); execs = __n3
      const failed: boolean = target(start, sink)
      let fresh: number = 0
      for (const hit of sink.hits) {
        if (!hashHas(seen, hit)) {
          seen.set(hit, true)
          const __n4 = edges + 1; if (!(__n4 <= 9007199254740991 && __n4 >= -9007199254740991)) __termIntStop(__n4); edges = __n4
          const __n5 = fresh + 1; if (!(__n5 <= 9007199254740991 && __n5 >= -9007199254740991)) __termIntStop(__n5); fresh = __n5
        }
      }
      if (failed) {
        crashed = true
        crash = start
      } else {
        corpus.push(start)
        novelty.push(__termInt(fresh + 1))
        chosen.push(0)
      }
    }
  }
  while (!crashed && execs < iterations) {
    const parent: number = pickEntry(novelty, chosen, state)
    __termPut(chosen, parent, __termInt(listGet(chosen, parent) + 1))
    const __n6 = 1 + Math.trunc(math.floor(listGet(novelty, parent) / __termInt(listGet(chosen, parent) + 1))); if (!(__n6 <= 9007199254740991 && __n6 >= -9007199254740991)) __termIntStop(__n6); const energy: number = __n6
    let turn: number = 0
    while (turn < energy && execs < iterations && !crashed) {
      const child: number[] = mutate(listGet(corpus, parent), corpus, state)
      const sink: CoverageSink = freshSink()
      const __n7 = execs + 1; if (!(__n7 <= 9007199254740991 && __n7 >= -9007199254740991)) __termIntStop(__n7); execs = __n7
      const failed: boolean = target(child, sink)
      let fresh: number = 0
      for (const hit of sink.hits) {
        if (!hashHas(seen, hit)) {
          seen.set(hit, true)
          const __n8 = edges + 1; if (!(__n8 <= 9007199254740991 && __n8 >= -9007199254740991)) __termIntStop(__n8); edges = __n8
          const __n9 = fresh + 1; if (!(__n9 <= 9007199254740991 && __n9 >= -9007199254740991)) __termIntStop(__n9); fresh = __n9
        }
      }
      if (failed) {
        crashed = true
        crash = child
      } else {
        if (fresh > 0) {
          corpus.push(child)
          novelty.push(fresh)
          chosen.push(0)
        }
      }
      const __n10 = turn + 1; if (!(__n10 <= 9007199254740991 && __n10 >= -9007199254740991)) __termIntStop(__n10); turn = __n10
    }
  }
  const none: number[] = ([] as number[])
  if (crashed) {
    return { crashed: true, crash: minimizeCrash(target, crash), execs: execs, edgesFound: edges, corpusSize: corpus.length }
  }
  return { crashed: false, crash: none, execs: execs, edgesFound: edges, corpusSize: corpus.length }
}
