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

import type { Program, Statement } from '@term/make/code/compile/node'

type Loose = { form?: string; [key: string]: unknown }

// one bound the guard checks: `base + offset` (base a variable's name, or absent for a literal `offset`) compared with 0
// (`low`) or with the list's length (`high`). `list` is the list's name, or for a list reached through a path the
// path's key (`listKey`, `ps/{k}/xs`), with `path` the node an emitter writes to read its length
export type BoundCheck = { list: string; base?: string; offset: number; side: 'low' | 'high'; path?: object }

// the key of a list a guard may name: a variable, or a path from one through fields and through slots at a literal
// or a variable index (`ps/{k}/xs`). The same text for the same path wherever it is read, so an emitter asks it of
// the list it is indexing; anything else has none
export function listKey(node: unknown): string | undefined {
  const e = node as Loose

  if (e.form === 'variable') {
    return e.name as string
  }

  if (e.form !== 'member') {
    return undefined
  }

  const inner = listKey(e.target)

  if (inner === undefined) {
    return undefined
  }

  const index = e.index as Loose | undefined

  if (index === undefined) {
    return /^\d+$/.test(e.name as string) ? `${inner}/{${e.name as string}}` : `${inner}/${e.name as string}`
  }

  if (index.form === 'integer') {
    return `${inner}/{${Number(index.value)}}`
  }

  return index.form === 'variable' ? `${inner}/{${index.name as string}}` : undefined
}

// a bound on a name the guard also reads, for the arguments of a call made unchecked: `name >= 0` (`low`) or
// `name <= high`
export type Limit = { name: string; low?: true; high?: number }

// `fast`: the call nodes in the body that may call the task's unchecked copy once the guard, `limits` included, holds
export type LoopGuard = { checks: BoundCheck[]; fast?: object[]; limits?: Limit[] }

export function boundedLoops(program: Program, lent: Map<string, Map<number, unknown>> = new Map()): WeakMap<Statement, LoopGuard> {
  const guards = new WeakMap<Statement, LoopGuard>()
  const closureWrites = namesWrittenInClosures(program)
  const pure = scalarTasks(program)
  // a task may run unchecked only where a call to it is one the guard allows: it reaches no list, or every list it takes
  // it takes LENT (`lent`, F1's `listFacts`, which never lends a list a task pushes or pops), so it may write a list's
  // slots but never its length. AWFY's Queens: `is-free` and `mark` read and write the board by `c + r`
  const tasks = new Map(program.flatMap(n => (n.form === 'function' ? [[n.name, n] as const] : [])))
  const lengthSafe = (name: string): boolean =>
    pure.has(name) || (tasks.get(name)?.params.every((p, i) => p.type?.kind !== 'array' || lent.get(name)?.has(i) === true) ?? false)
  const bounded = new Map([...integerBounds(program)].filter(([name]) => lengthSafe(name)))
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
      const guard = guardOf(node, closureWrites, pure, bounded, lent)

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

function guardOf(
  loop: Loose,
  closureWrites: Set<string>,
  pure: Set<string>,
  bounded: Map<string, number> = new Map(),
  lent: Map<string, Map<number, unknown>> = new Map(),
): LoopGuard | undefined {
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
    // a call whose every list argument its callee takes lent: it may write those lists' slots, never their lengths, and
    // it can reach no local of this loop (no closure is in it)
    const takesLent =
      node.form === 'call' &&
      (node.callee as Loose).form === 'variable' &&
      lent.has((node.callee as Loose).name as string) &&
      (node.args as Loose[]).every(
        (a, i) => scalar(a.type as { kind?: string; name?: string } | undefined) || lent.get((node.callee as Loose).name as string)!.has(i),
      )

    if ((node.form === 'call' && !reachesNoList && !takesLent) || node.form === 'closure' || node.form === 'await') {
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
  // a name the loop never writes and no closure writes: its value at the guard is its value on every turn
  const invariant = (e: Loose): boolean =>
    e.form === 'variable' && number(e) && (writes.get(e.name as string) ?? []).length === 0 && !closureWrites.has(e.name as string)
  // `path` is the list's node when it is reached through a path, for an emitter to read its length
  const bound = (list: string, index: Loose, path?: object): void => {
    const at = path ? { path } : {}

    // literal: `xs/0`, or `xs/{3}`
    if (index.form === 'integer') {
      const offset = Number(index.value)
      checks.push({ list, offset, side: 'low', ...at }, { list, offset, side: 'high', ...at })

      return
    }

    // a name the loop never writes (`ps/{k}` inside a walk over `i`): the guard reads it once, as every turn does
    if (invariant(index) && index.name !== smallName && index.name !== bigName) {
      checks.push({ list, base: index.name as string, offset: 0, side: 'low', ...at }, { list, base: index.name as string, offset: 0, side: 'high', ...at })

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

    checks.push({ list, base: lowBase, offset: lowOffset, side: 'low', ...at })
    checks.push(bigName ? { list, base: bigName, offset: highOffset, side: 'high', ...at } : { list, offset: Number(big.value) + highOffset, side: 'high', ...at })
  }

  // the key of a list reached through a path whose every part the loop holds still: a root it never writes, fields,
  // and slots at a literal or a name it never writes, each slot bounded in its own list FIRST, so the guard reads a
  // prefix only once its index is known inside it. A slot at the counter is a different list every turn, which one
  // guard cannot read: refused
  const pathList = (node: Loose): string | undefined => {
    if (node.form === 'variable') {
      return (writes.get(node.name as string) ?? []).length === 0 && !closureWrites.has(node.name as string) ? (node.name as string) : undefined
    }

    if (node.form !== 'member') {
      return undefined
    }

    const inner = pathList(node.target as Loose)
    const index = node.index as Loose | undefined
    const literal = index === undefined && /^\d+$/.test(node.name as string)

    if (inner === undefined) {
      return undefined
    }

    // a field
    if (index === undefined && !literal) {
      return `${inner}/${node.name as string}`
    }

    const at: Loose = literal ? { form: 'integer', value: Number(node.name) } : index!

    if (at.form !== 'integer' && !(invariant(at) && at.name !== smallName && at.name !== bigName)) {
      return undefined
    }

    const target = node.target as Loose

    bound(inner, at, target.form === 'variable' ? undefined : target)

    return listKey(node)
  }

  // whether a guarded list reached through a path could be a different list by a later turn: a field written (it may
  // be the path's own field), or a slot written whose value is not a scalar (it may replace a record on the path)
  let rebinds = false
  const findRebinds = (value: unknown): void => {
    if (typeof value !== 'object' || value === null) {
      return
    }

    if (Array.isArray(value)) {
      value.forEach(findRebinds)

      return
    }

    const node = value as Loose

    if (node.form === 'assign' && (node.target as Loose).form === 'member') {
      const target = node.target as Loose
      const slot = target.index !== undefined || /^\d+$/.test(target.name as string)

      if (!slot || !scalar((target.type ?? (node.value as Loose).type) as { kind?: string; name?: string } | undefined)) {
        rebinds = true
      }
    }

    // a call the guard allowed for its lengths (a task taking its lists lent) may still write a slot of one, and a slot
    // of a list of records holding a path's list would replace it: with a path guarded, a call is passed scalars only
    if (node.form === 'call' && (node.args as Loose[]).some(a => !scalar(a.type as { kind?: string; name?: string } | undefined))) {
      rebinds = true
    }

    for (const [key, child] of Object.entries(node)) {
      if (key !== 'type' && key !== 'span') {
        findRebinds(child)
      }
    }
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

        if (at < 0 || at >= firstStep) {
          refused = true

          return
        }

        // a slot of a list the loop never rebinds, read or written before either side steps
        if (target.form === 'variable') {
          if ((writes.get(target.name as string) ?? []).length > 0) {
            refused = true

            return
          }

          bound(target.name as string, literal ? { form: 'integer', value: Number(node.name) } : (node.index as Loose))
          uses(node.index, at)

          return
        }

        // a slot of a list reached through a path the loop holds still (`ps/{k}/xs/{i}`)
        const key = pathList(target)

        if (key === undefined) {
          refused = true

          return
        }

        bound(key, literal ? { form: 'integer', value: Number(node.name) } : (node.index as Loose), target)
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

  if (refused) {
    return undefined
  }

  if (checks.some(c => c.path)) {
    findRebinds(body)

    if (rebinds) {
      return undefined
    }
  }

  // the calls to a task whose integer arithmetic is safe below a bound (`integerBounds`), with every argument bounded
  // here: the counter before either side steps (in [small0, big0 - 1], so `small >= 0` and `big <= L`), a name the
  // loop never writes (`0 <= v <= L - 1`, read once at entry), or a literal inside [0, L)
  const fast: object[] = []
  const limits: Limit[] = []
  const calls = (value: unknown, at: number): void => {
    if (typeof value !== 'object' || value === null) {
      return
    }

    if (Array.isArray(value)) {
      value.forEach(v => calls(v, at))

      return
    }

    const node = value as Loose
    const callee = node.callee as Loose | undefined
    const limit = node.form === 'call' && callee?.form === 'variable' ? bounded.get(callee.name as string) : undefined

    if (limit !== undefined) {
      const mine: Limit[] = []
      const fits = (node.args as Loose[]).every(arg => {
        if (arg.form === 'integer') {
          return Number(arg.value) >= 0 && Number(arg.value) < limit
        }

        if (arg.form === 'boolean' || arg.form === 'float') {
          return true
        }

        if (arg.form !== 'variable') {
          return false
        }

        // a list the task takes lent, or a flag or a decimal: no bound on it, read by the copy as by the original
        if (['array', 'boolean', 'float'].includes((arg.type as { kind?: string } | undefined)?.kind ?? '')) {
          return true
        }

        const name = arg.name as string

        if (name === smallName) {
          if (at < 0 || at >= firstStep) {
            return false
          }

          mine.push({ name: smallName, low: true })

          if (bigName) {
            mine.push({ name: bigName, high: limit })

            return true
          }

          return Number(big.value) <= limit
        }

        if (name === bigName || (writes.get(name) ?? []).length > 0 || closureWrites.has(name)) {
          return false
        }

        mine.push({ name, low: true }, { name, high: limit - 1 })

        return true
      })

      if (fits) {
        fast.push(node)
        limits.push(...mine)
      }
    }

    for (const [key, child] of Object.entries(node)) {
      if (key !== 'type' && key !== 'span') {
        calls(child, at)
      }
    }
  }

  body.forEach((s, i) => calls(s, i))

  if (checks.length === 0 && fast.length === 0) {
    return undefined
  }

  // per name, the strictest of each kind
  const lows = new Set(limits.flatMap(l => (l.low ? [l.name] : [])))
  const highs = new Map<string, number>()

  for (const l of limits) {
    if (l.high !== undefined) {
      highs.set(l.name, Math.min(l.high, highs.get(l.name) ?? Infinity))
    }
  }

  const bounds: Limit[] = [...[...lows].map(name => ({ name, low: true as const })), ...[...highs].map(([name, high]) => ({ name, high }))]

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

  return { checks: [...extreme.values()], ...(fast.length ? { fast, limits: bounds } : {}) }
}

// a number, a float, a flag or a text: a value that holds no list
function scalar(type: { kind?: string; name?: string } | undefined): boolean {
  return (
    type !== undefined &&
    (type.kind === 'number' ||
      type.kind === 'float' ||
      type.kind === 'boolean' ||
      type.kind === 'string' ||
      (type.kind === 'named' && ['text', 'boolean', 'number', 'integer', 'float'].includes(type.name ?? '')))
  )
}

// The types that cannot hold a list: a scalar, or a record or variant form every field of which is list-free (a
// recursive form is list-free unless a field says otherwise). A list, a map, a function, an unknown or a type variable
// never is. A value of one reaches no list, so passing it to a task cannot hand that task a list another name holds:
// fasta's `fold(state, line, width)` (a record of three numbers, a text, a number) cost `random` its lent list
export function listFree(program: Program): (type: unknown) => boolean {
  const forms = new Map(
    program.flatMap(n =>
      n.form === 'record-type' && !n.params.length ? [[n.name, [...n.fields, ...n.variants.flatMap(v => v.fields)].map(f => f.type)] as const] : [],
    ),
  )
  const known = new Map<string, boolean>()

  const free = (type: unknown): boolean => {
    const t = type as { kind?: string; name?: string; args?: unknown[] } | undefined

    if (scalar(t)) {
      return true
    }

    if (t?.kind !== 'named' || (t.args?.length ?? 0) > 0 || !forms.has(t.name!)) {
      return false
    }

    if (known.has(t.name!)) {
      return known.get(t.name!)!
    }

    // assumed free while its own fields are checked, so a recursive form does not refuse itself
    known.set(t.name!, true)
    const answer = forms.get(t.name!)!.every(free)
    known.set(t.name!, answer)

    return answer
  }

  return free
}

// The tasks whose integer arithmetic cannot leave the safe integers while every argument is in [0, L): each answered
// with the largest such L, a power of two up to 2^31. Interval arithmetic over a body of `let`s and one `send back`,
// through `+`, `-`, `*`, integer `/` and `%` (by a divisor whose interval excludes 0) and the float operations, which
// carry no check. A loop that calls one with arguments it can bound (`boundedLoops`) runs an unchecked copy of it
// behind `n <= L` in its guard: spectral-norm's `a-value`, four checked operations 40 million times
const SAFE = Number.MAX_SAFE_INTEGER

export function integerBounds(program: Program): Map<string, number> {
  const found = new Map<string, number>()

  for (const fn of program) {
    // every parameter a number, or a list (whose slots the body may read and write by a bounded index, AWFY's Queens),
    // and at least one number to bound
    if (
      fn.form !== 'function' ||
      fn.async ||
      !fn.params.some(p => p.type?.kind === 'number') ||
      !fn.params.every(p => ['number', 'array', 'boolean', 'float'].includes(p.type?.kind ?? ''))
    ) {
      continue
    }

    for (let power = 31; power >= 1; power--) {
      if (fits(fn, 2 ** power)) {
        found.set(fn.name, 2 ** power)

        break
      }
    }
  }

  return found
}

// the integer `/` and `%` nodes of the bounded tasks whose both operands are proven non-negative (the divisor
// positive) inside the bound: on Rust the task's unchecked copy divides them unsigned, one shift for `/ 2` where a
// signed division needs a sign fix-up (spectral-norm's `a_value`, 227 ms to 218, the hand version 218)
export function unsignedDivisions(program: Program): WeakSet<object> {
  const found = new WeakSet<object>()
  const bounds = integerBounds(program)

  for (const fn of program) {
    if (fn.form === 'function' && bounds.has(fn.name)) {
      fits(fn, bounds.get(fn.name)!, found)
    }
  }

  return found
}

// whether every integer operation in the body stays inside the safe integers with each parameter in [0, limit), and
// into `divisions` each division or remainder whose operands it proved non-negative
function fits(fn: Extract<Statement, { form: 'function' }>, limit: number, divisions?: WeakSet<object>): boolean {
  type Range = { lo: number; hi: number } | 'float'
  const env = new Map<string, Range>(fn.params.flatMap(p => (p.type?.kind === 'number' ? [[p.name, { lo: 0, hi: limit - 1 }] as const] : [])))
  const lists = new Set(fn.params.flatMap(p => (p.type?.kind === 'array' ? [p.name] : [])))
  // a flag or a decimal parameter: read, never tracked, since nothing checks it
  const untracked = new Set(fn.params.flatMap(p => (p.type?.kind === 'boolean' || p.type?.kind === 'float' ? [p.name] : [])))
  // a slot of a list parameter, its index bounded like any operand; what it holds is not tracked, so integer arithmetic
  // on it is refused
  const slot = (e: Loose): boolean => e.form === 'member' && (e.target as Loose).form === 'variable' && lists.has((e.target as Loose).name as string)
  let ok = true

  const range = (e: Loose): Range => {
    if (!ok) {
      return 'float'
    }

    switch (e.form) {
      case 'integer':
        return { lo: e.value as number, hi: e.value as number }
      case 'float':
      case 'boolean':
        return 'float'
      case 'variable': {
        if (untracked.has(e.name as string)) {
          return 'float'
        }

        const known = env.get(e.name as string)

        if (known === undefined) {
          ok = false
        }

        return known ?? 'float'
      }
      case 'unary': {
        const inner = range(e.operand as Loose)

        if (inner === 'float' || e.op !== '-') {
          return inner
        }

        return { lo: -inner.hi, hi: -inner.lo }
      }
      case 'binary': {
        const a = range(e.left as Loose)
        const b = range(e.right as Loose)
        const integer = (e.left as Loose).type && ((e.left as Loose).type as { kind?: string }).kind === 'number' &&
          ((e.right as Loose).type as { kind?: string } | undefined)?.kind === 'number'

        if (!integer) {
          // a float operation, or a comparison: no check to remove, nothing to track
          return 'float'
        }

        if (a === 'float' || b === 'float') {
          ok = false

          return 'float'
        }

        type Span = { lo: number; hi: number }
        const corners = (f: (x: number, y: number) => number): Span => {
          const all = [f(a.lo, b.lo), f(a.lo, b.hi), f(a.hi, b.lo), f(a.hi, b.hi)]

          return { lo: Math.min(...all), hi: Math.max(...all) }
        }
        let out: Span

        switch (e.op) {
          case '+':
            out = { lo: a.lo + b.lo, hi: a.hi + b.hi }
            break
          case '-':
            out = { lo: a.lo - b.hi, hi: a.hi - b.lo }
            break
          case '*':
            out = corners((x, y) => x * y)
            break
          case '/':
            if (b.lo <= 0 && b.hi >= 0) {
              ok = false

              return 'float'
            }

            out = corners((x, y) => Math.trunc(x / y))

            if (a.lo >= 0 && b.lo > 0) {
              divisions?.add(e)
            }

            break
          case '%':
            if (b.lo <= 0 && b.hi >= 0) {
              ok = false

              return 'float'
            }

            out = { lo: Math.min(0, a.lo), hi: Math.max(0, a.hi) }

            if (a.lo >= 0 && b.lo > 0) {
              divisions?.add(e)
            }

            break
          default:
            // a comparison of two integers: a boolean
            return 'float'
        }

        if (out.lo < -SAFE || out.hi > SAFE) {
          ok = false
        }

        return out
      }
      case 'member':
        if (slot(e)) {
          if (e.index !== undefined) {
            range(e.index as Loose)
          }

          return 'float'
        }

        ok = false

        return 'float'
      case 'call': {
        // its arguments are bounded like any operand; a call answering a float (`to-decimal`) needs no range of its
        // own, and the callee keeps its own checks. One answering an integer is not followed
        ;(e.args as Loose[]).forEach(range)

        if ((e.type as { kind?: string } | undefined)?.kind !== 'float') {
          ok = false
        }

        return 'float'
      }
      default:
        ok = false

        return 'float'
    }
  }

  for (const s of fn.body as Loose[]) {
    if (s.form === 'let') {
      env.set(s.name as string, range(s.init as Loose))
    } else if (s.form === 'return' && s.value) {
      range(s.value as Loose)
    } else if (s.form === 'assign' && s.op === '=' && slot(s.target as Loose)) {
      range(s.target as Loose)
      range(s.value as Loose)
    } else {
      return false
    }
  }

  return ok
}

// A call to a native module's function (`fmath.sqrt`, through a `dock load` the checker leaves deferred, which a local
// or a task never is). It can hold none of the program's lists, so with scalar arguments it reaches none of them
export function nativeCall(callee: { form?: string; target?: unknown }): boolean {
  const module = callee.form === 'member' ? (callee.target as Loose) : undefined

  return module?.form === 'variable' && (module.binding as { kind?: string } | undefined)?.kind === 'deferred'
}

// The tasks that cannot reach any list: every parameter list-free (`listFree`: a scalar, or a record holding none),
// nothing in the body a closure, an await, a slot or length of a list, or a variable from outside the task whose type
// could hold one, and every call to another such task (or a native binding) with list-free arguments. A fixpoint, since
// one such task may call another. A call to one inside a counted loop cannot change a list's length, so it does not
// cost the loop its guard (spectral-norm's `a-value`), nor a task its lent lists (fasta's `fold`)
export function scalarTasks(program: Program): Set<string> {
  type Fn = Extract<Statement, { form: 'function' }>
  const fns = program.filter((n): n is Fn => n.form === 'function')
  const tasks = new Set(fns.map(f => f.name))
  const free = listFree(program)
  const pure = new Set(fns.filter(f => f.body.length > 0 && !f.async && f.params.every(p => free(p.type))).map(f => f.name))
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
          if (!locals.has(node.name as string) && !tasks.has(node.name as string) && !free(node.type)) {
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
          // a method of a text (`line.char-code-at(i)`, what the stdlib's text tasks inline to) reaches no list
          const textMethod = callee.form === 'member' && ((callee.target as Loose).type as { kind?: string } | undefined)?.kind === 'string'

          if (textMethod) {
            visit(callee.target)
          }

          if (!known && !nativeCall(callee) && !textMethod) {
            ok = false

            return
          }

          if (!(node.args as Loose[]).every(a => free(a.type))) {
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
