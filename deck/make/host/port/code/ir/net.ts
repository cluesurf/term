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

export interface Pair<A = any, B = any> {
  first: A
  second: B
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

export function hashRemove<K, V>(self: Map<K, V>, key: K): boolean {
  return self.delete(__termKey(key))
}

export function hashSize<K, V>(self: Map<K, V>): number {
  return self.size
}

export function hashKeys<K, V>(self: Map<K, V>): K[] {
  return Array.from(self.keys())
}

export function hashGetOrDefault<K, V>(self: Map<K, V>, key: K, fallback: V): V {
  return maybeUnwrapOr(hashGet(self, key), fallback)
}

export function listPush<T>(self: T[], item: T): number {
  return self.push(item)
}

export function listSet<T>(self: T[], index: number, item: T): T[] {
  __termSplice(self, index, 1, item)
  return self
}

export function listFirst<T>(self: T[]): Maybe<T> {
  if (self.length > 0) {
    return { form: "some", value: (0 < self.length ? self[0]! : __termReadPast(self, 0)) }
  } else {
    return __termVariantNone
  }
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

export interface SteppedNet {
  graph: Net
  fired: boolean
}

export function makeNet(): Net {
  return { nodes: new Map(), links: new Map(), next: 0, rewrites: 0, boundary: new Map() }
}

export function makePort(node: number, slot: number): Port {
  return { node: node, slot: slot }
}

export function arityOf(label: string): number {
  if (label === "era") {
    return 0
  }
  return 2
}

export function portKey(p: Port): string {
  return `${p.node}:${p.slot}`
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

export function hasPeer(graph: Net, p: Port): boolean {
  return hashHas(graph.links, `${p.node}:${p.slot}`)
}

export function peerOf(graph: Net, p: Port): Port {
  return hashGetOrDefault(graph.links, `${p.node}:${p.slot}`, { node: -1, slot: -1 })
}

export function markBoundary(graph: Net, id: number): Net {
  const boundary: Map<number, boolean> = graph.boundary
  hashSet(boundary, id, true)
  const next: Net = { ...graph }
  next.boundary = boundary
  return next
}

export function isBoundary(graph: Net, id: number): boolean {
  return hashHas(graph.boundary, id)
}

export function removeNode(graph: Net, id: number): Net {
  const n: number = arityOf(hashGetOrDefault(graph.nodes, id, "era"))
  const links: Map<string, Port> = graph.links
  let slot: number = 0
  while (slot <= n) {
    hashRemove(links, `${id}:${slot}`)
    slot = slot + 1
  }
  const nodes: Map<number, string> = graph.nodes
  hashRemove(nodes, id)
  const next: Net = { ...graph }
  next.links = links
  next.nodes = nodes
  return next
}

export function findActivePair(graph: Net): number[] {
  const pair: number[] = ([] as number[])
  for (const id of hashKeys(graph.nodes)) {
    if (hashHas(graph.boundary, id)) {
      continue
    }
    const principal: Port = { node: id, slot: 0 }
    if (hashHas(graph.links, `${principal.node}:${principal.slot}`)) {
      const peer: Port = hashGetOrDefault(graph.links, `${principal.node}:${principal.slot}`, { node: -1, slot: -1 })
      if (peer.slot === 0 && peer.node !== id && (hashHas(graph.nodes, peer.node) && !hashHas(graph.boundary, peer.node) && peer.node > id)) {
        pair.push(id)
        pair.push(peer.node)
        return pair
      }
    }
  }
  return pair
}

export function addWired(graph: Net, label: string, to: Port): Net {
  const added: AddedNode = addNode(graph, label)
  return wirePorts(added.graph, { node: added.id, slot: 0 }, to)
}

export function stepNet(graph: Net): SteppedNet {
  const pair: number[] = findActivePair(graph)
  if (pair.length === 0) {
    return { graph: graph, fired: false }
  }
  const a: number = (0 < pair.length ? pair[0]! : __termReadPast(pair, 0))
  const b: number = (1 < pair.length ? pair[1]! : __termReadPast(pair, 1))
  const la: string = hashGetOrDefault(graph.nodes, a, "")
  const lb: string = hashGetOrDefault(graph.nodes, b, "")
  let current: Net = { ...graph }
  current.rewrites = __termInt(graph.rewrites + 1)
  if (la === "era" && lb === "era") {
    current = removeNode(removeNode(current, a), b)
    return { graph: current, fired: true }
  }
  if (la === "era" || lb === "era") {
    let eraser: number = a
    let binary: number = b
    if (lb === "era") {
      eraser = b
      binary = a
    }
    const x1: Port = hashGetOrDefault(current.links, portKey({ node: binary, slot: 1 }), { node: -1, slot: -1 })
    const x2: Port = hashGetOrDefault(current.links, portKey({ node: binary, slot: 2 }), { node: -1, slot: -1 })
    current = removeNode(removeNode(current, eraser), binary)
    current = addWired(current, "era", x1)
    current = addWired(current, "era", x2)
    return { graph: current, fired: true }
  }
  const a1: Port = hashGetOrDefault(current.links, portKey({ node: a, slot: 1 }), { node: -1, slot: -1 })
  const a2: Port = hashGetOrDefault(current.links, portKey({ node: a, slot: 2 }), { node: -1, slot: -1 })
  const b1: Port = hashGetOrDefault(current.links, portKey({ node: b, slot: 1 }), { node: -1, slot: -1 })
  const b2: Port = hashGetOrDefault(current.links, portKey({ node: b, slot: 2 }), { node: -1, slot: -1 })
  current = removeNode(removeNode(current, a), b)
  if (la === lb) {
    current = wirePorts(current, a1, b1)
    current = wirePorts(current, a2, b2)
    return { graph: current, fired: true }
  }
  let made: AddedNode = addNode(current, lb)
  const b1n: number = made.id
  made = addNode(made.graph, lb)
  const b2n: number = made.id
  made = addNode(made.graph, la)
  const a1n: number = made.id
  made = addNode(made.graph, la)
  const a2n: number = made.id
  current = made.graph
  current = wirePorts(current, { node: b1n, slot: 0 }, a1)
  current = wirePorts(current, { node: b2n, slot: 0 }, a2)
  current = wirePorts(current, { node: a1n, slot: 0 }, b1)
  current = wirePorts(current, { node: a2n, slot: 0 }, b2)
  current = wirePorts(current, { node: b1n, slot: 1 }, { node: a1n, slot: 1 })
  current = wirePorts(current, { node: b1n, slot: 2 }, { node: a2n, slot: 1 })
  current = wirePorts(current, { node: b2n, slot: 1 }, { node: a1n, slot: 2 })
  current = wirePorts(current, { node: b2n, slot: 2 }, { node: a2n, slot: 2 })
  return { graph: current, fired: true }
}

export function normalizeNet(graph: Net, limit: number = 100000): Net {
  let current: Net = graph
  let steps: number = 0
  while (steps < limit) {
    const stepped: SteppedNet = stepNet(current)
    current = stepped.graph
    if (stepped.fired) {} else {
      break
    }
    steps = steps + 1
  }
  return current
}

export function netSize(graph: Net): number {
  return hashSize(graph.nodes)
}

export function listNodeIds(graph: Net): number[] {
  return hashKeys(graph.nodes)
}

export function labelOf(graph: Net, id: number): string {
  return hashGetOrDefault(graph.nodes, id, "")
}
