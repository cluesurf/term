// THE SECOND CHECKER'S INPUT: every claim the kernel checked as one term, written out as Lean 4 source, so the proof is
// re-checked by a kernel that shares no code with Term's (note/project/term/proof/lean-export/spec.md).
//
// THE FACE (items term-self-host-change-001-finish-self-host-0005 and 0006). The translation is Term,
// check/lean-exporting.tree, whose header says what it decided. This face keeps the front end, which runs the build's
// own TypeScript steps up to the kernel (parse, mill, resolve, the claim fill, the declared types, the surface check,
// the kernel's reading of the types, elaboration), and hands the port what they answered: the checked program, its
// claims, the elaboration data and the judge state elaboration left. The port runs inside judge.ts's `kernel`, as the
// original's `quote` did, so a kernel error leaves it as the original's class. Its other raises (a parse that failed
// in `joinSources`, a plant with no definition) leave as the original's `Error` with the same message. The shapes are
// the original's. Before: tmp/retired/make/check/lean-export.ts.

import { parse } from '@term/make/code/parser/tree'
import { expandTemplates } from '@term/make/code/compile/template'
import { mill } from '@term/make/code/compile/mill'
import { resolve } from '@term/make/code/check/resolve'
import { check } from '@term/make/code/check/infer'
import { fillClaims } from '@term/make/code/check/claim'
import { elaborateReport } from '@term/make/code/check/elaborate'
import { transparentAliases } from '@term/make/code/check/alias'
import * as elaborating from '@term/make/code/check/elaborating-data'
import type { Term } from '@term/make/code/check/judge'
import { judgeState, kernel } from '@term/make/code/check/judge'
import type { Program } from '@term/make/code/compile/node'
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

// a Term raise as the original's plain `Error`, its note the message; anything else as it came
function asError(error: unknown): unknown {
  const note = (error as { note?: unknown } | null)?.note

  return typeof note === 'string' ? new Error(note) : error
}

// ---- the front end, as the build runs it up to the kernel (compile/compile.ts, from the parse to `elaborateReport`)
// ----

function frontEnd(source: LeanSource): {
  program: Program
  claims: string[]
} {
  const parsed = parse({ file: source.file, text: source.text })

  if (!parsed.ok) {
    throw new Error(
      `parse failed: ${parsed.diagnostics.map(d => d.message).join('; ')}`,
    )
  }

  const built = mill(expandTemplates(parsed.tree), source.file)

  if (!built.ok) {
    throw new Error(
      `mill failed: ${built.diagnostics.map(d => d.message).join('; ')}`,
    )
  }

  resolve(built.program, source.file)

  const claims = built.program.flatMap(s =>
    s.form === 'function' && s.claim === true && !s.theorem
      ? [s.name]
      : [],
  )

  const program = fillClaims(
    built.program as never,
  ) as unknown as Program

  for (const statement of program) {
    if (statement.form === 'function') {
      statement.declared = {
        params: statement.params.map(p =>
          p.type ? { type: structuredClone(p.type) } : {},
        ),
        ...(statement.result
          ? { result: structuredClone(statement.result) }
          : {}),
      }
    }
  }

  check(program, source.file)

  return { program, claims: [...new Set(claims)] }
}

export function exportLean(source: LeanSource): LeanExport {
  const { program, claims } = frontEnd(source)

  // the kernel's reading of the program's types, the same one elaboration builds for itself (pure in the program)
  const data = elaborating.elaborationDataOf(
    structuredClone(program) as never,
    elaborating.newAliasState(transparentAliases(program)),
    [],
    () => false,
  )

  const report = elaborateReport(program, source.file)

  const out = kernel(() =>
    exporting.exportLean({
      file: source.file,
      program: program as never,
      claims,
      data,
      st: judgeState(),
      proven: report.proven,
      declined: report.declined,
    }),
  )

  return {
    lean: out.lean,
    claims,
    exported: out.exported,
    refused: out.refused,
    axioms: out.axioms,
    kernel: {
      proven: report.proven,
      declined: report.declined,
      diagnostics: report.diagnostics.map(d => d.message),
    },
    terms: out.terms as unknown as LeanExport['terms'],
    signature: data.signature as unknown as LeanExport['signature'],
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
