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

const __termVariantFullReload = Object.freeze({ type: "full-reload" as const })

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

export function listPush<T>(self: T[], item: T): number {
  return self.push(item)
}

export function listPop<T>(self: T[]): T {
  return __termPop(self)
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

export interface ModuleNode {
  url: string
  id: string
  file: string
  importers: string[]
  importedModules: string[]
  acceptedHmrDeps: string[]
  isSelfAccepting: boolean
  compiled: string
  lastHmrTimestamp: number
  loaded: boolean
}

export interface ModuleGraph {
  byId: Map<string, ModuleNode>
  byURL: Map<string, string>
}

export function moduleById(graph: ModuleGraph, id: string): ModuleNode {
  return hashGetOrDefault(graph.byId, id, { url: "", id: id, file: "", importers: ([] as string[]), importedModules: ([] as string[]), acceptedHmrDeps: ([] as string[]), isSelfAccepting: false, compiled: "", lastHmrTimestamp: 0, loaded: false })
}

export interface HmrUpdate {
  boundary: string
  accepted: string
}

export type HmrResult =
  | { type: "update"; updates: HmrUpdate[] }
  | { type: "full-reload" }
  | { type: "error"; errors: string[] }

export interface BoundaryWalk {
  dead: boolean
  found: HmrUpdate[]
}

export function makeHmrUpdate(boundary: string, accepted: string): HmrUpdate {
  return { boundary: boundary, accepted: accepted }
}

export function walkBoundaries(graph: ModuleGraph, node: ModuleNode, chain: string[], found: HmrUpdate[]): BoundaryWalk {
  let out: HmrUpdate[] = listCopy(found)
  if (node.isSelfAccepting) {
    out.push(makeHmrUpdate(node.url, node.url))
    return { dead: false, found: out }
  }
  if (node.importers.length === 0) {
    return { dead: true, found: out }
  }
  for (const id of node.importers) {
    const importer: ModuleNode = hashGetOrDefault(graph.byId, id, { url: "", id: id, file: "", importers: ([] as string[]), importedModules: ([] as string[]), acceptedHmrDeps: ([] as string[]), isSelfAccepting: false, compiled: "", lastHmrTimestamp: 0, loaded: false })
    if (listContains(importer.acceptedHmrDeps, node.url)) {
      out.push(makeHmrUpdate(importer.url, node.url))
      continue
    }
    if (listContains(chain, id)) {
      return { dead: true, found: out }
    }
    const longer: string[] = listCopy(chain)
    longer.push(id)
    const above: BoundaryWalk = walkBoundaries(graph, importer, longer, out)
    out = above.found
    if (above.dead) {
      return { dead: true, found: out }
    }
  }
  return { dead: false, found: out }
}

export function propagateUpdate(graph: ModuleGraph, changedId: string): HmrResult {
  if (hashHas(graph.byId, changedId)) {} else {
    return __termVariantFullReload
  }
  const changed: ModuleNode = hashGetOrDefault(graph.byId, changedId, { url: "", id: changedId, file: "", importers: ([] as string[]), importedModules: ([] as string[]), acceptedHmrDeps: ([] as string[]), isSelfAccepting: false, compiled: "", lastHmrTimestamp: 0, loaded: false })
  if (changed.loaded) {} else {
    return __termVariantFullReload
  }
  const chain: string[] = ([] as string[])
  chain.push(changedId)
  const walked: BoundaryWalk = walkBoundaries(graph, changed, chain, ([] as HmrUpdate[]))
  if (walked.dead) {
    return __termVariantFullReload
  }
  const seen: Map<string, boolean> = new Map()
  const updates: HmrUpdate[] = ([] as HmrUpdate[])
  for (const one of walked.found) {
    const key: string = `${one.boundary}
${one.accepted}`
    if (hashHas(seen, key)) {} else {
      hashSet(seen, key, true)
      updates.push(one)
    }
  }
  return { type: "update", updates: updates }
}

export function affectedModules(graph: ModuleGraph, changedId: string): string[] {
  const affected: string[] = ([] as string[])
  if (hashHas(graph.byId, changedId)) {} else {
    return affected
  }
  const seen: Map<string, boolean> = new Map()
  const stack: string[] = ([] as string[])
  hashSet(seen, changedId, true)
  affected.push(changedId)
  stack.push(changedId)
  while (stack.length > 0) {
    const node: ModuleNode = moduleById(graph, listPop(stack))
    for (const id of node.importers) {
      if (hashHas(seen, id)) {} else {
        hashSet(seen, id, true)
        affected.push(id)
        stack.push(id)
      }
    }
  }
  return affected
}
