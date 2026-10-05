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

export function maybeUnwrapOr<T>(self: Maybe<T>, fallback: T): T {
  if (self.form === "some") {
    return self.value
  } else {
    return fallback
  }
}

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

export function hashGetOrDefault<K, V>(self: Map<K, V>, key: K, fallback: V): V {
  return maybeUnwrapOr(hashGet(self, key), fallback)
}

export function listGet<T>(self: T[], index: number): T {
  return (index >= 0 && index < self.length ? self[index]! : __termReadPast(self, index))
}

export function listSet<T>(self: T[], index: number, item: T): T[] {
  __termSplice(self, index, 1, item)
  return self
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

export type Expression =
  | { form: "var"; index: number }
  | { form: "const"; value: number }
  | { form: "add"; left: Expression; right: Expression }
  | { form: "sub"; left: Expression; right: Expression }
  | { form: "min"; left: Expression; right: Expression }
  | { form: "max"; left: Expression; right: Expression }
  | { form: "ite"; test: Condition; then: Expression; else: Expression }

export type Condition =
  | { form: "ge"; left: Expression; right: Expression }
  | { form: "gt"; left: Expression; right: Expression }
  | { form: "eq"; left: Expression; right: Expression }

export function evalExpr(expr: Expression, inputs: number[]): number {
  if (expr.form === "var") {
    const index = expr.index
    return listGet(inputs, index)
  } else if (expr.form === "const") {
    const value = expr.value
    return value
  } else if (expr.form === "add") {
    const left = expr.left
    const right = expr.right
    const __n0 = evalExpr(left, inputs) + evalExpr(right, inputs); if (!(__n0 <= 9007199254740991 && __n0 >= -9007199254740991)) __termIntStop(__n0); return __n0
  } else if (expr.form === "sub") {
    const left = expr.left
    const right = expr.right
    const __n1 = evalExpr(left, inputs) - evalExpr(right, inputs); if (!(__n1 <= 9007199254740991 && __n1 >= -9007199254740991)) __termIntStop(__n1); return __n1
  } else if (expr.form === "min") {
    const left = expr.left
    const right = expr.right
    const l: number = evalExpr(left, inputs)
    const r: number = evalExpr(right, inputs)
    if (r < l) {
      return r
    }
    return l
  } else if (expr.form === "max") {
    const left = expr.left
    const right = expr.right
    const l: number = evalExpr(left, inputs)
    const r: number = evalExpr(right, inputs)
    if (r > l) {
      return r
    }
    return l
  } else {
    const test = expr.test
    const then = expr.then
    const else_ = expr.else
    if (evalCond(test, inputs)) {
      return evalExpr(then, inputs)
    }
    return evalExpr(else_, inputs)
  }
}

export function evalCond(cond: Condition, inputs: number[]): boolean {
  if (cond.form === "ge") {
    const left = cond.left
    const right = cond.right
    return evalExpr(left, inputs) >= evalExpr(right, inputs)
  } else if (cond.form === "gt") {
    const left = cond.left
    const right = cond.right
    return evalExpr(left, inputs) > evalExpr(right, inputs)
  } else {
    const left = cond.left
    const right = cond.right
    return evalExpr(left, inputs) === evalExpr(right, inputs)
  }
}

export function exprsOfSize(size: number, varCount: number, cache: Map<number, Expression[]>): Expression[] {
  if (hashHas(cache, size)) {
    return hashGetOrDefault(cache, size, ([] as Expression[]))
  }
  const out: Expression[] = ([] as Expression[])
  if (size === 1) {
    let index: number = 0
    while (index < varCount) {
      out.push({ form: "var", index: index })
      index = index + 1
    }
    out.push({ form: "const", value: 0 })
    out.push({ form: "const", value: 1 })
    cache.set(size, out)
    return out
  }
  let a: number = 1
  while (a < size) {
    const __n2 = __termInt(size - 1) - a; if (!(__n2 <= 9007199254740991 && __n2 >= -9007199254740991)) __termIntStop(__n2); const b: number = __n2
    if (b >= 1) {
      const lefts: Expression[] = exprsOfSize(a, varCount, cache)
      const rights: Expression[] = exprsOfSize(b, varCount, cache)
      for (const left of lefts) {
        for (const right of rights) {
          out.push({ form: "add", left: left, right: right })
          out.push({ form: "sub", left: left, right: right })
          out.push({ form: "min", left: left, right: right })
          out.push({ form: "max", left: left, right: right })
        }
      }
    }
    a = a + 1
  }
  if (size >= 4) {
    const atoms: Expression[] = exprsOfSize(1, varCount, cache)
    for (const tl of atoms) {
      for (const tr of atoms) {
        for (const thenExpr of atoms) {
          for (const elseExpr of atoms) {
            out.push({ form: "ite", test: { form: "ge", left: tl, right: tr }, then: thenExpr, else: elseExpr })
            out.push({ form: "ite", test: { form: "gt", left: tl, right: tr }, then: thenExpr, else: elseExpr })
          }
        }
      }
    }
  }
  cache.set(size, out)
  return out
}

export function enumerateIn01(maxSize: number, varCount: number): Expression[] {
  const cache: Map<number, Expression[]> = new Map()
  const out: Expression[] = ([] as Expression[])
  let size: number = 1
  while (size <= maxSize) {
    for (const each of exprsOfSize(size, varCount, cache)) {
      out.push(each)
    }
    const __n3 = size + 1; if (!(__n3 <= 9007199254740991 && __n3 >= -9007199254740991)) __termIntStop(__n3); size = __n3
  }
  return out
}

export type Predicate =
  | { form: "ge"; left: Expression; right: Expression }
  | { form: "le"; left: Expression; right: Expression }
  | { form: "eq"; left: Expression; right: Expression }
  | { form: "and"; left: Predicate; right: Predicate }
  | { form: "or"; left: Predicate; right: Predicate }
  | { form: "not"; inner: Predicate }

export function evalPred(pred: Predicate, inputs: number[]): boolean {
  if (pred.form === "ge") {
    const left = pred.left
    const right = pred.right
    return evalExpr(left, inputs) >= evalExpr(right, inputs)
  } else if (pred.form === "le") {
    const left = pred.left
    const right = pred.right
    return evalExpr(left, inputs) <= evalExpr(right, inputs)
  } else if (pred.form === "eq") {
    const left = pred.left
    const right = pred.right
    return evalExpr(left, inputs) === evalExpr(right, inputs)
  } else if (pred.form === "and") {
    const left = pred.left
    const right = pred.right
    if (evalPred(left, inputs)) {
      return evalPred(right, inputs)
    }
    return false
  } else if (pred.form === "or") {
    const left = pred.left
    const right = pred.right
    if (evalPred(left, inputs)) {
      return true
    }
    return evalPred(right, inputs)
  } else {
    const inner = pred.inner
    return !evalPred(inner, inputs)
  }
}

export function comparePred(kind: string, left: Expression, right: Expression): Predicate {
  if (kind === "ge") {
    return { form: "ge", left: left, right: right }
  }
  if (kind === "le") {
    return { form: "le", left: left, right: right }
  }
  return { form: "eq", left: left, right: right }
}

export function enumeratePreds(varCount: number, exprSize: number, predSize: number): Predicate[] {
  const exprs: Expression[] = enumerateIn01(exprSize, varCount)
  const atoms: Predicate[] = ([] as Predicate[])
  for (const left of exprs) {
    for (const right of exprs) {
      atoms.push(comparePred("ge", left, right))
      atoms.push(comparePred("le", left, right))
      atoms.push(comparePred("eq", left, right))
    }
  }
  const bySize: Map<number, Predicate[]> = new Map()
  bySize.set(1, atoms)
  let size: number = 2
  while (size <= predSize) {
    const here: Predicate[] = ([] as Predicate[])
    for (const inner of hashGetOrDefault(bySize, size - 1, ([] as Predicate[]))) {
      here.push({ form: "not", inner: inner })
    }
    let a: number = 1
    while (a < size) {
      const b: number = size - 1 - a
      if (b >= 1) {
        for (const left of hashGetOrDefault(bySize, a, ([] as Predicate[]))) {
          for (const right of hashGetOrDefault(bySize, b, ([] as Predicate[]))) {
            here.push({ form: "and", left: left, right: right })
            here.push({ form: "or", left: left, right: right })
          }
        }
      }
      a = a + 1
    }
    bySize.set(size, here)
    size = size + 1
  }
  const out: Predicate[] = ([] as Predicate[])
  size = 1
  while (size <= predSize) {
    for (const each of hashGetOrDefault(bySize, size, ([] as Predicate[]))) {
      out.push(each)
    }
    size = size + 1
  }
  return out
}

export interface MapResult {
  ok: boolean
  transform: Expression
  counterexamples: number[][]
  reason: string
}

export interface FilterResult {
  ok: boolean
  keep: Predicate
  counterexamples: number[][]
  reason: string
}

export function randomLists(seed: number, count: number): number[][] {
  const state: number[] = seedState(seed)
  const lists: number[][] = ([] as number[][])
  let made: number = 0
  while (made < count) {
    const size: number = Math.trunc(math.floor(nextRandom(state) * 6))
    const one: number[] = ([] as number[])
    let at: number = 0
    while (at < size) {
      one.push(__termInt(Math.trunc(math.floor(nextRandom(state) * 12)) - 4))
      at = at + 1
    }
    lists.push(one)
    made = made + 1
  }
  return lists
}

export function sameList(left: number[], right: number[]): boolean {
  if (left.length !== right.length) {
    return false
  }
  let at: number = 0
  for (const each of left) {
    if (each !== listGet(right, at)) {
      return false
    }
    const __n4 = at + 1; if (!(__n4 <= 9007199254740991 && __n4 >= -9007199254740991)) __termIntStop(__n4); at = __n4
  }
  return true
}

export function mapped(transform: Expression, items: number[]): number[] {
  const out: number[] = ([] as number[])
  for (const each of items) {
    const point: number[] = [each]
    out.push(evalExpr(transform, point))
  }
  return out
}

export function kept(keep: Predicate, items: number[]): number[] {
  const out: number[] = ([] as number[])
  for (const each of items) {
    const point: number[] = [each]
    if (evalPred(keep, point)) {
      out.push(each)
    }
  }
  return out
}

export function mapFits(transform: Expression, spec: (a0: number[]) => number[], lists: number[][]): boolean {
  for (const items of lists) {
    if (!sameList(mapped(transform, items), spec(items))) {
      return false
    }
  }
  return true
}

export function filterFits(keep: Predicate, spec: (a0: number[]) => number[], lists: number[][]): boolean {
  for (const items of lists) {
    if (!sameList(kept(keep, items), spec(items))) {
      return false
    }
  }
  return true
}

export function mapMissed(reason: string, counterexamples: number[][]): MapResult {
  return { ok: false, transform: { form: "const", value: 0 }, counterexamples: counterexamples, reason: reason }
}

export function filterMissed(reason: string, counterexamples: number[][]): FilterResult {
  return { ok: false, keep: comparePred("ge", { form: "const", value: 0 }, { form: "const", value: 0 }), counterexamples: counterexamples, reason: reason }
}

export function synthesizeMap(spec: (a0: number[]) => number[], maxSize: number, seed: number): MapResult {
  const candidates: Expression[] = enumerateIn01(maxSize, 1)
  const probes: number[][] = randomLists(seed, 400)
  const counterexamples: number[][] = ([] as number[][])
  let round: number = 0
  while (round <= candidates.length) {
    let found: boolean = false
    let pick: Expression = { form: "const", value: 0 }
    for (const each of candidates) {
      if (!found && mapFits(each, spec, counterexamples)) {
        pick = each
        found = true
      }
    }
    if (!found) {
      return { ok: false, transform: { form: "const", value: 0 }, counterexamples: counterexamples, reason: "no element transform fits" }
    }
    let missed: boolean = false
    for (const items of probes) {
      if (!missed && !sameList(mapped(pick, items), spec(items))) {
        counterexamples.push(items)
        missed = true
      }
    }
    if (!missed) {
      return { ok: true, transform: pick, counterexamples: counterexamples, reason: "" }
    }
    const __n5 = round + 1; if (!(__n5 <= 9007199254740991 && __n5 >= -9007199254740991)) __termIntStop(__n5); round = __n5
  }
  return { ok: false, transform: { form: "const", value: 0 }, counterexamples: counterexamples, reason: "did not converge" }
}

export function synthesizeFilter(spec: (a0: number[]) => number[], seed: number): FilterResult {
  const preds: Predicate[] = enumeratePreds(1, 2, 2)
  const probes: number[][] = randomLists(seed, 400)
  const counterexamples: number[][] = ([] as number[][])
  let round: number = 0
  while (round <= preds.length) {
    let found: boolean = false
    let pick: Predicate = comparePred("ge", { form: "const", value: 0 }, { form: "const", value: 0 })
    for (const each of preds) {
      if (!found && filterFits(each, spec, counterexamples)) {
        pick = each
        found = true
      }
    }
    if (!found) {
      return { ok: false, keep: comparePred("ge", { form: "const", value: 0 }, { form: "const", value: 0 }), counterexamples: counterexamples, reason: "no keep-predicate fits" }
    }
    let missed: boolean = false
    for (const items of probes) {
      if (!missed && !sameList(kept(pick, items), spec(items))) {
        counterexamples.push(items)
        missed = true
      }
    }
    if (!missed) {
      return { ok: true, keep: pick, counterexamples: counterexamples, reason: "" }
    }
    const __n6 = round + 1; if (!(__n6 <= 9007199254740991 && __n6 >= -9007199254740991)) __termIntStop(__n6); round = __n6
  }
  return { ok: false, keep: comparePred("ge", { form: "const", value: 0 }, { form: "const", value: 0 }), counterexamples: counterexamples, reason: "did not converge" }
}
