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

export function listContains<T>(self: T[], item: T): boolean {
  return self.some((__e) => __termEqual(__e, item))
}

export function listJoin<T>(self: T[], separator: string): string {
  return self.join(separator)
}

export function listSlice<T>(self: T[], start: number, end: number): T[] {
  return __termSlice(self, start, end)
}

export function listDrop<T>(self: T[], count: number, side: Side): T[] {
  if (side.form === "end") {
    return __termSlice(self, 0, __termInt(self.length - count))
  } else if (side.form === "start") {
    return __termSlice(self, count)
  } else {
    return __termSlice(self, count, __termInt(self.length - count))
  }
}

export type Value =
  | { kind: "make"; ctor: string; args: string[]; reuse: string }
  | { kind: "call"; fn: string; args: string[] }
  | { kind: "var"; name: string }
  | { kind: "lit" }

export type Inst =
  | { op: "let"; name: string; value: Value }
  | { op: "return"; name: string }
  | { op: "dup"; name: string }
  | { op: "drop"; name: string }
  | { op: "if"; cond: string; then: Inst[]; else: Inst[] }
  | { op: "while"; cond: string; body: Inst[] }
  | { op: "match"; subject: string; arms: Inst[][] }

export interface BlockPass {
  insts: Inst[]
  live: string[]
}

export function makeDup(name: string): Inst {
  return { op: "dup", name: name }
}

export function makeDrop(name: string): Inst {
  return { op: "drop", name: name }
}

export function addName(names: string[], name: string): string[] {
  const out: string[] = listCopy(names)
  if (listContains(out, name)) {} else {
    out.push(name)
  }
  return out
}

export function removeName(names: string[], name: string): string[] {
  const out: string[] = ([] as string[])
  for (const one of names) {
    if (one === name) {} else {
      out.push(one)
    }
  }
  return out
}

export function valueReads(v: Value): string[] {
  const none: string[] = ([] as string[])
  if (v.kind === "make") {
    const args = v.args
    return args
  } else if (v.kind === "call") {
    const args = v.args
    return args
  } else if (v.kind === "var") {
    const name = v.name
    const one: string[] = ([] as string[])
    one.push(name)
    return one
  } else {
    return none
  }
}

export function reads(i: Inst): string[] {
  const none: string[] = ([] as string[])
  if (i.op === "let") {
    const value = i.value
    return valueReads(value)
  } else if (i.op === "return") {
    const name = i.name
    const one: string[] = ([] as string[])
    one.push(name)
    return one
  } else if (i.op === "dup") {
    return none
  } else if (i.op === "drop") {
    return none
  } else if (i.op === "if") {
    return none
  } else if (i.op === "while") {
    return none
  } else {
    return none
  }
}

export function letName(i: Inst): string {
  if (i.op === "let") {
    const name = i.name
    return name
  } else if (i.op === "return") {
    return ""
  } else if (i.op === "dup") {
    return ""
  } else if (i.op === "drop") {
    return ""
  } else if (i.op === "if") {
    return ""
  } else if (i.op === "while") {
    return ""
  } else {
    return ""
  }
}

export function dropName(i: Inst): string {
  if (i.op === "let") {
    return ""
  } else if (i.op === "return") {
    return ""
  } else if (i.op === "dup") {
    return ""
  } else if (i.op === "drop") {
    const name = i.name
    return name
  } else if (i.op === "if") {
    return ""
  } else if (i.op === "while") {
    return ""
  } else {
    return ""
  }
}

export function makeArity(i: Inst): number {
  if (i.op === "let") {
    const value = i.value
    if (value.kind === "make") {
      const args = value.args
      return args.length
    } else if (value.kind === "call") {
      return -1
    } else if (value.kind === "var") {
      return -1
    } else {
      return -1
    }
  } else if (i.op === "return") {
    return -1
  } else if (i.op === "dup") {
    return -1
  } else if (i.op === "drop") {
    return -1
  } else if (i.op === "if") {
    return -1
  } else if (i.op === "while") {
    return -1
  } else {
    return -1
  }
}

export function withReuse(i: Inst, cell: string): Inst {
  if (i.op === "let") {
    const name = i.name
    const value = i.value
    if (value.kind === "make") {
      const ctor = value.ctor
      const args = value.args
      return { op: "let", name: name, value: { kind: "make", ctor: ctor, args: args, reuse: cell } }
    } else if (value.kind === "call") {
      return i
    } else if (value.kind === "var") {
      return i
    } else {
      return i
    }
  } else if (i.op === "return") {
    return i
  } else if (i.op === "dup") {
    return i
  } else if (i.op === "drop") {
    return i
  } else if (i.op === "if") {
    return i
  } else if (i.op === "while") {
    return i
  } else {
    return i
  }
}

export function perceus(params: string[], body: Inst[]): Inst[] {
  const lastUse: Map<string, number> = new Map()
  let at: number = 0
  for (const i of body) {
    for (const v of reads(i)) {
      hashSet(lastUse, v, at)
    }
    const __n0 = at + 1; if (!(__n0 <= 9007199254740991 && __n0 >= -9007199254740991)) __termIntStop(__n0); at = __n0
  }
  const arity: Map<string, number> = new Map()
  for (const i of body) {
    const n: number = makeArity(i)
    if (n >= 0) {
      hashSet(arity, letName(i), n)
    }
  }
  const out: Inst[] = ([] as Inst[])
  for (const p of params) {
    if (hashHas(lastUse, p)) {} else {
      out.push({ op: "drop", name: p })
    }
  }
  at = 0
  for (const i of body) {
    for (const v of reads(i)) {
      if (!__termEqual(maybeUnwrapOr(hashGet(lastUse, v), -1), at)) {
        out.push({ op: "dup", name: v })
      }
    }
    out.push(i)
    const bound: string = letName(i)
    if (bound !== "" && !hashHas(lastUse, bound)) {
      out.push({ op: "drop", name: bound })
    }
    const __n1 = at + 1; if (!(__n1 <= 9007199254740991 && __n1 >= -9007199254740991)) __termIntStop(__n1); at = __n1
  }
  return reuseCells(out, arity)
}

export function reuseCells(insts: Inst[], arity: Map<string, number>): Inst[] {
  const out: Inst[] = ([] as Inst[])
  let at: number = 0
  while (at < insts.length) {
    const here: Inst = listGet(insts, at)
    const dropped: string = dropName(here)
    let fused: boolean = false
    if (dropped !== "" && hashHas(arity, dropped)) {
      if (__termInt(at + 1) < insts.length) {
        const next: Inst = listGet(insts, __termInt(at + 1))
        if (__termEqual(makeArity(next), maybeUnwrapOr(hashGet(arity, dropped), -2))) {
          out.push(withReuse(next, dropped))
          fused = true
        }
      }
    }
    if (fused) {
      const __n2 = at + 2; if (!(__n2 <= 9007199254740991 && __n2 >= -9007199254740991)) __termIntStop(__n2); at = __n2
    } else {
      out.push(here)
      const __n3 = at + 1; if (!(__n3 <= 9007199254740991 && __n3 >= -9007199254740991)) __termIntStop(__n3); at = __n3
    }
  }
  return out
}

export function perceusControl(params: string[], body: Inst[]): Inst[] {
  const none: string[] = ([] as string[])
  return control(params, body, none, true)
}

export function perceusControlHeap(params: string[], body: Inst[], heap: string[]): Inst[] {
  return control(params, body, heap, false)
}

export function control(params: string[], body: Inst[], heap: string[], every: boolean): Inst[] {
  const none: string[] = ([] as string[])
  const pass: BlockPass = processBlock(body, none, heap, every)
  const out: Inst[] = ([] as Inst[])
  for (const p of params) {
    if ((every || listContains(heap, p)) && !listContains(pass.live, p)) {
      out.push({ op: "drop", name: p })
    }
  }
  for (const i of pass.insts) {
    out.push(i)
  }
  return out
}

export function isHeap(name: string, heap: string[], every: boolean): boolean {
  return every || listContains(heap, name)
}

export function processBlock(insts: Inst[], liveAfter: string[], heap: string[], every: boolean): BlockPass {
  let live: string[] = listCopy(liveAfter)
  const reversed: Inst[] = ([] as Inst[])
  const __n4 = insts.length - 1; if (!(__n4 <= 9007199254740991 && __n4 >= -9007199254740991)) __termIntStop(__n4); let at: number = __n4
  while (at >= 0) {
    const i: Inst = listGet(insts, at)
    at = at - 1
    const step: BlockPass = processOne(i, live, heap, every)
    for (const one of step.insts) {
      reversed.push(one)
    }
    live = step.live
  }
  const out: Inst[] = ([] as Inst[])
  const __n5 = reversed.length - 1; if (!(__n5 <= 9007199254740991 && __n5 >= -9007199254740991)) __termIntStop(__n5); let k: number = __n5
  while (k >= 0) {
    out.push(listGet(reversed, k))
    k = k - 1
  }
  return { insts: out, live: live }
}

export function union(a: string[], b: string[]): string[] {
  let out: string[] = listCopy(a)
  for (const v of b) {
    out = addName(out, v)
  }
  return out
}

export function processOne(i: Inst, live: string[], heap: string[], every: boolean): BlockPass {
  const reversed: Inst[] = ([] as Inst[])
  const none: string[] = ([] as string[])
  if (i.op === "while") {
    const cond = i.cond
    const body = i.body
    let liveHeader: string[] = listCopy(live)
    let settled: boolean = false
    while (!settled) {
      const inner: BlockPass = processBlock(body, union(liveHeader, live), heap, every)
      const grown: string[] = union(liveHeader, inner.live)
      if (grown.length === liveHeader.length) {
        settled = true
      } else {
        liveHeader = grown
      }
    }
    const final: BlockPass = processBlock(body, union(liveHeader, live), none, true)
    for (const v of liveHeader) {
      if (listContains(live, v)) {} else {
        reversed.push({ op: "drop", name: v })
      }
    }
    reversed.push({ op: "while", cond: cond, body: final.insts })
    let next: string[] = listCopy(live)
    for (const v of liveHeader) {
      next = addName(next, v)
    }
    return { insts: reversed, live: next }
  } else if (i.op === "match") {
    const subject = i.subject
    const arms = i.arms
    const results: BlockPass[] = ([] as BlockPass[])
    for (const arm of arms) {
      results.push(processBlock(arm, live, heap, every))
    }
    let consumed: string[] = ([] as string[])
    for (const r of results) {
      consumed = union(consumed, r.live)
    }
    const newArms: Inst[][] = ([] as Inst[][])
    for (const r of results) {
      const arm: Inst[] = ([] as Inst[])
      for (const v of consumed) {
        if (!listContains(r.live, v) && !listContains(live, v)) {
          arm.push({ op: "drop", name: v })
        }
      }
      for (const one of r.insts) {
        arm.push(one)
      }
      newArms.push(arm)
    }
    reversed.push({ op: "match", subject: subject, arms: newArms })
    let next: string[] = listCopy(live)
    for (const r of results) {
      next = union(next, r.live)
    }
    return { insts: reversed, live: next }
  } else if (i.op === "if") {
    const cond = i.cond
    const then = i.then
    const else_ = i.else
    const left: BlockPass = processBlock(then, live, heap, every)
    const right: BlockPass = processBlock(else_, live, heap, every)
    const newThen: Inst[] = ([] as Inst[])
    for (const v of right.live) {
      if (!listContains(left.live, v) && !listContains(live, v)) {
        newThen.push({ op: "drop", name: v })
      }
    }
    for (const one of left.insts) {
      newThen.push(one)
    }
    const newElse: Inst[] = ([] as Inst[])
    for (const v of left.live) {
      if (!listContains(right.live, v) && !listContains(live, v)) {
        newElse.push({ op: "drop", name: v })
      }
    }
    for (const one of right.insts) {
      newElse.push(one)
    }
    reversed.push({ op: "if", cond: cond, then: newThen, else: newElse })
    let next: string[] = union(union(live, left.live), right.live)
    return { insts: reversed, live: next }
  } else if (i.op === "let") {
    return processStraight(i, live, heap, every)
  } else if (i.op === "return") {
    return processStraight(i, live, heap, every)
  } else if (i.op === "dup") {
    return processStraight(i, live, heap, every)
  } else {
    return processStraight(i, live, heap, every)
  }
}

export function processStraight(i: Inst, live: string[], heap: string[], every: boolean): BlockPass {
  const def: string = letName(i)
  let counted: string[] = ([] as string[])
  const counts: Map<string, number> = new Map()
  for (const v of reads(i)) {
    if (every || listContains(heap, v)) {
      counted = addName(counted, v)
      counts.set(v, __termInt((counts.get(v) ?? 0) + 1))
    }
  }
  const dups: Inst[] = ([] as Inst[])
  for (const v of counted) {
    let need: number = maybeUnwrapOr(hashGet(counts, v), 0) - 1
    if (listContains(live, v)) {
      const __n6 = need + 1; if (!(__n6 <= 9007199254740991 && __n6 >= -9007199254740991)) __termIntStop(__n6); need = __n6
    }
    let k: number = 0
    while (k < need) {
      dups.push({ op: "dup", name: v })
      k = k + 1
    }
  }
  const reversed: Inst[] = ([] as Inst[])
  if (def !== "") {
    if ((every || listContains(heap, def)) && !listContains(live, def)) {
      reversed.push({ op: "drop", name: def })
    }
  }
  reversed.push(i)
  for (const d of dups) {
    reversed.push(d)
  }
  let next: string[] = live
  if (def !== "") {
    next = removeName(next, def)
  }
  for (const v of counted) {
    next = addName(next, v)
  }
  return { insts: reversed, live: next }
}

export function showInst(i: Inst): string {
  if (i.op === "dup") {
    const name = i.name
    return `dup ${name}`
  } else if (i.op === "drop") {
    const name = i.name
    return `drop ${name}`
  } else if (i.op === "return") {
    const name = i.name
    return `return ${name}`
  } else if (i.op === "let") {
    const name = i.name
    const value = i.value
    return `let ${name} = ${showValue(value)}`
  } else if (i.op === "if") {
    const cond = i.cond
    const then = i.then
    const else_ = i.else
    return `if ${cond} { ${showBlock(then, "; ")} } else { ${showBlock(else_, "; ")} }`
  } else if (i.op === "while") {
    const cond = i.cond
    const body = i.body
    return `while ${cond} { ${showBlock(body, "; ")} }`
  } else {
    const subject = i.subject
    const arms = i.arms
    const shown: string[] = ([] as string[])
    for (const arm of arms) {
      shown.push(showBlock(arm, "; "))
    }
    return `match ${subject} { ${shown.join(" | ")} }`
  }
}

export function showValue(v: Value): string {
  if (v.kind === "make") {
    const ctor = v.ctor
    const args = v.args
    const reuse = v.reuse
    if (reuse === "") {
      return `make ${ctor}(${args.join(", ")})`
    }
    return `make ${ctor}(${args.join(", ")}) reuse ${reuse}`
  } else if (v.kind === "call") {
    const fn = v.fn
    const args = v.args
    return `${fn}(${args.join(", ")})`
  } else if (v.kind === "var") {
    const name = v.name
    return name
  } else {
    return "lit"
  }
}

export function showBlock(insts: Inst[], separator: string): string {
  const shown: string[] = ([] as string[])
  for (const one of insts) {
    shown.push(showInst(one))
  }
  return listJoin(shown, separator)
}
