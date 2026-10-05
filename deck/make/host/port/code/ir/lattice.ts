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

export function hashKeys<K, V>(self: Map<K, V>): K[] {
  return Array.from(self.keys())
}

export function hashGetOrDefault<K, V>(self: Map<K, V>, key: K, fallback: V): V {
  return maybeUnwrapOr(hashGet(self, key), fallback)
}

export function listPush<T>(self: T[], item: T): number {
  return self.push(item)
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

export function listNodeIds(graph: Net): number[] {
  return hashKeys(graph.nodes)
}

export interface Cell {
  id: number
  shell: number
  parent: number
  children: number[]
}

export interface Tiling {
  cells: Cell[]
  perShell: number[]
}

export interface Layout {
  placement: Map<number, number>
  locality: number
}

export interface HoneycombSpec {
  centre: number
  branch: number
}

export function grow(centre: number, branch: number, shells: number): Tiling {
  const cells: Cell[] = ([] as Cell[])
  cells.push({ id: 0, shell: 0, parent: -1, children: ([] as number[]) })
  const perShell: number[] = ([] as number[])
  perShell.push(1)
  let frontier: number[] = ([] as number[])
  frontier.push(0)
  let shell: number = 1
  while (shell <= shells) {
    const nextFrontier: number[] = ([] as number[])
    for (const parentId of frontier) {
      let childCount: number = branch
      if (parentId === 0) {
        childCount = centre
      }
      let k: number = 0
      while (k < childCount) {
        const id: number = cells.length
        cells.push({ id: id, shell: shell, parent: parentId, children: ([] as number[]) })
        const parent: Cell = listGet(cells, parentId)
        const children: number[] = listCopy(parent.children)
        children.push(id)
        parent.children = children
        listSet(cells, parentId, parent)
        nextFrontier.push(id)
        k = k + 1
      }
    }
    perShell.push(nextFrontier.length)
    frontier = nextFrontier
    const __n0 = shell + 1; if (!(__n0 <= 9007199254740991 && __n0 >= -9007199254740991)) __termIntStop(__n0); shell = __n0
  }
  return { cells: cells, perShell: perShell }
}

export function lattice(p: number, q: number, shells: number): Tiling {
  if (q !== 3) {
    throw ((note: string) => Object.assign(new Error(note), { name: "TermException", host: "", form: "failure", note, code: "", time: Date.now(), link: {} }))("lattice: only q = 3 is modeled")
  }
  if (p < 5) {
    throw ((note: string) => Object.assign(new Error(note), { name: "TermException", host: "", form: "failure", note, code: "", time: Date.now(), link: {} }))("lattice: {p,3} is hyperbolic only for p >= 5")
  }
  return grow(p, __termInt(p - 3), shells)
}

export function findHoneycomb(schlafli: string): HoneycombSpec {
  const spec: HoneycombSpec = { centre: 0, branch: 0 }
  if (schlafli === "{7,3}") {
    spec.centre = 7
    spec.branch = 4
  }
  if (schlafli === "{5,3,4}") {
    spec.centre = 12
    spec.branch = 10
  }
  if (schlafli === "{3,4,3,4}") {
    spec.centre = 24
    spec.branch = 22
  }
  return spec
}

export function honeycomb(schlafli: string, shells: number): Tiling {
  const spec: HoneycombSpec = findHoneycomb(schlafli)
  if (spec.centre === 0) {
    throw ((note: string) => Object.assign(new Error(note), { name: "TermException", host: "", form: "failure", note, code: "", time: Date.now(), link: {} }))(`honeycomb: ${schlafli} is not one of {7,3}, {5,3,4}, {3,4,3,4}`)
  }
  return grow(spec.centre, spec.branch, shells)
}

export function isAdjacent(cells: Cell[], a: number, b: number): boolean {
  const left: Cell = listGet(cells, a)
  const right: Cell = listGet(cells, b)
  return left.parent === b || right.parent === a
}

export function place(graph: Net, cells: Cell[]): Layout {
  const placement: Map<number, number> = new Map()
  let cell: number = 0
  for (const node of listNodeIds(graph)) {
    if (cell >= cells.length) {
      throw ((note: string) => Object.assign(new Error(note), { name: "TermException", host: "", form: "failure", note, code: "", time: Date.now(), link: {} }))("lattice too small for the net")
    }
    hashSet(placement, node, cell)
    const __n1 = cell + 1; if (!(__n1 <= 9007199254740991 && __n1 >= -9007199254740991)) __termIntStop(__n1); cell = __n1
  }
  let wires: number = 0
  let local: number = 0
  const seen: Map<string, boolean> = new Map()
  for (const node of listNodeIds(graph)) {
    let slot: number = 0
    while (slot <= 2) {
      const at: Port = { node: node, slot: slot }
      slot = slot + 1
      if (hashHas(graph.links, `${at.node}:${at.slot}`)) {} else {
        continue
      }
      const peer: Port = hashGetOrDefault(graph.links, `${at.node}:${at.slot}`, { node: -1, slot: -1 })
      if (hashHas(placement, peer.node)) {} else {
        continue
      }
      let key: string = `${peer.node}-${node}`
      if (node < peer.node) {
        key = `${node}-${peer.node}`
      }
      if (hashHas(seen, key)) {
        continue
      }
      hashSet(seen, key, true)
      const __n2 = wires + 1; if (!(__n2 <= 9007199254740991 && __n2 >= -9007199254740991)) __termIntStop(__n2); wires = __n2
      if (isAdjacent(cells, maybeUnwrapOr(hashGet(placement, node), 0), hashGetOrDefault(placement, peer.node, 0))) {
        const __n3 = local + 1; if (!(__n3 <= 9007199254740991 && __n3 >= -9007199254740991)) __termIntStop(__n3); local = __n3
      }
    }
  }
  let locality: number = 1
  if (wires > 0) {
    locality = local / wires
  }
  return { placement: placement, locality: locality }
}
