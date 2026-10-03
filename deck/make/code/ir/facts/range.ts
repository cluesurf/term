// Increments proven not to overflow (note/term/codegen/passes.md, P2, the first fact built).
//
// A counted loop `while (i < bound) { ...; i = i + 1 }` is what every `walk size` lowers to (mint-bridge.ts, mode
// `size`), and most index loops are written that way. Its increment cannot overflow when nothing else writes `i`:
// at the increment `i` still holds the value the condition tested, so `i < bound`, and `bound` is itself a number the
// backend represents, so `i + 1 <= bound` is one too. That holds on every backend: an i64 `bound` is at most i64::MAX
// on Rust, Swift and Kotlin, and a `number` on TypeScript is a safe integer or the program has already stopped.
//
// What makes it sound, and what each check below is for:
//   - the condition is a strict `<` with the counter on the small side (`<=` would allow `i == bound == MAX`)
//   - the counter is written exactly once inside the loop, by `i = i + 1`, so it is the tested value
//   - that write is not inside a nested loop or a closure, so it runs at most once per test of the condition
//   - no closure anywhere in the program writes a variable of the counter's name: a closure made before the loop and
//     called inside it writes the counter without its write appearing in the loop's body
//   - the counter is a `number`
// The same holds on the other side of the condition: in `while (low < high)`, a single `high = high - 1` cannot go
// below the minimum, since `high > low >= MIN`. And the step's own expression read EARLIER in the body (`i + 1` used as
// an index before `i = i + 1`) is proven too, outside closures, because there the counter is still the tested value.
// Separately, `x % c` by a nonzero integer literal cannot leave the range: the result is smaller than |c|.
// A fact that is wrong removes a check that should fire, so every rule has a counterexample in
// test/ir/facts/range.ts that must NOT be proven.
//
// The result is the set of `+` nodes an emitter may write as a plain `+`. It is keyed by node identity, the way twins
// are: nothing in the program changes, and an emitter that ignores it stays correct.

import type { Expression, Program } from '../../compile/node'

type Loose = { form?: string; [key: string]: unknown }

export function provenIncrements(program: Program): WeakSet<Expression> {
  const proven = new WeakSet<Expression>()
  const seen = new Set<object>()
  const closureWrites = namesWrittenInClosures(program)

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
      check(node)
    }

    // `x % c` by a nonzero integer literal: the result is smaller than |c|, so it cannot leave the range, and c is no zero
    if (
      node.form === 'binary' &&
      node.op === '%' &&
      (node.right as Loose).form === 'integer' &&
      Number((node.right as Loose).value) !== 0 &&
      ((node.left as Loose).type as { kind?: string } | undefined)?.kind === 'number'
    ) {
      proven.add(node as unknown as Expression)
    }

    for (const [key, inner] of Object.entries(node)) {
      if (key !== 'type' && key !== 'span') {
        visit(inner)
      }
    }
  }

  const check = (loop: Loose): void => {
    const cond = loop.cond as Loose | undefined

    // a counter against an integer LITERAL with a non-strict comparison, `i >= 0` / `0 <= i` stepping down or
    // `i <= c` / `c >= i` stepping up: at the step the counter is at least (at most) the literal, so one step down (up)
    // cannot leave the range while the literal is not the minimum (maximum). AWFY's Permute counts down to 0
    if (cond?.form === 'binary' && (cond.op === '>=' || cond.op === '<=')) {
      const left = cond.left as Loose
      const right = cond.right as Loose
      const literal = (e: Loose): boolean => e.form === 'integer' && Math.abs(Number(e.value)) < Number.MAX_SAFE_INTEGER

      // the counter on the large side steps down, on the small side up
      if (left.form === 'variable' && literal(right)) {
        counted(loop, left, cond.op === '>=' ? -1 : 1)
      } else if (right.form === 'variable' && literal(left)) {
        counted(loop, right, cond.op === '<=' ? -1 : 1)
      }

      return
    }

    if (cond?.form !== 'binary' || (cond.op !== '<' && cond.op !== '>')) {
      return
    }

    // `small < big`, or `big > small`: the small side may step up by one and the big side down by one
    const small = (cond.op === '<' ? cond.left : cond.right) as Loose
    const big = (cond.op === '<' ? cond.right : cond.left) as Loose

    if (small.form === 'variable') {
      counted(loop, small, 1)
    }

    if (big.form === 'variable') {
      counted(loop, big, -1)
    }
  }

  // one side of the condition as a counter stepping by `direction`: its step is proven, and so is the same expression
  // read anywhere in the loop body BEFORE the statement that steps it, outside a closure, where the counter still holds
  // the value the condition tested
  const counted = (loop: Loose, side: Loose, direction: 1 | -1): void => {
    const counter = side.name as string

    if (closureWrites.has(counter) || (side.type as { kind?: string } | undefined)?.kind !== 'number') {
      return
    }

    // every write to the counter anywhere inside the loop, and whether it sits inside a nested loop or a closure
    const writes: { node: Loose; nested: boolean }[] = []
    const inner = new Set<object>()
    const find = (value: unknown, nested: boolean): void => {
      if (typeof value !== 'object' || value === null || inner.has(value)) {
        return
      }

      inner.add(value)

      if (Array.isArray(value)) {
        value.forEach(v => find(v, nested))

        return
      }

      const node = value as Loose
      const deeper = nested || node.form === 'while' || node.form === 'for-each' || node.form === 'closure'

      if (node.form === 'assign' && (node.target as Loose).form === 'variable' && (node.target as Loose).name === counter) {
        writes.push({ node, nested })
      }

      // a nested `let` of the same name is another variable: a write after it is not to the counter, so the loop is
      // left unproven rather than told apart
      if (node.form === 'let' && node.name === counter) {
        writes.push({ node, nested: true })
      }

      for (const [key, child] of Object.entries(node)) {
        if (key !== 'type' && key !== 'span') {
          find(child, deeper)
        }
      }
    }

    find(loop.body, false)

    if (writes.length !== 1 || writes[0]!.nested) {
      return
    }

    const write = writes[0]!.node
    const isCounter = (e: Loose): boolean => e.form === 'variable' && e.name === counter
    const isOne = (e: Loose): boolean => e.form === 'integer' && Number(e.value) === 1
    // `counter + 1` (either order) stepping up, `counter - 1` stepping down
    const isStep = (e: Loose): boolean =>
      e.form === 'binary' &&
      (direction === 1
        ? e.op === '+' && ((isCounter(e.left as Loose) && isOne(e.right as Loose)) || (isOne(e.left as Loose) && isCounter(e.right as Loose)))
        : e.op === '-' && isCounter(e.left as Loose) && isOne(e.right as Loose))

    if (write.op !== '=' || !isStep(write.value as Loose)) {
      return
    }

    proven.add(write.value as unknown as Expression)

    // the reads before the stepping statement, when that statement is one of the loop body's own
    const body = loop.body as unknown[]
    const at = Array.isArray(body) ? body.indexOf(write) : -1

    if (at < 0) {
      return
    }

    const before = new Set<object>()
    const collect = (value: unknown): void => {
      if (typeof value !== 'object' || value === null || before.has(value)) {
        return
      }

      before.add(value)

      if (Array.isArray(value)) {
        value.forEach(collect)

        return
      }

      const node = value as Loose

      if (node.form === 'closure') {
        return
      }

      if (isStep(node)) {
        proven.add(node as unknown as Expression)
      }

      for (const [key, child] of Object.entries(node)) {
        if (key !== 'type' && key !== 'span') {
          collect(child)
        }
      }
    }

    body.slice(0, at).forEach(collect)
  }

  visit(program)

  // `x - c`, a positive integer literal taken from a local proven NOT NEGATIVE, cannot leave the range: the result is
  // at least `-c`, and below `x`, which is a number already. A local is not negative when every value it is given is:
  // a literal at least 0, another such local, or a sum, product or `%` of such values (each of which was itself checked
  // when it was made, so it is a number). Solved optimistically per task, so a counter's own step `i = i + 1` keeps it,
  // and dropped by any write that is not. Parameters are never proven (a caller may pass anything), nor a name a
  // closure writes or something binds another way (a walk's item, a closure's parameter, an arm's field).
  // AWFY's Sieve reads `flags/{i - 1}` and clears `flags/{k - 1}`: each checked subtraction cost TypeScript 7%.
  for (const fn of program) {
    if (fn.form === 'function') {
      notNegative(fn as unknown as Loose, closureWrites, proven)
    }
  }

  return proven
}

function notNegative(fn: Loose, closureWrites: Set<string>, proven: WeakSet<Expression>): void {
  const writes = new Map<string, Loose[]>()
  const excluded = new Set<string>((fn.params as { name: string }[]).map(p => p.name))
  const subtractions: Loose[] = []
  const seen = new Set<object>()
  const isNumber = (e: Loose | undefined): boolean => (e?.type as { kind?: string } | undefined)?.kind === 'number'

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

    if (node.form === 'let') {
      writes.set(node.name as string, [...(writes.get(node.name as string) ?? []), node.init as Loose])
    }

    if (node.form === 'assign' && (node.target as Loose).form === 'variable') {
      const name = (node.target as Loose).name as string

      // a compound write is not read here: only `x = <value>`
      if (node.op !== '=') {
        excluded.add(name)
      }

      writes.set(name, [...(writes.get(name) ?? []), node.value as Loose])
    }

    if (node.form === 'for-each') {
      excluded.add(node.item as string)
    }

    if (node.form === 'closure') {
      for (const p of node.params as { name: string }[]) {
        excluded.add(p.name)
      }
    }

    if (node.form === 'match') {
      for (const c of node.cases as { binds?: string[] }[]) {
        for (const b of c.binds ?? []) {
          excluded.add(b)
        }
      }
    }

    if (
      node.form === 'binary' &&
      node.op === '-' &&
      (node.left as Loose).form === 'variable' &&
      (node.right as Loose).form === 'integer' &&
      Number((node.right as Loose).value) > 0 &&
      Number((node.right as Loose).value) <= 2 ** 52 &&
      isNumber(node.left as Loose)
    ) {
      subtractions.push(node)
    }

    for (const [key, child] of Object.entries(node)) {
      if (key !== 'type' && key !== 'span') {
        visit(child)
      }
    }
  }

  visit(fn.body)

  const holds = new Set([...writes.keys()].filter(name => !excluded.has(name) && !closureWrites.has(name)))
  const positive = (e: Loose): boolean => {
    switch (e.form) {
      case 'integer':
        return Number(e.value) >= 0
      case 'variable':
        return holds.has(e.name as string)
      case 'binary':
        return (
          ((e.op === '+' || e.op === '*') && positive(e.left as Loose) && positive(e.right as Loose)) ||
          (e.op === '%' && positive(e.left as Loose) && (e.right as Loose).form === 'integer' && Number((e.right as Loose).value) > 0)
        )
      default:
        return false
    }
  }

  for (let changed = true; changed; ) {
    changed = false

    for (const name of [...holds]) {
      if (!writes.get(name)!.every(positive)) {
        holds.delete(name)
        changed = true
      }
    }
  }

  for (const node of subtractions) {
    if (holds.has((node.left as Loose).name as string)) {
      proven.add(node as unknown as Expression)
    }
  }
}

// every variable name an assignment inside some closure writes
function namesWrittenInClosures(program: Program): Set<string> {
  const names = new Set<string>()
  // one visited set per context: a node shared between a closure and the code around it is seen in both
  const seenOutside = new Set<object>()
  const seenInside = new Set<object>()
  const visit = (value: unknown, inClosure: boolean): void => {
    const seen = inClosure ? seenInside : seenOutside

    if (typeof value !== 'object' || value === null || seen.has(value)) {
      return
    }

    seen.add(value)

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
