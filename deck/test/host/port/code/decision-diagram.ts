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

const __termVariantLess = Object.freeze({ form: "less" as const })

const __termVariantGreater = Object.freeze({ form: "greater" as const })

const __termVariantEqual = Object.freeze({ form: "equal" as const })

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

export type Ordering =
  | { form: "less" }
  | { form: "equal" }
  | { form: "greater" }

export function orderingIsGreater(self: Ordering): boolean {
  if (self.form === "greater") {
    return true
  } else if (self.form === "less") {
    return false
  } else {
    return false
  }
}

export function fromNumbers(left: number, right: number): Ordering {
  if (left < right) {
    return __termVariantLess
  } else {
    if (left > right) {
      return __termVariantGreater
    } else {
      return __termVariantEqual
    }
  }
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

function mergePass<T>(source: T[], width: number, compare: (a0: T, a1: T) => Ordering): T[] {
  const n: number = source.length
  const merged: T[] = ([] as T[])
  let low: number = 0
  while (low < n) {
    const __n0 = low + width; if (!(__n0 <= 9007199254740991 && __n0 >= -9007199254740991)) __termIntStop(__n0); let middle: number = __n0
    if (middle > n) {
      middle = n
    }
    const __n1 = middle + width; if (!(__n1 <= 9007199254740991 && __n1 >= -9007199254740991)) __termIntStop(__n1); let high: number = __n1
    if (high > n) {
      high = n
    }
    let i: number = low
    let j: number = middle
    while (i < middle && j < high && (i < source.length && j < source.length)) {
      const left: T = listGet(source, i)
      const right: T = listGet(source, j)
      if (orderingIsGreater(compare(left, right))) {
        merged.push(right)
        const __n2 = j + 1; if (!(__n2 <= 9007199254740991 && __n2 >= -9007199254740991)) __termIntStop(__n2); j = __n2
      } else {
        merged.push(left)
        const __n3 = i + 1; if (!(__n3 <= 9007199254740991 && __n3 >= -9007199254740991)) __termIntStop(__n3); i = __n3
      }
    }
    while (i < middle && i < source.length) {
      merged.push(listGet(source, i))
      const __n4 = i + 1; if (!(__n4 <= 9007199254740991 && __n4 >= -9007199254740991)) __termIntStop(__n4); i = __n4
    }
    while (j < high && j < source.length) {
      merged.push(listGet(source, j))
      const __n5 = j + 1; if (!(__n5 <= 9007199254740991 && __n5 >= -9007199254740991)) __termIntStop(__n5); j = __n5
    }
    low = high
  }
  return merged
}

export function sort<T>(items: T[], compare: (a0: T, a1: T) => Ordering): T[] {
  let source: T[] = ([] as T[])
  for (const item of items) {
    source.push(item)
  }
  const total: number = source.length
  let width: number = 1
  while (width < total) {
    source = mergePass(source, width, compare)
    const __n6 = width * 2; if (!(__n6 <= 9007199254740991 && __n6 >= -9007199254740991)) __termIntStop(__n6); const doubled: number = __n6
    if (doubled > total) {
      width = total
      continue
    } else {
      width = doubled
      continue
    }
  }
  return source
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

export interface Reordered {
  manager: DiagramManager
  roots: number[]
  order: number[]
  before: number
  after: number
}

export interface Copied {
  manager: DiagramManager
  roots: number[]
}

export function makeManager(): DiagramManager {
  const none: number[] = ([] as number[])
  return makeManagerOrdered(none)
}

export function makeManagerOrdered(order: number[]): DiagramManager {
  const position: Map<number, number> = new Map()
  let level: number = 0
  for (const each of order) {
    position.set(each, level)
    const __n7 = level + 1; if (!(__n7 <= 9007199254740991 && __n7 >= -9007199254740991)) __termIntStop(__n7); level = __n7
  }
  return __termShare({ nodes: ([] as DiagramNode[]), unique: new Map(), iteCache: new Map(), position: position })
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
  const __n8 = manager.nodes.length + 2; if (!(__n8 <= 9007199254740991 && __n8 >= -9007199254740991)) __termIntStop(__n8); const id: number = __n8
  manager.nodes.push({ variable: variable, low: low, high: high })
  manager.unique.set(key, id)
  return id
}

export function makeDiagramNode(variable: number, low: number, high: number): DiagramNode {
  return { variable: variable, low: low, high: high }
}

export function nodeOf(manager: DiagramManager, diagram: number): DiagramNode {
  return listGet(manager.nodes, __termInt(diagram - 2))
}

export function isTerminal(diagram: number): boolean {
  return diagram === 0 || diagram === 1
}

export function variableOf(manager: DiagramManager, index: number): number {
  return makeNode(manager, index, 0, 1)
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

export function diagramXor(manager: DiagramManager, f: number, g: number): number {
  return ifThenElse(manager, f, ifThenElse(manager, g, 0, 1), g)
}

export function diagramImplies(manager: DiagramManager, f: number, g: number): number {
  return ifThenElse(manager, f, g, 1)
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

export function exists(manager: DiagramManager, diagram: number, variable: number): number {
  return diagramOr(manager, restrict(manager, diagram, variable, false), restrict(manager, diagram, variable, true))
}

export function existsMany(manager: DiagramManager, diagram: number, variables: number[]): number {
  let result: number = diagram
  for (const each of variables) {
    result = diagramOr(manager, restrict(manager, result, each, false), restrict(manager, result, each, true))
  }
  return result
}

export function nodeCount(manager: DiagramManager): number {
  return manager.nodes.length
}

export function reachableNodes(manager: DiagramManager, roots: number[]): number[] {
  const seen: Map<number, boolean> = new Map()
  const order: number[] = ([] as number[])
  const stack: number[] = ([] as number[])
  for (const root of roots) {
    stack.push(root)
    while (stack.length > 0) {
      const at: number = __termPop(stack)
      if (at === 0 || at === 1 || hashHas(seen, at)) {} else {
        seen.set(at, true)
        order.push(at)
        const found: DiagramNode = listGet(manager.nodes, __termInt(at - 2))
        stack.push(found.high)
        stack.push(found.low)
      }
    }
  }
  return order
}

export function reachable(manager: DiagramManager, roots: number[]): number {
  const nodes: number[] = reachableNodes(manager, roots)
  return nodes.length
}

export function variablesIn(manager: DiagramManager, roots: number[]): number[] {
  const seen: Map<number, boolean> = new Map()
  const variables: number[] = ([] as number[])
  for (const at of reachableNodes(manager, roots)) {
    const found: DiagramNode = listGet(manager.nodes, __termInt(at - 2))
    if (hashHas(seen, found.variable)) {} else {
      seen.set(found.variable, true)
      variables.push(found.variable)
    }
  }
  return variables
}

export function copyUnder(manager: DiagramManager, order: number[], roots: number[]): Copied {
  const target: DiagramManager = makeManagerOrdered(order)
  const memo: Map<number, number> = new Map()
  const copiedRoots: number[] = ([] as number[])
  for (const root of roots) {
    copiedRoots.push(copyNode(manager, target, memo, root))
  }
  return { manager: target, roots: copiedRoots }
}

export function copyNode(manager: DiagramManager, target: DiagramManager, memo: Map<number, number>, diagram: number): number {
  if (diagram === 0 || diagram === 1) {
    return diagram
  }
  if (hashHas(memo, diagram)) {
    return maybeUnwrapOr(hashGet(memo, diagram), 0)
  }
  const found: DiagramNode = listGet(manager.nodes, __termInt(diagram - 2))
  const chosen: number = makeNode(target, found.variable, 0, 1)
  const high: number = copyNode(manager, target, memo, found.high)
  const low: number = copyNode(manager, target, memo, found.low)
  const result: number = ifThenElse(target, chosen, high, low)
  memo.set(diagram, result)
  return result
}

export function orderOf(manager: DiagramManager, roots: number[]): number[] {
  const ranked: RankedVariable[] = ([] as RankedVariable[])
  for (const each of variablesIn(manager, roots)) {
    ranked.push(makeRanked(hashGetOrDefault(manager.position, each, each), each))
  }
  const out: number[] = ([] as number[])
  for (const each of sort(ranked, byLevel)) {
    out.push(each.variable)
  }
  return out
}

export interface RankedVariable {
  level: number
  variable: number
}

export function makeRanked(level: number, variable: number): RankedVariable {
  return { level: level, variable: variable }
}

export function byLevel(left: RankedVariable, right: RankedVariable): Ordering {
  return fromNumbers(left.level, right.level)
}

export function siftReorder(manager: DiagramManager, roots: number[]): Reordered {
  const before: number = reachable(manager, roots)
  let bestOrder: number[] = orderOf(manager, roots)
  let best: Copied = copyUnder(manager, bestOrder, roots)
  let bestSize: number = reachable(best.manager, best.roots)
  const variables: number[] = listCopy(bestOrder)
  for (const each of variables) {
    let position: number = 0
    while (position < bestOrder.length) {
      const rest: number[] = ([] as number[])
      for (const other of bestOrder) {
        if (other === each) {} else {
          rest.push(other)
        }
      }
      const candidate: number[] = ([] as number[])
      let at: number = 0
      for (const other of rest) {
        if (at === position) {
          candidate.push(each)
        }
        candidate.push(other)
        const __n9 = at + 1; if (!(__n9 <= 9007199254740991 && __n9 >= -9007199254740991)) __termIntStop(__n9); at = __n9
      }
      if (rest.length <= position) {
        candidate.push(each)
      }
      const built: Copied = copyUnder(manager, candidate, roots)
      const size: number = reachable(built.manager, built.roots)
      if (size < bestSize) {
        bestSize = size
        bestOrder = candidate
        best = built
      }
      position = position + 1
    }
  }
  return { manager: best.manager, roots: best.roots, order: bestOrder, before: before, after: bestSize }
}
