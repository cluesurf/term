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

    for (const [key, inner] of Object.entries(node)) {
      if (key !== 'type' && key !== 'span') {
        visit(inner)
      }
    }
  }

  const check = (loop: Loose): void => {
    const cond = loop.cond as Loose | undefined

    if (cond?.form !== 'binary') {
      return
    }

    const left = cond.left as Loose
    const right = cond.right as Loose
    // `i < bound`, or `bound > i`
    const counter =
      cond.op === '<' && left.form === 'variable'
        ? (left.name as string)
        : cond.op === '>' && right.form === 'variable'
          ? (right.name as string)
          : undefined
    const counterNode = cond.op === '<' ? left : right

    if (!counter || closureWrites.has(counter) || (counterNode.type as { kind?: string } | undefined)?.kind !== 'number') {
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
    const step = write.value as Loose
    const isCounter = (e: Loose): boolean => e.form === 'variable' && e.name === counter
    const isOne = (e: Loose): boolean => e.form === 'integer' && Number(e.value) === 1

    if (write.op === '=' && step.form === 'binary' && step.op === '+') {
      const a = step.left as Loose
      const b = step.right as Loose

      if ((isCounter(a) && isOne(b)) || (isOne(a) && isCounter(b))) {
        proven.add(step as unknown as Expression)
      }
    }
  }

  visit(program)

  return proven
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
