// The type checker: gradual, bidirectional inference over the compile AST. Type variables are inference holes,
// solved by unification. `unknown` is the gradual any: consistent with everything, never an error. Concrete
// mismatches are reported with spans. This is the formal type-checking pass that runs after resolution. See
// note/project/term/archive/computation/plans/04-typecheck.md and 11-elaboration.md.
//
// A face over the check/inferring-*.tree parts (item term-self-host-001-0259, decision 032 of
// note/project/term/self-host/change/001-finish-self-host): `check` hands the program to `infer-program`
// (check/inferring-main.tree), which writes the checked program in place and answers the diagnostics. The face holds
// only what decision 032 left to it: the one profile a process has (`setInferProfile`, handed down so the parts count
// their generalizes into it), and the count and time of each `check` (section 4.9). `check` hands the process's one
// instance of the checker's switches (check/strict.ts) and the `groups` of check/overload.ts's bound, read at each check
// (decision 069 section 3). `checkGiven` is the compile's: compile/program-types.tree hands it the run's own switches
// and the overload groups its gate bound, so a compile reads no state it was not given (ruling 1262 (a) of
// term/self-host/change/001-finish-self-host, item 1649).

import type { Diagnostic } from '@term/make/code/parser/diagnostic'
import type { Program } from '@term/make/code/compile/node'
import { inferProgram } from '@term/make/code/check/inferring-main'
import { checkerSwitches } from '@term/make/code/check/strict'
import type { CheckerSwitches } from '@term/make/code/check/checker-switches'
import { overloadBound } from '@term/make/code/check/overload'

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
  // the overload groups the last binding left, read now (decision 069 section 3)
  return profiled(() =>
    checkProgram(
      program,
      file,
      merged,
      only,
      checkerSwitches,
      overloadBound.groups,
    ),
  )
}

// THE COMPILE'S CHECK: the whole program, with the switches and the overload groups (the first candidate's mangled
// name to every candidate's) the run holds, never the process's
export function checkGiven(
  program: Program,
  file: string,
  merged: boolean,
  switches: CheckerSwitches,
  groups: Map<string, string[]>,
): Diagnostic[] {
  return profiled(() =>
    checkProgram(program, file, merged, undefined, switches, groups),
  )
}

// a check counted into the profile when one is handed in
function profiled(run: () => Diagnostic[]): Diagnostic[] {
  if (!profile) {
    return run()
  }

  const start = performance.now()

  try {
    return run()
  } finally {
    profile.checks += 1
    profile.checkMs += performance.now() - start
  }
}

function checkProgram(
  program: Program,
  file: string,
  merged: boolean | undefined,
  only: string | undefined,
  switches: CheckerSwitches,
  groups: Map<string, string[]>,
): Diagnostic[] {
  const state = inferProgram(
    program as never,
    file,
    merged === true,
    only === undefined ? NONE : { form: 'some', value: only },
    switches,
    profile === undefined ? NONE : { form: 'some', value: profile },
    groups,
  )

  // the checked program is written where the caller holds it: a statement the check replaced stands at its place
  if ((state.program as unknown) !== program) {
    program.splice(
      0,
      program.length,
      ...(state.program as unknown as Program),
    )
  }

  return state.diagnostics as unknown as Diagnostic[]
}
