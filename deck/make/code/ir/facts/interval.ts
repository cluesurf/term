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
//
// The analysis is Term, ir/facts/intervals.tree (self-hosting, 2026-10-06), and its header says how a node stands in for
// its identity there: by its place in node-reach's walk of its task's body. This face hands the sets in as the port's
// hashes, numbers each place by the object it holds (a compiled program shares nodes between places, and the original
// kept one fact per object), and makes the `WeakSet` of the nodes the port answers, which are the program's own objects.

import type { Expression, Program, Statement } from '@term/make/code/compile/node'
import { reachStatements } from '@term/make/code/compile/node-reach'
import { boundedArithmetic as boundedIn } from '@term/make/code/ir/facts/intervals'

type Lend = 'read' | 'write'

const flags = (names: Set<string>): Map<string, boolean> => new Map([...names].map(name => [name, true]))

// per task, in the program's order, each place of node-reach's walk of its body (the port's places) as the first place
// across every task that holds the same object
function identities(program: Program): number[][] {
  const first = new Map<object, number>()
  let next = 0
  const out: number[][] = []

  for (const statement of program as Statement[]) {
    if (statement.form !== 'function') {
      continue
    }

    const seen = reachStatements(statement.body, ['type', 'span'])
    const ids: number[] = []
    let e = 0
    let s = 0

    for (const isExpression of seen.order) {
      const node: object = isExpression ? seen.expressions[e++]! : seen.statements[s++]!
      let id = first.get(node)

      if (id === undefined) {
        id = next++
        first.set(node, id)
      }

      ids.push(id)
    }

    out.push(ids)
  }

  return out
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
  return new WeakSet<Expression>(boundedIn(program, flags(owned), lend, flags(native), identities(program)))
}
