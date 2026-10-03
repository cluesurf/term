// Integer operations proven inside the safe integers by intervals (note/term/codegen/passes.md, P2). Every `+`, `-`
// and `*` on two numbers is checked on every backend (`__termInt`, `checked_add`, `Math.addExact`), because a result
// past the range is a different integer or a rounded one. A check whose operands are bounded can never fire, and this
// fact names the operations where that is proven, so an emitter writes them plain.
//
// The intervals are FLOW-INSENSITIVE and program-wide, solved as one fixpoint:
//   - a local's interval is the hull of every value it is given (its `let` and each plain `=`), so it holds at every
//     read. A parameter, a walk's item, a closure's parameter, an arm's field, a name a closure writes, a name written
//     with a compound operator, and a name the task also reads as a global are unknown
//   - a counted loop's step (`i = i + 1` under `i < E`, the shape ir/facts/range.ts proves) is given the condition's
//     bound: at the step `i` still holds the tested value, so `i + 1 <= hi(E)`. That is what keeps a counter finite
//   - `x % c` by a nonzero literal lies inside `(-|c|, |c|)`, on the dividend's side of zero when its sign is known,
//     and an integer quotient is no larger than its dividend
//   - a slot of a record's list that the record OWNS (backend.ts `ownedFields`: reached only through its path, given
//     a fresh list or an owned local at every construction) holds the hull of what is ever put in it: each slot
//     written through the path, and each value the owned local was given before it was stored (its literal items, its
//     pushes, its slot writes). A list passed to a task that writes it makes its elements unknown
// An interval that is still growing after a few rounds is widened to unknown, so the fixpoint ends. The bound is
// 2^53 - 1, which is inside i64, so a proof holds on Rust, Swift and Kotlin as it does on TypeScript.
//
// A fact that is wrong removes a check that should fire, so every rule has a counterexample in
// test/ir/facts/interval.ts that must NOT be proven.
//
// Measured first on Particle (ours): every coordinate is `(old * 31 + i + step) % 1000`, written back into the record's
// own list. TypeScript 286 ms to 212 with those checks gone (`tmp/ts-particle-ab.ts`), the hand version 135.

import type { Expression, Program, Statement } from '../../compile/node'

type Loose = Record<string, unknown> & { form?: string; name?: string }
// a side past the safe integers is infinite, which is unknown on that side only: `[0, Infinity)` is "not negative"
type Span = { lo: number; hi: number }
// `null` is no value yet (the fixpoint's bottom), `'top'` any value
type Value = Span | null | 'top'
type Fn = Extract<Statement, { form: 'function' }>
type Lend = 'read' | 'write'

const SAFE = Number.MAX_SAFE_INTEGER
// rounds an entry may grow before the side that grows is widened to unknown. Enough for a recursion that counts to a
// small literal one step a round (Queens' column, 0 to 7) to settle before it is widened
const WIDEN = 16

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
const finite = (v: Value): v is Span => v !== null && v !== 'top' && Number.isFinite(v.lo) && Number.isFinite(v.hi)

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

// a counted step `i = i + e` (or `e + i`) under `i < E` / `i <= c`, or `i = i - e` under `E < i` / `i >= c`: the
// counter read, the amount, the condition's other side, and whether the comparison is strict
type Step = { counter: Loose; amount: Loose; bound: Loose; up: boolean; strict: boolean }

// what a branch knows at a node: `name op bound`, from a condition the path to the node passed true or false
type Fact = { name: string; op: string; bound: Loose }

const NEGATE: Record<string, string> = { '<': '>=', '<=': '>', '>': '<=', '>=': '<', '==': '!=', '!=': '==' }
const FLIP: Record<string, string> = { '<': '>', '<=': '>=', '>': '<', '>=': '<=', '==': '==', '!=': '!=' }

// the facts a condition gives when it is `truth`: a comparison with a name on either side, both sides of an `&&` that
// held or an `||` that failed, and a `!` turned over. Anything else gives none, which is only less precise
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

// whether a statement list always leaves before its end: its last statement returns, raises, breaks or continues
const exits = (body: Statement[]): boolean => {
  const last = body[body.length - 1] as Loose | undefined

  return last !== undefined && ['return', 'throw', 'break', 'continue'].includes(last.form as string)
}

// every node of a body mapped to the facts its path holds: a branch's body knows its own condition and that every
// branch before it failed, the `otherwise` that all failed, the statements after an `if` whose every branch leaves
// know all failed, and a `while`'s body knows its condition. Whether a fact may refine a name is the reader's call
// (`stable`): only a name that cannot change between the test and the read
function guardFacts(value: unknown, facts: Fact[], into: WeakMap<object, Fact[]>): void {
  if (typeof value !== 'object' || value === null) {
    return
  }

  if (Array.isArray(value)) {
    let current = facts

    for (const item of value) {
      guardFacts(item, current, into)
      const node = item as Loose

      if (node?.form === 'if' && !node.otherwise) {
        const branches = node.branches as { cond: Loose; body: Statement[] }[]

        if (branches.every(b => exits(b.body))) {
          current = [...current, ...branches.flatMap(b => conditionFacts(b.cond, false))]
        }
      }
    }

    return
  }

  const node = value as Loose

  into.set(node, facts)

  if (node.form === 'if') {
    let failed: Fact[] = []

    for (const branch of node.branches as { cond: Loose; body: Statement[] }[]) {
      guardFacts(branch.cond, [...facts, ...failed], into)
      guardFacts(branch.body, [...facts, ...failed, ...conditionFacts(branch.cond, true)], into)
      failed = [...failed, ...conditionFacts(branch.cond, false)]
    }

    guardFacts(node.otherwise, [...facts, ...failed], into)

    return
  }

  if (node.form === 'while') {
    guardFacts(node.cond, facts, into)
    guardFacts(node.body, [...facts, ...conditionFacts(node.cond as Loose, true)], into)

    return
  }

  for (const [key, child] of Object.entries(node)) {
    if (key !== 'type' && key !== 'span') {
      guardFacts(child, facts, into)
    }
  }
}

// a slot read or written by index: `xs/{i}` or a literal `xs/0`
const slot = (node: Loose | undefined): boolean =>
  node?.form === 'member' && (node.index !== undefined || /^\d+$/.test(node.name as string))

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
  // a plain record's number fields, keyed `form.field`: each the hull of what every construction gives it and every
  // write through a path puts in it. Unknown for a form native code may build, for a construction that leaves it out
  // or fills it by position, and for every form once the program fills or melts one (their walkers build any)
  const numberFields = new Map<string, string[]>()

  for (const node of program as Statement[]) {
    if (node.form === 'record-type' && node.variants.length === 0) {
      numberFields.set(node.name, node.fields.filter(f => f.type.kind === 'number').map(f => f.name))
    }
  }

  // the field key a path `r.field` names, when it reads a plain record's number field
  const fieldKey = (node: Loose | undefined): string | undefined => {
    if (node?.form !== 'member' || node.index !== undefined || /^\d+$/.test(node.name as string)) {
      return undefined
    }

    const type = (node.target as Loose).type as { kind?: string; name?: string } | undefined

    return type?.kind === 'named' && numberFields.get(type.name!)?.includes(node.name as string) ? `${type.name}.${node.name as string}` : undefined
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

  // per task: the locals it tracks, each with the values it is given, and the counted steps. A write is evaluated in
  // its own task, or in `caller` for a parameter given an argument
  type Write = { value: Loose; caller?: Task; step?: Step }
  // `stable`: the names a branch's facts may refine, each a parameter or a `let` declared once, never assigned and
  // never bound another way, so its value at a read is its value where the branch tested it
  type Task = { fn: Fn; writes: Map<string, Write[]>; values: Map<string, Value>; excluded: Set<string>; stable: Set<string> }
  // the facts at every node of every task (`guardFacts`)
  const guards = new WeakMap<object, Fact[]>()
  const tasks: Task[] = []
  // per owned key: what is put in, each with the task it is evaluated in, or `top` once anything unknown is
  const puts = new Map<string, { task: Task; value: Loose }[]>()
  const unknownKeys = new Set<string>()
  // whether the program fills or melts a form, whose walkers build records with any field
  let walkers = false

  // the tasks whose every call is in the program and seen here: internal (outside the public surface), defined once,
  // not async, not a trait's method, and never named except as the callee of a direct call. Each parameter of one is
  // the hull of its arguments
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
  // the direct calls to each closed task, with the task each is made in
  const calls = new Map<string, { task: Task; args: Loose[] }[]>()

  for (const fn of fns) {
    // a parameter of a closed task is tracked, its values the arguments added below
    const excluded = new Set<string>(closed.has(fn.name) ? [] : fn.params.map(p => p.name))
    const task: Task = { fn, writes: new Map(), values: new Map(), excluded, stable: new Set() }
    // for `stable`: how often each name is declared, and the names any assignment writes
    const declared = new Map<string, number>(fn.params.map(p => [p.name, 1]))
    const assigned = new Set<string>()
    // the names bound another way, or written with a compound operator, or read as a global: untracked, and never
    // stable. A parameter left untracked only because its task is not closed is still stable
    const rebound = new Set<string>()
    const exclude = (name: string): void => {
      excluded.add(name)
      rebound.add(name)
    }
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
          task.writes.set(node.name as string, [...(task.writes.get(node.name as string) ?? []), { value: node.init as Loose }])
          declared.set(node.name as string, (declared.get(node.name as string) ?? 0) + 1)
          break
        case 'assign': {
          const target = node.target as Loose

          if (target.form === 'variable') {
            assigned.add(target.name as string)

            if (node.op !== '=') {
              exclude(target.name as string)
            }

            task.writes.set(target.name as string, [...(task.writes.get(target.name as string) ?? []), { value: node.value as Loose }])
          }

          // a slot written through an owned path
          if (slot(target) && pathKey(target.target as Loose)) {
            const key = pathKey(target.target as Loose)!

            if (node.op === '=') {
              puts.set(key, [...(puts.get(key) ?? []), { task, value: node.value as Loose }])
            } else {
              unknownKeys.add(key)
            }
          }

          // a number field written through a path
          if (fieldKey(target)) {
            const key = fieldKey(target)!

            if (node.op === '=') {
              puts.set(key, [...(puts.get(key) ?? []), { task, value: node.value as Loose }])
            } else {
              unknownKeys.add(key)
            }
          }

          break
        }
        case 'variable':
          // a name the task reads as something other than a local or a parameter
          if ((node.binding as { kind?: string } | undefined)?.kind && !['local', 'parameter'].includes((node.binding as { kind: string }).kind)) {
            exclude(node.name as string)
          }

          break
        case 'call': {
          const callee = node.callee as Loose

          if (callee.form === 'variable' && closed.has(callee.name as string)) {
            calls.set(callee.name as string, [...(calls.get(callee.name as string) ?? []), { task, args: node.args as Loose[] }])
          }

          // the form walkers build any record, with any field
          if (callee.form === 'variable' && (callee.name === 'fill-form' || callee.name === 'melt-form')) {
            walkers = true
          }

          break
        }
        case 'for-each':
          exclude(node.item as string)

          if (typeof node.index === 'string') {
            exclude(node.index)
          }

          break
        case 'closure':
          for (const p of (node.params as { name: string }[]) ?? []) {
            exclude(p.name)
          }

          break
        case 'match':
          for (const c of node.cases as { binds?: string[] }[]) {
            for (const b of c.binds ?? []) {
              exclude(b)
            }
          }

          break
        case 'record': {
          // a construction: an owned field given an empty list adds nothing, a local adds what that local was given,
          // anything else (a fresh task's answer) is unknown
          if (plain.has(node.name as string)) {
            for (const f of node.fields as { name: string; value: Loose }[]) {
              const key = `${node.name as string}/${f.name}`

              if (!owned.has(key)) {
                continue
              }

              if (f.value.form === 'array' && (f.value.items as unknown[]).length === 0) {
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
              puts.set(key, [...(puts.get(key) ?? []), { task, value: given.value }])
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

    for (const [name, count] of declared) {
      if (count === 1 && !assigned.has(name) && !rebound.has(name) && !closureWrites.has(name)) {
        task.stable.add(name)
      }
    }

    guardFacts(fn.body, [], guards)

    for (const name of [...task.writes.keys()]) {
      if (excluded.has(name) || closureWrites.has(name)) {
        task.writes.delete(name)
      }
    }

    // each tracked counter's step under its loop's condition
    countedSteps(fn.body, task.writes)

    // what each stored local was given: its literal items, its pushes, its slot writes. A local the task hands to a
    // task that writes it is unknown (ownedLocals allows that call, and the callee may put anything in)
    for (const [local, key] of stored) {
      elementsOf(fn.body, local, lend, value => puts.set(key, [...(puts.get(key) ?? []), { task, value }]), () => unknownKeys.add(key))
    }

    tasks.push(task)
  }

  // each parameter of a closed task given every argument it is passed, evaluated in the caller. A call with the wrong
  // number of arguments leaves the parameter untracked (the checker fills omitted ones, so this should not happen), and
  // a name the body also binds another way (a walk's item, an arm's field) is excluded with its own rule
  for (const task of tasks) {
    if (!closed.has(task.fn.name)) {
      continue
    }

    const sites = calls.get(task.fn.name) ?? []

    task.fn.params.forEach((p, i) => {
      if (sites.length === 0 || sites.some(s => s.args.length !== task.fn.params.length) || closureWrites.has(p.name)) {
        return
      }

      // a parameter the body excludes (written with a compound operator, bound again as a walk's item or an arm's
      // field, read as a global) stays untracked. A plain assignment in the body is a write of its own, kept
      if (task.excluded.has(p.name)) {
        return
      }

      task.writes.set(p.name, [...(task.writes.get(p.name) ?? []), ...sites.map(s => ({ value: s.args[i]!, caller: s.task }))])
    })
  }

  for (const task of tasks) {
    for (const name of task.writes.keys()) {
      task.values.set(name, null)
    }
  }

  const elements = new Map<string, Value>([...owned].map(key => [key, unknownKeys.has(key) ? ('top' as const) : null]))

  // what each task answers, the hull of its `return`s outside any closure (a closure's are its own), keyed `task:name`
  // beside the other keys: for a task defined once, not async and not a trait's method, whose result is a number. A
  // call to it is that hull, whoever calls it
  const answers = new Set<string>()

  for (const task of tasks) {
    const fn = task.fn

    if (defined.get(fn.name) !== 1 || fn.async || fn.method || fn.result?.kind !== 'number') {
      continue
    }

    const key = `task:${fn.name}`
    const returns: Loose[] = []
    const collect = (value: unknown): void => {
      if (typeof value !== 'object' || value === null) {
        return
      }

      if (Array.isArray(value)) {
        value.forEach(collect)

        return
      }

      const node = value as Loose

      if (node.form === 'closure') {
        return
      }

      if (node.form === 'return' && node.value) {
        returns.push(node.value as Loose)
      }

      for (const [k, child] of Object.entries(node)) {
        if (k !== 'type' && k !== 'span') {
          collect(child)
        }
      }
    }

    collect(fn.body)
    answers.add(fn.name)
    elements.set(key, null)
    puts.set(key, returns.map(value => ({ task, value })))
  }

  for (const [form, fields] of numberFields) {
    for (const field of fields) {
      const key = `${form}.${field}`
      elements.set(key, walkers || native.has(form) || unknownKeys.has(key) ? 'top' : null)
    }
  }
  const grown = new Map<object | string, number>()

  // the value of an expression in a task, from the current intervals
  const evaluate = (e: Loose | undefined, task: Task): Value => {
    if (!e) {
      return 'top'
    }

    switch (e.form) {
      case 'integer': {
        const v = Number(e.value)

        return span(v, v)
      }
      case 'variable': {
        const base = task.values.has(e.name as string) ? task.values.get(e.name as string)! : 'top'
        const facts = task.stable.has(e.name as string) ? (guards.get(e) ?? []).filter(f => f.name === e.name) : []

        return facts.length ? refine(base, facts, task) : base
      }
      case 'unary': {
        const inner = evaluate(e.operand as Loose, task)

        if (e.op !== '-' || !isNumber(e.operand as Loose)) {
          return 'top'
        }

        return inner === null || inner === 'top' ? inner : span(-inner.hi, -inner.lo)
      }
      case 'call': {
        // a task's answer, the hull of its returns
        const callee = e.callee as Loose

        return callee.form === 'variable' && answers.has(callee.name as string) && (callee.binding as { kind?: string } | undefined)?.kind === 'function'
          ? elements.get(`task:${callee.name as string}`)!
          : 'top'
      }
      case 'member': {
        // a slot of an owned list, or a plain record's number field
        const key = slot(e) ? pathKey(e.target as Loose) : fieldKey(e)

        return key ? elements.get(key)! : 'top'
      }
      case 'binary': {
        if (!isNumber(e.left as Loose) || !isNumber(e.right as Loose) || !['+', '-', '*', '%', '/'].includes(e.op as string)) {
          return 'top'
        }

        const a = evaluate(e.left as Loose, task)
        const b = evaluate(e.right as Loose, task)

        // a remainder by a divisor that excludes zero is smaller than the divisor, whatever the dividend
        if (e.op === '%' && b !== null && b !== 'top' && (b.lo > 0 || b.hi < 0)) {
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
        const corners = (): Value => {
          const times = (x: number, y: number): number => (x === 0 || y === 0 ? 0 : x * y)
          const all = [times(a.lo, b.lo), times(a.lo, b.hi), times(a.hi, b.lo), times(a.hi, b.hi)]

          return span(Math.min(...all), Math.max(...all))
        }

        switch (e.op) {
          case '+':
            return span(a.lo + b.lo, a.hi + b.hi)
          case '-':
            return span(a.lo - b.hi, a.hi - b.lo)
          case '*':
            return corners()
          case '/': {
            // an integer quotient is no larger than its dividend, and not negative when both sides are not; a zero
            // divisor stops the program
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
      default:
        return 'top'
    }
  }

  // a stable name's value narrowed by the facts its read holds. A bound not known yet narrows nothing, which is only
  // less precise; a fact that leaves nothing means the read is unreachable, and it answers no value
  const refine = (base: Value, facts: Fact[], task: Task): Value => {
    if (base === null) {
      return null
    }

    let lo = base === 'top' ? -Infinity : base.lo
    let hi = base === 'top' ? Infinity : base.hi

    for (const fact of facts) {
      // the bound as read at its condition, with that condition's own facts, which all lie outside this one, so
      // the reading ends
      const bound = evaluate(fact.bound, task)

      if (bound === null || bound === 'top') {
        continue
      }

      switch (fact.op) {
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
    }

    return lo > hi ? null : span(lo, hi)
  }

  // a counted step's value: the counter moved by an amount that is not negative, no further past the bound than the
  // amount. At the step the counter still holds the value the condition tested, so under `i < E` it is at most
  // hi(E) - 1 and `i + e` at most hi(E) - 1 + hi(e); under `i <= c` at most c + hi(e). Down, under `E < i` it is at
  // least lo(E) + 1, under `i >= c` at least c. An amount that may be negative is evaluated as written
  const stepValue = (write: Write, task: Task): Value => {
    const step = write.step!
    const counter = evaluate(step.counter, task)
    const amount = evaluate(step.amount, task)

    if (counter === null || amount === null) {
      return null
    }

    if (amount === 'top' || amount.lo < 0) {
      return evaluate(write.value, task)
    }

    const known = evaluate(step.bound, task)

    if (known === null) {
      return null
    }

    // an unknown side stays unknown, and the other side still bounds the step
    const whole: Span = { lo: -Infinity, hi: Infinity }
    const from = counter === 'top' ? whole : counter
    const bound = known === 'top' ? whole : known

    return step.up
      ? span(from.lo + amount.lo, (step.strict ? bound.hi - 1 : bound.hi) + amount.hi)
      : span((step.strict ? bound.lo + 1 : bound.lo) - amount.hi, from.hi - amount.lo)
  }

  const settle = (id: object | string, before: Value, after: Value): Value => {
    if (same(before, after)) {
      return before
    }

    const times = (grown.get(id) ?? 0) + 1
    grown.set(id, times)

    if (times <= WIDEN || before === null || before === 'top' || after === null || after === 'top') {
      return after
    }

    // only the side that grew is widened, so a counter falling from a known start keeps its top. Each side widens at
    // most once, so the iteration ends
    return span(after.lo < before.lo ? -Infinity : after.lo, after.hi > before.hi ? Infinity : after.hi)
  }

  for (let changed = true, round = 0; changed && round < 100; round++) {
    changed = false

    for (const task of tasks) {
      for (const [name, writes] of task.writes) {
        const before = task.values.get(name)!
        let after: Value = null

        for (const write of writes) {
          after = join(after, write.step ? stepValue(write, task) : evaluate(write.value, write.caller ?? task))
        }

        // an interval only grows: the hull with what it was keeps the iteration monotone. Widened per local, keyed by
        // its list of writes, which is its own
        const next = settle(writes, before, join(before, after))

        if (!same(before, next)) {
          task.values.set(name, next)
          changed = true
        }
      }
    }

    for (const [key, list] of puts) {
      const before = elements.get(key)!
      let after: Value = null

      for (const { task, value } of list) {
        after = join(after, evaluate(value, task))
      }

      const next = settle(key, before, join(before, after))

      if (!same(before, next)) {
        elements.set(key, next)
        changed = true
      }
    }

    // a fixpoint that does not settle proves nothing
    if (round === 99 && changed) {
      return proven
    }
  }

  // every integer `+`, `-` and `*` whose exact result is inside the bound
  for (const task of tasks) {
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
        if (['+', '-', '*'].includes(node.op as string) && finite(evaluate(node, task))) {
          proven.add(node as unknown as Expression)
        }

        // a quotient or remainder by a divisor whose interval excludes zero cannot fail: a remainder is smaller than
        // its divisor, and a quotient is no larger than its dividend, so it overflows only as the minimum divided by
        // -1, which a divisor excluding -1 or a known dividend rules out
        if (node.op === '%' || node.op === '/') {
          const divisor = evaluate(node.right as Loose, task)
          const nonzero = divisor !== null && divisor !== 'top' && (divisor.lo > 0 || divisor.hi < 0)
          const notMinusOne = nonzero && (divisor.lo > 0 || divisor.hi < -1)

          if (nonzero && (node.op === '%' || notMinusOne || finite(evaluate(node.left as Loose, task)))) {
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

// marks each tracked counter's single step with its loop's condition: a `while` whose condition compares the counter
// with `<`, `>`, `<=` or `>=` against any expression that does not read it, and whose body writes the counter exactly
// once, as a statement of its own body (not inside a nested loop or a closure), stepping it toward the bound by an
// amount that does not read it. The counter is then the tested value at the step, which is what bounds it
function countedSteps(body: Statement[], writes: Map<string, { value: Loose; step?: Step }[]>): void {
  const loops: Loose[] = []
  const collect = (value: unknown): void => {
    if (typeof value !== 'object' || value === null) {
      return
    }

    if (Array.isArray(value)) {
      value.forEach(collect)

      return
    }

    const node = value as Loose

    if (node.form === 'while') {
      loops.push(node)
    }

    for (const [key, child] of Object.entries(node)) {
      if (key !== 'type' && key !== 'span') {
        collect(child)
      }
    }
  }

  collect(body)

  for (const loop of loops) {
    const cond = loop.cond as Loose | undefined

    if (cond?.form !== 'binary') {
      continue
    }

    const left = cond.left as Loose
    const right = cond.right as Loose
    // each candidate: the counter, the side it steps toward, the bound, and whether the comparison is strict
    const candidates: { counter: string; up: boolean; bound: Loose; strict: boolean }[] = []

    if (cond.op === '<' || cond.op === '>' || cond.op === '<=' || cond.op === '>=') {
      const strict = cond.op === '<' || cond.op === '>'
      const small = cond.op === '<' || cond.op === '<=' ? left : right
      const big = cond.op === '<' || cond.op === '<=' ? right : left

      if (small.form === 'variable') {
        candidates.push({ counter: small.name as string, up: true, bound: big, strict })
      }

      if (big.form === 'variable') {
        candidates.push({ counter: big.name as string, up: false, bound: small, strict })
      }
    }

    for (const candidate of candidates) {
      const list = writes.get(candidate.counter)

      if (!list || !isNumber(candidate.bound)) {
        continue
      }

      const inLoop = writesIn(loop.body, candidate.counter)

      if (inLoop.length !== 1 || inLoop[0]!.nested || !(loop.body as unknown[]).includes(inLoop[0]!.node)) {
        continue
      }

      const value = inLoop[0]!.node.value as Loose
      const isCounter = (e: Loose): boolean => e.form === 'variable' && e.name === candidate.counter
      const left = value.left as Loose
      const right = value.right as Loose
      // the counter on one side, the amount on the other, which must not read the counter
      const parts =
        value.form !== 'binary'
          ? undefined
          : candidate.up && value.op === '+'
            ? isCounter(left)
              ? { counter: left, amount: right }
              : isCounter(right)
                ? { counter: right, amount: left }
                : undefined
            : !candidate.up && value.op === '-' && isCounter(left)
              ? { counter: left, amount: right }
              : undefined

      // the bound may not name the counter: `i < i + 1` holds for every i
      if (!parts || !isNumber(parts.amount) || mentions(parts.amount, candidate.counter) || inLoop[0]!.node.op !== '=' || mentions(candidate.bound, candidate.counter)) {
        continue
      }

      const entry = list.find(w => w.value === value)

      if (entry) {
        entry.step = { ...parts, bound: candidate.bound, up: candidate.up, strict: candidate.strict }
      }
    }
  }
}

// every write to `name` inside a loop body, and whether it sits in a nested loop or a closure. A `let` of the name is
// another variable, so it counts as a nested write and leaves the loop unproven
function writesIn(body: unknown, name: string): { node: Loose; nested: boolean }[] {
  const out: { node: Loose; nested: boolean }[] = []
  const find = (value: unknown, nested: boolean): void => {
    if (typeof value !== 'object' || value === null) {
      return
    }

    if (Array.isArray(value)) {
      value.forEach(v => find(v, nested))

      return
    }

    const node = value as Loose
    const deeper = nested || node.form === 'while' || node.form === 'for-each' || node.form === 'closure'

    if (node.form === 'assign' && (node.target as Loose).form === 'variable' && (node.target as Loose).name === name) {
      out.push({ node, nested })
    }

    if (node.form === 'let' && node.name === name) {
      out.push({ node, nested: true })
    }

    for (const [key, child] of Object.entries(node)) {
      if (key !== 'type' && key !== 'span') {
        find(child, deeper)
      }
    }
  }

  find(body, false)

  return out
}

function mentions(value: unknown, name: string): boolean {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  if (Array.isArray(value)) {
    return value.some(v => mentions(v, name))
  }

  const node = value as Loose

  if (node.form === 'variable' && node.name === name) {
    return true
  }

  return Object.entries(node).some(([key, child]) => key !== 'type' && key !== 'span' && mentions(child, name))
}

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
        } else if (callee.form === 'variable' && callee.name === 'list_size' && i === 0) {
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
