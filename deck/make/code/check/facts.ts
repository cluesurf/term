// Which tasks are pure, state free, length keeping and fresh-returning: the program-level answers of check/purity.tree
// (self-hosting, 2026-10-06), whose header says what each means.
//
// THE FACE (items term-self-host-001-0073 and 0368, decision 055 section 3, spec 4.8). The name walks and the sorting
// of what a caller handed them went with their one caller, check/elaborate.ts, which asks check/purity.tree itself
// since item 0070. The four per-program identity memos went too: a caller that reads several answers of one program
// asks for the one record check/program-facts.tree makes (`programFacts`), each answer computed once, and the proofs
// phase makes it in Term (compile/program-proofs.tree) and hands it to check/holds.ts. An answer asked alone is
// computed afresh. Before: tmp/retired/make/check/facts-face.ts (with the walks), facts-memo-face.ts (the memos).

import type { Program } from '@term/make/code/compile/node'
import {
  functionNames as functionNamesIn,
  purity as purityIn,
  returnsFreshFunctions as returnsFreshIn,
  stateFreeFunctions as stateFreeIn,
} from '@term/make/code/check/purity'
import { programFactsOf } from '@term/make/code/check/program-facts'
import type { ProgramFacts } from '@term/make/code/check/program-facts'

export type { ProgramFacts } from '@term/make/code/check/program-facts'

export type Purity = {
  pure: Set<string>
  impure: Set<string>
  writes: Map<string, Set<number>>
}

// every fact of the program, each computed once (check/program-facts.tree)
export function programFacts(program: Program): ProgramFacts {
  return programFactsOf(program)
}

export function pureFunctions(program: Program): Set<string> {
  return new Set(purityIn(program).pure)
}

export function purity(program: Program): Purity {
  const answer = purityIn(program)

  return {
    pure: new Set(answer.pure),
    impure: new Set(answer.impure),
    writes: new Map(
      [...answer.writes].map(([name, at]) => [name, new Set(at)]),
    ),
  }
}

export function stateFreeFunctions(program: Program): Set<string> {
  return new Set(
    stateFreeIn(
      program,
      purityIn(program).pure,
      returnsFreshIn(program),
    ),
  )
}

export function returnsFreshFunctions(program: Program): Set<string> {
  return new Set(returnsFreshIn(program))
}

export function lengthKeepingFunctions(program: Program): Set<string> {
  return new Set(programFacts(program).lengthKeeping)
}

export function functionNames(program: Program): Set<string> {
  return new Set(functionNamesIn(program))
}
