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
// No `main` is added to the source: the caller decides what the entry point does. `--build` adds the main and builds
// it, and `--run` runs it (call/code/native-build.ts). The entry's own tasks are the roots, so each is kept even when
// nothing calls it, and the native emitters mangle their names (`run-all` is `run_all` on Rust and `runAll` on Swift and
// Kotlin).
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
import { buildNative, buildThroughRust, runBuilt } from '@term/call/code/native-build'
import type { ThroughRust } from '@term/call/code/native-build'
import { tmpdir } from 'os'
import { emitHvm } from '@term/make/code/compile/hvm'
import type { FragmentGap } from '@term/make/code/compile/hvm'
import { emitWgsl } from '@term/make/code/compile/wgsl'
import { diagnose } from '@term/make/code/parser/diagnostic'

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

// THE FRAGMENT TARGETS: WGSL (a GPU shader) and HVM (the interaction-combinator runtime) lower a numeric, recursive
// part of the language, not every program. A construct outside it is REFUSED, naming the construct and where it is,
// before anything is written: until 2026-10-05 neither had a command, and their emitters wrote a `SEED-UNSUPPORTED`
// marker into the output in its place. Each emitter reports its own gaps (compile/hvm.ts, compile/wgsl.ts), so what the
// command refuses is exactly what the emitter could not lower
export const FRAGMENT_TARGETS = ['wgsl', 'hvm'] as const
export type FragmentTarget = (typeof FRAGMENT_TARGETS)[number]

const FRAGMENT: Record<FragmentTarget, { name: string; holds: string }> = {
  wgsl: { name: 'WGSL', holds: 'numbers, booleans, arithmetic, branches and loops over them, and calls' },
  hvm: { name: 'HVM', holds: 'numbers, booleans, arithmetic, branches and recursion, each task one returned value' },
}

export function emitFragment(input: { root: string; file: string; target: FragmentTarget }):
  | { ok: true; source: string }
  | { ok: false; errors: string[]; problems?: { diagnostic: Diagnostic; text?: string }[] } {
  const file = path.resolve(input.root, input.file)

  if (!existsSync(file)) {
    return { ok: false, errors: [`no such file: ${input.file}`] }
  }

  const text = readFileSync(file, 'utf8')
  const installRoot = findProjectRoot(path.dirname(fileURLToPath(import.meta.url)))
  const result = compile(
    { file, text },
    { resolve: projectResolver(input.root, 'node', installRoot), env: 'node', deckOf: projectDeckOf(), roleOf: projectRoleOf(input.root), leanOf: projectLeanOf(input.root) },
  )

  if (!result.ok) {
    return {
      ok: false,
      errors: result.diagnostics.map(diagnostic => renderDiagnostic(diagnostic, diagnostic.file === file ? text : undefined)),
      problems: result.diagnostics.map(diagnostic => ({ diagnostic, text: diagnostic.file === file ? text : undefined })),
    }
  }

  const gaps: FragmentGap[] = []
  const source = input.target === 'wgsl' ? emitWgsl(result.program, gaps) : emitHvm(result.program, gaps)

  if (gaps.length === 0) {
    return { ok: true, source }
  }

  const { name, holds } = FRAGMENT[input.target]
  // one refusal per construct and place
  const seen = new Set<string>()
  const refusals = gaps.flatMap(gap => {
    const key = `${gap.form}@${gap.span?.start.line}:${gap.span?.start.column}`

    if (seen.has(key)) {
      return []
    }

    seen.add(key)

    return [
      diagnose('not-implemented', {
        file: gap.span?.file ?? file,
        span: gap.span ?? { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } },
        message: `${gap.form} is outside what ${name} lowers: ${holds}`,
        hint: `keep the part that runs on ${name} to that fragment, or emit this program for node, rust, swift or kotlin`,
      }),
    ]
  })

  return {
    ok: false,
    errors: refusals.map(diagnostic => renderDiagnostic(diagnostic, diagnostic.file === file ? text : undefined)),
    problems: refusals.map(diagnostic => ({ diagnostic, text: diagnostic.file === file ? text : undefined })),
  }
}

export function callEmit(input: {
  root: string
  file?: string
  target: string
  out?: string
  units?: boolean
  // build it with its toolchain, and run it (call/code/native-build.ts)
  build?: boolean
  run?: boolean
  // the task the program starts at, when not `run`, `boot` or `main`
  main?: string
}): void {
  // the project folder is the subject (section 3); the program and the backend are what this run is about, as facts
  openRun({ verb: 'make', root: input.root, facts: ['--emit', input.target, ...(input.file ? [input.file] : [])] })

  // a fragment target: the program's source for WGSL or HVM, or a refusal naming each construct outside the fragment
  if ((FRAGMENT_TARGETS as readonly string[]).includes(input.target)) {
    const target = input.target as FragmentTarget

    if (!input.file || input.build || input.run || input.units) {
      report({ glyph: 'failed', kind: 'problem', subject: input.file ? `--${input.build ? 'build' : input.run ? 'run' : 'units'} is for node, rust, swift and kotlin: ${target} is emitted as source` : 'There is no file to emit' })
      process.exit(closeRun({ verdict: 'Nothing emitted', next: `term make --emit ${target} <file.tree> [--out <path>]`, failure: 'usage' }))
    }

    const started = Date.now()
    const emitted = emitFragment({ root: input.root, file: input.file, target })

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

    const source = emitted.source.endsWith('\n') ? emitted.source : `${emitted.source}\n`

    if (!input.out) {
      printData(source)
      report({ glyph: 'done', verb: 'emit', subject: target, duration: Date.now() - started, bytes: Buffer.byteLength(source), facts: ['stdout'] })
      closeRun({ verdict: `Emitted ${target}` })

      return
    }

    const out = path.resolve(input.root, input.out)
    mkdirSync(path.dirname(out), { recursive: true })
    writeFileSync(out, source)
    report({ glyph: 'done', verb: 'emit', subject: target, duration: Date.now() - started, bytes: Buffer.byteLength(source), fields: [location(showPath(out, input.root))] })
    closeRun({ verdict: `Emitted ${target}` })

    return
  }

  // LLVM IR and WebAssembly, through the program's Rust (call/code/native-build.ts `buildThroughRust`)
  if (input.target === 'llvm' || input.target === 'wasm') {
    const target: ThroughRust = input.target

    if (!input.file) {
      report({ glyph: 'failed', kind: 'problem', subject: 'There is no file to emit' })
      process.exit(closeRun({ verdict: 'Nothing emitted', next: `term make --emit ${target} <file.tree> [--run]`, failure: 'usage' }))
    }

    const started = Date.now()
    const emitted = emitProgram({ root: input.root, file: input.file, target: 'rust' })

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

    const name = path.basename(input.file, '.tree')
    // the IR alone goes to stdout, or `--out`; anything built goes in a folder
    const irOnly = target === 'llvm' && !input.build && !input.run
    const folder = irOnly ? path.join(tmpdir(), `term-llvm-${process.pid}`) : path.resolve(input.root, input.out ?? path.join('host', target))
    const built = buildThroughRust({ source: emitted.source, target, folder, name, build: !irOnly, ...(input.main ? { entry: input.main } : {}) })

    if (!built.ok) {
      report({ glyph: 'failed', kind: 'problem', verb: 'build', subject: built.reason.split('\n')[0]!, ...(built.reason.includes('\n') ? { quote: built.reason.split('\n').slice(1, 30) } : {}) })
      process.exit(closeRun({ verdict: `Not built for ${target}`, failure: 'failure' }))
    }

    if (irOnly) {
      const ir = readFileSync(built.artifact, 'utf8')

      if (input.out) {
        const out = path.resolve(input.root, input.out)
        mkdirSync(path.dirname(out), { recursive: true })
        writeFileSync(out, ir)
        report({ glyph: 'done', verb: 'emit', subject: 'llvm', duration: Date.now() - started, bytes: Buffer.byteLength(ir), fields: [location(showPath(out, input.root))] })
      } else {
        printData(ir)
        report({ glyph: 'done', verb: 'emit', subject: 'llvm', duration: Date.now() - started, bytes: Buffer.byteLength(ir), facts: ['stdout'] })
      }

      closeRun({ verdict: 'Emitted llvm' })

      return
    }

    report({ glyph: 'done', verb: 'build', subject: target, duration: Date.now() - started, fields: [location(showPath(built.artifact, input.root))] })

    if (!input.run) {
      closeRun({ verdict: `Built ${target}`, next: built.command.map(one => (one.includes(' ') ? JSON.stringify(one) : one)).join(' ') })

      return
    }

    closeRun({ verdict: `Built ${target}, running` })
    process.exit(runBuilt(built.command))
  }

  // wrong usage, exit 2 (section 18)
  if (!isEmitTarget(input.target)) {
    report({ glyph: 'failed', kind: 'problem', subject: `There is no target named ${input.target}`, fields: [field('targets', [...EMIT_TARGETS, ...FRAGMENT_TARGETS, 'llvm', 'wasm'].join(', '))] })
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

  // `--build` and `--run`: the program with its main, built by its toolchain into `--out` (a folder, host/<target>/
  // by default), and run (call/code/native-build.ts)
  if (input.build || input.run) {
    const folder = path.resolve(input.root, input.out ?? path.join('host', input.target))
    const name = path.basename(input.file, '.tree')
    const built = buildNative({ source, target: input.target, folder, name, ...(input.main ? { entry: input.main } : {}) })

    if (!built.ok) {
      report({ glyph: 'failed', kind: 'problem', verb: 'build', subject: built.reason.split('\n')[0]!, ...(built.reason.includes('\n') ? { quote: built.reason.split('\n').slice(1, 30) } : {}) })
      process.exit(closeRun({ verdict: `Not built for ${input.target}`, failure: 'failure' }))
    }

    report({ glyph: 'done', verb: 'build', subject: input.target, duration: Date.now() - started, fields: [location(showPath(built.artifact, input.root))] })

    if (!input.run) {
      closeRun({ verdict: `Built ${input.target}`, next: built.command.map(one => (one.includes(' ') ? JSON.stringify(one) : one)).join(' ') })

      return
    }

    closeRun({ verdict: `Built ${input.target}, running` })
    process.exit(runBuilt(built.command))
  }

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
