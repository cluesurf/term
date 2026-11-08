// THE SECOND CHECKER'S INPUT: every claim the kernel checked as one term, written out as Lean 4 source, so the proof is
// re-checked by a kernel that shares no code with Term's (note/project/term/proof/lean-export/spec.md).
//
// THE FACE (items term-self-host-change-001-finish-self-host-0005, 0006 and term-self-host-001-0511). The work is
// Term, check/lean-exporting.tree, whose header says what it decided: the front end (`lean-front-of`: parse, mill,
// resolve, the claim fill, the declared types, the surface check, the kernel's reading of the types, elaboration) and
// the export after it. This face holds the names and shapes callers know, the one judge state, and the error classes.
// The export runs inside judge.ts's `kernel`, as the original's `quote` did, so a kernel error leaves it as the
// original's class. A parse or mill that failed in the front end, a parse that failed in `joinSources` and a plant with
// no definition leave as the original's `Error` with the same message. Before: tmp/retired/make/check/lean-export.ts.

import type { Term } from '@term/make/code/check/judge'
import { judgeState, kernel } from '@term/make/code/check/judge'
import * as exporting from '@term/make/code/check/lean-exporting'

export type LeanSource = { file: string; text: string }

// one exported definition: its Term name, whether it is a claim (a `rule` with no `show`), and the axioms it rests on
export type LeanEntry = {
  name: string
  claim: boolean
  axioms: string[]
}

export type LeanExport = {
  // the Lean 4 source, ready for `lean <file>`
  lean: string
  // every claim of the source, in order
  claims: string[]
  // what was written: claims and the definitions they reach
  exported: LeanEntry[]
  // a claim or definition left out, with the reason
  refused: { name: string; reason: string }[]
  // every constant written as an axiom
  axioms: string[]
  // what the kernel itself said about the source
  kernel: {
    proven: string[]
    declined: { name: string; reason: string }[]
    diagnostics: string[]
  }
  // the kernel's own terms, for a caller that re-checks them (the test does, with the judge)
  terms: Map<string, { type: Term; value: Term }>
  signature: { name: string; type: Term }[]
}

// the front end's raise of a failed parse or mill (its note `lean-front:` and the message), as the original's `Error`
const FRONT = 'lean-front:'

// a Term raise as the original's plain `Error`, its note the message; anything else as it came
function asError(error: unknown): unknown {
  const note = (error as { note?: unknown } | null)?.note

  return typeof note === 'string' ? new Error(note) : error
}

// the front end's own raise as the original's `Error`; any other raise of a step it runs as it came
function asFrontError(error: unknown): unknown {
  const note = (error as { note?: unknown } | null)?.note

  return typeof note === 'string' && note.startsWith(FRONT)
    ? new Error(note.slice(FRONT.length))
    : error
}

export function exportLean(source: LeanSource): LeanExport {
  let front: ReturnType<typeof exporting.leanFrontOf>

  try {
    front = exporting.leanFrontOf(source, judgeState())
  } catch (error) {
    throw asFrontError(error)
  }

  const out = kernel(() => exporting.exportLean(front))

  return {
    lean: out.lean,
    claims: front.claims,
    exported: out.exported,
    refused: out.refused,
    axioms: out.axioms,
    kernel: {
      proven: front.proven,
      declined: front.declined,
      diagnostics: front.diagnostics,
    },
    terms: out.terms as unknown as LeanExport['terms'],
    signature: front.data.signature as unknown as LeanExport['signature'],
  }
}

// a planted twin: the same export with one definition's body replaced by another term, written in the same names.
// Lean must refuse the file. The test plants a wrong proof this way
export function plantLean(
  lean: string,
  name: string,
  body: string,
): string {
  try {
    return exporting.plantLean(lean, name, body)
  } catch (error) {
    throw asError(error)
  }
}

// the stdlib's files, read as one source: each file's top-level `load` groups dropped (check/lean-exporting.tree
// `join-sources`). A prototype's stand-in for the build's module binding
export function joinSources(sources: LeanSource[]): LeanSource {
  try {
    return exporting.joinSources(sources)
  } catch (error) {
    throw asError(error)
  }
}
