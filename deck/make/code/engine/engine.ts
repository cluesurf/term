// The engine: a tree-walking interpreter for the imperative vibe language. Async throughout (Promise-based) so
// async functions and `await` work. Deterministic (no randomness, FIFO microtask scheduling). The reference
// semantics the compiler will be checked against. See note/research/vibe/computation/engine/03-execution-model.md.

import type {
  Program,
  Statement,
  Expression,
  BinaryOp,
} from '@cluesurf/make/code/engine/ast'
import {
  type Value,
  type Scope,
  type Closure,
  UNIT,
  integer,
  float,
  boolean,
  string,
  truthy,
  valuesEqual,
  keyOf,
  display,
} from '@cluesurf/make/code/engine/value'
import * as Int from '@cluesurf/make/code/engine/data/integer'
import * as Flt from '@cluesurf/make/code/engine/data/float'
import * as Str from '@cluesurf/make/code/engine/data/string'
import * as Arr from '@cluesurf/make/code/engine/data/array'
import * as Mp from '@cluesurf/make/code/engine/data/map'

type Signal =
  | { kind: 'normal' }
  | { kind: 'return'; value: Value }
  | { kind: 'break' }
  | { kind: 'continue' }
  | { kind: 'throw'; value: Value }

const NORMAL: Signal = { kind: 'normal' }

// ---- scopes ----
function makeScope(parent: Scope | null): Scope {
  return { vars: new Map(), consts: new Set(), parent }
}

function define(
  scope: Scope,
  name: string,
  value: Value,
  mutable: boolean,
): void {
  scope.vars.set(name, value)

  if (!mutable) {
    scope.consts.add(name)
  }
}

function lookup(scope: Scope, name: string): Value {
  for (let s: Scope | null = scope; s; s = s.parent) {
    if (s.vars.has(name)) {
      return s.vars.get(name)!
    }
  }

  throw new Error(`undefined variable "${name}"`)
}

function assignVar(scope: Scope, name: string, value: Value): void {
  for (let s: Scope | null = scope; s; s = s.parent) {
    if (s.vars.has(name)) {
      if (s.consts.has(name)) {
        throw new Error(`cannot assign to const "${name}"`)
      }

      s.vars.set(name, value)

      return
    }
  }

  throw new Error(`assignment to undefined variable "${name}"`)
}

// ---- expressions ----
async function evaluate(
  expr: Expression,
  scope: Scope,
): Promise<Value> {
  switch (expr.form) {
    case 'integer':
      return integer(expr.value)
    case 'float':
      return float(expr.value)
    case 'boolean':
      return boolean(expr.value)
    case 'string':
      return string(expr.value)
    case 'unit':
      return UNIT
    case 'variable':
      return lookup(scope, expr.name)

    case 'array': {
      const items: Value[] = []

      for (const e of expr.items) {
        items.push(await evaluate(e, scope))
      }

      return { form: 'array', value: Arr.fromArray(items) }
    }

    case 'map': {
      const m = Mp.makeMap<Value>()

      for (const { key, value } of expr.entries) {
        Mp.set(m, `s:${key}`, await evaluate(value, scope))
      }

      return { form: 'map', value: m }
    }

    case 'closure':
      return {
        form: 'function',
        value: {
          params: expr.params,
          body: expr.body,
          env: scope,
          isAsync: expr.isAsync ?? false,
        },
      }

    case 'unary': {
      const v = await evaluate(expr.operand, scope)

      if (expr.op === '!') {
        return boolean(!truthy(v))
      }

      if (v.form === 'integer') {
        return { form: 'integer', value: Int.negate(v.value) }
      }

      if (v.form === 'float') {
        return { form: 'float', value: Flt.negate(v.value) }
      }

      throw new Error(`unary - on ${v.form}`)
    }

    case 'binary': {
      if (expr.op === '&&') {
        const l = await evaluate(expr.left, scope)

        return truthy(l) ? evaluate(expr.right, scope) : l
      }

      if (expr.op === '||') {
        const l = await evaluate(expr.left, scope)

        return truthy(l) ? l : evaluate(expr.right, scope)
      }

      return binary(
        expr.op,
        await evaluate(expr.left, scope),
        await evaluate(expr.right, scope),
      )
    }

    case 'index': {
      const target = await evaluate(expr.target, scope)
      const index = await evaluate(expr.index, scope)

      return indexGet(target, index)
    }

    case 'member': {
      const target = await evaluate(expr.target, scope)

      return memberGet(target, expr.name)
    }

    case 'await': {
      const v = await evaluate(expr.expr, scope)

      return v.form === 'task' ? await v.promise : v
    }

    case 'call': {
      const callee = await evaluate(expr.callee, scope)
      const args: Value[] = []

      for (const a of expr.args) {
        args.push(await evaluate(a, scope))
      }

      if (callee.form === 'native') {
        return await callee.fn(args)
      }

      if (callee.form === 'function') {
        const run = applyClosure(callee.value, args)

        return callee.value.isAsync
          ? { form: 'task', promise: run }
          : await run
      }

      throw new Error(`cannot call a ${callee.form}`)
    }
  }
}

export function binary(op: BinaryOp, a: Value, b: Value): Value {
  if (op === '==') {
    return boolean(valuesEqual(a, b))
  }

  if (op === '!=') {
    return boolean(!valuesEqual(a, b))
  }

  // string concatenation and array concatenation with +
  if (op === '+' && a.form === 'string' && b.form === 'string') {
    return { form: 'string', value: Str.concat(a.value, b.value) }
  }

  if (op === '+' && a.form === 'array' && b.form === 'array') {
    return { form: 'array', value: Arr.concat(a.value, b.value) }
  }

  // ordering of strings
  if (a.form === 'string' && b.form === 'string') {
    const c =
      Str.toString(a.value) < Str.toString(b.value)
        ? -1
        : Str.toString(a.value) > Str.toString(b.value)
          ? 1
          : 0

    return compareResult(op, c)
  }

  // numeric: integer if both integer, else float
  if (a.form === 'integer' && b.form === 'integer') {
    switch (op) {
      case '+':
        return { form: 'integer', value: Int.add(a.value, b.value) }
      case '-':
        return {
          form: 'integer',
          value: Int.subtract(a.value, b.value),
        }
      case '*':
        return {
          form: 'integer',
          value: Int.multiply(a.value, b.value),
        }
      case '/':
        return { form: 'integer', value: Int.divide(a.value, b.value) }
      case '%':
        return {
          form: 'integer',
          value: Int.remainder(a.value, b.value),
        }
      default:
        return compareResult(op, Int.compare(a.value, b.value))
    }
  }

  const af = toFloat(a),
    bf = toFloat(b)

  switch (op) {
    case '+':
      return { form: 'float', value: Flt.add(af, bf) }
    case '-':
      return { form: 'float', value: Flt.subtract(af, bf) }
    case '*':
      return { form: 'float', value: Flt.multiply(af, bf) }
    case '/':
      return {
        form: 'float',
        value: Flt.fromNumber(Flt.toNumber(af) / Flt.toNumber(bf)),
      }
    case '%':
      return {
        form: 'float',
        value: Flt.fromNumber(Flt.toNumber(af) % Flt.toNumber(bf)),
      }
    default:
      return compareResult(op, Flt.compare(af, bf))
  }
}

function toFloat(v: Value): Flt.TernaryFloat {
  if (v.form === 'float') {
    return v.value
  }

  if (v.form === 'integer') {
    return Flt.fromNumber(Number(v.value.value))
  }

  throw new Error(`expected a number, got ${v.form}`)
}

function compareResult(op: BinaryOp, c: number): Value {
  switch (op) {
    case '<':
      return boolean(c < 0)
    case '<=':
      return boolean(c <= 0)
    case '>':
      return boolean(c > 0)
    case '>=':
      return boolean(c >= 0)
    default:
      throw new Error(`bad comparison ${op}`)
  }
}

export function indexGet(target: Value, index: Value): Value {
  if (target.form === 'array') {
    return Arr.get(
      target.value,
      Number((index as { value: { value: bigint } }).value.value),
    )
  }

  if (target.form === 'string') {
    return string(
      Str.charAt(
        target.value,
        Number((index as { value: { value: bigint } }).value.value),
      ),
    )
  }

  if (target.form === 'map') {
    return Mp.get(target.value, keyOf(index)) ?? UNIT
  }

  throw new Error(`cannot index a ${target.form}`)
}

export function memberGet(target: Value, name: string): Value {
  if (name === 'length') {
    if (target.form === 'string') {
      return integer(Str.length(target.value))
    }

    if (target.form === 'array') {
      return integer(Arr.size(target.value))
    }

    if (target.form === 'map') {
      return integer(target.value.size)
    }
  }

  if (target.form === 'map') {
    return Mp.get(target.value, `s:${name}`) ?? UNIT
  }

  throw new Error(`no member "${name}" on ${target.form}`)
}

// ---- statements ----
// a thrown vibe value can escape through a value-returning context (a stdlib callback, a call expression) as a
// VibeThrow exception; catch it here and turn it back into a throw signal so try/catch can handle it uniformly
async function execute(stmt: Statement, scope: Scope): Promise<Signal> {
  try {
    return await executeStatement(stmt, scope)
  } catch (e) {
    if (e instanceof VibeThrow) {
      return { kind: 'throw', value: e.value }
    }

    throw e
  }
}

async function executeStatement(
  stmt: Statement,
  scope: Scope,
): Promise<Signal> {
  switch (stmt.form) {
    case 'let':
      define(
        scope,
        stmt.name,
        await evaluate(stmt.init, scope),
        stmt.mutable,
      )

      return NORMAL
    case 'expression':
      await evaluate(stmt.expr, scope)

      return NORMAL
    case 'return':
      return {
        kind: 'return',
        value: stmt.value ? await evaluate(stmt.value, scope) : UNIT,
      }
    case 'break':
      return { kind: 'break' }
    case 'continue':
      return { kind: 'continue' }
    case 'block':
      return executeBlock(stmt.body, makeScope(scope))
    case 'throw':
      return { kind: 'throw', value: await evaluate(stmt.value, scope) }

    case 'try': {
      let result = await executeBlock(stmt.body, makeScope(scope))

      if (result.kind === 'throw' && stmt.catchBody) {
        const cs = makeScope(scope)

        if (stmt.catchName) {
          define(cs, stmt.catchName, result.value, true)
        }

        result = await executeBlock(stmt.catchBody, cs)
      }

      if (stmt.finallyBody) {
        const f = await executeBlock(stmt.finallyBody, makeScope(scope))

        if (f.kind !== 'normal') {
          return f
        } // finally overrides the pending signal
      }

      return result
    }

    case 'for': {
      const iter = await evaluate(stmt.iterable, scope)

      for (const item of forItems(iter)) {
        const inner = makeScope(scope)
        define(inner, stmt.name, item, true)

        const sig = await executeBlock(stmt.body, inner)

        if (sig.kind === 'break') {
          break
        }

        if (sig.kind === 'return' || sig.kind === 'throw') {
          return sig
        }
      }

      return NORMAL
    }

    case 'function':
      define(
        scope,
        stmt.name,
        {
          form: 'function',
          value: {
            params: stmt.params,
            body: stmt.body,
            env: scope,
            isAsync: stmt.isAsync ?? false,
            name: stmt.name,
          },
        },
        false,
      )

      return NORMAL
    case 'assign':
      return assign(stmt, scope)

    case 'if': {
      for (const b of stmt.branches) {
        if (truthy(await evaluate(b.cond, scope))) {
          return executeBlock(b.body, makeScope(scope))
        }
      }

      return stmt.otherwise
        ? executeBlock(stmt.otherwise, makeScope(scope))
        : NORMAL
    }

    case 'while': {
      while (truthy(await evaluate(stmt.cond, scope))) {
        const sig = await executeBlock(stmt.body, makeScope(scope))

        if (sig.kind === 'break') {
          break
        }

        if (sig.kind === 'return') {
          return sig
        }
        // continue / normal both loop again
      }

      return NORMAL
    }

    case 'switch': {
      const subject = await evaluate(stmt.subject, scope)

      let matched = -1

      for (let i = 0; i < stmt.cases.length; i++) {
        if (
          valuesEqual(
            subject,
            await evaluate(stmt.cases[i]!.match, scope),
          )
        ) {
          matched = i
          break
        }
      }

      const inner = makeScope(scope)

      if (matched < 0) {
        return stmt.otherwise
          ? executeBlock(stmt.otherwise, inner)
          : NORMAL
      }

      for (let i = matched; i < stmt.cases.length; i++) {
        // fall-through until break
        const sig = await executeBlock(stmt.cases[i]!.body, inner)

        if (sig.kind === 'break') {
          return NORMAL
        }

        if (sig.kind === 'return' || sig.kind === 'continue') {
          return sig
        }
      }

      return NORMAL
    }
  }
}

async function executeBlock(
  body: Statement[],
  scope: Scope,
): Promise<Signal> {
  for (const stmt of body) {
    const sig = await execute(stmt, scope)

    if (sig.kind !== 'normal') {
      return sig
    }
  }

  return NORMAL
}

async function assign(
  stmt: Extract<Statement, { form: 'assign' }>,
  scope: Scope,
): Promise<Signal> {
  const rhs = await evaluate(stmt.value, scope)
  const apply = (current: Value): Value =>
    stmt.op === '=' ? rhs : binary(stmt.op[0] as BinaryOp, current, rhs)

  const t = stmt.target

  if (t.form === 'variable') {
    const next = stmt.op === '=' ? rhs : apply(lookup(scope, t.name))
    assignVar(scope, t.name, next)

    return NORMAL
  }

  if (t.form === 'index') {
    if (t.target.form !== 'variable') {
      throw new Error('index assignment target must be a variable')
    }

    const container = lookup(scope, t.target.name)
    const index = await evaluate(t.index, scope)

    if (container.form === 'array') {
      const i = Number(
        (index as { value: { value: bigint } }).value.value,
      )

      const next = apply(
        stmt.op === '=' ? UNIT : Arr.get(container.value, i),
      )

      assignVar(scope, t.target.name, {
        form: 'array',
        value: Arr.set(container.value, i, next),
      })

      return NORMAL
    }

    if (container.form === 'map') {
      const k = keyOf(index)
      const next = apply(
        stmt.op === '=' ? UNIT : (Mp.get(container.value, k) ?? UNIT),
      )

      Mp.set(container.value, k, next)

      return NORMAL
    }

    throw new Error(`cannot index-assign a ${container.form}`)
  }

  if (t.form === 'member') {
    if (t.target.form !== 'variable') {
      throw new Error('member assignment target must be a variable')
    }

    const container = lookup(scope, t.target.name)

    if (container.form !== 'map') {
      throw new Error(`cannot set member on a ${container.form}`)
    }

    const k = `s:${t.name}`
    Mp.set(
      container.value,
      k,
      apply(
        stmt.op === '=' ? UNIT : (Mp.get(container.value, k) ?? UNIT),
      ),
    )

    return NORMAL
  }

  throw new Error('invalid assignment target')
}

async function applyClosure(
  closure: Closure,
  args: Value[],
): Promise<Value> {
  const scope = makeScope(closure.env)
  closure.params.forEach((p, i) =>
    define(scope, p, args[i] ?? UNIT, true),
  )

  const sig = await executeBlock(closure.body, scope)

  if (sig.kind === 'throw') {
    throw new VibeThrow(sig.value)
  }

  return sig.kind === 'return' ? sig.value : UNIT
}

// a thrown vibe value escaping into host code (e.g. a stdlib callback), carried so the caller can rewrap it
export class VibeThrow extends Error {
  constructor(public value: Value) {
    super('vibe throw')
  }
}

// call any callable value (a closure or a native), used by higher-order built-ins (map / filter / reduce / ...)
export async function callValue(
  fn: Value,
  args: Value[],
): Promise<Value> {
  if (fn.form === 'function') {
    return applyClosure(fn.value, args)
  }

  if (fn.form === 'native') {
    return fn.fn(args)
  }

  if (fn.form === 'task') {
    return fn.promise
  }

  throw new Error(`cannot call a ${fn.form}`)
}

// the elements a `for` loop iterates: array elements, string codepoints, or map keys
function forItems(v: Value): Value[] {
  if (v.form === 'array') {
    return Arr.toArray(v.value)
  }

  if (v.form === 'string') {
    return Array.from(Str.toString(v.value)).map(c => string(c))
  }

  if (v.form === 'map') {
    return Mp.keys(v.value).map(k => string(k.replace(/^s:/, '')))
  }

  throw new Error(`cannot iterate a ${v.form}`)
}

// ---- the global scope with built-ins ----
export function makeGlobalScope(extra?: Record<string, Value>): Scope {
  const g = makeScope(null)
  const native = (
    name: string,
    fn: (args: Value[]) => Value | Promise<Value>,
  ): void => define(g, name, { form: 'native', name, fn }, false)

  native('print', a => {
    console.log(a.map(display).join(' '))

    return UNIT
  })
  native('len', a => indexLength(a[0]!))
  native('push', a => {
    const arr = a[0]!

    if (arr.form !== 'array') {
      throw new Error('push needs an array')
    }

    return { form: 'array', value: Arr.push(arr.value, a[1]!) }
  })
  native('str', a => string(display(a[0]!)))
  native('int', a => integer(numberOf(a[0]!)))
  native('keys', a => {
    const m = a[0]!

    if (m.form !== 'map') {
      throw new Error('keys needs a map')
    }

    return {
      form: 'array',
      value: Arr.fromArray(
        Mp.keys(m.value).map(k => string(k.replace(/^s:/, ''))),
      ),
    }
  })
  native('float', a => float(numberOf(a[0]!)))

  // math
  native('abs', a => {
    const v = a[0]!

    return v.form === 'integer'
      ? { form: 'integer', value: Int.absolute(v.value) }
      : float(Math.abs(numberOf(v)))
  })
  native('min', a => (compareValues(a[0]!, a[1]!) <= 0 ? a[0]! : a[1]!))
  native('max', a => (compareValues(a[0]!, a[1]!) >= 0 ? a[0]! : a[1]!))
  native('pow', a => {
    const x = a[0]!,
      y = a[1]!

    if (
      x.form === 'integer' &&
      y.form === 'integer' &&
      y.value.value >= 0n
    ) {
      return integer(x.value.value ** y.value.value)
    }

    return float(Math.pow(numberOf(x), numberOf(y)))
  })
  native('sqrt', a => float(Math.sqrt(numberOf(a[0]!))))
  native('floor', a => integer(BigInt(Math.floor(numberOf(a[0]!)))))
  native('ceil', a => integer(BigInt(Math.ceil(numberOf(a[0]!)))))

  // sequences
  native('range', a => {
    const s = a.length === 1 ? 0 : numberOf(a[0]!)
    const e = numberOf(a[a.length - 1]!)
    const items: Value[] = []

    for (let i = s; i < e; i++) {
      items.push(integer(i))
    }

    return { form: 'array', value: Arr.fromArray(items) }
  })
  native('pop', a => {
    const v = a[0]!

    if (v.form !== 'array') {
      throw new Error('pop needs an array')
    }

    return { form: 'array', value: Arr.pop(v.value) }
  })
  native('slice', a => {
    const v = a[0]!
    const s = numberOf(a[1]!)
    const e = a[2] ? numberOf(a[2]) : undefined

    if (v.form === 'array') {
      return { form: 'array', value: Arr.slice(v.value, s, e) }
    }

    if (v.form === 'string') {
      return { form: 'string', value: Str.slice(v.value, s, e) }
    }

    throw new Error(`slice of ${v.form}`)
  })
  native('reverse', a => ({
    form: 'array',
    value: Arr.fromArray(asArrayItems(a[0]!, 'reverse').reverse()),
  }))
  native('first', a => asArrayItems(a[0]!, 'first')[0] ?? UNIT)
  native('last', a => {
    const xs = asArrayItems(a[0]!, 'last')

    return xs[xs.length - 1] ?? UNIT
  })
  native('contains', a => {
    const c = a[0]!,
      x = a[1]!

    if (c.form === 'array') {
      return boolean(Arr.toArray(c.value).some(e => valuesEqual(e, x)))
    }

    if (c.form === 'string') {
      return boolean(Str.toString(c.value).includes(display(x)))
    }

    if (c.form === 'map') {
      return boolean(Mp.has(c.value, keyOf(x)))
    }

    throw new Error(`contains on ${c.form}`)
  })
  native('indexOf', a => {
    const xs = asArrayItems(a[0]!, 'indexOf')

    return integer(xs.findIndex(e => valuesEqual(e, a[1]!)))
  })
  native('sort', a => ({
    form: 'array',
    value: Arr.fromArray(
      asArrayItems(a[0]!, 'sort').slice().sort(compareValues),
    ),
  }))

  // higher-order (call a function value back via callValue)
  native('map', async a => {
    const fn = a[1]!
    const out: Value[] = []

    let i = 0

    for (const e of asArrayItems(a[0]!, 'map')) {
      out.push(await callValue(fn, [e, integer(i++)]))
    }

    return { form: 'array', value: Arr.fromArray(out) }
  })
  native('filter', async a => {
    const fn = a[1]!
    const out: Value[] = []

    for (const e of asArrayItems(a[0]!, 'filter')) {
      if (truthy(await callValue(fn, [e]))) {
        out.push(e)
      }
    }

    return { form: 'array', value: Arr.fromArray(out) }
  })
  native('reduce', async a => {
    const fn = a[1]!

    let acc = a[2] ?? UNIT

    for (const e of asArrayItems(a[0]!, 'reduce')) {
      acc = await callValue(fn, [acc, e])
    }

    return acc
  })
  native('sortBy', async a => {
    const fn = a[1]!
    const xs = asArrayItems(a[0]!, 'sortBy')
    const keyed = await Promise.all(
      xs.map(async e => ({ e, k: await callValue(fn, [e]) })),
    )

    keyed.sort((p, q) => compareValues(p.k, q.k))

    return { form: 'array', value: Arr.fromArray(keyed.map(x => x.e)) }
  })

  // strings
  native('split', a => ({
    form: 'array',
    value: Arr.fromArray(
      display(a[0]!).split(display(a[1]!)).map(string),
    ),
  }))
  native('join', a =>
    string(
      asArrayItems(a[0]!, 'join')
        .map(display)
        .join(a[1] ? display(a[1]) : ''),
    ),
  ) // join(arr, sep?)
  native('upper', a => string(display(a[0]!).toUpperCase()))
  native('lower', a => string(display(a[0]!).toLowerCase()))
  native('replace', a =>
    string(display(a[0]!).split(display(a[1]!)).join(display(a[2]!))),
  ) // replace all
  native('trim', a => string(display(a[0]!).trim()))

  // maps
  native('has', a => {
    const m = a[0]!

    if (m.form === 'map') {
      return boolean(Mp.has(m.value, keyOf(a[1]!)))
    }

    return boolean(
      asArrayItems(m, 'has').some(e => valuesEqual(e, a[1]!)),
    )
  })
  native('get', a => indexGet(a[0]!, a[1]!))
  native('setKey', a => {
    const m = a[0]!

    if (m.form !== 'map') {
      throw new Error('setKey needs a map')
    }

    Mp.set(m.value, keyOf(a[1]!), a[2]!)

    return m
  })
  native('del', a => {
    const m = a[0]!

    if (m.form !== 'map') {
      throw new Error('del needs a map')
    }

    Mp.remove(m.value, keyOf(a[1]!))

    return m
  })
  native('entries', a => {
    const m = a[0]!

    if (m.form !== 'map') {
      throw new Error('entries needs a map')
    }

    return {
      form: 'array',
      value: Arr.fromArray(
        Mp.entries(m.value).map(e => ({
          form: 'array',
          value: Arr.fromArray([
            string(e.key.replace(/^[sif]:/, '')),
            e.value,
          ]),
        })),
      ),
    }
  })

  for (const [k, v] of Object.entries(extra ?? {})) {
    define(g, k, v, false)
  }

  return g
}

function indexLength(v: Value): Value {
  if (v.form === 'string') {
    return integer(Str.length(v.value))
  }

  if (v.form === 'array') {
    return integer(Arr.size(v.value))
  }

  if (v.form === 'map') {
    return integer(v.value.size)
  }

  throw new Error(`len of ${v.form}`)
}

function numberOf(v: Value): number {
  if (v.form === 'integer') {
    return Number(v.value.value)
  }

  if (v.form === 'float') {
    return Flt.toNumber(v.value)
  }

  if (v.form === 'string') {
    return Number(Str.toString(v.value))
  }

  throw new Error(`int of ${v.form}`)
}

function compareValues(a: Value, b: Value): number {
  if (truthy(binary('<', a, b))) {
    return -1
  }

  if (truthy(binary('>', a, b))) {
    return 1
  }

  return 0
}

function asArrayItems(v: Value, op: string): Value[] {
  if (v.form !== 'array') {
    throw new Error(`${op} needs an array, got ${v.form}`)
  }

  return Arr.toArray(v.value)
}

// run a program in a fresh global scope (plus any extra bindings), returning the last evaluated value
export async function run(
  program: Program,
  extra?: Record<string, Value>,
): Promise<Value> {
  const g = makeGlobalScope(extra)

  // hoist function declarations so they can be called before their textual position
  for (const stmt of program) {
    if (stmt.form === 'function') {
      await execute(stmt, g)
    }
  }

  let last: Value = UNIT

  for (const stmt of program) {
    if (stmt.form === 'function') {
      continue
    }

    if (stmt.form === 'expression') {
      last = await evaluate(stmt.expr, g)
      continue
    }

    const sig = await execute(stmt, g)

    if (sig.kind === 'return') {
      return sig.value
    }
  }

  return last
}

// call a named function defined in a program, with argument values, returning its result
export async function callFunction(
  program: Program,
  name: string,
  args: Value[],
  extra?: Record<string, Value>,
): Promise<Value> {
  const g = makeGlobalScope(extra)

  for (const stmt of program) {
    if (stmt.form === 'function') {
      await execute(stmt, g)
    }
  }

  const fn = lookup(g, name)

  if (fn.form === 'function') {
    return applyClosure(fn.value, args)
  }

  if (fn.form === 'native') {
    return fn.fn(args)
  }

  throw new Error(`"${name}" is not a function`)
}
