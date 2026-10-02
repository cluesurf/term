// Contracts, lowered into `hold`s. A task's `have` / `must` / `down` and a walk's `must` / `down` are not code that
// runs: they are claims about the code, and every one of them becomes an ordinary `hold` in a COPY of the program
// that only the checker reads. The provers then discharge them exactly as they discharge a hold the programmer
// wrote, under the same path facts (check/facts.ts). Nothing here reaches a backend, and the real program keeps its
// kernel verification and its transparent definitions, which a body full of extra holds would lose.
//
// What each line becomes, in the copy:
//
//   task  have P      the body runs under `if P`, so every fact in it may assume P,
//                     and at every call to the task, a hold of P with the arguments in place of the parameters ('need')
//   task  must Q      at every `send back v`: `host back = v`, a hold of Q ('must'), `send back back`
//   task  down m      at every call the task makes to itself: a hold that m, with the arguments in place, is below
//                     m on entry, and that m is a natural number on entry ('down')
//   walk  must I      a hold of I before the walk ('keep-entry'); the turn runs under `if I`; a hold of I at the
//                     end of the turn, before every `turn next` and before every `halt` ('keep-turn'); and what
//                     follows the walk runs under `if I`, and under the negated condition too when nothing breaks out
//   walk  down m      at the top of a turn, a hold that m is a natural number, and its value kept; at the end of the
//                     turn and before every `turn next`, a hold that m is below the kept value ('down')
//
// See note/term/proof-by-default/vocabulary.md for the words and readme.md for why it is a copy.

import type {
  Expression,
  HoldOrigin,
  Program,
  Span,
  Statement,
} from '@term/make/code/compile/node'
import { readNames } from '@term/make/code/check/facts'

type Fn = Extract<Statement, { form: 'function' }>

// does any task or walk in the program carry a contract (if not, there is nothing to lower and no copy to make)
export function hasContracts(program: Program): boolean {
  let found = false
  const seen = new Set<unknown>()
  const stack: unknown[] = [program]

  while (stack.length > 0 && !found) {
    const node = stack.pop()

    if (node === null || typeof node !== 'object' || seen.has(node)) {
      continue
    }

    seen.add(node)

    if (Array.isArray(node)) {
      stack.push(...node)
      continue
    }

    const record = node as Record<string, unknown>

    if (
      (record.form === 'function' ||
        record.form === 'while' ||
        record.form === 'for-each') &&
      (record.have !== undefined ||
        record.must !== undefined ||
        record.down !== undefined)
    ) {
      found = true
    }

    for (const key of Object.keys(record)) {
      if (key !== 'type' && key !== 'span' && key !== 'binding') {
        stack.push(record[key])
      }
    }
  }

  return found
}

// replace every read of a name by an expression, without entering a closure (whose parameters may shadow it)
export function substitute(
  expression: Expression,
  binding: Map<string, Expression>,
): Expression {
  const walk = (node: unknown): unknown => {
    if (node === null || typeof node !== 'object') {
      return node
    }

    if (Array.isArray(node)) {
      return node.map(walk)
    }

    const record = node as Record<string, unknown>

    if (record.form === 'variable' && typeof record.name === 'string') {
      const replacement = binding.get(record.name)

      if (replacement) {
        return replacement
      }
    }

    if (record.form === 'closure') {
      return record
    }

    const out: Record<string, unknown> = {}

    for (const key of Object.keys(record)) {
      out[key] =
        key === 'type' || key === 'span' || key === 'binding'
          ? record[key]
          : walk(record[key])
    }

    return out
  }

  return walk(expression) as Expression
}

// every call an expression makes, without entering a closure (a closure's calls happen when it runs, not here)
function callsIn(expression: unknown): Extract<Expression, { form: 'call' }>[] {
  const calls: Extract<Expression, { form: 'call' }>[] = []
  const stack: unknown[] = [expression]

  while (stack.length > 0) {
    const node = stack.pop()

    if (node === null || typeof node !== 'object') {
      continue
    }

    if (Array.isArray(node)) {
      stack.push(...node)
      continue
    }

    const record = node as Record<string, unknown>

    if (record.form === 'closure') {
      continue
    }

    // another dialect's node may also be called `call`; only an expression call has a callee and arguments
    if (
      record.form === 'call' &&
      Array.isArray(record.args) &&
      record.callee !== undefined
    ) {
      calls.push(record as Extract<Expression, { form: 'call' }>)
    }

    for (const key of Object.keys(record)) {
      if (key !== 'type' && key !== 'span' && key !== 'binding') {
        stack.push(record[key])
      }
    }
  }

  return calls
}

const variable = (name: string, span: Span): Expression => ({
  form: 'variable',
  name,
  span,
})

const hold = (
  expr: Expression,
  origin: HoldOrigin,
  span: Span,
): Statement => ({ form: 'hold', expr, origin, span })

const not = (operand: Expression, span: Span): Expression => ({
  form: 'unary',
  op: '!',
  operand,
  span,
})

const below = (left: Expression, right: Expression, span: Span): Expression => ({
  form: 'binary',
  op: '<',
  left,
  right,
  span,
})

const atLeastZero = (value: Expression, span: Span): Expression => ({
  form: 'binary',
  op: '>=',
  left: value,
  right: { form: 'integer', value: 0, span } as Expression,
  span,
})

// run `body` under each condition in turn, as nested branches with no else: what the checker may assume there
function under(conditions: Expression[], body: Statement[], span: Span): Statement[] {
  let out = body

  for (let at = conditions.length - 1; at >= 0; at--) {
    out = [{ form: 'if', branches: [{ cond: conditions[at]!, body: out }], span }]
  }

  return out
}

// does a body break out of THIS loop (a bare `halt`), not counting a break that belongs to a loop nested in it
function breaksOut(body: Statement[]): boolean {
  for (const statement of body) {
    switch (statement.form) {
      case 'break':
        return true
      case 'if':
        if (
          statement.branches.some(b => breaksOut(b.body)) ||
          (statement.otherwise && breaksOut(statement.otherwise))
        ) {
          return true
        }

        break
      case 'match':
        if (
          statement.cases.some(c => breaksOut(c.body)) ||
          (statement.otherwise && breaksOut(statement.otherwise))
        ) {
          return true
        }

        break
      case 'guard':
        if (
          breaksOut(statement.body) ||
          (statement.catch && breaksOut(statement.catch.body))
        ) {
          return true
        }

        break
      default:
        break
    }
  }

  return false
}

type Context = {
  // every task of the program, by name, for the `have` owed at each call and the `down` of a self-call
  functions: Map<string, Fn>
  // the task whose body is being lowered
  current: Fn
  // the value of the task's `down` on entry, when it has one
  downAtEntry?: string
  // a counter for the names this pass makes up, which no source can spell (a `#` is not a name character)
  fresh: { next: number }
  // write tier-0 obligations for this task (only for the tasks of the file being compiled, so an imported task is
  // counted once, in its own file)
  tier0: boolean
}

const or = (left: Expression, right: Expression, span: Span): Expression => ({
  form: 'binary',
  op: '||',
  left,
  right,
  span,
})

const and = (left: Expression, right: Expression, span: Span): Expression => ({
  form: 'binary',
  op: '&&',
  left,
  right,
  span,
})

// an obligation that is owed only where its guards hold: `!(g1 && g2) || claim`. The prover splits the
// disjunction, assuming the guards while it proves the claim.
function guarded(claim: Expression, guards: Expression[], span: Span): Expression {
  if (guards.length === 0) {
    return claim
  }

  const all = guards.reduce((sum, g) => and(sum, g, span))

  return or(not(all, span), claim, span)
}

// TIER 0: the failures every task is proven free of with nothing written. Each list read owes its index inside
// the list, and each division owes a divisor other than zero. A read on the right of `&&` is owed only where the
// left holds, on the right of `||` only where it does not, and in a conditional only in its own branch, because
// that is where it runs. A closure's body runs later and is not walked here.
function obligationsIn(
  expression: Expression,
  guards: Expression[],
  out: Statement[],
): void {
  // `0 <= index < target/length`, under the guards the expression sits beneath
  const owesIndex = (
    target: Expression,
    index: Expression,
    span: Expression['span'],
    under: Expression[],
  ): void => {
    const length: Expression = { form: 'member', target, name: 'length', span }

    out.push(
      hold(
        guarded(
          and(atLeastZero(index, span), below(index, length, span), span),
          under,
          span,
        ),
        'index',
        span,
      ),
    )
  }

  const visit = (node: Expression, under: Expression[]): void => {
    switch (node.form) {
      case 'closure':
        return

      case 'member': {
        visit(node.target, under)

        // `read xs/{i}` computes its index, and `read xs/0` writes a literal one as a plain segment
        const index: Expression | undefined =
          node.index ??
          (/^[0-9]+$/.test(node.name)
            ? ({ form: 'integer', value: Number(node.name), span: node.span } as Expression)
            : undefined)

        if (index) {
          if (node.index) {
            visit(node.index, under)
          }

          if (node.target.type?.kind === 'array') {
            owesIndex(node.target, index, node.span, under)
          }
        }

        return
      }

      case 'binary':
        visit(node.left, under)

        if (node.op === '&&') {
          visit(node.right, [...under, node.left])
        } else if (node.op === '||') {
          visit(node.right, [...under, not(node.left, node.span)])
        } else {
          visit(node.right, under)
        }

        if (
          (node.op === '/' || node.op === '%') &&
          node.type?.kind !== 'float'
        ) {
          out.push(
            hold(
              guarded(
                {
                  form: 'binary',
                  op: '!=',
                  left: node.right,
                  right: { form: 'integer', value: 0, span: node.span } as Expression,
                  span: node.span,
                },
                under,
                node.span,
              ),
              'zero',
              node.span,
            ),
          )
        }

        return

      case 'conditional': {
        const earlier: Expression[] = []

        for (const branch of node.branches) {
          visit(branch.cond, [...under, ...earlier])
          visit(branch.value, [...under, ...earlier, branch.cond])
          earlier.push(not(branch.cond, node.span))
        }

        if (node.otherwise) {
          visit(node.otherwise, [...under, ...earlier])
        }

        return
      }

      default: {
        const record = node as unknown as Record<string, unknown>

        for (const key of Object.keys(record)) {
          if (key === 'type' || key === 'span' || key === 'binding') {
            continue
          }

          const value = record[key]
          const children = Array.isArray(value) ? value : [value]

          for (const child of children) {
            if (child && typeof child === 'object') {
              const inner = child as Record<string, unknown>

              if (typeof inner.form === 'string') {
                visit(inner as unknown as Expression, under)
              } else {
                // a `{ key, value }` map entry or a `{ name, value }` record field
                for (const field of Object.values(inner)) {
                  if (
                    field &&
                    typeof field === 'object' &&
                    typeof (field as Record<string, unknown>).form === 'string'
                  ) {
                    visit(field as Expression, under)
                  }
                }
              }
            }
          }
        }

        // `xs/get i`, `xs/at i` and `xs/set i, v` on a list are the same read or write as `read xs/{i}`: every backend
        // indexes. A write past the end panics on Rust and grows the list on TypeScript, so it is owed the same way,
        // and a `set` that is owed it changes no length (holds.ts lengthKeeping)
        if (
          node.form === 'call' &&
          node.callee.form === 'member' &&
          !node.callee.index &&
          (node.callee.name === 'get' || node.callee.name === 'at' || node.callee.name === 'set') &&
          node.callee.target.type?.kind === 'array' &&
          node.args.length === (node.callee.name === 'set' ? 2 : 1)
        ) {
          owesIndex(node.callee.target, node.args[0]!, node.span, under)
        }
      }
    }
  }

  visit(expression, guards)
}

// what a statement's own expressions owe before it runs: each callee's `have`, the measure of a self-call, and
// (when tier 0 is on) every list read and division in them
function owedAt(
  expressions: Expression[],
  context: Context,
  guards: Expression[] = [],
): Statement[] {
  const owed = owedAtCalls(expressions, context)

  if (context.tier0) {
    for (const expression of expressions) {
      obligationsIn(expression, guards, owed)
    }
  }

  return owed
}

// the facts a binding or assignment `x = call f(args)` may assume afterwards: f's `must` lines, with `back` as x and
// each parameter as its argument, each a `given` hold in line after it. Empty unless the value is exactly a call to a
// task of the program that carries a `must`. An argument that reads x itself is the OLD x, which the write replaced,
// so such a promise is about a value nothing names any more and is dropped.
function promisedBy(
  name: string,
  init: Expression,
  span: Span,
  context: Context,
): Statement[] {
  if (init.form !== 'call' || init.callee.form !== 'variable') {
    return []
  }

  const callee = context.functions.get(init.callee.name)

  if (!callee?.must || callee.must.length === 0) {
    return []
  }

  const binding = new Map<string, Expression>([['back', variable(name, span)]])

  // the parameters whose argument reads the name being written: after the write, that argument means something else
  const stale = new Set<string>()

  callee.params.forEach((param, at) => {
    const argument = init.args[at]

    if (argument) {
      binding.set(param.name, argument)

      if (readNames(argument).has(name)) {
        stale.add(param.name)
      }
    }
  })

  return callee.must
    .filter(m => ![...readNames(m)].some(read => stale.has(read)))
    .map(m => hold(substitute(m, binding), 'given', span))
}

// the holds a statement's own expressions owe at their calls: each callee's `have`, and the measure of a self-call
function owedAtCalls(expressions: unknown[], context: Context): Statement[] {
  const owed: Statement[] = []

  for (const call of callsIn(expressions)) {
    if (call.callee.form !== 'variable') {
      continue
    }

    const callee = context.functions.get(call.callee.name)

    if (!callee) {
      continue
    }

    const binding = new Map<string, Expression>()
    callee.params.forEach((param, at) => {
      const argument = call.args[at]

      if (argument) {
        binding.set(param.name, argument)
      }
    })

    for (const precondition of callee.have ?? []) {
      owed.push(hold(substitute(precondition, binding), 'need', call.span))
    }

    if (
      callee === context.current &&
      callee.down &&
      context.downAtEntry !== undefined
    ) {
      owed.push(
        hold(
          below(
            substitute(callee.down, binding),
            variable(context.downAtEntry, call.span),
            call.span,
          ),
          'down',
          call.span,
        ),
      )
    }
  }

  return owed
}

// the measure a walk's condition implies: while `a < b` runs, `b - a` is a natural number, and so on for each
// comparison. Undefined for a condition of any other shape, including `true`.
function inferredMeasure(cond: Expression): Expression | undefined {
  if (cond.form !== 'binary') {
    return undefined
  }

  const span = cond.span
  const minus = (l: Expression, r: Expression): Expression => ({
    form: 'binary',
    op: '-',
    left: l,
    right: r,
    span,
  })
  const plusOne = (e: Expression): Expression => ({
    form: 'binary',
    op: '+',
    left: e,
    right: { form: 'integer', value: 1, span } as Expression,
    span,
  })

  switch (cond.op) {
    case '<':
      return minus(cond.right, cond.left)
    case '<=':
      return plusOne(minus(cond.right, cond.left))
    case '>':
      return minus(cond.left, cond.right)
    case '>=':
      return plusOne(minus(cond.left, cond.right))
    default:
      return undefined
  }
}

// a loop's end-of-turn obligations: the invariant again, and the measure below its value at the top of the turn
type Turn = {
  invariants: Expression[]
  // a measure that must fall every turn: a written `down` (owed as 'down', a contract), or one inferred from the
  // walk's condition (owed as 'ends', tier 0)
  measure?: { down: Expression; kept: string; origin: HoldOrigin }
  // what the condition owes when it is evaluated again for the next turn
  again: Statement[]
  span: Span
}

function endOfTurn(turn: Turn | undefined): Statement[] {
  if (!turn) {
    return []
  }

  const out = [
    ...turn.invariants.map(i => hold(i, 'keep-turn', turn.span)),
    ...structuredClone(turn.again),
  ]

  if (turn.measure) {
    out.push(
      hold(
        below(turn.measure.down, variable(turn.measure.kept, turn.span), turn.span),
        turn.measure.origin,
        turn.span,
      ),
    )
  }

  return out
}

// lower one statement list. `turn` is the innermost enclosing loop's end-of-turn obligations, owed before every
// `turn next`; a `halt` owes only the invariant, since a break ends the walk and the measure no longer matters.
function lowerList(
  statements: Statement[],
  context: Context,
  turn: Turn | undefined,
): Statement[] {
  const out: Statement[] = []

  for (let at = 0; at < statements.length; at++) {
    const statement = statements[at]!

    switch (statement.form) {
      case 'let':
        // WHAT A CALLEE PROMISES. `save x, call f(...)` where f carries a `must`: what follows may assume it, with
        // `back` read as x and f's parameters as the arguments. This is the other half of `have`: the caller owes the
        // callee's precondition before the call and is owed its postcondition after. f's `must` is proven where f is
        // checked, so assuming it here is not trust, it is the modular half of the same proof. It is a `given` hold
        // in line, not a branch around the rest, so the statements after it keep their place in a walk's body.
        out.push(
          ...owedAt([statement.init], context),
          statement,
          ...promisedBy(statement.name, statement.init, statement.span, context),
        )
        break

      case 'assign':
        out.push(
          ...owedAt([statement.target, statement.value], context),
          statement,
          ...(statement.target.form === 'variable' && statement.op === '='
            ? promisedBy(statement.target.name, statement.value, statement.span, context)
            : []),
        )
        break

      case 'expression':
        out.push(...owedAt([statement.expr], context), statement)
        break

      case 'throw':
        out.push(...owedAt([statement.value], context), statement)
        break

      case 'return': {
        if (!statement.value) {
          out.push(statement)
          break
        }

        out.push(...owedAt([statement.value], context))
        const must = context.current.must ?? []

        if (must.length === 0) {
          out.push(statement)
          break
        }

        // `back` names the value being returned, inside a `must`. It is bound once, so the value is computed once
        const back = `back#${context.fresh.next++}`
        const binding = new Map([['back', variable(back, statement.span)]])

        out.push(
          {
            form: 'let',
            name: back,
            init: statement.value,
            mutable: false,
            span: statement.span,
          },
          ...must.map(m => hold(substitute(m, binding), 'must', statement.span)),
          { ...statement, value: variable(back, statement.span) },
        )
        break
      }

      case 'continue':
        out.push(...endOfTurn(turn), statement)
        break

      case 'break':
        out.push(
          ...(turn?.invariants ?? []).map(i => hold(i, 'keep-turn', statement.span)),
          statement,
        )
        break

      case 'if': {
        // a later condition is evaluated only when every earlier one was false
        const earlier: Expression[] = []
        const owed: Statement[] = []

        for (const branch of statement.branches) {
          owed.push(...owedAt([branch.cond], context, earlier))
          earlier.push(not(branch.cond, statement.span))
        }

        out.push(
          ...owed,
          {
            ...statement,
            branches: statement.branches.map(b => ({
              ...b,
              body: lowerList(b.body, context, turn),
            })),
            ...(statement.otherwise
              ? { otherwise: lowerList(statement.otherwise, context, turn) }
              : {}),
          },
        )
        break
      }

      case 'match':
        out.push(...owedAt([statement.subject], context), {
          ...statement,
          cases: statement.cases.map(c => ({
            ...c,
            body: lowerList(c.body, context, turn),
          })),
          ...(statement.otherwise
            ? { otherwise: lowerList(statement.otherwise, context, turn) }
            : {}),
        })
        break

      case 'guard':
        out.push({
          ...statement,
          body: lowerList(statement.body, context, turn),
          ...(statement.catch
            ? {
                catch: {
                  ...statement.catch,
                  body: lowerList(statement.catch.body, context, turn),
                },
              }
            : {}),
        })
        break

      case 'while':
      case 'for-each': {
        const invariants = statement.must ?? []
        const written = statement.form === 'while' ? statement.down : undefined
        // TERMINATION BY DEFAULT: a `walk test` with no `down` of its own gets one inferred from its condition
        // (`i < n` falls as `n - i`), owed as tier 0. A condition with no such shape owes an obligation nothing
        // proves, so a walk nobody showed to end is counted rather than passed.
        // a task marked `note roam` runs forever on purpose, so its walks owe no termination
        const owesEnd =
          statement.form === 'while' &&
          !written &&
          context.tier0 &&
          !context.current.roam
        const inferred = owesEnd
          ? inferredMeasure((statement as { cond: Expression }).cond)
          : undefined
        const down = written ?? inferred
        const measureOrigin: HoldOrigin = written ? 'down' : 'ends'
        const kept = down ? `down#${context.fresh.next++}` : undefined

        if (owesEnd && !inferred) {
          out.push(
            hold(
              { form: 'boolean', value: false, span: statement.span } as Expression,
              'ends',
              statement.span,
            ),
          )
        }
        const owed =
          statement.form === 'while'
            ? owedAt([statement.cond], context)
            : owedAt([statement.iterable], context)
        // a while's condition is evaluated again before every turn, so what it owes is owed again at the end of
        // each one (a list walk's sequence is evaluated once)
        const again = statement.form === 'while' ? owed : []
        const inner: Turn | undefined =
          invariants.length > 0 || down || again.length > 0
            ? {
                invariants,
                ...(down && kept
                  ? { measure: { down, kept, origin: measureOrigin } }
                  : {}),
                again,
                span: statement.span,
              }
            : undefined

        // the turn: the measure is a natural number and is kept, then the body, then the end-of-turn holds
        const top: Statement[] =
          down && kept
            ? [
                hold(atLeastZero(down, statement.span), measureOrigin, statement.span),
                {
                  form: 'let',
                  name: kept,
                  init: down,
                  mutable: false,
                  span: statement.span,
                },
              ]
            : []
        const body = [
          ...top,
          ...lowerList(statement.body, context, inner),
          ...endOfTurn(inner),
        ]

        out.push(
          ...owed,
          ...invariants.map(i => hold(i, 'keep-entry', statement.span)),
          { ...statement, body: under(invariants, body, statement.span) },
        )

        // what follows a walk with an invariant may assume it, and the negated condition too when nothing breaks
        // out early. The rest of the list is lowered inside that assumption.
        if (invariants.length > 0) {
          const after = [...invariants]

          if (statement.form === 'while' && !breaksOut(statement.body)) {
            after.push(not(statement.cond, statement.span))
          }

          out.push(
            ...under(
              after,
              lowerList(statements.slice(at + 1), context, turn),
              statement.span,
            ),
          )

          return out
        }

        break
      }

      default:
        out.push(statement)
        break
    }
  }

  return out
}

// the checker's copy of a program, with every contract lowered into holds, and the tier-0 obligations of the tasks
// that belong to `file` (when `tier0` is set) written in beside them
export function lowerContracts(
  program: Program,
  options: { file?: string; tier0?: boolean } = {},
): { program: Program; lowered: Set<string> } {
  // every top-level node is stamped with the file it came from when modules merge. A task with no file was made by
  // a pass (a dictionary, an intrinsic) and belongs to no file; only when NOTHING is stamped (a bare program) is
  // every task the entry's own.
  const stamped = program.some(
    s => s.form === 'function' && s.span.file !== undefined,
  )
  const ownTask = (s: Statement): boolean =>
    s.form === 'function' &&
    !s.claim &&
    !s.stub &&
    (stamped ? s.span.file === options.file : true)

  // ONLY THIS FILE'S OWN TASKS are copied and lowered. Every other task is shared with the real program untouched:
  // its contracts are checked in its own file's compile, and what a call here owes it (its `have`) is read off it,
  // never written into it. Copying the whole merged program for every file was most of what this pass cost.
  const copy = program.map(s => (ownTask(s) ? structuredClone(s) : s))
  const functions = new Map<string, Fn>()

  for (const statement of copy) {
    if (statement.form === 'function') {
      functions.set(statement.name, statement)
    }
  }

  const fresh = { next: 0 }
  const lowered = new Set<string>()

  for (const statement of copy) {
    if (statement.form !== 'function' || !ownTask(statement)) {
      continue
    }

    lowered.add(statement.name)
    const context: Context = {
      functions,
      current: statement,
      fresh,
      tier0: options.tier0 === true,
    }
    const entry: Statement[] = []

    if (statement.down) {
      const kept = `down#${fresh.next++}`
      context.downAtEntry = kept
      entry.push(
        hold(atLeastZero(statement.down, statement.span), 'down', statement.span),
        {
          form: 'let',
          name: kept,
          init: statement.down,
          mutable: false,
          span: statement.span,
        },
      )
    }

    const body = [...entry, ...lowerList(statement.body, context, undefined)]

    statement.body = under(statement.have ?? [], body, statement.span)
  }

  return { program: copy, lowered }
}
