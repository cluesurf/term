// `term make --emit <node|rust|swift|kotlin> <file.tree> [--out <path>]`: ONE program's complete source for one backend.
//
// The entry and its whole import closure go through the build's own front end (`compile`, with the project resolver
// for that env, so `{platform}` native modules resolve to the target's implementation), and the runtime shims the
// program docks are prepended (`nativePrelude`). What comes out is a single file a toolchain takes as it is:
//
//   node     TypeScript, ESM. Bundle it with esbuild (or run it with tsx). The entry's tasks are top-level functions
//   rust     one `.rs` file for `rustc`
//   swift    one `.swift` file for `swiftc`
//   kotlin   one `.kt` file for `kotlinc`, every import hoisted to the top
//
// No `main` is added: the caller decides what the entry point does. The entry's own tasks are the roots, so each is
// kept even when nothing calls it, and the native emitters mangle their names (`run-all` is `run_all` on Rust and
// `runAll` on Swift and Kotlin).
//
// The program is DATA, on stdout (or the `--out` file); the run around it is the human view on stderr, through the
// terminal output library (code/output.ts).
//
// A check error REFUSES: every diagnostic is drawn as a Problem item, nothing is written, and the exit code is 1. This is
// task/term/native-emit.ts made into a command, with that script's one difference removed: it printed check errors and
// emitted anyway, which is right for reading a half-checked module and wrong for anything that will be run.

import path from 'path'
import { fileURLToPath } from 'url'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { compile } from '@term/make/code/compile/compile'
import {
  EMIT_TARGETS,
  emitTarget,
  emitTargetUnits,
  isEmitTarget,
} from '@term/make/code/compile/emit-target'
import type { EmitTarget, UnitFiles } from '@term/make/code/compile/emit-target'
import { projectResolver } from '@term/call/code/make'
import { findProjectRoot } from '@term/call/code/boot'
import { projectDeckOf } from '@term/call/code/deck-of'
import { projectLeanOf, projectRoleOf } from '@term/call/code/role-of'
import { renderDiagnostic } from '@term/call/code/report'
import { checkBindTargets } from '@term/make/code/check/binds'
import type { Diagnostic } from '@term/make/code/parser/diagnostic'
import { closeRun, count, field, location, openRun, printData, report, reportProblems, showPath } from '@term/call/code/output'

// the per-target emit is make/code/compile/emit-target.ts, shared with the browser worker (call/code/browser/)
export { EMIT_TARGETS, isEmitTarget }
export type { EmitTarget }

const readRuntime = (file: string): string | undefined =>
  existsSync(file) ? readFileSync(file, 'utf8') : undefined

// the source text, or every diagnostic rendered. Exported for the test, which asks without a process exit. `problems`
// carries the same diagnostics whole, with the text their spans point into, for the command to draw as Problem items
export function emitProgram(input: {
  root: string
  file: string
  target: EmitTarget
  // a native target's program as one file per Term module beside a shared one (`emitTargetUnits`)
  units?: boolean
}):
  | { ok: true; source: string; files?: UnitFiles }
  | { ok: false; errors: string[]; problems?: { diagnostic: Diagnostic; text?: string }[] } {
  const file = path.resolve(input.root, input.file)

  if (!existsSync(file)) {
    return { ok: false, errors: [`no such file: ${input.file}`] }
  }

  const text = readFileSync(file, 'utf8')
  const installRoot = findProjectRoot(
    path.dirname(fileURLToPath(import.meta.url)),
  )
  const env = input.target
  const result = compile(
    { file, text },
    {
      resolve: projectResolver(input.root, env, installRoot),
      env,
      deckOf: projectDeckOf(),
      roleOf: projectRoleOf(input.root),
      leanOf: projectLeanOf(input.root),
    },
  )

  if (!result.ok) {
    return {
      ok: false,
      errors: result.diagnostics.map(diagnostic =>
        renderDiagnostic(diagnostic, diagnostic.file === file ? text : undefined),
      ),
      problems: result.diagnostics.map(diagnostic => ({ diagnostic, text: diagnostic.file === file ? text : undefined })),
    }
  }

  // a data file or a stylesheet compiles to no program, and there is nothing a backend could run
  if (result.program.length === 0) {
    return {
      ok: false,
      errors: [`${input.file} is not a program (data or a stylesheet), so it has no ${env} source`],
    }
  }

  // every bind the emitted program calls has a case for this backend. Without one the emitter wrote an undefined name,
  // `SEED_UNSUPPORTED_BIND_...`, and the toolchain was the first to fail (check/binds.ts)
  const unbound = checkBindTargets(result.program, file, env).errors

  if (unbound.length > 0) {
    return {
      ok: false,
      errors: unbound.map(diagnostic =>
        renderDiagnostic(diagnostic, diagnostic.file === file ? text : undefined),
      ),
      problems: unbound.map(diagnostic => ({ diagnostic, text: diagnostic.file === file ? text : undefined })),
    }
  }

  if (input.units && env !== 'node') {
    const files = emitTargetUnits({ program: result.program, target: env, readRuntime })

    return { ok: true, source: files.files.find(([name]) => name === files.main)?.[1] ?? '', files }
  }

  return {
    ok: true,
    source: emitTarget({
      program: result.program,
      typescript: result.typescript,
      target: env,
      readRuntime,
    }),
  }
}

export function callEmit(input: {
  root: string
  file?: string
  target: string
  out?: string
  units?: boolean
}): void {
  // the project folder is the subject (section 3); the program and the backend are what this run is about, as facts
  openRun({ verb: 'make', root: input.root, facts: ['--emit', input.target, ...(input.file ? [input.file] : [])] })

  // wrong usage, exit 2 (section 18)
  if (!isEmitTarget(input.target)) {
    report({ glyph: 'failed', kind: 'problem', subject: `There is no target named ${input.target}`, fields: [field('targets', EMIT_TARGETS.join(', '))] })
    process.exit(closeRun({ verdict: 'Nothing emitted', failure: 'usage' }))
  }

  if (!input.file) {
    report({ glyph: 'failed', kind: 'problem', subject: 'There is no file to emit' })
    process.exit(closeRun({ verdict: 'Nothing emitted', next: 'term make --emit <node|rust|swift|kotlin> <file.tree> [--out <path>]', failure: 'usage' }))
  }

  // one file per module goes in a folder, and needs a native target
  if (input.units && (input.target === 'node' || !input.out)) {
    report({ glyph: 'failed', kind: 'problem', subject: '--units writes a native program to a folder, and needs rust, swift or kotlin and --out <folder>' })
    process.exit(closeRun({ verdict: 'Nothing emitted', next: 'term make --emit rust <file.tree> --out <folder> --units', failure: 'usage' }))
  }

  const started = Date.now()
  const emitted = emitProgram({
    root: input.root,
    file: input.file,
    target: input.target,
    units: input.units,
  })

  // a check error refuses: every problem drawn, nothing written, exit 1
  if (!emitted.ok) {
    if (emitted.problems) {
      reportProblems(emitted.problems, input.root)
    } else {
      for (const error of emitted.errors) {
        report({ glyph: 'failed', kind: 'problem', verb: 'check', subject: error.charAt(0).toUpperCase() + error.slice(1) })
      }
    }

    process.exit(closeRun({ verdict: 'Refused, nothing written', counts: [count(emitted.errors.length, 'errors', 'error')] }))
  }

  // one file per module, each written only when its text changed, so a toolchain's incremental build redoes the module
  // that was edited and no other (compile/unit-split.ts). `units.txt` names the files of this program, for a build
  // that takes a list: a module no longer loaded leaves its file behind, which a glob would compile
  if (emitted.files) {
    const folder = path.resolve(input.root, input.out!)
    mkdirSync(folder, { recursive: true })
    let changed = 0

    for (const [name, text] of [...emitted.files.files, ['units.txt', `${emitted.files.files.map(([one]) => one).join('\n')}\n`] as [string, string]]) {
      const at = path.join(folder, name)

      if (!existsSync(at) || readFileSync(at, 'utf8') !== text) {
        writeFileSync(at, text)
        changed++
      }
    }

    report({
      glyph: 'done',
      verb: 'emit',
      subject: input.target,
      duration: Date.now() - started,
      counts: [count(emitted.files.files.length, 'files', 'file'), count(changed, 'written', 'written')],
      fields: [location(showPath(folder, input.root)), field('main', emitted.files.main)],
    })
    closeRun({ verdict: `Emitted ${input.target}` })

    return
  }

  const source = emitted.source.endsWith('\n') ? emitted.source : `${emitted.source}\n`

  // the program is the answer the user asked for: data, on stdout, as it is
  if (!input.out) {
    printData(source)
    report({ glyph: 'done', verb: 'emit', subject: input.target, duration: Date.now() - started, bytes: Buffer.byteLength(source), facts: ['stdout'] })
    closeRun({ verdict: `Emitted ${input.target}` })

    return
  }

  const out = path.resolve(input.root, input.out)

  mkdirSync(path.dirname(out), { recursive: true })
  writeFileSync(out, source)
  report({ glyph: 'done', verb: 'emit', subject: input.target, duration: Date.now() - started, bytes: Buffer.byteLength(source), fields: [location(showPath(out, input.root))] })
  closeRun({ verdict: `Emitted ${input.target}` })
}
