// Interface stubs for separate compilation. A dependency unit's CHECKED program is reduced to the surface a dependent
// can observe: function signatures (bodies dropped, marked `stub`), record types, masks, instances, native / bind
// declarations, views without their bodies, and top-level lets. Dependents type-check against these stubs instead of
// the dependency's bodies, which is what makes a body-only dependency edit invisible to them (the early-cutoff
// firewall). Stubs are built from the checked program, so the types the checker INFERRED are part of the surface.
//
// The work is Term, compile/stubbing.tree (item term-self-host-001-0105): the stubs, the facts each task carries, the
// names each definition gives and mentions, and the fingerprints. This face hands the port the analyses that are still
// TypeScript modules with state of their own (the raise sets, the termination check with its linear prover, the rules
// the provers proved in this unit), and converts a left-out `known` to the port's maybe.

import type { Program } from '@term/make/code/compile/node'
import { raiseSetsOf } from '@term/make/code/check/effects'
import { terminatingFunctions } from '@term/make/code/check/totality'
import { provenRules } from '@term/make/code/check/holds'
import * as port from '@term/make/code/compile/stubbing'

// what the whole-program analyses found about each task of a checked unit, with every body in hand. Read only by
// `stubProgram`
export type StubKnown = port.StubKnown

// one definition of a surface, as the name-level cutoff reads it (compile/names.tree)
export type NameDef = {
  gives: string[]
  reads: string[]
  print: string
}

const same = (text: string): string => text

export function stubKnown(program: Program): StubKnown {
  return port.stubKnownOf(
    program as never,
    // a task's pass-through parameters (`pass <i>`) and the members its set holds for them (`kink <i>`) ride in its
    // stored set, so a dependent unit puts a call's arguments in their place as the whole program does (decision 089
    // rule 4 of note/project/term/self-host/change/001-finish-self-host). check/effects reads them back off
    // `stubRaises`
    (whole, exceptions) => {
      const sets = raiseSetsOf(whole as never, exceptions)

      for (const [name, carried] of sets.through) {
        sets.raises.set(name, [...(sets.raises.get(name) ?? []), ...carried])
      }

      return sets
    },
    whole => [...terminatingFunctions(whole as never)],
    // the proof pass of this unit ran just before (compile/separate.ts calls this after compiling the unit), so its
    // record is this unit's
    new Map(provenRules()),
  )
}

// the fingerprint of a unit's surface, its stubs without where they were written. `portable` writes each deck's root as
// a token (compile/separate.ts `portableBy`)
export function surfaceHash(
  surface: Program,
  portable: (text: string) => string = same,
): string {
  return port.surfaceHash(surface as never, portable)
}

export function nameDefs(
  surface: Program,
  portable: (text: string) => string = same,
): NameDef[] {
  return port.nameDefs(surface as never, portable)
}

// every name a unit's own program writes
export function namesUsed(program: Program): string[] {
  return port.namesUsed(program as never)
}

export const NAMES_ALWAYS_USED: string[] = port.namesAlwaysUsed()

// the stub of one checked program: its public, body-less surface, in original order
export function stubProgram(
  program: Program,
  known?: StubKnown,
  underProof = false,
): Program {
  const maybe =
    known === undefined
      ? ({ form: 'none' } as const)
      : ({ form: 'some', value: known } as const)

  return port.stubProgram(program as never, maybe, underProof) as never
}
