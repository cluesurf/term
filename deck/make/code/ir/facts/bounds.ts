// List indexes proven inside their list for a whole counted loop, once a guard written before the loop holds
// (note/term/codegen/passes.md, P2; F3 ranges in note/term/codegen/shared.md). The emitter writes the loop twice: the
// guard true runs a copy with no bounds checks, the guard false runs the original, checked, unchanged. So a run that
// could reach outside a list takes the checked copy and stops exactly where it always did, and the guard is the one
// place the bounds are read.
//
// The loop: `while (small < big)` where
//   - `small` is a counter written exactly once in the loop, by a top-level `small = small + 1`
//   - `big` is an integer literal, or a variable written never or exactly once, by a top-level `big = big - 1`
//   - neither is written by any closure in the program (a closure called inside the loop would write it unseen)
//   - nothing in the body is a call, a closure or an await: a call could grow or shrink a list, so the lengths the
//     guard read stay the lengths of every turn only when nothing is called
// While a turn's accesses run (before either step), the condition held and neither side has moved, so
//   small in [small0, big0 - 1]   and   big in [small0 + 1, big0]
// for the values small0 and big0 the two had when the loop was entered, which is when the guard reads them. An index
// `small + c`, `big + c`, a body-local `let x = small + c` read as `x`, or a literal `c`, is then inside known bounds,
// and the guard asks, per list, that the lowest is at least 0 and the highest is below the list's length. A list
// written by slot keeps its length, and the loop may not rebind the list. Every index into a list in the body must be
// one of those shapes, or the loop gets no guard.
//
// The result maps a `while` node to its guard. Keyed by node identity, like every fact: an emitter that ignores it
// stays correct. test/ir/facts/bounds.ts holds the shapes that must NOT get a guard.

import type { Program, Statement } from '../../compile/node'

type Loose = { form?: string; [key: string]: unknown }

// one bound the guard checks: `base + offset` (base a variable's name, or absent for a literal `offset`) compared with 0
// (`low`) or with the list's length (`high`)
export type BoundCheck = { list: string; base?: string; offset: number; side: 'low' | 'high' }

export type LoopGuard = { checks: BoundCheck[] }

export function boundedLoops(program: Program): WeakMap<Statement, LoopGuard> {
  const guards = new WeakMap<Statement, LoopGuard>()
  const closureWrites = namesWrittenInClosures(program)
  const pure = scalarTasks(program)
  const seen = new Set<object>()

  const visit = (value: unknown): void => {
    if (typeof value !== 'object' || value === null || seen.has(value)) {
      return
    }

    seen.add(value)

    if (Array.isArray(value)) {
      value.forEach(visit)

      return
    }

    const node = value as Loose

    if (node.form === 'while') {
      const guard = guardOf(node, closureWrites, pure)

      if (guard) {
        guards.set(node as unknown as Statement, guard)
      }
    }

    for (const [key, inner] of Object.entries(node)) {
      if (key !== 'type' && key !== 'span') {
        visit(inner)
      }
    }
  }

  visit(program)

  return guards
}

function guardOf(loop: Loose, closureWrites: Set<string>, pure: Set<string>): LoopGuard | undefined {
  const cond = loop.cond as Loose | undefined
  const body = loop.body as Loose[]

  if (cond?.form !== 'binary' || (cond.op !== '<' && cond.op !== '>') || !Array.isArray(body)) {
    return undefined
  }

  const small = (cond.op === '<' ? cond.left : cond.right) as Loose
  const big = (cond.op === '<' ? cond.right : cond.left) as Loose
  const number = (e: Loose): boolean => (e.type as { kind?: string } | undefined)?.kind === 'number'

  if (small.form !== 'variable' || !number(small) || closureWrites.has(small.name as string)) {
    return undefined
  }

  if (big.form !== 'integer' && (big.form !== 'variable' || !number(big) || closureWrites.has(big.name as string))) {
    return undefined
  }

  const smallName = small.name as string
  const bigName = big.form === 'variable' ? (big.name as string) : undefined

  // nothing in the body may call, capture or wait: any of them could change a list's length or a counter unseen
  let opaque = false
  const scan = (value: unknown): void => {
    if (opaque || typeof value !== 'object' || value === null) {
      return
    }

    if (Array.isArray(value)) {
      value.forEach(scan)

      return
    }

    const node = value as Loose

    // a call to a task that cannot reach a list (`scalarTasks`), with only scalar arguments, changes no length
    const reachesNoList =
      node.form === 'call' &&
      (((node.callee as Loose).form === 'variable' && pure.has((node.callee as Loose).name as string)) ||
        nativeCall(node.callee as Loose)) &&
      (node.args as Loose[]).every(a => scalar(a.type as { kind?: string; name?: string } | undefined))

    if ((node.form === 'call' && !reachesNoList) || node.form === 'closure' || node.form === 'await') {
      opaque = true

      return
    }

    for (const [key, child] of Object.entries(node)) {
      if (key !== 'type' && key !== 'span') {
        scan(child)
      }
    }
  }

  scan(body)
  scan(cond)

  if (opaque) {
    return undefined
  }

  // every write to a name anywhere in the body, and where: a top-level statement's index, or -1 when nested
  const writes = new Map<string, { at: number; node: Loose }[]>()
  const record = (name: string, at: number, node: Loose): void => {
    writes.set(name, [...(writes.get(name) ?? []), { at, node }])
  }
  const findWrites = (value: unknown, at: number): void => {
    if (typeof value !== 'object' || value === null) {
      return
    }

    if (Array.isArray(value)) {
      value.forEach(v => findWrites(v, at))

      return
    }

    const node = value as Loose

    if (node.form === 'assign' && (node.target as Loose).form === 'variable') {
      record((node.target as Loose).name as string, at, node)
    }

    // a `let` of a name is a second variable of that name: counted as a write so the loop is refused
    if (node.form === 'let') {
      record(node.name as string, at, node)
    }

    for (const [key, child] of Object.entries(node)) {
      if (key !== 'type' && key !== 'span') {
        findWrites(child, -1)
      }
    }
  }

  body.forEach((s, i) => findWrites(s, i))

  const isVar = (e: Loose, name: string): boolean => e.form === 'variable' && e.name === name
  const isOne = (e: Loose): boolean => e.form === 'integer' && Number(e.value) === 1
  const smallWrites = writes.get(smallName) ?? []
  const smallStep = smallWrites[0]

  // the counter's one write, a top-level `small = small + 1`
  if (
    smallWrites.length !== 1 ||
    smallStep!.at < 0 ||
    smallStep!.node.form !== 'assign' ||
    smallStep!.node.op !== '=' ||
    (smallStep!.node.value as Loose).form !== 'binary' ||
    (smallStep!.node.value as Loose).op !== '+' ||
    !(
      (isVar((smallStep!.node.value as Loose).left as Loose, smallName) && isOne((smallStep!.node.value as Loose).right as Loose)) ||
      (isOne((smallStep!.node.value as Loose).left as Loose) && isVar((smallStep!.node.value as Loose).right as Loose, smallName))
    )
  ) {
    return undefined
  }

  // the big side's writes: none, or one top-level `big = big - 1`
  let firstStep = smallStep!.at

  if (bigName) {
    const bigWrites = writes.get(bigName) ?? []

    if (bigWrites.length > 1) {
      return undefined
    }

    if (bigWrites.length === 1) {
      const step = bigWrites[0]!
      const value = step.node.value as Loose | undefined

      if (
        step.at < 0 ||
        step.node.form !== 'assign' ||
        step.node.op !== '=' ||
        value?.form !== 'binary' ||
        value.op !== '-' ||
        !isVar(value.left as Loose, bigName) ||
        !isOne(value.right as Loose)
      ) {
        return undefined
      }

      firstStep = Math.min(firstStep, step.at)
    }
  }

  // body-local aliases `let x = small + c` (or `big + c`, `- c`), never written again, read as indexes
  const aliases = new Map<string, { base: 'small' | 'big'; offset: number }>()

  body.slice(0, firstStep).forEach(s => {
    if (s.form !== 'let') {
      return
    }

    const init = s.init as Loose
    const name = s.name as string

    if ((writes.get(name) ?? []).length !== 1 || init.form !== 'binary' || (init.op !== '+' && init.op !== '-')) {
      return
    }

    const left = init.left as Loose
    const right = init.right as Loose

    if (right.form !== 'integer') {
      return
    }

    const offset = (init.op === '+' ? 1 : -1) * Number(right.value)

    if (isVar(left, smallName)) {
      aliases.set(name, { base: 'small', offset })
    } else if (bigName && isVar(left, bigName)) {
      aliases.set(name, { base: 'big', offset })
    }
  })

  // every list index in the body, each turned into its two bounds, or the loop is refused
  const checks: BoundCheck[] = []
  let refused = false
  const bound = (list: string, index: Loose): void => {
    // literal: `xs/0`, or `xs/{3}`
    if (index.form === 'integer') {
      const at = Number(index.value)
      checks.push({ list, offset: at, side: 'low' }, { list, offset: at, side: 'high' })

      return
    }

    let base: 'small' | 'big' | undefined
    let offset = 0

    if (isVar(index, smallName)) {
      base = 'small'
    } else if (bigName && isVar(index, bigName)) {
      base = 'big'
    } else if (index.form === 'variable' && aliases.has(index.name as string)) {
      const alias = aliases.get(index.name as string)!
      base = alias.base
      offset = alias.offset
    } else if (index.form === 'binary' && (index.op === '+' || index.op === '-') && (index.right as Loose).form === 'integer') {
      const sign = index.op === '+' ? 1 : -1
      const left = index.left as Loose

      if (isVar(left, smallName)) {
        base = 'small'
        offset = sign * Number((index.right as Loose).value)
      } else if (bigName && isVar(left, bigName)) {
        base = 'big'
        offset = sign * Number((index.right as Loose).value)
      }
    }

    if (!base) {
      refused = true

      return
    }

    // small in [small0, big0 - 1], big in [small0 + 1, big0]: the lowest and highest each index can be
    const lowBase = smallName
    const lowOffset = base === 'small' ? offset : offset + 1
    const highOffset = base === 'small' ? offset - 1 : offset

    checks.push({ list, base: lowBase, offset: lowOffset, side: 'low' })
    checks.push(bigName ? { list, base: bigName, offset: highOffset, side: 'high' } : { list, offset: Number(big.value) + highOffset, side: 'high' })
  }

  const uses = (value: unknown, at: number): void => {
    if (refused || typeof value !== 'object' || value === null) {
      return
    }

    if (Array.isArray(value)) {
      value.forEach(v => uses(v, at))

      return
    }

    const node = value as Loose

    if (node.form === 'member' && ((node.target as Loose).type as { kind?: string } | undefined)?.kind === 'array') {
      const literal = node.index === undefined && /^\d+$/.test(node.name as string)

      if (node.index !== undefined || literal) {
        const target = node.target as Loose

        // a slot of a list the loop never rebinds, read or written before either side steps
        if (target.form !== 'variable' || (writes.get(target.name as string) ?? []).length > 0 || at < 0 || at >= firstStep) {
          refused = true

          return
        }

        bound(target.name as string, literal ? { form: 'integer', value: Number(node.name) } : (node.index as Loose))
        uses(node.index, at)

        return
      }
    }

    for (const [key, child] of Object.entries(node)) {
      if (key !== 'type' && key !== 'span') {
        uses(child, at)
      }
    }
  }

  body.forEach((s, i) => uses(s, i))

  if (refused || checks.length === 0) {
    return undefined
  }

  // per list, base and side only the extreme bound: the lowest offset tested against 0 implies every higher one, and the
  // highest tested against the length implies every lower one (`high < len` makes `high - 1 < len` redundant)
  const extreme = new Map<string, BoundCheck>()

  for (const c of checks) {
    const key = `${c.list}|${c.base ?? ''}|${c.side}`
    const held = extreme.get(key)

    if (!held || (c.side === 'low' ? c.offset < held.offset : c.offset > held.offset)) {
      extreme.set(key, c)
    }
  }

  return { checks: [...extreme.values()] }
}

// a number, a float, a flag or a text: a value that holds no list
function scalar(type: { kind?: string; name?: string } | undefined): boolean {
  return (
    type !== undefined &&
    (type.kind === 'number' ||
      type.kind === 'float' ||
      type.kind === 'boolean' ||
      type.kind === 'string' ||
      (type.kind === 'named' && ['text', 'boolean', 'number', 'integer', 'decimal'].includes(type.name ?? '')))
  )
}

// A call to a native module's function (`fmath.sqrt`, through a `dock load` the checker leaves deferred, which a local
// or a task never is). It can hold none of the program's lists, so with scalar arguments it reaches none of them
export function nativeCall(callee: { form?: string; target?: unknown }): boolean {
  const module = callee.form === 'member' ? (callee.target as Loose) : undefined

  return module?.form === 'variable' && (module.binding as { kind?: string } | undefined)?.kind === 'deferred'
}

// The tasks that cannot reach any list: every parameter a scalar, nothing in the body a closure, an await, a slot or
// length of a list, or a variable from outside the task that holds anything but a scalar, and every call to another
// such task (or a native binding) with scalar arguments. A fixpoint, since one such task may call another. A call to
// one inside a counted loop cannot change a list's length, so it does not cost the loop its guard
// (spectral-norm's `a-value`, called in the innermost loop)
export function scalarTasks(program: Program): Set<string> {
  type Fn = Extract<Statement, { form: 'function' }>
  const fns = program.filter((n): n is Fn => n.form === 'function')
  const tasks = new Set(fns.map(f => f.name))
  const pure = new Set(fns.filter(f => f.body.length > 0 && !f.async && f.params.every(p => scalar(p.type as never))).map(f => f.name))
  let changed = true

  const clean = (fn: Fn): boolean => {
    const locals = new Set(fn.params.map(p => p.name))
    let ok = true
    const visit = (value: unknown): void => {
      if (!ok || typeof value !== 'object' || value === null) {
        return
      }

      if (Array.isArray(value)) {
        value.forEach(visit)

        return
      }

      const node = value as Loose

      switch (node.form) {
        case 'closure':
        case 'await':
          ok = false

          return
        case 'let':
          locals.add(node.name as string)
          break
        case 'variable':
          if (!locals.has(node.name as string) && !tasks.has(node.name as string) && !scalar(node.type as never)) {
            ok = false
          }

          return
        case 'member':
          if (((node.target as Loose).type as { kind?: string } | undefined)?.kind === 'array') {
            ok = false

            return
          }

          break
        case 'call': {
          const callee = node.callee as Loose

          const known = callee.form === 'variable' && (!tasks.has(callee.name as string) || pure.has(callee.name as string))

          if (!known && !nativeCall(callee)) {
            ok = false

            return
          }

          if (!(node.args as Loose[]).every(a => scalar(a.type as never))) {
            ok = false

            return
          }

          visit(node.args)

          return
        }
        default:
          break
      }

      for (const [key, child] of Object.entries(node)) {
        if (key !== 'type' && key !== 'span') {
          visit(child)
        }
      }
    }

    visit(fn.body)

    return ok
  }

  while (changed) {
    changed = false

    for (const fn of fns) {
      if (pure.has(fn.name) && !clean(fn)) {
        pure.delete(fn.name)
        changed = true
      }
    }
  }

  return pure
}

// every variable name an assignment inside some closure writes (as ir/facts/range.ts reads it)
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
