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

export function listUnique<T>(self: T[]): T[] {
  const out: T[] = ([] as T[])
  for (const value of self) {
    const seen: boolean = out.some((__e) => __termEqual(__e, value))
    if (!seen) {
      out.push(value)
    }
  }
  return out
}

export interface DiagramNode {
  variable: number
  low: number
  high: number
}

export interface DiagramManager {
  nodes: DiagramNode[]
  unique: Map<string, number>
  iteCache: Map<string, number>
  position: Map<number, number>
}

export function levelOf(manager: DiagramManager, variable: number): number {
  return hashGetOrDefault(manager.position, variable, variable)
}

export function makeNode(manager: DiagramManager, variable: number, low: number, high: number): number {
  if (low === high) {
    return low
  }
  const key: string = `${variable}:${low}:${high}`
  if (hashHas(manager.unique, key)) {
    return hashGetOrDefault(manager.unique, key, 0)
  }
  const __n0 = manager.nodes.length + 2; if (!(__n0 <= 9007199254740991 && __n0 >= -9007199254740991)) __termIntStop(__n0); const id: number = __n0
  manager.nodes.push({ variable: variable, low: low, high: high })
  manager.unique.set(key, id)
  return id
}

export function ifThenElse(manager: DiagramManager, f: number, g: number, h: number): number {
  if (f === 1) {
    return g
  }
  if (f === 0) {
    return h
  }
  if (g === h) {
    return g
  }
  if (g === 1 && h === 0) {
    return f
  }
  const key: string = `${f}?${g}:${h}`
  if (hashHas(manager.iteCache, key)) {
    return hashGetOrDefault(manager.iteCache, key, 0)
  }
  const top: number = lowestVariable(manager, f, g, h)
  const low: number = ifThenElse(manager, restrictTop(manager, f, top, false), restrictTop(manager, g, top, false), restrictTop(manager, h, top, false))
  const high: number = ifThenElse(manager, restrictTop(manager, f, top, true), restrictTop(manager, g, top, true), restrictTop(manager, h, top, true))
  const result: number = makeNode(manager, top, low, high)
  manager.iteCache.set(key, result)
  return result
}

export function lowestVariable(manager: DiagramManager, f: number, g: number, h: number): number {
  let best: number = -1
  for (const each of [f, g, h]) {
    if (each === 0 || each === 1) {} else {
      const found: DiagramNode = listGet(manager.nodes, __termInt(each - 2))
      if (best === -1 || levelOf(manager, found.variable) < hashGetOrDefault(manager.position, best, best)) {
        best = found.variable
      }
    }
  }
  return best
}

export function restrictTop(manager: DiagramManager, diagram: number, variable: number, value: boolean): number {
  if (diagram === 0 || diagram === 1) {
    return diagram
  }
  const found: DiagramNode = listGet(manager.nodes, __termInt(diagram - 2))
  if (found.variable === variable) {} else {
    return diagram
  }
  if (value) {
    return found.high
  }
  return found.low
}

export function diagramNot(manager: DiagramManager, f: number): number {
  return ifThenElse(manager, f, 0, 1)
}

export function diagramAnd(manager: DiagramManager, f: number, g: number): number {
  return ifThenElse(manager, f, g, 0)
}

export function diagramOr(manager: DiagramManager, f: number, g: number): number {
  return ifThenElse(manager, f, 1, g)
}

export function restrict(manager: DiagramManager, diagram: number, variable: number, value: boolean): number {
  if (diagram === 0 || diagram === 1) {
    return diagram
  }
  const found: DiagramNode = listGet(manager.nodes, __termInt(diagram - 2))
  if (levelOf(manager, found.variable) > hashGetOrDefault(manager.position, variable, variable)) {
    return diagram
  }
  if (found.variable === variable) {
    if (value) {
      return found.high
    }
    return found.low
  }
  return makeNode(manager, found.variable, restrict(manager, found.low, variable, value), restrict(manager, found.high, variable, value))
}

export function existsMany(manager: DiagramManager, diagram: number, variables: number[]): number {
  let result: number = diagram
  for (const each of variables) {
    result = diagramOr(manager, restrict(manager, result, each, false), restrict(manager, result, each, true))
  }
  return result
}

export interface CtlChecker {
  manager: DiagramManager
  bits: number
  transition: number
}

export function makeCtlChecker(manager: DiagramManager, bits: number, transition: number): CtlChecker {
  return { manager: manager, bits: bits, transition: transition }
}

export function nextVariables(checker: CtlChecker): number[] {
  const out: number[] = ([] as number[])
  let at: number = 0
  while (at < checker.bits) {
    out.push(__termInt(checker.bits + at))
    at = at + 1
  }
  return out
}

export function toNext(checker: CtlChecker, p: number): number {
  const manager: DiagramManager = checker.manager
  let result: number = p
  let at: number = 0
  while (at < checker.bits) {
    const chosen: number = makeNode(manager, __termInt(checker.bits + at), 0, 1)
    const whenTrue: number = restrict(manager, result, at, true)
    const whenFalse: number = restrict(manager, result, at, false)
    result = ifThenElse(manager, chosen, whenTrue, whenFalse)
    at = at + 1
  }
  return result
}

export function ex(checker: CtlChecker, p: number): number {
  const next: number = toNext(checker, p)
  const both: number = diagramAnd(checker.manager, checker.transition, next)
  return existsMany(checker.manager, both, nextVariables(checker))
}

export function ef(checker: CtlChecker, p: number): number {
  let x: number = p
  while (true) {
    const next: number = diagramOr(checker.manager, x, ex(checker, x))
    if (next === x) {
      return x
    }
    x = next
  }
  return x
}

export function eg(checker: CtlChecker, p: number): number {
  let x: number = p
  while (true) {
    const next: number = diagramAnd(checker.manager, p, ex(checker, x))
    if (next === x) {
      return x
    }
    x = next
  }
  return x
}

export function eu(checker: CtlChecker, p: number, q: number): number {
  let x: number = q
  while (true) {
    const step: number = ex(checker, x)
    const next: number = diagramOr(checker.manager, q, ifThenElse(checker.manager, p, step, 0))
    if (next === x) {
      return x
    }
    x = next
  }
  return x
}

export function ag(checker: CtlChecker, p: number): number {
  return diagramNot(checker.manager, ef(checker, ifThenElse(checker.manager, p, 0, 1)))
}

export function af(checker: CtlChecker, p: number): number {
  return diagramNot(checker.manager, eg(checker, ifThenElse(checker.manager, p, 0, 1)))
}

export function holdsInitially(checker: CtlChecker, init: number, formula: number): boolean {
  const negated: number = ifThenElse(checker.manager, formula, 0, 1)
  return ifThenElse(checker.manager, init, negated, 0) === 0
}
