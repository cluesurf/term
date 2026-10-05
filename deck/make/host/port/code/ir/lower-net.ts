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

export function hashKeys<K, V>(self: Map<K, V>): K[] {
  return Array.from(self.keys())
}

export function listSet<T>(self: T[], index: number, item: T): T[] {
  __termSplice(self, index, 1, item)
  return self
}

export interface Port {
  node: number
  slot: number
}

export interface Net {
  nodes: Map<number, string>
  links: Map<string, Port>
  next: number
  rewrites: number
  boundary: Map<number, boolean>
}

export interface AddedNode {
  graph: Net
  id: number
}

export function addNode(graph: Net, label: string): AddedNode {
  const id: number = graph.next
  const nodes: Map<number, string> = graph.nodes
  hashSet(nodes, id, label)
  const next: Net = { ...graph }
  next.nodes = nodes
  next.next = __termInt(id + 1)
  return { graph: next, id: id }
}

export function wirePorts(graph: Net, a: Port, b: Port): Net {
  const links: Map<string, Port> = graph.links
  hashSet(links, `${a.node}:${a.slot}`, b)
  hashSet(links, `${b.node}:${b.slot}`, a)
  const next: Net = { ...graph }
  next.links = links
  return next
}

export function markBoundary(graph: Net, id: number): Net {
  const boundary: Map<number, boolean> = graph.boundary
  hashSet(boundary, id, true)
  const next: Net = { ...graph }
  next.boundary = boundary
  return next
}

export function listNodeIds(graph: Net): number[] {
  return hashKeys(graph.nodes)
}

export type LambdaTerm =
  | { t: "var"; name: string }
  | { t: "lam"; param: string; body: LambdaTerm }
  | { t: "app"; fn: LambdaTerm; arg: LambdaTerm }

export interface Lowered {
  graph: Net
  root: Port
  free: Map<string, Port>
}

export interface Lowering {
  graph: Net
  free: Map<string, Port>
  at: Port
}

export function pinFree(graph: Net, free: Map<string, Port>, name: string): Lowering {
  if (hashHas(free, name)) {
    return { graph: graph, free: free, at: maybeUnwrapOr(hashGet(free, name), { node: -1, slot: -1 }) }
  }
  const added: AddedNode = addNode(graph, "era")
  const p: Port = { node: added.id, slot: 0 }
  hashSet(free, name, p)
  return { graph: markBoundary(added.graph, added.id), free: free, at: p }
}

export function buildNet(graph: Net, free: Map<string, Port>, node: LambdaTerm, scope: Map<string, Port>): Lowering {
  if (node.t === "var") {
    const name = node.name
    if (hashHas(scope, name)) {
      return { graph: graph, free: free, at: maybeUnwrapOr(hashGet(scope, name), { node: -1, slot: -1 }) }
    }
    return pinFree(graph, free, name)
  } else if (node.t === "lam") {
    const param = node.param
    const body = node.body
    const added: AddedNode = addNode(graph, "con")
    const con: number = added.id
    const inner: Map<string, Port> = new Map()
    for (const key of hashKeys(scope)) {
      hashSet(inner, key, maybeUnwrapOr(hashGet(scope, key), { node: -1, slot: -1 }))
    }
    hashSet(inner, param, { node: con, slot: 1 })
    const inside: Lowering = buildNet(added.graph, free, body, inner)
    return { graph: wirePorts(inside.graph, { node: con, slot: 2 }, inside.at), free: inside.free, at: { node: con, slot: 0 } }
  } else {
    const fn = node.fn
    const arg = node.arg
    const added: AddedNode = addNode(graph, "con")
    const con: number = added.id
    const left: Lowering = buildNet(added.graph, free, fn, scope)
    const wired: Net = wirePorts(left.graph, { node: con, slot: 0 }, left.at)
    const right: Lowering = buildNet(wired, left.free, arg, scope)
    return { graph: wirePorts(right.graph, { node: con, slot: 1 }, right.at), free: right.free, at: { node: con, slot: 2 } }
  }
}

export function lower(term: LambdaTerm): Lowered {
  const free: Map<string, Port> = new Map()
  const scope: Map<string, Port> = new Map()
  const built: Lowering = buildNet({ nodes: new Map(), links: new Map(), next: 0, rewrites: 0, boundary: new Map() }, free, term, scope)
  const added: AddedNode = addNode(built.graph, "era")
  const root: Port = { node: added.id, slot: 0 }
  const graph: Net = markBoundary(added.graph, added.id)
  return { graph: wirePorts(graph, root, built.at), root: root, free: built.free }
}

export function agentCount(lowered: Lowered): number {
  let n: number = 0
  for (const id of listNodeIds(lowered.graph)) {
    if (hashHas(lowered.graph.boundary, id)) {} else {
      const __n0 = n + 1; if (!(__n0 <= 9007199254740991 && __n0 >= -9007199254740991)) __termIntStop(__n0); n = __n0
    }
  }
  return n
}
