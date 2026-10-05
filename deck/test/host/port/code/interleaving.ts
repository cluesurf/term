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

export function hashSet<K, V>(self: Map<K, V>, key: K, value: V): Map<K, V> {
  return self.set(__termKey(key), value)
}

export function hashHas<K, V>(self: Map<K, V>, key: K): boolean {
  return self.has(__termKey(key))
}

export function hashRemove<K, V>(self: Map<K, V>, key: K): boolean {
  return self.delete(__termKey(key))
}

export function listSet<T>(self: T[], index: number, item: T): T[] {
  __termSplice(self, index, 1, item)
  return self
}

export function listContains<T>(self: T[], item: T): boolean {
  return self.some((__e) => __termEqual(__e, item))
}

export interface Action<S = any> {
  id: string
  enabled: (a0: S) => boolean
  fire: (a0: S) => S
  reads: string[]
  writes: string[]
}

export interface ConcurrentSystem<S = any> {
  init: S
  actions: Action<S>[]
  key: (a0: S) => string
}

export interface Exploration {
  states: number
  transitions: number
  badReached: boolean
}

export interface Search {
  seen: Map<string, boolean>
  onStack: Map<string, boolean>
  transitions: number
  badReached: boolean
}

export function independent<S>(a: Action<S>, b: Action<S>): boolean {
  for (const written of a.writes) {
    if (listContains(b.reads, written) || listContains(b.writes, written)) {
      return false
    }
  }
  for (const written of b.writes) {
    if (listContains(a.reads, written) || listContains(a.writes, written)) {
      return false
    }
  }
  return true
}

export function reachFull<S>(system: ConcurrentSystem<S>, bad: (a0: S) => boolean): Exploration {
  const seen: Map<string, boolean> = new Map()
  const stack: S[] = ([] as S[])
  stack.push(system.init)
  seen.set(system.key(system.init), true)
  let transitions: number = 0
  let badReached: boolean = bad(system.init)
  while (stack.length > 0) {
    const state: S = __termPop(stack)
    for (const each of system.actions) {
      if (each.enabled(state)) {
        const __n0 = transitions + 1; if (!(__n0 <= 9007199254740991 && __n0 >= -9007199254740991)) __termIntStop(__n0); transitions = __n0
        const after: S = each.fire(state)
        const key: string = system.key(after)
        if (hashHas(seen, key)) {} else {
          seen.set(key, true)
          if (bad(after)) {
            badReached = true
          }
          stack.push(after)
        }
      }
    }
  }
  return { states: seen.size, transitions: transitions, badReached: badReached }
}

export function reachPor<S>(system: ConcurrentSystem<S>, bad: (a0: S) => boolean): Exploration {
  const found: Search = __termShare({ seen: new Map(), onStack: new Map(), transitions: 0, badReached: bad(system.init) })
  searchFrom(system, bad, found, system.init)
  return { states: found.seen.size, transitions: found.transitions, badReached: found.badReached }
}

export function searchFrom<S>(system: ConcurrentSystem<S>, bad: (a0: S) => boolean, found: Search, state: S): void {
  const key: string = system.key(state)
  found.seen.set(key, true)
  found.onStack.set(key, true)
  const enabled: Action<S>[] = ([] as Action<S>[])
  for (const each of system.actions) {
    if (each.enabled(state)) {
      enabled.push(each)
    }
  }
  for (const each of ampleSet(system, state, enabled, found.onStack)) {
    found.transitions = __termInt(found.transitions + 1)
    const after: S = each.fire(state)
    const afterKey: string = system.key(after)
    if (bad(after)) {
      found.badReached = true
    }
    if (hashHas(found.seen, afterKey)) {} else {
      searchFrom(system, bad, found, after)
    }
  }
  hashRemove(found.onStack, key)
}

export function ampleSet<S>(system: ConcurrentSystem<S>, state: S, enabled: Action<S>[], onStack: Map<string, boolean>): Action<S>[] {
  if (enabled.length <= 1) {
    return enabled
  }
  let at: number = 0
  for (const each of enabled) {
    let alone: boolean = true
    let other: number = 0
    for (const rest of enabled) {
      if (other !== at && !independent(each, rest)) {
        alone = false
      }
      const __n1 = other + 1; if (!(__n1 <= 9007199254740991 && __n1 >= -9007199254740991)) __termIntStop(__n1); other = __n1
    }
    if (alone) {
      if (hashHas(onStack, system.key(each.fire(state)))) {} else {
        const chosen: Action<S>[] = ([] as Action<S>[])
        chosen.push(each)
        return chosen
      }
    }
    const __n2 = at + 1; if (!(__n2 <= 9007199254740991 && __n2 >= -9007199254740991)) __termIntStop(__n2); at = __n2
  }
  return enabled
}
