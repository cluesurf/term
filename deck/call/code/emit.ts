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
// A check error REFUSES: every diagnostic is printed to stderr, nothing is written, and the exit code is 1. This is
// task/term/native-emit.ts made into a command, with that script's one difference removed: it printed check errors and
// emitted anyway, which is right for reading a half-checked module and wrong for anything that will be run.

import path from 'path'
import { fileURLToPath } from 'url'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { compile } from '@term/make/code/compile/compile'
import {
  EMIT_TARGETS,
  emitTarget,
  isEmitTarget,
} from '@term/make/code/compile/emit-target'
import type { EmitTarget } from '@term/make/code/compile/emit-target'
import { projectResolver } from '@term/call/code/make'
import { findProjectRoot } from '@term/call/code/boot'
import { projectDeckOf } from '@term/call/code/deck-of'
import { projectLeanOf, projectRoleOf } from '@term/call/code/role-of'
import { renderDiagnostic } from '@term/call/code/report'

// the per-target emit is make/code/compile/emit-target.ts, shared with the browser worker (make/code/browser/)
export { EMIT_TARGETS, isEmitTarget }
export type { EmitTarget }

const readRuntime = (file: string): string | undefined =>
  existsSync(file) ? readFileSync(file, 'utf8') : undefined

// the source text, or every diagnostic rendered. Exported for the test, which asks without a process exit
export function emitProgram(input: {
  root: string
  file: string
  target: EmitTarget
}): { ok: true; source: string } | { ok: false; errors: string[] } {
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
    }
  }

  // a data file or a stylesheet compiles to no program, and there is nothing a backend could run
  if (result.program.length === 0) {
    return {
      ok: false,
      errors: [`${input.file} is not a program (data or a stylesheet), so it has no ${env} source`],
    }
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
}): void {
  if (!isEmitTarget(input.target)) {
    process.stderr.write(
      `--emit takes one of ${EMIT_TARGETS.join(', ')}, not ${input.target}\n`,
    )
    process.exit(2)
  }

  if (!input.file) {
    process.stderr.write(
      'usage: term make --emit <node|rust|swift|kotlin> <file.tree> [--out <path>]\n',
    )
    process.exit(2)
  }

  const emitted = emitProgram({
    root: input.root,
    file: input.file,
    target: input.target,
  })

  if (!emitted.ok) {
    for (const error of emitted.errors) {
      process.stderr.write(`${error}\n`)
    }

    process.stderr.write(
      `refused: ${emitted.errors.length} error${emitted.errors.length === 1 ? '' : 's'}, nothing written\n`,
    )
    process.exit(1)
  }

  if (!input.out) {
    process.stdout.write(emitted.source.endsWith('\n') ? emitted.source : `${emitted.source}\n`)

    return
  }

  const out = path.resolve(input.root, input.out)

  mkdirSync(path.dirname(out), { recursive: true })
  writeFileSync(out, emitted.source.endsWith('\n') ? emitted.source : `${emitted.source}\n`)
}
