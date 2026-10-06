// `term make --env <rust|swift|kotlin|node>`: every program of the project, each one file for that backend under
// host/<env>/ (note/term/plan/backends-complete.md, step 2). Until 2026-10-05 a whole-project `term make` wrote
// TypeScript only, and a native build was one `--emit` per program, typed by hand.
//
// A PROGRAM is a file that defines an entry: a top-level `task run`, `boot` or `main` that takes nothing, the entries
// `--emit --build` starts at (compile/native-main.ts `ENTRY_NAMES`). Read with the compiler's own parse (deck/read.ts),
// never a pattern. A file with none is a library, and reaches the build through the programs that load it.
//
// Each program is emitted as `--emit` emits it (emit.ts `emitProgram`: its whole import closure, the runtime it docks,
// a check error refusing), to host/<env>/<its path under the project>.<rs|swift|kt|ts>. One that does not build is
// reported with its problems and the rest are written, and the run fails. `--build` also builds each, with its main,
// by its toolchain (native-build.ts), beside its source.

import path from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { findTreeFiles } from '@term/call/code/make'
import { emitProgram } from '@term/call/code/emit'
import type { EmitTarget } from '@term/call/code/emit'
import { buildNative } from '@term/call/code/native-build'
import { ENTRY_NAMES } from '@term/make/code/compile/native-main'
import { readTree } from '@term/deck/code/read'
import { closeRun, count, field, location, openRun, report, reportProblems, showPath } from '@term/call/code/output'

export const PROJECT_ENVS = ['rust', 'swift', 'kotlin', 'node'] as const
export type ProjectEnv = (typeof PROJECT_ENVS)[number]

const EXTENSION: Record<ProjectEnv, string> = { rust: 'rs', swift: 'swift', kotlin: 'kt', node: 'ts' }

// a file defines an entry when one of its top-level tasks is named for one and takes nothing
export function definesEntry(file: string): boolean {
  const read = readTree({ file, text: readFileSync(file, 'utf8') })

  if (!read.ok) {
    return false
  }

  return read.forms.some(form => form.head === 'task' && ENTRY_NAMES.includes(form.terms[0] ?? '') && form.terms.length === 1 && !form.forms.some(one => one.head === 'take'))
}

// the project's programs, in walk order, with the platform's native trees only
export function projectPrograms(root: string, env: ProjectEnv): string[] {
  return findTreeFiles(root, [], env).filter(definesEntry).sort()
}

export function callMakeNative(input: { root: string; env: string; build?: boolean }): void {
  openRun({ verb: 'make', root: input.root, facts: ['--env', input.env, ...(input.build ? ['--build'] : [])] })

  if (!(PROJECT_ENVS as readonly string[]).includes(input.env)) {
    report({ glyph: 'failed', kind: 'problem', subject: `There is no backend named ${input.env}`, fields: [field('backends', PROJECT_ENVS.join(', '))] })
    process.exit(closeRun({ verdict: 'Nothing built', failure: 'usage' }))
  }

  const env = input.env as ProjectEnv
  const programs = projectPrograms(input.root, env)

  if (programs.length === 0) {
    report({ glyph: 'failed', kind: 'problem', subject: `No file of the project defines \`${ENTRY_NAMES.join('`, `')}\` taking nothing, so there is no program to build` })
    process.exit(closeRun({ verdict: 'Nothing built', next: `term make --emit ${env} <file.tree> --main <task>`, failure: 'failure' }))
  }

  const host = path.join(input.root, 'host', env)
  let written = 0
  let failed = 0

  for (const file of programs) {
    const started = Date.now()
    const relative = path.relative(input.root, file)
    const emitted = emitProgram({ root: input.root, file, target: env as EmitTarget })

    if (!emitted.ok) {
      failed++

      if (emitted.problems) {
        reportProblems(emitted.problems, input.root)
      } else {
        for (const error of emitted.errors) {
          report({ glyph: 'failed', kind: 'problem', verb: 'check', subject: error.charAt(0).toUpperCase() + error.slice(1) })
        }
      }

      report({ glyph: 'failed', verb: 'emit', subject: relative, duration: Date.now() - started })
      continue
    }

    const stem = path.join(host, relative.replace(/\.tree$/, ''))
    const out = `${stem}.${EXTENSION[env]}`
    const source = emitted.source.endsWith('\n') ? emitted.source : `${emitted.source}\n`
    mkdirSync(path.dirname(out), { recursive: true })
    // unchanged source is left as it is, so a toolchain watching the folder sees only what changed
    if (!existsSync(out) || readFileSync(out, 'utf8') !== source) {
      writeFileSync(out, source)
    }
    written++

    if (!input.build) {
      report({ glyph: 'done', verb: 'emit', subject: relative, duration: Date.now() - started, bytes: Buffer.byteLength(source), fields: [location(showPath(out, input.root))] })
      continue
    }

    const built = buildNative({ source: emitted.source, target: env as EmitTarget, folder: path.join(path.dirname(stem), 'build'), name: path.basename(stem) })

    if (!built.ok) {
      failed++
      report({ glyph: 'failed', verb: 'build', subject: relative, duration: Date.now() - started, message: built.reason.split('\n').slice(0, 20) })
      continue
    }

    report({ glyph: 'done', verb: 'build', subject: relative, duration: Date.now() - started, fields: [location(showPath(built.artifact, input.root))] })
  }

  const counts = [count(written, 'written'), ...(failed > 0 ? [count(failed, 'failed')] : [])]
  const verdict = `${input.build ? 'Built' : 'Emitted'} ${programs.length - failed} of ${programs.length} ${programs.length === 1 ? 'program' : 'programs'} for ${env}`

  if (failed > 0) {
    process.exit(closeRun({ verdict, counts, failure: 'failure' }))
  }

  closeRun({ verdict, counts })
}
