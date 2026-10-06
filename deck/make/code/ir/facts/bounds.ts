// List indexes proven inside their list for a whole counted loop, once a guard written before the loop holds, and the
// facts beside it: the integer bounds a task's arithmetic is safe under, the divisions they prove unsigned, the types
// that hold no list, and the tasks that reach none. The analyses are Term, ir/facts/guards.tree (self-hosting,
// 2026-10-06), and its header says what each proves. This face makes the maps and sets the emitters ask of by identity,
// builds the TypeScript shape of a guard, reads the lent lists into the port's hash, and keeps the list-free test's
// memo across the calls a caller makes of it.

import type { Expression, Program, Statement } from '@term/make/code/compile/node'
import {
  boundedLoops as guardsIn,
  integerBounds as integerBoundsIn,
  isListFree,
  listFreedomOf,
  listKey as listKeyIn,
  nativeCall as nativeCallIn,
  scalarTasks as scalarTasksIn,
  unsignedDivisions as unsignedDivisionsIn,
} from '@term/make/code/ir/facts/guards'

// one bound the guard checks: `base + offset` (base a variable's name, or absent for a literal `offset`) compared with 0
// (`low`) or with the list's length (`high`). `list` is the list's name, or for a list reached through a path the
// path's key (`listKey`, `ps/{k}/xs`), with `path` the node an emitter writes to read its length
export type BoundCheck = { list: string; base?: string; offset: number; side: 'low' | 'high'; path?: object }

// the key of a list a guard may name: a variable, or a path from one through fields and through slots at a literal or
// a variable index (`ps/{k}/xs`)
export function listKey(node: unknown): string | undefined {
  const key = listKeyIn(node as Expression)

  return key.form === 'some' ? key.value : undefined
}

// a bound on a name the guard also reads, for the arguments of a call made unchecked: `name >= 0` (`low`) or
// `name <= high`
export type Limit = { name: string; low?: true; high?: number }

// `fast`: the call nodes in the body that may call the task's unchecked copy once the guard, `limits` included, holds
export type LoopGuard = { checks: BoundCheck[]; fast?: object[]; limits?: Limit[] }

export function boundedLoops(program: Program, lent: Map<string, Map<number, unknown>> = new Map()): WeakMap<Statement, LoopGuard> {
  const guards = new WeakMap<Statement, LoopGuard>()
  const lentLists = new Map([...lent].map(([name, at]) => [name, [...at.keys()]]))

  for (const found of guardsIn(program, lentLists)) {
    const checks: BoundCheck[] = found.checks.map(c => ({
      list: c.list,
      ...(c.base !== '' ? { base: c.base } : {}),
      offset: c.offset,
      side: c.side as 'low' | 'high',
      ...(c.path.form === 'some' ? { path: c.path.value } : {}),
    }))
    const limits: Limit[] = found.limits.map(l =>
      l.low ? { name: l.name, low: true as const } : { name: l.name, high: l.high.form === 'some' ? l.high.value : 0 },
    )

    guards.set(found.loop, { checks, ...(found.fast.length ? { fast: found.fast, limits } : {}) })
  }

  return guards
}

// the types that cannot hold a list: a scalar, or a record or variant form every field of which is list-free
export function listFree(program: Program): (type: unknown) => boolean {
  const state = listFreedomOf(program)

  return type => isListFree(state, type === undefined ? { form: 'none' } : { form: 'some', value: type as never })
}

// the tasks whose integer arithmetic cannot leave the safe integers while every argument is in [0, L), each with L
export function integerBounds(program: Program): Map<string, number> {
  return new Map(integerBoundsIn(program).map(b => [b.task, b.limit]))
}

// the integer `/` and `%` nodes of the bounded tasks whose both operands are proven non-negative
export function unsignedDivisions(program: Program): WeakSet<object> {
  return new WeakSet<object>(unsignedDivisionsIn(program))
}

// a call to a native module's function, through a `dock load` the checker leaves deferred
export function nativeCall(callee: { form?: string; target?: unknown }): boolean {
  return nativeCallIn(callee as Expression)
}

// the tasks that cannot reach any list
export function scalarTasks(program: Program): Set<string> {
  return new Set(scalarTasksIn(program))
}
