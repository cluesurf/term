// THE SECOND CHECKER, RUN: find Lean 4, run it on a file `lean-export.ts` wrote, and read its verdict per claim from the
// `#print axioms` lines the export ends with (note/project/term/proof/lean-export/spec.md). `term hold --lean`
// (call/code/hold-lean.ts) and test/assurance/lean.ts both read Lean through this, so there is one reading of its
// output. Nothing here decides a proof: Lean does, and this only reads what it said.

import { statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

// how to get Lean, in one line, for a run that found none
export const LEAN_INSTALL =
  'brew install elan-init, then elan default leanprover/lean4:stable'

// the namespace lean-export.ts writes every name into
const SPACE = 'TermExport'

// Lean's own spelling of a name: a plain identifier bare, anything else (a dash) in «»
export function leanName(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `«${name}»`
}

// a Lean name as Term wrote it: the namespace and the quotes taken off
function termName(lean: string): string {
  return lean
    .replace(new RegExp(`^${SPACE}\\.`), '')
    .replace(/[«»]/g, '')
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

// Lean: TERM_LEAN when it names a file, else the first `lean` on the PATH. Read off the environment given, never a
// shell, so a run with no PATH finds none rather than failing to start a `which`
export function findLean(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const named = env.TERM_LEAN

  if (named && isFile(named)) {
    return named
  }

  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (dir && isFile(path.join(dir, 'lean'))) {
      return path.join(dir, 'lean')
    }
  }

  return undefined
}

// `4.35.0`, read off `lean --version`, or empty when it says nothing that looks like one
export function leanVersion(lean: string): string {
  const run = spawnSync(lean, ['--version'], {
    encoding: 'utf8',
    timeout: 60_000,
  })

  return (
    /version (\d+\.\d+\.\d+)/.exec(
      `${run.stdout ?? ''}${run.stderr ?? ''}`,
    )?.[1] ?? ''
  )
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

// the definition each line of the source falls in, by the `def` / `inductive` / `axiom` heads the export writes
function definitionsByLine(source: string): (string | undefined)[] {
  let current: string | undefined

  const head = new RegExp(
    `^(?:def|theorem|inductive|axiom|structure) ${SPACE}\\.(\\S+)`,
  )

  return source.split('\n').map(line => {
    const found = head.exec(line)

    if (found) {
      current = termName(found[1]!)
    } else if (line === 'end' || line.startsWith('#print')) {
      current = undefined
    }

    return current
  })
}

// run Lean on `file`, the export `source` written there, and read a verdict for each of `claims`
export function runLean(input: {
  lean: string
  file: string
  source: string
  claims: string[]
  timeout?: number
}): LeanRun {
  const run = spawnSync(input.lean, [input.file], {
    encoding: 'utf8',
    timeout: (input.timeout ?? 1800) * 1000,
    maxBuffer: 256 * 1024 * 1024,
  })

  const stdout = run.stdout ?? ''
  const output = `${stdout}${run.stderr ?? ''}`
  const byLine = definitionsByLine(input.source)

  const errors: LeanError[] = []

  for (const found of output.matchAll(
    /^.*?:(\d+):(\d+): error: (.*)$/gm,
  )) {
    const line = Number(found[1])
    errors.push({
      line,
      column: Number(found[2]),
      text: `${line}:${found[2]}: error: ${found[3]}`,
      definition: byLine[line - 1],
    })
  }

  const warnings = [...output.matchAll(/^.*?:\d+:\d+: warning: /gm)]
    .length

  // every `#print axioms` answer: the claim, and the axioms it rests on
  const said = new Map<string, string[]>()

  for (const found of stdout.matchAll(
    new RegExp(
      `^'(${SPACE}\\.[^']+)' (?:does not depend on any axioms|depends on axioms: \\[([^\\]]*)\\])`,
      'gm',
    ),
  )) {
    said.set(
      termName(found[1]!),
      found[2]
        ? found[2]
            .split(',')
            .map(axiom => termName(axiom.trim()))
            .filter(Boolean)
        : [],
    )
  }

  const firstError = errors[0]
  const elsewhere = firstError
    ? `it rests on ${firstError.definition ?? 'a definition'}, which Lean refused: ${firstError.text}`
    : run.error
      ? `Lean did not run: ${run.error.message}`
      : 'Lean printed no axioms line for it'

  const claims = input.claims.map((name): LeanClaim => {
    const axioms = said.get(name)
    const own = errors.find(error => error.definition === name)

    if (axioms === undefined || axioms.includes('sorryAx')) {
      return {
        name,
        verdict: 'refused',
        axioms: (axioms ?? []).filter(axiom => axiom !== 'sorryAx'),
        error: own?.text ?? elsewhere,
      }
    }

    return {
      name,
      verdict: axioms.length > 0 ? 'axioms' : 'checked',
      axioms,
    }
  })

  return { status: run.status, output, errors, warnings, claims }
}
