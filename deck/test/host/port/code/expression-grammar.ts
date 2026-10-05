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

export function variableAt(index: number): Expression {
  return { form: "var", index: index }
}

export function constantOf(value: number): Expression {
  return { form: "const", value: value }
}

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

export function showExpr(expr: Expression, names: string[]): string {
  if (expr.form === "var") {
    const index = expr.index
    return listGet(names, index)
  } else if (expr.form === "const") {
    const value = expr.value
    return `${value}`
  } else if (expr.form === "add") {
    const left = expr.left
    const right = expr.right
    return `(${showExpr(left, names)} + ${showExpr(right, names)})`
  } else if (expr.form === "sub") {
    const left = expr.left
    const right = expr.right
    return `(${showExpr(left, names)} - ${showExpr(right, names)})`
  } else if (expr.form === "min") {
    const left = expr.left
    const right = expr.right
    return `min(${showExpr(left, names)}, ${showExpr(right, names)})`
  } else if (expr.form === "max") {
    const left = expr.left
    const right = expr.right
    return `max(${showExpr(left, names)}, ${showExpr(right, names)})`
  } else {
    const test = expr.test
    const then = expr.then
    const else_ = expr.else
    return `(${showCond(test, names)} ? ${showExpr(then, names)} : ${showExpr(else_, names)})`
  }
}

export function showCond(cond: Condition, names: string[]): string {
  if (cond.form === "ge") {
    const left = cond.left
    const right = cond.right
    return `${showExpr(left, names)} >= ${showExpr(right, names)}`
  } else if (cond.form === "gt") {
    const left = cond.left
    const right = cond.right
    return `${showExpr(left, names)} > ${showExpr(right, names)}`
  } else {
    const left = cond.left
    const right = cond.right
    return `${showExpr(left, names)} == ${showExpr(right, names)}`
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

export function enumerate(maxSize: number, varCount: number): Expression[] {
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
