// The type checker: gradual, bidirectional inference over the compile AST. Type variables are inference holes,
// solved by unification. `unknown` is the gradual any: consistent with everything, never an error. Concrete
// mismatches are reported with spans. This is the formal type-checking pass that runs after resolution. See
// note/project/term/archive/computation/plans/04-typecheck.md and 11-elaboration.md.
//
// A face over the check/inferring-*.tree parts (item term-self-host-001-0259, decision 032 of
// note/project/term/self-host/change/001-finish-self-host): `check` hands the program to `infer-program`
// (check/inferring-main.tree), which writes the checked program in place and answers the diagnostics. The face holds
// only what decision 032 left to it: the one profile a process has (`setInferProfile`, handed down so the parts count
// their generalizes into it), and the count and time of each `check` (section 4.9). The checker's switches are the
// process's one instance in check/strict.ts.

import type { Diagnostic } from '@term/make/code/parser/diagnostic'
import type { Program } from '@term/make/code/compile/node'
import { inferProgram } from '@term/make/code/check/inferring-main'
import { checkerSwitches } from '@term/make/code/check/strict'

// WHAT INFERENCE SPENDS, for `pnpm term:generalize-bench` (decisions-2026-10.md, D10): every `check`, and every
// `generalize` inside one with the size of the environment it walked. Off unless a profile is handed in, so a build
// pays one comparison per generalized binding
export type InferProfile = {
  checks: number
  checkMs: number
  generalizes: number
  generalizeMs: number
  // the environment entries walked, summed over every generalize
  walked: number
}

let profile: InferProfile | undefined

export function setInferProfile(next: InferProfile | undefined): void {
  profile = next
}

const NONE = { form: 'none' } as const

export function check(
  program: Program,
  file: string,
  merged?: boolean,
  // when set, only this function's body is checked + zonked (signatures + module bindings are still built whole, which
  // is cheap). The incremental compiler uses this for per-definition type checking. Default (undefined) checks all
  only?: string,
): Diagnostic[] {
  if (!profile) {
    return checkProgram(program, file, merged, only)
  }

  const start = performance.now()

  try {
    return checkProgram(program, file, merged, only)
  } finally {
    profile.checks += 1
    profile.checkMs += performance.now() - start
  }
}

function checkProgram(program: Program, file: string, merged: boolean | undefined, only: string | undefined): Diagnostic[] {
  const state = inferProgram(
    program as never,
    file,
    merged === true,
    only === undefined ? NONE : { form: 'some', value: only },
    checkerSwitches,
    profile === undefined ? NONE : { form: 'some', value: profile },
  )

  // the checked program is written where the caller holds it: a statement the check replaced stands at its place
  if ((state.program as unknown) !== program) {
    program.splice(0, program.length, ...(state.program as unknown as Program))
  }

  return state.diagnostics as unknown as Diagnostic[]
}
