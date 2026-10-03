// The claim check: a `rule` states a claim, a `task` of the same name proves it, and between the two the name is
// DECLARED and not DEFINED. This is the wall the law-and-proof gate stands on, and it is two rules:
//
//   1. a claim with no fill is refused (`open-claim`), unless the rule carries `mark open`, which leaves it
//      deliberately open: counted and reported, never silently passed;
//   2. code that RUNS may not call a claim nobody has filled (`open-claim-used`). An open claim is a promise, and
//      a program cannot be built on one. This is the half that makes the first half mean something: without it a
//      claim could be marked open and then used as though it were proven.
//
// The count of open claims is returned rather than printed, so the CLI can put it in the build line and a gate
// can refuse on it. See note/term/project/law-proof-gate.md, and note/research/repo/bend/laws.md for the design
// this follows: an unfilled law is a dead claim, and live code cannot use it.
//
// Browser-safe, no host APIs.

import type {
  Diagnostic,
  Span,
} from '@term/make/code/parser/diagnostic'
import { diagnose } from '@term/make/code/parser/diagnostic'
import type {
  Program,
  Statement,
} from '@term/make/code/compile/node'

export type ClaimReport = {
  diagnostics: Diagnostic[]
  // every claim the book states, filled or not
  claimed: string[]
  // the claims still owing a proof, in declaration order. A non-empty list is what a gate refuses on.
  open: string[]
}

// Walk any node of the compile AST and hand every `{ form: 'variable', name }` to the visitor. Structural rather
// than a switch over the forty expression forms, so a new form cannot quietly escape the wall by being forgotten
// here. Spans are read off the node the name sits on.
function eachName(
  node: unknown,
  visit: (
    name: string,
    span: Span | undefined,
    binding: { kind: string } | undefined,
  ) => void,
  seen: Set<object> = new Set(),
): void {
  if (node === null || typeof node !== 'object') {
    return
  }

  if (seen.has(node as object)) {
    return
  }

  seen.add(node as object)

  if (Array.isArray(node)) {
    for (const item of node) {
      eachName(item, visit, seen)
    }

    return
  }

  const record = node as Record<string, unknown>

  if (record.form === 'variable' && typeof record.name === 'string') {
    visit(
      record.name,
      record.span as Span | undefined,
      record.binding as { kind: string } | undefined,
    )
  }

  for (const key in record) {
    // a `binding` back-pointer the checker attaches can lead back up the tree; `seen` already stops the cycle, and
    // skipping it keeps the walk to the syntax rather than the resolution graph
    if (key === 'binding' || key === 'type') {
      continue
    }

    eachName(record[key], visit, seen)
  }
}

// A FILL INHERITS ITS CLAIM'S SIGNATURE. The claim is where the type is written, so the proof states the name
// and the parameters and nothing else:
//
//   rule refl              the claim: the type, written once
//     head a
//     take x, like a
//     like equal a x x
//
//   task refl              the fill: the same name, bare parameters, no `head` and no `like`
//     take x
//     send back
//       make equal/refl
//
// Only what the fill LEFT BLANK is taken: a fill that states its own generics, result or parameter type keeps
// them, and the checker then holds the two to each other like any other pair of declarations. Runs before the
// type checker, so the body is checked against the claim rather than against nothing. Bend's `def f(x, y):`
// with bare names and no return type is the same rule.
export function fillClaims(program: Program): void {
  const claims = new Map<string, Statement & { form: 'function' }>()

  for (const statement of program) {
    if (
      statement.form === 'function' &&
      statement.claim &&
      !claims.has(statement.name)
    ) {
      claims.set(statement.name, statement)
    }
  }

  if (claims.size === 0) {
    return
  }

  for (const statement of program) {
    if (
      statement.form !== 'function' ||
      statement.claim ||
      statement.stub
    ) {
      continue
    }

    const claim = claims.get(statement.name)

    if (!claim) {
      continue
    }

    if (statement.generics.length === 0 && claim.generics.length > 0) {
      statement.generics = claim.generics
    }

    if (statement.result === undefined && claim.result !== undefined) {
      statement.result = claim.result
    }

    statement.params.forEach((param, at) => {
      const declared = claim.params[at]

      if (param.type === undefined && declared?.type !== undefined) {
        param.type = declared.type
      }
    })
  }
}

// What the rest of the checker learned about the program's tasks, which a fill is held to. Absent only in callers
// that check claims alone (tests of the open-claim rules), where the third rule is not asked.
export type ClaimEvidence = {
  // the tasks whose whole body the kernel checked as ONE TERM against the declared type (elaborate.ts
  // ElaborationReport.proven). Not `verified`, which also holds bodies checked statement by statement, where a body
  // with no return at all passes
  verified: Set<string>
  // the tasks shown to terminate (totality.ts terminatingFunctions)
  terminating: Set<string>
  // the pure tasks (facts.ts pureFunctions)
  pure: Set<string>
  // why the kernel declined a task, when it did (elaborate.ts ElaborationReport.declined)
  declined?: Map<string, string>
}

// WHY A DEFINITION CANNOT CARRY A PROOF, or undefined when it can. A fill is checked against its claim with every
// task it calls read at that task's SIGNATURE only, so a fill proves its claim only if everything it reaches proves
// its own signature in turn. Until 2026-10-02 only the fill itself was asked, and a fill that called a helper the
// kernel had declined proved anything the helper's signature said: a helper typed `equal a x x -> equal a x y`
// whose body the kernel never read made `x == y` hold for every x and y.
//
// A definition is GROUNDED when the kernel checked its whole body as one term (not statement by statement, where a
// body with no return passes), it terminates, it is pure, and every task its body names is grounded. A cycle is
// assumed grounded while it is being walked: each member is still checked by the kernel against its own signature,
// and whether the recursion ends is the termination check's question, asked of every member above.
//
// A separate-compilation stub has no body here. Its own unit stamped `grounded` on it (stampGrounded below) when
// the stub was taken, and an unstamped stub is not grounded: a verdict nobody recorded is not a verdict.
export type Ungrounded = {
  // the definition that failed, which may be the fill itself or anything it reaches
  name: string
  // why that definition proves nothing
  reason: string
  // the call path from the fill to `name`, the fill first
  path: string[]
}

type FunctionStatement = Statement & { form: 'function' }

export function groundingOf(
  program: Program,
  evidence: ClaimEvidence,
): (name: string) => Ungrounded | undefined {
  // every DEFINITION of a name: an ordinary task, a claim's fill, or a stub of either. A claim is not a definition,
  // it is the statement its fill is held to.
  const definitions = new Map<string, FunctionStatement[]>()

  for (const statement of program) {
    if (statement.form !== 'function' || statement.claim) {
      continue
    }

    const list = definitions.get(statement.name) ?? []
    list.push(statement)
    definitions.set(statement.name, list)
  }

  const memo = new Map<string, Ungrounded | null>()
  const walking = new Set<string>()

  const own = (statement: FunctionStatement): string | undefined => {
    const name = statement.name

    if (statement.stub) {
      return statement.grounded === true
        ? undefined
        : 'its unit recorded no kernel verdict for it'
    }

    if (!evidence.pure.has(name)) {
      return 'it calls something impure'
    }

    if (!evidence.terminating.has(name)) {
      return 'it is not shown to terminate'
    }

    if (!evidence.verified.has(name)) {
      const declined = evidence.declined?.get(name)

      return declined
        ? `the kernel declined it: ${declined}`
        : 'the kernel did not check it as one term'
    }

    return undefined
  }

  const visit = (name: string): Ungrounded | undefined => {
    const known = memo.get(name)

    if (known !== undefined) {
      return known ?? undefined
    }

    if (walking.has(name)) {
      return undefined
    }

    const statements = definitions.get(name)

    if (!statements) {
      // not a task of this program: a constructor, a type, or a primitive the kernel's base signature states
      return undefined
    }

    walking.add(name)

    let found: Ungrounded | undefined

    for (const statement of statements) {
      const reason = own(statement)

      if (reason) {
        found = { name, reason, path: [name] }
        break
      }

      const callees = new Set<string>()

      eachName(statement.body, (callee, _span, binding) => {
        if (binding?.kind === 'parameter' || binding?.kind === 'local') {
          return
        }

        if (definitions.has(callee)) {
          callees.add(callee)
        }
      })

      for (const callee of callees) {
        const below = visit(callee)

        if (below) {
          found = { ...below, path: [name, ...below.path] }
          break
        }
      }

      if (found) {
        break
      }
    }

    walking.delete(name)
    memo.set(name, found ?? null)

    return found
  }

  return visit
}

// Record on every task of the program whether it is grounded, so a stub taken from this unit carries the verdict
// to a dependent unit that sees only the signature (compile/stub.ts copies the statement). Runs once per compile,
// after the kernel and before the claim check.
export function stampGrounded(
  program: Program,
  evidence: ClaimEvidence,
): void {
  const grounding = groundingOf(program, evidence)

  for (const statement of program) {
    if (
      statement.form !== 'function' ||
      statement.claim ||
      statement.stub
    ) {
      continue
    }

    if (grounding(statement.name)) {
      delete statement.grounded
    } else {
      statement.grounded = true
    }
  }
}

export function checkClaims(
  program: Program,
  file: string,
  evidence?: ClaimEvidence,
): ClaimReport {
  const diagnostics: Diagnostic[] = []

  const claims = new Map<string, { open: boolean; span: Span }>()

  for (const statement of program) {
    if (statement.form === 'function' && statement.claim) {
      // a claim declared twice is a duplicate like any other name; the first declaration owns the obligation
      if (!claims.has(statement.name)) {
        claims.set(statement.name, {
          open: statement.open === true,
          span: statement.span,
        })
      }
    }
  }

  if (claims.size === 0) {
    return { diagnostics, claimed: [], open: [] }
  }

  // a fill is an ORDINARY function of the same name: it has a body and is not itself a claim. A stub (separate
  // compilation) does not fill anything, because a stub is a signature too.
  const filled = new Set<string>()

  for (const statement of program) {
    if (
      statement.form === 'function' &&
      !statement.claim &&
      !statement.stub &&
      claims.has(statement.name)
    ) {
      filled.add(statement.name)
    }
  }

  // rule 2: a call to an unfilled claim, from anywhere that runs. The claim's own declaration has an empty body,
  // so it cannot reach itself, and a fill is not a claim, so proving a claim by using it is not possible either.
  for (const statement of program) {
    if (statement.form !== 'function' || statement.claim) {
      continue
    }

    eachName(statement.body, (name, span, binding) => {
      if (!claims.has(name) || filled.has(name)) {
        return
      }

      // a LOCAL that happens to share the claim's spelling is not the claim. The checker has already resolved
      // every name by the time this runs, so a parameter or a `save` binding says so on the node itself, and
      // only an unresolved or function-resolved name can be the global the claim declares.
      if (binding?.kind === 'parameter' || binding?.kind === 'local') {
        return
      }

      diagnostics.push(
        diagnose('open-claim-used', {
          file,
          span: span ?? statement.span,
          message: `\`${name}\` is a claim with no proof, so it cannot be called`,
          hint: `write \`task ${name}\` whose body proves it`,
        }),
      )
    })
  }

  // rule 3: a fill is a proof only if the kernel checked it, it ends, and it is pure. A fill the kernel declined
  // proves nothing (its type may be gradual, or its body outside the fragment), a fill that may not end proves
  // anything, and a fill that touches the world is a different value on every run.
  if (evidence) {
    const grounding = groundingOf(program, evidence)

    for (const statement of program) {
      if (
        statement.form !== 'function' ||
        statement.claim ||
        statement.stub ||
        !claims.has(statement.name)
      ) {
        continue
      }

      const name = statement.name

      if (!evidence.pure.has(name)) {
        diagnostics.push(
          diagnose('impure-proof', {
            file,
            span: statement.span,
            message: `the proof of \`${name}\` calls something impure`,
          }),
        )
      } else if (!evidence.terminating.has(name)) {
        diagnostics.push(
          diagnose('looping-proof', {
            file,
            span: statement.span,
            message: `the proof of \`${name}\` is not shown to terminate, and a proof that never ends proves anything`,
          }),
        )
      } else if (!evidence.verified.has(name)) {
        const reason = evidence.declined?.get(name)

        diagnostics.push(
          diagnose('unverified-proof', {
            file,
            span: statement.span,
            message: reason
              ? `the proof of \`${name}\` was not verified by the kernel (${reason}), so it proves nothing`
              : `the proof of \`${name}\` was not verified by the kernel as one term, so it proves nothing`,
          }),
        )
      } else {
        // the fill itself passed, so anything wrong is in what it reaches: every task it calls was read at its
        // signature, and a signature proves nothing unless its body was checked too
        const below = grounding(name)

        if (below && below.name !== name) {
          diagnostics.push(
            diagnose('unverified-proof', {
              file,
              span: statement.span,
              message: `the proof of \`${name}\` rests on \`${below.name}\` (${below.path.join(' -> ')}), and ${below.reason}, so it proves nothing`,
              hint: `make the kernel check \`${below.name}\` as one term, or leave the claim unfilled with \`mark open\``,
            }),
          )
        }
      }
    }
  }

  const open: string[] = []

  for (const [name, claim] of claims) {
    if (filled.has(name)) {
      continue
    }

    open.push(name)

    // rule 1: an unfilled claim is refused, unless it says out loud that it is open
    if (!claim.open) {
      diagnostics.push(
        diagnose('open-claim', {
          file,
          span: claim.span,
          message: `\`${name}\` is stated but never proven`,
          hint: `write \`task ${name}\` whose body proves it, or add \`mark open\` to leave it open`,
        }),
      )
    }
  }

  return { diagnostics, claimed: [...claims.keys()], open }
}
