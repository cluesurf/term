// Interface stubs for separate compilation. A dependency unit's CHECKED program is reduced to the surface a
// dependent can observe: function signatures (bodies dropped, marked `stub`), record types, masks, instances,
// native / bind declarations, zones, and top-level lets. Private functions and top-level proof obligations are
// dropped (they belong to the owning unit). Dependents type-check against these stubs instead of the dependency's
// bodies, which is what makes a body-only dependency edit invisible to them (the early-cutoff firewall).
//
// Stubs are built from the checked (type-annotated) program, not the raw milled one, so parameter and result types
// the checker INFERRED are part of the surface a dependent sees, exactly matching `moduleInterface`'s fingerprint.

import type {
  Program,
  Statement,
} from '@cluesurf/make/code/compile/node'

// the stub of one checked program: its public, body-less surface, in original order
export function stubProgram(program: Program): Program {
  const out: Program = []

  for (const statement of program) {
    switch (statement.form) {
      case 'function': {
        if (statement.private) {
          break
        }

        out.push({
          ...statement,
          // arity-overload mangling (`name__<arity>`, code/check/overload.ts) is undone: the DEPENDENT unit runs its
          // own disambiguation over these stubs plus its calls, which re-derives the identical mangled names, so the
          // emitted imports line up with the owning unit's exports
          name: statement.name.replace(/__\d+$/, ''),
          body: [],
          stub: true,
        })
        break
      }

      // type-level and declaration-level statements are the surface itself: dependents need the whole shape
      case 'record-type':
      case 'mask':
      case 'instance':
      case 'bind':
      case 'native':
      case 'zone':
        out.push(statement)
        break

      // a top-level let is observable (its name and type resolve in dependents)
      case 'let':
        out.push(statement)
        break

      // proof obligations, top-level expressions, and everything else belong to the owning unit
      default:
        break
    }
  }

  return out
}
