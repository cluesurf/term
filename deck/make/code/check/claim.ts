// The claim check: a `rule` states a claim, a `task` of the same name proves it, and between the two the name is
// DECLARED and not DEFINED. This is the wall the law-and-proof gate stands on, and it is two rules:
//
//   1. a claim with no fill is refused (`open-claim`), unless the rule carries `note open`, which leaves it
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

export function checkClaims(
  program: Program,
  file: string,
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
          hint: `write \`task ${name}\` whose body proves it, or add \`note open\` to leave it open`,
        }),
      )
    }
  }

  return { diagnostics, claimed: [...claims.keys()], open }
}
