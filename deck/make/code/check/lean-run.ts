// THE SECOND CHECKER, RUN: find Lean 4, run it on a file `lean-export.ts` wrote, and read its verdict per claim from the
// `#print axioms` lines the export ends with (note/project/term/proof/lean-export/spec.md). `term hold --lean`
// (call/code/hold-lean.ts) and test/assurance/lean.ts both read Lean through this. The work is Term,
// check/lean-running.tree (item term-self-host-change-001-finish-self-host-0007, decision 075), whose header says what
// changed: Lean runs through @term/base/process/run under a limit, so `runLean` and `leanVersion` are async. This face
// keeps the names, the object input and the record shapes its callers know.
import * as running from '@term/make/code/check/lean-running'

// how to get Lean, in one line, for a run that found none
export const LEAN_INSTALL = running.sayInstall()

// Lean's own spelling of a name: a plain identifier bare, anything else (a dash) in «»
export function leanName(name: string): string {
  return running.leanName(name)
}

// Lean: TERM_LEAN when it names a file, else the first `lean` on the PATH. Read off the environment given, never a
// shell, so a run with no PATH finds none rather than failing to start a `which`
export function findLean(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return (
    running.findLean(env.TERM_LEAN ?? '', env.PATH ?? '') || undefined
  )
}

// `4.35.0`, read off `lean --version`, or empty when it says nothing that looks like one or does not answer in a minute
export function leanVersion(lean: string): Promise<string> {
  return running.leanVersion(lean, 60_000)
}

// one error Lean printed: where, the line as Lean printed it with the file dropped, and the definition it fell in
export type LeanError = {
  line: number
  column: number
  text: string
  definition?: string
}

// one claim's verdict: Lean checked it with no axiom, checked it resting on axioms, or refused it (its definition, or
// one it reaches, failed, which Lean reports as resting on `sorryAx`)
export type LeanClaim = {
  name: string
  verdict: 'checked' | 'axioms' | 'refused'
  axioms: string[]
  error?: string
}

export type LeanRun = {
  // Lean's exit status, null when it was killed
  status: number | null
  // stdout and stderr, as printed
  output: string
  errors: LeanError[]
  warnings: number
  claims: LeanClaim[]
}

type Maybe<T> = { form: 'some'; value: T } | { form: 'none' }

const valueOf = <T>(maybe: Maybe<T>): T | undefined =>
  maybe.form === 'some' ? maybe.value : undefined

// run Lean on `file`, the export `source` written there, and read a verdict for each of `claims`. `timeout` is in
// seconds, 1800 when left out
export async function runLean(input: {
  lean: string
  file: string
  source: string
  claims: string[]
  timeout?: number
}): Promise<LeanRun> {
  const run = await running.runLean(
    input.lean,
    input.file,
    input.source,
    input.claims,
    (input.timeout ?? 1800) * 1000,
  )

  return {
    status: valueOf(run.status as Maybe<number>) ?? null,
    output: run.output,
    // the original wrote `definition` on every error, holding undefined outside a definition
    errors: run.errors.map(one => ({
      line: one.line,
      column: one.column,
      text: one.text,
      definition: valueOf(one.definition as Maybe<string>),
    })),
    warnings: run.warnings,
    // and `error` only on a refused claim
    claims: run.claims.map(one =>
      one.verdict === 'refused'
        ? {
            name: one.name,
            verdict: 'refused' as const,
            axioms: one.axioms,
            error: one.error,
          }
        : {
            name: one.name,
            verdict: one.verdict as 'checked' | 'axioms',
            axioms: one.axioms,
          },
    ),
  }
}
