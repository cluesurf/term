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

export function listCopy<T>(self: T[]): T[] {
  return __termSlice(self, 0)
}

export function listContains<T>(self: T[], item: T): boolean {
  return self.some((__e) => __termEqual(__e, item))
}

export function listSlice<T>(self: T[], start: number, end: number): T[] {
  return __termSlice(self, start, end)
}

export interface InputCell {
  value: any
  changedAt: number
  durability: number
}

export interface Memo {
  value: any
  changedAt: number
  verifiedAt: number
  deps: string[]
  durability: number
}

export interface Frame {
  deps: string[]
  durability: number
}

export interface Store {
  revision: number
  inputs: Map<string, InputCell>
  memos: Map<string, Memo>
  lastChanged: number[]
  recomputes: number
  runCount: Map<string, number>
}

export function makeStore(): Store {
  return __termShare({ revision: 1, inputs: new Map(), memos: new Map(), lastChanged: [0, 0, 0], recomputes: 0, runCount: new Map() })
}

export function makeFrame(): Frame {
  return __termShare({ deps: ([] as string[]), durability: 2 })
}

export function runs(store: Store, key: string): number {
  return hashGetOrDefault(store.runCount, key, 0)
}

export function hasInput(store: Store, key: string): boolean {
  return hashHas(store.inputs, key)
}

export function blankInput(): InputCell {
  return { value: "", changedAt: 0, durability: 0 }
}

export function inputValue(store: Store, key: string): any {
  const cell: InputCell = hashGetOrDefault(store.inputs, key, { value: "", changedAt: 0, durability: 0 })
  return cell.value
}

export function setInput(store: Store, key: string, value: any, durability: number, sameValue: boolean): void {
  if (hashHas(store.inputs, key)) {
    const held: InputCell = hashGetOrDefault(store.inputs, key, { value: "", changedAt: 0, durability: 0 })
    if (sameValue) {
      if (held.durability === durability) {
        return
      }
    }
  }
  store.revision = __termInt(store.revision + 1)
  store.inputs.set(key, makeInputCell(value, store.revision, durability))
  __termPut(store.lastChanged, durability, store.revision)
}

export function makeInputCell(value: any, changedAt: number, durability: number): InputCell {
  return { value: value, changedAt: changedAt, durability: durability }
}

export function noteDependency(frame: Frame, key: string, durability: number): void {
  if (listContains(frame.deps, key)) {} else {
    frame.deps.push(key)
  }
  if (durability < frame.durability) {
    frame.durability = durability
  }
}

export function readInput(store: Store, frame: Frame, key: string): any {
  const cell: InputCell = hashGetOrDefault(store.inputs, key, { value: "", changedAt: 0, durability: 0 })
  noteDependency(frame, key, cell.durability)
  return cell.value
}

export function hasMemo(store: Store, key: string): boolean {
  return hashHas(store.memos, key)
}

export function blankMemo(): Memo {
  return { value: "", changedAt: 0, verifiedAt: 0, deps: ([] as string[]), durability: 2 }
}

export function memoOf(store: Store, key: string): Memo {
  return hashGetOrDefault(store.memos, key, { value: "", changedAt: 0, verifiedAt: 0, deps: ([] as string[]), durability: 2 })
}

export function memoValue(store: Store, key: string): any {
  const found: Memo = hashGetOrDefault(store.memos, key, { value: "", changedAt: 0, verifiedAt: 0, deps: ([] as string[]), durability: 2 })
  return found.value
}

export function memoDeps(store: Store, key: string): string[] {
  const found: Memo = hashGetOrDefault(store.memos, key, { value: "", changedAt: 0, verifiedAt: 0, deps: ([] as string[]), durability: 2 })
  return found.deps
}

export function noteQuery(store: Store, frame: Frame, key: string): void {
  const found: Memo = hashGetOrDefault(store.memos, key, { value: "", changedAt: 0, verifiedAt: 0, deps: ([] as string[]), durability: 2 })
  noteDependency(frame, key, found.durability)
}

export function isVerified(store: Store, key: string): boolean {
  if (hashHas(store.memos, key)) {} else {
    return false
  }
  const found: Memo = hashGetOrDefault(store.memos, key, { value: "", changedAt: 0, verifiedAt: 0, deps: ([] as string[]), durability: 2 })
  return found.verifiedAt === store.revision
}

export function markVerified(store: Store, key: string): void {
  const found: Memo = hashGetOrDefault(store.memos, key, { value: "", changedAt: 0, verifiedAt: 0, deps: ([] as string[]), durability: 2 })
  found.verifiedAt = store.revision
  store.memos.set(key, found)
}

export function isUnchangedByDurability(store: Store, key: string): boolean {
  const found: Memo = hashGetOrDefault(store.memos, key, { value: "", changedAt: 0, verifiedAt: 0, deps: ([] as string[]), durability: 2 })
  let latest: number = 0
  let d: number = found.durability
  while (d <= 2) {
    const at: number = listGet(store.lastChanged, d)
    if (at > latest) {
      latest = at
    }
    d = d + 1
  }
  return latest <= found.verifiedAt
}

export function inputChangedAfter(store: Store, key: string, revision: number): boolean {
  const cell: InputCell = hashGetOrDefault(store.inputs, key, { value: "", changedAt: 0, durability: 0 })
  return cell.changedAt > revision
}

export function memoChangedAfter(store: Store, key: string, revision: number): boolean {
  const found: Memo = hashGetOrDefault(store.memos, key, { value: "", changedAt: 0, verifiedAt: 0, deps: ([] as string[]), durability: 2 })
  return found.changedAt > revision
}

export function memoVerifiedAt(store: Store, key: string): number {
  const found: Memo = hashGetOrDefault(store.memos, key, { value: "", changedAt: 0, verifiedAt: 0, deps: ([] as string[]), durability: 2 })
  return found.verifiedAt
}

export function storeResult(store: Store, key: string, value: any, equalPrevious: boolean, frame: Frame): void {
  store.recomputes = __termInt(store.recomputes + 1)
  store.runCount.set(key, __termInt(hashGetOrDefault(store.runCount, key, 0) + 1))
  const previous: Memo = hashGetOrDefault(store.memos, key, { value: "", changedAt: 0, verifiedAt: 0, deps: ([] as string[]), durability: 2 })
  let changedAt: number = store.revision
  if (equalPrevious) {
    changedAt = previous.changedAt
  }
  store.memos.set(key, makeMemo(value, changedAt, store.revision, listCopy(frame.deps), frame.durability))
}

export function makeMemo(value: any, changedAt: number, verifiedAt: number, deps: string[], durability: number): Memo {
  return { value: value, changedAt: changedAt, verifiedAt: verifiedAt, deps: deps, durability: durability }
}

export function revisionOf(store: Store): number {
  return store.revision
}

export function recomputesOf(store: Store): number {
  return store.recomputes
}
