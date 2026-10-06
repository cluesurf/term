// Which facts survive a statement, and which tasks are pure. The pass is Term, check/purity.tree (self-hosting,
// 2026-10-06), and its header says what each answer means. This face keeps what Term cannot hold: the answer per program
// (the last few programs asked about, by identity), and the sorting of what a caller hands the name walks, which may be
// a block, a statement, an expression, or a list of any of them. A set the caller holds goes in as a test of a name.

import type {
  Expression,
  Program,
  Statement,
} from '@term/make/code/compile/node'
import {
  callsImpure as callsImpureIn,
  everything,
  freshNames as freshNamesIn,
  functionNames as functionNamesIn,
  immutableKinds,
  lengthKeepingFunctions as lengthKeepingIn,
  localNames as localNamesIn,
  onlyStatement as onlyStatementIn,
  purity as purityIn,
  readNames as readNamesIn,
  readOnlyListMethods,
  readsAny as readsAnyIn,
  readsState as readsStateIn,
  returnsFreshFunctions as returnsFreshIn,
  rootName as rootNameIn,
  stateFreeFunctions as stateFreeIn,
  volatileNames as volatileNamesIn,
  writtenNames as writtenNamesIn,
} from '@term/make/code/check/purity'
import type { Subtree } from '@term/make/code/check/purity'

type Fn = Extract<Statement, { form: 'function' }>

// node.tree's statement and expression cases. No case is both, so a node's `form` says which it is
const STATEMENT_FORMS = new Set([
  'let', 'assign', 'expression', 'if', 'while', 'match', 'for-each', 'break', 'continue', 'return', 'exit', 'debug',
  'guard', 'throw', 'hold', 'function', 'record-type', 'mask', 'instance', 'native', 'bind', 'view', 'dock', 'roll',
  'tell',
])
const EXPRESSION_FORMS = new Set([
  'integer', 'float', 'boolean', 'string', 'template', 'unit', 'null', 'variable', 'binary', 'unary', 'call', 'array',
  'map', 'record', 'member', 'await', 'closure', 'conditional', 'hole',
])

// what a caller handed, as the parts the walks take: a list is each of its items, in turn
function partsOf(subtree: unknown, into: Subtree[] = []): Subtree[] {
  if (Array.isArray(subtree)) {
    if (subtree.every(item => STATEMENT_FORMS.has((item as { form?: string } | undefined)?.form ?? ''))) {
      into.push({ form: 'in-block', node: subtree as Statement[] })
    } else {
      for (const item of subtree) {
        partsOf(item, into)
      }
    }

    return into
  }

  const form = (subtree as { form?: string } | null | undefined)?.form ?? ''

  if (STATEMENT_FORMS.has(form)) {
    into.push({ form: 'in-statement', node: subtree as Statement })
  } else if (EXPRESSION_FORMS.has(form)) {
    into.push({ form: 'in-expression', node: subtree as Expression })
  } else if (subtree !== undefined && subtree !== null) {
    throw new Error(`check/facts: not a statement or an expression: ${form === '' ? typeof subtree : form}`)
  }

  return into
}

// the variable a write lands in: `x` for `save x`, `b` for `save b/size` and `save b/{i}/size`. Undefined when the
// target is not rooted in a name, which callers treat as "anything may have changed".
export function rootName(target: Expression): string | undefined {
  const root = rootNameIn(target)

  return root.form === 'some' ? root.value : undefined
}

// the sentinel for a write whose root could not be named: every fact is dropped
export const EVERYTHING = everything()

export function writtenNames(subtree: unknown): Set<string> {
  return new Set(writtenNamesIn(partsOf(subtree)))
}

export function volatileNames(body: Statement[]): Set<string> {
  return new Set(volatileNamesIn(body))
}

export function readNames(expression: unknown): Set<string> {
  return new Set(readNamesIn(partsOf(expression)))
}

export function readsAny(expression: unknown, names: Set<string>): boolean {
  return readsAnyIn(partsOf(expression), name => names.has(name))
}

export function readsState(expression: unknown): boolean {
  return readsStateIn(partsOf(expression))
}

// The answer for the last few PROGRAMS asked about, by identity. Was a module-level WeakMap per table, which a Term
// port cannot spell and a Rust build cannot hold (self-hosting-0022). A bounded memo keeps what the weak map was for,
// that a long-lived process does not keep every program it ever checked alive, and keeps the hit rate: the passes
// that ask alternate between at most a program and the checker's lowered copy of it (check/contract.ts), so four
// slots never thrash.
function recentPrograms<T>(size = 4): {
  get: (program: Program) => T | undefined
  set: (program: Program, value: T) => void
} {
  const slots: { program: Program; value: T }[] = []

  return {
    get: program => slots.find(slot => slot.program === program)?.value,
    set: (program, value) => {
      slots.unshift({ program, value })
      slots.length = Math.min(slots.length, size)
    },
  }
}

// the answer per program array: the kernel, both hold walks and the claim wall each ask, after the last pass that
// rewrites a body (async resolution runs before the kernel), so one answer serves them all
const PURE = recentPrograms<Purity>()

export type Purity = { pure: Set<string>; impure: Set<string>; writes: Map<string, Set<number>> }

export function onlyStatement(fn: Fn): Statement | undefined {
  const only = onlyStatementIn(fn)

  return only.form === 'some' ? only.value : undefined
}

export function pureFunctions(program: Program): Set<string> {
  return purity(program).pure
}

export function purity(program: Program): Purity {
  const known = PURE.get(program)

  if (known) {
    return known
  }

  const answer = purityIn(program)
  const result: Purity = {
    pure: new Set(answer.pure),
    impure: new Set(answer.impure),
    writes: new Map([...answer.writes].map(([name, at]) => [name, new Set(at)])),
  }
  PURE.set(program, result)

  return result
}

// the scalars no method can change in place, on any backend (`bytes` is a buffer, and can be)
export const IMMUTABLE = new Set(immutableKinds())

const STATE_FREE = recentPrograms<Set<string>>()
const LENGTH_KEEPING = recentPrograms<Set<string>>()
const RETURNS_FRESH = recentPrograms<Set<string>>()

export function stateFreeFunctions(program: Program): Set<string> {
  const known = STATE_FREE.get(program)

  if (known) {
    return known
  }

  const answer = new Set(
    stateFreeIn(program, [...pureFunctions(program)], [...returnsFreshFunctions(program)]),
  )
  STATE_FREE.set(program, answer)

  return answer
}

export function freshNames(fn: Fn, returning: Set<string> = new Set()): Set<string> {
  return new Set(freshNamesIn(fn, name => returning.has(name)))
}

export function returnsFreshFunctions(program: Program): Set<string> {
  const known = RETURNS_FRESH.get(program)

  if (known) {
    return known
  }

  const answer = new Set(returnsFreshIn(program))
  RETURNS_FRESH.set(program, answer)

  return answer
}

export function lengthKeepingFunctions(program: Program): Set<string> {
  const known = LENGTH_KEEPING.get(program)

  if (known) {
    return known
  }

  const answer = new Set(
    lengthKeepingIn(
      program,
      [...pureFunctions(program)],
      [...stateFreeFunctions(program)],
      [...returnsFreshFunctions(program)],
    ),
  )
  LENGTH_KEEPING.set(program, answer)

  return answer
}

export const READ_ONLY_LIST_METHODS = new Set(readOnlyListMethods())

export function callsImpure(
  expression: unknown,
  pure: Set<string>,
  functions: Set<string>,
  local: Set<string> = new Set(),
): boolean {
  return callsImpureIn(
    partsOf(expression),
    name => pure.has(name),
    name => functions.has(name),
    name => local.has(name),
  )
}

export function localNames(fn: Fn): Set<string> {
  return new Set(localNamesIn(fn))
}

export function functionNames(program: Program): Set<string> {
  return new Set(functionNamesIn(program))
}
