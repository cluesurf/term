// Integer operations proven inside the safe integers by intervals (note/term/codegen/passes.md, P2). Every `+`, `-`
// and `*` on two numbers is checked on every backend (`__termInt`, `checked_add`, `Math.addExact`), because a result
// past the range is a different integer or a rounded one. A check whose operands are bounded can never fire, and this
// fact names the operations where that is proven, so an emitter writes them plain; and a `/` or `%` whose divisor is
// proven not zero (nor -1 for a quotient of an unknown, the one quotient that overflows).
//
// Two levels, solved together:
//
// IN A TASK, FLOW-SENSITIVE. Each task is walked forward, statement by statement, with a state of intervals for its
// locals, so an expression's value is the value at THAT point: `if x > 500 { x = 500 }` leaves `x <= 500` after it,
// which no hull of every value `x` is ever given can say (AWFY's Bounce). An `if` refines each branch by its condition
// and joins the branches after; a branch that leaves (`return`, `throw`, `break`, `continue`) joins nothing. A `while`
// is iterated to a fixpoint, each turn entered with its condition true and left with it false, widened after a few
// turns (a side still growing becomes unknown) and then narrowed once, so a counter under `i < 1000` leaves the loop
// at most 1000. `&&`, `||` and a conditional refine their right side by their left. A guard's handler starts with every
// name its body assigns unknown, since any prefix of the body may have run. A closure's body may run at any later
// time, so it sees only the outer names that never change (declared once, never assigned); a name a closure writes is
// unknown everywhere. A walk's item, an arm's field and a closure's parameter are unknown.
//
// ACROSS THE PROGRAM, A FIXPOINT of what the walks find:
//   - a parameter of a task outside the public surface (`internal`), defined once, not async, not a trait's method,
//     and never named except as the callee of a direct call, is the hull of its arguments at every call, each the
//     value at that call. A root's parameters are unknown: anything outside may call it
//   - a task's answer is the hull of its `return`s outside closures, for a task defined once, not async, not a method
//   - a slot of a record's list that the record OWNS (backend.ts `ownedFields`) holds the hull of what is ever put in
//     it: each slot written through the path, and what the owned local was given before it was stored (its literal
//     items, its pushes, its slot writes). A list passed to a task that writes it makes them unknown
//   - a plain record's number field is the hull of what every construction gives it and every path write puts in it,
//     unknown for a form native code may build, a construction that leaves it out or fills it by position, and every
//     form once the program fills or melts one
// A global still growing after a number of rounds is widened on the side that grows. The bound is 2^53 - 1, inside
// i64, so a proof holds on Rust, Swift and Kotlin as it does on TypeScript. A task whose walk exceeds its step budget
// proves nothing and makes everything it gives unknown, so compile time stays bounded.
//
// A fact that is wrong removes a check that should fire, so every rule has a counterexample in
// test/ir/facts/interval.ts that must NOT be proven.
//
// Measured first on Particle (ours): every coordinate is `(old * 31 + i + step) % 1000`, written back into the record's
// own list. TypeScript 286 ms to 212 with those checks gone (`tmp/ts-particle-ab.ts`), the hand version 135.

import type { Expression, Program, Statement } from '@term/make/code/compile/node'
import { LIST_LENGTH_TASKS } from '@term/make/code/compile/lowered-members'

type Loose = Record<string, unknown> & { form?: string; name?: string }
// a side past the safe integers is infinite, which is unknown on that side only: `[0, Infinity)` is "not negative"
type Span = { lo: number; hi: number }
// `null` is no value (unreachable, or the fixpoint's bottom), `'top'` any value
type Value = Span | null | 'top'
type Fn = Extract<Statement, { form: 'function' }>
type Lend = 'read' | 'write'
// the intervals of the tracked names at one point; `null` where the point cannot be reached
type State = Map<string, Value> | null

const SAFE = Number.MAX_SAFE_INTEGER
// rounds a global may grow before the side that grows is widened. Enough for a recursion that counts to a small literal
// one step a round (Queens' column, 0 to 7) to settle first
const WIDEN = 16
// turns a loop may grow before the side that grows is widened (a loop then narrows once, which recovers its bound)
const WIDEN_LOOP = 6
// the steps one task's walk may take in one round before it gives up
const BUDGET = 400_000

const isNumber = (e: Loose | undefined): boolean => (e?.type as { kind?: string } | undefined)?.kind === 'number'

const span = (lo: number, hi: number): Value => {
  if (Number.isNaN(lo) || Number.isNaN(hi)) {
    return 'top'
  }

  const low = lo < -SAFE ? -Infinity : lo
  const high = hi > SAFE ? Infinity : hi

  return low === -Infinity && high === Infinity ? 'top' : { lo: low, hi: high }
}

// a span with both sides known, which is the only kind that proves anything
const finite = (v: Value | undefined): v is Span => v !== undefined && v !== null && v !== 'top' && Number.isFinite(v.lo) && Number.isFinite(v.hi)

const join = (a: Value, b: Value): Value => {
  if (a === null) {
    return b
  }

  if (b === null) {
    return a
  }

  if (a === 'top' || b === 'top') {
    return 'top'
  }

  return { lo: Math.min(a.lo, b.lo), hi: Math.max(a.hi, b.hi) }
}

const same = (a: Value, b: Value): boolean =>
  a === b || (a !== null && b !== null && a !== 'top' && b !== 'top' && a.lo === b.lo && a.hi === b.hi)

// the side of `after` that grew past `before`, widened to unknown
const widen = (before: Value, after: Value): Value => {
  if (before === null || before === 'top' || after === null || after === 'top') {
    return after
  }

  return span(after.lo < before.lo ? -Infinity : after.lo, after.hi > before.hi ? Infinity : after.hi)
}

// the arithmetic of two intervals, by operator; `undefined` for an operator this does not track
function arith(op: string, a: Value, b: Value): Value {
  // a remainder by a divisor that excludes zero is smaller than the divisor, whatever the dividend
  if (op === '%' && b !== null && b !== 'top' && (b.lo > 0 || b.hi < 0)) {
    const m = Math.max(Math.abs(b.lo), Math.abs(b.hi)) - 1

    if (a === null) {
      return null
    }

    if (a !== 'top' && a.lo >= 0) {
      return span(0, Math.min(a.hi, m))
    }

    if (a !== 'top' && a.hi <= 0) {
      return span(Math.max(a.lo, -m), 0)
    }

    return span(-m, m)
  }

  if (a === null || b === null) {
    return null
  }

  if (a === 'top' || b === 'top') {
    return 'top'
  }

  // a product's corners; an unknown side times 0 is 0, since what it stands for is a number
  const times = (x: number, y: number): number => (x === 0 || y === 0 ? 0 : x * y)

  switch (op) {
    case '+':
      return span(a.lo + b.lo, a.hi + b.hi)
    case '-':
      return span(a.lo - b.hi, a.hi - b.lo)
    case '*': {
      const all = [times(a.lo, b.lo), times(a.lo, b.hi), times(a.hi, b.lo), times(a.hi, b.hi)]

      return span(Math.min(...all), Math.max(...all))
    }
    case '/': {
      // an integer quotient is no larger than its dividend, and not negative when both sides are not; a zero divisor
      // stops the program
      if (b.lo <= 0 && b.hi >= 0) {
        return 'top'
      }

      if (a.lo >= 0 && b.lo > 0) {
        return span(0, a.hi)
      }

      const m = Math.max(Math.abs(a.lo), Math.abs(a.hi))

      return span(-m, m)
    }
    default:
      return 'top'
  }
}

// what a condition says when it is `truth`: `name op bound`, from a comparison with a name on either side, both
// sides of an `&&` that held or an `||` that failed, and a `!` turned over. Anything else says nothing, which is only
// less precise
type Fact = { name: string; op: string; bound: Loose }

const NEGATE: Record<string, string> = { '<': '>=', '<=': '>', '>': '<=', '>=': '<', '==': '!=', '!=': '==' }
const FLIP: Record<string, string> = { '<': '>', '<=': '>=', '>': '<', '>=': '<=', '==': '==', '!=': '!=' }

function conditionFacts(cond: Loose, truth: boolean): Fact[] {
  if (cond.form === 'unary' && cond.op === '!') {
    return conditionFacts(cond.operand as Loose, !truth)
  }

  if (cond.form !== 'binary') {
    return []
  }

  const left = cond.left as Loose
  const right = cond.right as Loose
  const op = cond.op as string

  if ((op === '&&' && truth) || (op === '||' && !truth)) {
    return [...conditionFacts(left, truth), ...conditionFacts(right, truth)]
  }

  if (!(op in NEGATE) || !isNumber(left) || !isNumber(right)) {
    return []
  }

  const held = truth ? op : NEGATE[op]!
  const facts: Fact[] = []

  if (left.form === 'variable') {
    facts.push({ name: left.name as string, op: held, bound: right })
  }

  if (right.form === 'variable') {
    facts.push({ name: right.name as string, op: FLIP[held]!, bound: left })
  }

  return facts
}

// a value narrowed by one fact against its bound's interval; `null` where nothing is left
function narrowBy(value: Value, op: string, bound: Value): Value {
  if (value === null || bound === null || bound === 'top') {
    return value
  }

  let lo = value === 'top' ? -Infinity : value.lo
  let hi = value === 'top' ? Infinity : value.hi

  switch (op) {
    case '<':
      hi = Math.min(hi, bound.hi - 1)
      break
    case '<=':
      hi = Math.min(hi, bound.hi)
      break
    case '>':
      lo = Math.max(lo, bound.lo + 1)
      break
    case '>=':
      lo = Math.max(lo, bound.lo)
      break
    case '==':
      lo = Math.max(lo, bound.lo)
      hi = Math.min(hi, bound.hi)
      break
    case '!=':
      // only a single excluded value at an end moves it
      if (bound.lo === bound.hi && lo === bound.lo) {
        lo += 1
      } else if (bound.lo === bound.hi && hi === bound.hi) {
        hi -= 1
      }

      break
  }

  return lo > hi ? null : span(lo, hi)
}

// a slot read or written by index: `xs/{i}` or a literal `xs/0`
const slot = (node: Loose | undefined): boolean =>
  node?.form === 'member' && (node.index !== undefined || /^\d+$/.test(node.name as string))

// every name an assignment writes under a node
function assignedNames(value: unknown, into = new Set<string>()): Set<string> {
  if (typeof value !== 'object' || value === null) {
    return into
  }

  if (Array.isArray(value)) {
    value.forEach(v => assignedNames(v, into))

    return into
  }

  const node = value as Loose

  if (node.form === 'assign' && (node.target as Loose).form === 'variable') {
    into.add((node.target as Loose).name as string)
  }

  if (node.form === 'let') {
    into.add(node.name as string)
  }

  for (const [key, child] of Object.entries(node)) {
    if (key !== 'type' && key !== 'span') {
      assignedNames(child, into)
    }
  }

  return into
}

export function boundedArithmetic(
  program: Program,
  // the record list fields the record owns, keyed `form/field` (backend.ts, `ownedFields`)
  owned: Set<string>,
  // the list parameters each task takes lent, and whether it writes them (backend.ts, `listFacts`)
  lend: Map<string, Map<number, Lend>>,
  // the forms whose values cross into native code (backend.ts, `nativeForms`): a shim may build one with any field
  native: Set<string> = new Set(),
): WeakSet<Expression> {
  const proven = new WeakSet<Expression>()
  const fns = (program as Statement[]).filter((n): n is Fn => n.form === 'function')
  const plain = new Set((program as Statement[]).flatMap(n => (n.form === 'record-type' && n.variants.length === 0 ? [n.name] : [])))
  const closureWrites = namesWrittenInClosures(program)
  const numberFields = new Map<string, string[]>()

  for (const node of program as Statement[]) {
    if (node.form === 'record-type' && node.variants.length === 0) {
      numberFields.set(node.name, node.fields.filter(f => f.type.kind === 'number').map(f => f.name))
    }
  }

  // the owned key a path `r/field` names
  const pathKey = (node: Loose | undefined): string | undefined => {
    if (node?.form !== 'member' || node.index !== undefined) {
      return undefined
    }

    const type = (node.target as Loose).type as { kind?: string; name?: string } | undefined
    const key = type?.kind === 'named' && plain.has(type.name!) ? `${type.name}/${node.name as string}` : undefined

    return key !== undefined && owned.has(key) ? key : undefined
  }

  // the field key a path `r.field` names, when it reads a plain record's number field
  const fieldKey = (node: Loose | undefined): string | undefined => {
    if (node?.form !== 'member' || node.index !== undefined || /^\d+$/.test(node.name as string)) {
      return undefined
    }

    const type = (node.target as Loose).type as { kind?: string; name?: string } | undefined

    return type?.kind === 'named' && numberFields.get(type.name!)?.includes(node.name as string) ? `${type.name}.${node.name as string}` : undefined
  }

  // the tasks whose every call is in the program and seen here (each parameter the hull of its arguments), and the
  // tasks whose answer is the hull of their returns
  const defined = new Map<string, number>()
  const named = new Set<string>()

  for (const fn of fns) {
    defined.set(fn.name, (defined.get(fn.name) ?? 0) + 1)
  }

  const references = (value: unknown, callee: boolean): void => {
    if (typeof value !== 'object' || value === null) {
      return
    }

    if (Array.isArray(value)) {
      value.forEach(v => references(v, false))

      return
    }

    const node = value as Loose
    const kind = (node.binding as { kind?: string } | undefined)?.kind

    if (node.form === 'variable' && !callee && kind !== 'local' && kind !== 'parameter') {
      named.add(node.name as string)
    }

    for (const [key, child] of Object.entries(node)) {
      if (key !== 'type' && key !== 'span') {
        references(child, node.form === 'call' && key === 'callee')
      }
    }
  }

  references(program, false)

  const closed = new Set(
    fns
      .filter(fn => fn.internal && !fn.async && !fn.method && defined.get(fn.name) === 1 && !named.has(fn.name) && fn.params.length > 0)
      .map(fn => fn.name),
  )
  const answers = new Set(fns.filter(fn => defined.get(fn.name) === 1 && !fn.async && !fn.method && fn.result?.kind === 'number').map(fn => fn.name))

  // the static scan: what each node gives a global when it is evaluated (`contrib`), the keys anything unknown is put
  // in, and per task the names it tracks and the names that never change
  type Task = { fn: Fn; excluded: Set<string>; stable: Set<string> }
  const tasks: Task[] = []
  const contrib = new WeakMap<object, string[]>()
  const give = (node: object, key: string): void => {
    contrib.set(node, [...(contrib.get(node) ?? []), key])
  }
  const unknownKeys = new Set<string>()
  let walkers = false
  // the calls to each closed task, to check their number of arguments
  const arities = new Map<string, number[]>()

  for (const fn of fns) {
    const excluded = new Set<string>()
    const declared = new Map<string, number>(fn.params.map(p => [p.name, 1]))
    const assigned = new Set<string>()
    // the stored locals of this task: a construction handing one into an owned field
    const stored = new Map<string, string>()

    const visit = (value: unknown): void => {
      if (typeof value !== 'object' || value === null) {
        return
      }

      if (Array.isArray(value)) {
        value.forEach(visit)

        return
      }

      const node = value as Loose

      switch (node.form) {
        case 'let':
          declared.set(node.name as string, (declared.get(node.name as string) ?? 0) + 1)
          break
        case 'assign': {
          const target = node.target as Loose

          if (target.form === 'variable') {
            assigned.add(target.name as string)
          }

          // a slot written through an owned path, and a number field written through a path
          const key = slot(target) ? pathKey(target.target as Loose) : fieldKey(target)

          if (key) {
            if (node.op === '=') {
              give(node.value as object, key)
            } else {
              unknownKeys.add(key)
            }
          }

          break
        }
        case 'variable':
          // a name the task reads as something other than a local or a parameter
          if ((node.binding as { kind?: string } | undefined)?.kind && !['local', 'parameter'].includes((node.binding as { kind: string }).kind)) {
            excluded.add(node.name as string)
          }

          break
        case 'call': {
          const callee = node.callee as Loose
          const args = node.args as Loose[]

          if (callee.form === 'variable' && closed.has(callee.name as string)) {
            arities.set(callee.name as string, [...(arities.get(callee.name as string) ?? []), args.length])
            args.forEach((a, i) => give(a, `param:${callee.name as string}:${i}`))
          }

          // the form walkers build any record, with any field
          if (callee.form === 'variable' && (callee.name === 'fill-form' || callee.name === 'melt-form')) {
            walkers = true
          }

          break
        }
        case 'for-each':
          excluded.add(node.item as string)

          if (typeof node.index === 'string') {
            excluded.add(node.index)
          }

          break
        case 'closure':
          for (const p of (node.params as { name: string }[]) ?? []) {
            excluded.add(p.name)
          }

          break
        case 'match':
          for (const c of node.cases as { binds?: string[] }[]) {
            for (const b of c.binds ?? []) {
              excluded.add(b)
            }
          }

          break
        case 'guard':
          if ((node.catch as { name?: string } | undefined)?.name) {
            excluded.add((node.catch as { name: string }).name)
          }

          break
        case 'record': {
          // a construction: an owned field given an empty list adds nothing, a local adds what that local was given,
          // anything else (a fresh task's answer) is unknown
          if (plain.has(node.name as string)) {
            for (const f of node.fields as { name: string; value: Loose }[]) {
              const key = `${node.name as string}/${f.name}`

              if (!owned.has(key) || (f.value.form === 'array' && (f.value.items as unknown[]).length === 0)) {
                continue
              }

              if (f.value.form === 'variable') {
                stored.set(f.value.name as string, key)
              } else {
                unknownKeys.add(key)
              }
            }
          }

          // each number field given its value, or unknown when the construction leaves it out or fills by position
          for (const field of numberFields.get(node.name as string) ?? []) {
            const key = `${node.name as string}.${field}`
            const given = (node.fields as { name: string; value: Loose }[]).find(f => f.name === field)

            if (given && !(node.positional as unknown[] | undefined)?.length) {
              give(given.value, key)
            } else {
              unknownKeys.add(key)
            }
          }

          break
        }
      }

      for (const [key, child] of Object.entries(node)) {
        if (key !== 'type' && key !== 'span') {
          visit(child)
        }
      }
    }

    visit(fn.body)

    for (const name of closureWrites) {
      excluded.add(name)
    }

    // what each stored local was given: its literal items, its pushes, its slot writes. A local the task hands to a
    // task that writes it is unknown
    for (const [local, key] of stored) {
      elementsOf(fn.body, local, lend, value => give(value, key), () => unknownKeys.add(key))
    }

    const stable = new Set([...declared].filter(([name, count]) => count === 1 && !assigned.has(name) && !excluded.has(name)).map(([name]) => name))

    tasks.push({ fn, excluded, stable })
  }

  // the globals: owned list elements, number fields, closed tasks' parameters, answers
  const globals = new Map<string, Value>()

  for (const key of owned) {
    globals.set(key, unknownKeys.has(key) ? 'top' : null)
  }

  for (const [form, fields] of numberFields) {
    for (const field of fields) {
      const key = `${form}.${field}`
      globals.set(key, walkers || native.has(form) || unknownKeys.has(key) ? 'top' : null)
    }
  }

  for (const fn of fns) {
    if (closed.has(fn.name)) {
      // a call with another number of arguments leaves the parameters unknown (the checker fills omitted ones, so this
      // should not happen), and a task never called keeps them bottom: its body is never reached
      const bad = (arities.get(fn.name) ?? []).some(n => n !== fn.params.length)
      fn.params.forEach((_, i) => globals.set(`param:${fn.name}:${i}`, bad ? 'top' : null))
    }

    if (answers.has(fn.name)) {
      globals.set(`task:${fn.name}`, null)
    }
  }

  // what this round's walks put in each global, and what each expression evaluated to (joined over every walk: a
  // global only grows, so a later walk's value covers an earlier one's)
  let found = new Map<string, Value>()
  const recorded = new WeakMap<object, Value>()
  // the tasks that ran out of steps, and the globals each task's walk read, so a round re-walks only a task whose
  // inputs changed
  const spent = new Set<Fn>()
  const reads = new Map<Fn, Set<string>>()
  let reading = new Set<string>()
  const read = (key: string): Value => {
    reading.add(key)

    return globals.get(key)!
  }
  const put = (key: string, v: Value): void => {
    if (globals.has(key) && v !== null) {
      found.set(key, join(found.get(key) ?? null, v))
    }
  }

  // one task's walk
  const walk = (task: Task): void => {
    let steps = 0
    type Loop = { breaks: State[]; continues: State[] }
    const loops: Loop[] = []
    // inside a closure's body a `return` is the closure's, not the task's answer
    let inClosure = false

    const tick = (): void => {
      if (++steps > BUDGET) {
        throw new Spent()
      }
    }

    // a state is changed in place along a straight line, and copied where control splits (each branch, each turn, each
    // case, a guard's body and handler), so an assignment costs one write, not a copy of every name
    const set = (state: Map<string, Value>, name: string, v: Value): Map<string, Value> => {
      if (!task.excluded.has(name)) {
        state.set(name, v)
      }

      return state
    }
    const copy = (state: State): State => (state === null ? null : new Map(state))

    const joinStates = (states: State[]): State => {
      const live = states.filter((s): s is Map<string, Value> => s !== null)

      if (live.length === 0) {
        return null
      }

      if (live.length === 1) {
        return live[0]!
      }

      const out = new Map<string, Value>()

      for (const s of live) {
        for (const [name, v] of s) {
          out.set(name, out.has(name) ? join(out.get(name)!, v) : v)
        }
      }

      return out
    }

    const sameStates = (a: State, b: State): boolean => {
      if (a === null || b === null) {
        return a === b
      }

      if (a.size !== b.size) {
        return false
      }

      for (const [name, v] of a) {
        if (!b.has(name) || !same(v, b.get(name)!)) {
          return false
        }
      }

      return true
    }

    const widenStates = (before: State, after: State): State => {
      if (before === null || after === null) {
        return after
      }

      const out = new Map<string, Value>()

      for (const [name, v] of after) {
        out.set(name, before.has(name) ? widen(before.get(name)!, v) : v)
      }

      return out
    }

    // a condition's facts applied to a state; `null` where the condition cannot be `truth` there
    const refine = (state: State, cond: Loose, truth: boolean): State => {
      if (state === null) {
        return null
      }

      // always a new state, so the caller may change it
      const out = new Map(state)

      for (const fact of conditionFacts(cond, truth)) {
        if (!out.has(fact.name)) {
          continue
        }

        const narrowed = narrowBy(out.get(fact.name)!, fact.op, value(fact.bound, state, true))

        if (narrowed === null) {
          return null
        }

        set(out, fact.name, narrowed)
      }

      return out
    }

    // an expression's value in a state. `quiet` reads without recording or giving, for a condition's bound
    const value = (e: Loose | undefined, state: State, quiet = false): Value => {
      if (!e || state === null) {
        return null
      }

      tick()
      let v: Value = 'top'

      switch (e.form) {
        case 'integer': {
          const n = Number(e.value)
          v = span(n, n)
          break
        }
        case 'variable':
          v = state.has(e.name as string) ? state.get(e.name as string)! : 'top'
          break
        case 'unary': {
          const inner = value(e.operand as Loose, state, quiet)
          v = e.op === '-' && isNumber(e.operand as Loose) ? (inner === null || inner === 'top' ? inner : span(-inner.hi, -inner.lo)) : 'top'
          break
        }
        case 'binary': {
          const op = e.op as string
          const a = value(e.left as Loose, state, quiet)
          // the right side of `&&` and `||` runs only where the left allowed it
          const right = op === '&&' ? refine(state, e.left as Loose, true) : op === '||' ? refine(state, e.left as Loose, false) : state
          const b = value(e.right as Loose, right, quiet)
          v = ['+', '-', '*', '/', '%'].includes(op) && isNumber(e.left as Loose) && isNumber(e.right as Loose) ? arith(op, a, b) : 'top'
          break
        }
        case 'member': {
          value(e.target as Loose, state, quiet)
          value(e.index as Loose | undefined, state, quiet)
          const key = slot(e) ? pathKey(e.target as Loose) : fieldKey(e)
          v = key ? read(key) : 'top'
          break
        }
        case 'call': {
          const callee = e.callee as Loose

          if (callee.form !== 'variable') {
            value(callee, state, quiet)
          }

          for (const a of e.args as Loose[]) {
            value(a, state, quiet)
          }

          v =
            callee.form === 'variable' && answers.has(callee.name as string) && (callee.binding as { kind?: string } | undefined)?.kind === 'function'
              ? read(`task:${callee.name as string}`)
              : 'top'
          break
        }
        case 'conditional': {
          let rest: State = state
          v = null

          for (const b of e.branches as { cond: Loose; value: Loose }[]) {
            value(b.cond, rest, quiet)
            v = join(v, value(b.value, refine(rest, b.cond, true), quiet))
            rest = refine(rest, b.cond, false)
          }

          v = join(v, value(e.otherwise as Loose | undefined, rest, quiet))
          break
        }
        case 'closure':
          if (!quiet) {
            closure(e, state)
          }

          break
        case 'array':
          ;(e.items as Loose[]).forEach(i => value(i, state, quiet))
          break
        case 'map':
          ;(e.entries as { key: Loose; value: Loose }[]).forEach(en => {
            value(en.key, state, quiet)
            value(en.value, state, quiet)
          })
          break
        case 'record':
          ;(e.fields as { value: Loose }[]).forEach(f => value(f.value, state, quiet))
          ;((e.positional as Loose[] | undefined) ?? []).forEach(p => value(p, state, quiet))
          break
        case 'template':
          // each part says which it is (compile/node.ts, `TemplatePart`)
          ;(e.parts as { form: string; value: unknown }[]).forEach(p => {
            if (p.form === 'value') value(p.value as Loose, state, quiet)
          })
          break
        case 'await':
          value(e.expr as Loose, state, quiet)
          break
      }

      if (!quiet && v !== null) {
        recorded.set(e, join(recorded.get(e) ?? null, v))

        for (const key of contrib.get(e) ?? []) {
          put(key, v)
        }
      }

      return v
    }

    // a closure's body, run where it is made: it may run then or at any later time, so it sees only the names that
    // never change
    const closure = (e: Loose, state: Map<string, Value>): void => {
      const entry = new Map([...state].filter(([name]) => task.stable.has(name)))
      const outerLoops = loops.splice(0)
      const outer = inClosure
      inClosure = true
      run(e.body as Statement[], entry)
      inClosure = outer
      loops.push(...outerLoops)
    }

    const run = (body: Statement[], state: State): State => {
      let s = state

      for (const statement of body) {
        if (s === null) {
          return null
        }

        s = step(statement as unknown as Loose, s)
      }

      return s
    }

    // a loop body iterated to a fixpoint from `entry`: each turn entered through `enter` (the condition, for a
    // `while`), widened after a few turns, then narrowed once. Answers the state at the loop's head and the breaks
    const iterate = (entry: Map<string, Value>, enter: (head: State) => State, body: Statement[]): { head: State; breaks: State[] } => {
      let head: State = entry
      let breaks: State[] = []

      for (let turn = 0; ; turn++) {
        loops.push({ breaks: [], continues: [] })
        const out = run(body, copy(enter(head)))
        const loop = loops.pop()!
        breaks = loop.breaks
        const next = joinStates([head, out, ...loop.continues])

        if (sameStates(next, head)) {
          break
        }

        head = turn >= WIDEN_LOOP ? widenStates(head, next) : next
      }

      // one narrowing turn from the fixpoint: the entry joined with what a turn gives back, which recovers a bound the
      // widening gave up (a counter under `i < 1000` back to at most 1000). Sound, since it starts from a post-fixpoint
      loops.push({ breaks: [], continues: [] })
      const out = run(body, copy(enter(head)))
      const loop = loops.pop()!
      const narrowed = joinStates([entry, out, ...loop.continues])

      return { head: narrowed, breaks: [...breaks, ...loop.breaks] }
    }

    const step = (s: Loose, state: Map<string, Value>): State => {
      tick()

      switch (s.form) {
        case 'let':
          return set(state, s.name as string, value(s.init as Loose, state))
        case 'assign': {
          const target = s.target as Loose
          const v = value(s.value as Loose, state)

          if (target.form === 'variable') {
            const name = target.name as string
            const op = s.op as string

            if (op === '=') {
              return set(state, name, v)
            }

            // a compound write is the operation on the name's value
            const current = state.has(name) ? state.get(name)! : 'top'

            return set(state, name, isNumber(target) && ['+=', '-=', '*='].includes(op) ? arith(op[0]!, current, v) : 'top')
          }

          value(target, state)

          return state
        }
        case 'expression':
          value(s.expr as Loose, state)

          return state
        case 'return': {
          const v = value(s.value as Loose | undefined, state)

          if (!inClosure && answers.has(task.fn.name) && s.value) {
            put(`task:${task.fn.name}`, v)
          }

          return null
        }
        case 'throw':
          value(s.value as Loose, state)

          return null
        case 'exit':
          return null
        case 'break':
          loops[loops.length - 1]?.breaks.push(state)

          return null
        case 'continue':
          loops[loops.length - 1]?.continues.push(state)

          return null
        case 'if': {
          let rest: State = state
          const outs: State[] = []

          for (const b of s.branches as { cond: Loose; body: Statement[] }[]) {
            value(b.cond, rest)
            outs.push(run(b.body, refine(rest, b.cond, true)))
            rest = refine(rest, b.cond, false)
          }

          outs.push(s.otherwise ? run(s.otherwise as Statement[], rest) : rest)

          return joinStates(outs)
        }
        case 'while': {
          const cond = s.cond as Loose
          const { head, breaks } = iterate(
            state,
            h => {
              value(cond, h)

              return refine(h, cond, true)
            },
            s.body as Statement[],
          )

          return joinStates([refine(head, cond, false), ...breaks])
        }
        case 'for-each': {
          value(s.iterable as Loose, state)
          const { head, breaks } = iterate(state, h => h, s.body as Statement[])

          return joinStates([head, ...breaks])
        }
        case 'match': {
          value(s.subject as Loose, state)
          const outs = (s.cases as { body: Statement[] }[]).map(c => run(c.body, copy(state)))

          if (s.otherwise) {
            outs.push(run(s.otherwise as Statement[], copy(state)))
          } else if (!s.closed) {
            outs.push(state)
          }

          return joinStates(outs)
        }
        case 'guard': {
          const done = run(s.body as Statement[], copy(state))
          // the handler may follow any prefix of the body, so whatever the body assigns is unknown there
          const caught: Map<string, Value> = new Map(state)

          for (const name of assignedNames(s.body)) {
            set(caught, name, 'top')
          }

          const handler = s.catch as { body: Statement[] } | undefined

          return joinStates([done, handler ? run(handler.body, caught) : caught])
        }
        default:
          return state
      }
    }

    reading = new Set()
    const entry = new Map<string, Value>()

    task.fn.params.forEach((p, i) => {
      if (!task.excluded.has(p.name)) {
        entry.set(p.name, closed.has(task.fn.name) ? read(`param:${task.fn.name}:${i}`) : 'top')
      }
    })

    try {
      run(task.fn.body, entry)
    } catch (thrown) {
      if (!(thrown instanceof Spent)) {
        throw thrown
      }

      // a task that ran out of steps gives unknown to everything it reaches, and is not walked again
      spent.add(task.fn)
      const visit = (value: unknown): void => {
        if (typeof value !== 'object' || value === null) return
        if (Array.isArray(value)) return value.forEach(visit)
        for (const key of contrib.get(value) ?? []) put(key, 'top')
        for (const [k, child] of Object.entries(value)) if (k !== 'type' && k !== 'span') visit(child)
      }

      visit(task.fn.body)

      if (answers.has(task.fn.name)) {
        put(`task:${task.fn.name}`, 'top')
      }
    }

    reads.set(task.fn, reading)
  }

  const grown = new Map<string, number>()
  let settled = false

  // the tasks a round walks: every one at first, then only those that read a global the last round changed
  let due: Task[] = tasks

  for (let round = 0; round < 100; round++) {
    found = new Map()

    for (const task of due) {
      if (!spent.has(task.fn)) {
        walk(task)
      }
    }

    const changed = new Set<string>()

    for (const [key, before] of globals) {
      const after = join(before, found.get(key) ?? null)

      if (same(before, after)) {
        continue
      }

      const times = (grown.get(key) ?? 0) + 1
      grown.set(key, times)
      globals.set(key, times > WIDEN ? widen(before, after) : after)
      changed.add(key)
    }

    if (changed.size === 0) {
      settled = true
      break
    }

    due = tasks.filter(task => [...(reads.get(task.fn) ?? [])].some(key => changed.has(key)))
  }

  // a fixpoint that does not settle proves nothing
  if (!settled) {
    return proven
  }

  // every integer `+`, `-` and `*` whose value at its own point is inside the bound, and every `/` and `%` whose
  // divisor's excludes zero (and -1, for a quotient of an unknown)
  for (const task of tasks) {
    if (spent.has(task.fn)) {
      continue
    }

    const visit = (value: unknown): void => {
      if (typeof value !== 'object' || value === null) {
        return
      }

      if (Array.isArray(value)) {
        value.forEach(visit)

        return
      }

      const node = value as Loose

      if (node.form === 'binary' && isNumber(node.left as Loose) && isNumber(node.right as Loose)) {
        if (['+', '-', '*'].includes(node.op as string) && finite(recorded.get(node))) {
          proven.add(node as unknown as Expression)
        }

        if (node.op === '%' || node.op === '/') {
          const divisor = recorded.get(node.right as object)
          const nonzero = divisor !== undefined && divisor !== null && divisor !== 'top' && (divisor.lo > 0 || divisor.hi < 0)
          const notMinusOne = nonzero && (divisor.lo > 0 || divisor.hi < -1)

          if (nonzero && (node.op === '%' || notMinusOne || finite(recorded.get(node.left as object)))) {
            proven.add(node as unknown as Expression)
          }
        }
      }

      for (const [key, child] of Object.entries(node)) {
        if (key !== 'type' && key !== 'span') {
          visit(child)
        }
      }
    }

    visit(task.fn.body)
  }

  return proven
}

// a walk that ran past its step budget
class Spent extends Error {}

// what a local list is given in a body: each literal item of its `let`, each value pushed onto it, each value written
// into one of its slots. `unknown` when anything else could put a value in: a `let` from anything but a list literal or
// an empty list, a compound write into a slot, the local passed to a task that writes it, or the local written whole
function elementsOf(
  body: Statement[],
  local: string,
  lend: Map<string, Map<number, Lend>>,
  put: (value: Loose) => void,
  unknown: () => void,
): void {
  const visit = (value: unknown): void => {
    if (typeof value !== 'object' || value === null) {
      return
    }

    if (Array.isArray(value)) {
      value.forEach(visit)

      return
    }

    const node = value as Loose

    if (node.form === 'let' && node.name === local) {
      const init = node.init as Loose

      if (init.form === 'array') {
        ;(init.items as Loose[]).forEach(put)
      } else if (!(init.form === 'record' && init.name === 'list' && (init.fields as unknown[]).length === 0)) {
        unknown()
      }
    }

    if (node.form === 'assign') {
      const target = node.target as Loose

      if (target.form === 'variable' && target.name === local) {
        unknown()
      }

      if (slot(target) && (target.target as Loose).form === 'variable' && (target.target as Loose).name === local) {
        if (node.op === '=') {
          put(node.value as Loose)
        } else {
          unknown()
        }
      }
    }

    if (node.form === 'call') {
      const callee = node.callee as Loose
      const args = node.args as Loose[]

      args.forEach((a, i) => {
        if (a.form !== 'variable' || a.name !== local) {
          return
        }

        if (callee.form === 'variable' && callee.name === 'list_push' && i === 0) {
          put(args[1]!)
        } else if (callee.form === 'variable' && LIST_LENGTH_TASKS.has(callee.name as string) && i === 0) {
          // its size, read
        } else if (!(callee.form === 'variable' && lend.get(callee.name as string)?.get(i) === 'read')) {
          unknown()
        }
      })

      // a push through the collection operation, `xs.push(v)`
      if (callee.form === 'member' && callee.name === 'push' && (callee.target as Loose).form === 'variable' && (callee.target as Loose).name === local) {
        args.forEach(put)
      }
    }

    for (const [key, child] of Object.entries(node)) {
      if (key !== 'type' && key !== 'span') {
        visit(child)
      }
    }
  }

  visit(body)
}

// every variable name an assignment inside some closure writes
function namesWrittenInClosures(program: Program): Set<string> {
  const names = new Set<string>()
  const visit = (value: unknown, inClosure: boolean): void => {
    if (typeof value !== 'object' || value === null) {
      return
    }

    if (Array.isArray(value)) {
      value.forEach(v => visit(v, inClosure))

      return
    }

    const node = value as Loose
    const inside = inClosure || node.form === 'closure'

    if (inside && node.form === 'assign' && (node.target as Loose).form === 'variable') {
      names.add((node.target as Loose).name as string)
    }

    for (const [key, child] of Object.entries(node)) {
      if (key !== 'type' && key !== 'span') {
        visit(child, inside)
      }
    }
  }

  visit(program, false)

  return names
}
