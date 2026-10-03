// The compiler in a browser Web Worker: Term source in, the four targets of `term make --emit` out.
//
// THE SAME CALLS AS THE CLI, NOT A COPY OF THEM. A compile here is `compile()` with the stdlib resolver for the
// target's env (wrapped by `withNativeEnv`, as `projectResolver` wraps it), the role, lean and deck readers the CLI
// passes, and then `emitTarget` (compile/emit-target.ts), which is what call/code/emit.ts runs per target. The only
// difference is the disk: `fs` and `path` are aliased to ./disk.ts and ./path.ts, an in-memory snapshot of the
// standard library, so the CLI's own readers run unchanged over it.
//
// THE SNAPSHOT IS FETCHED ONLY WHEN A PROGRAM LOADS A PACKAGE. A program with no `load @...` line (the Fibonacci
// sample) compiles with nothing fetched at all, which is what `collectModules` would do anyway: it asks the resolver
// for nothing.
//
// The protocol, both directions, `form` the tag. One page sends `start` once and then `compile` per edit; the worker
// answers every `compile` with exactly one `made`, `refused` or `fault` carrying the same `id`. The page drops an
// answer whose id is older than the text on screen. Mirrored by `site/component/page/explore/protocol.ts` on
// term.surf, which is where to change it on both sides.
//
//   page -> worker   { form: 'start', snapshot: '<url of the stdlib snapshot json>' }
//                    { form: 'compile', id, text }
//   worker -> page   { form: 'made', id, ms, output: { node, rust, swift, kotlin }, issue: Issue[] }   warnings in issue
//                    { form: 'refused', id, ms, issue: Issue[] }
//                    { form: 'fault', id, message }                                                  the compiler threw

import { compile } from '@term/make/code/compile/compile'
import { importPathsOf, makeParseMemo } from '@term/make/code/compile/load'
import type { Resolver, Source } from '@term/make/code/compile/load'
import { withNativeEnv } from '@term/make/code/compile/native'
import { EMIT_TARGETS, emitTarget } from '@term/make/code/compile/emit-target'
import type { EmitTarget } from '@term/make/code/compile/emit-target'
import { stdlibResolver } from '@term/make/code/resolve'
import { renderKink } from '@term/make/code/parser/diagnostic'
import type { Diagnostic } from '@term/make/code/parser/diagnostic'
import { projectDeckOf } from '@term/call/code/deck-of'
import { projectLeanOf, projectRoleOf } from '@term/call/code/role-of'
import { existsSync, mountFiles, mountedCount, readFileSync } from '@term/make/code/browser/disk'

// for a test that drives the worker under Node, mounting the snapshot itself rather than fetching it
export { mountFiles }

// where the snapshot is mounted. The bundle pins `process.env.TERM_STDLIB` to the same path (build.mjs), which is
// how `stdlibBase()` finds it without walking up from a file URL a worker does not have
export const STDLIB_ROOT = '/term/base'

// the one file the page edits. The basename matches the file the build-time outputs were made from, so the first
// compile in the browser emits the same bytes the server rendered
export const ENTRY_FILE = '/explore/fibonacci.tree'

// the snapshot's shape, written by mesh/task/explore/make.ts: every file under the stdlib's package directory that a
// compile can read, by its path relative to that directory
type Snapshot = { file: Record<string, string> }

export type Issue = {
  severity: 'error' | 'warning' | 'info'
  name: string
  message: string
  // zero-based, as the compiler counts. Undefined when the diagnostic is about another file
  line?: number
  column?: number
  endLine?: number
  endColumn?: number
  // the CLI's kink frame for it, uncolored
  frame: string
}

type Request =
  | { form: 'start'; snapshot: string }
  | { form: 'compile'; id: number; text: string }

type Reply =
  | { form: 'made'; id: number; ms: number; output: Record<EmitTarget, string>; issue: Issue[] }
  | { form: 'refused'; id: number; ms: number; issue: Issue[] }
  | { form: 'fault'; id: number; message: string }

type Scope = {
  onmessage: ((event: { data: Request }) => void) | null
  postMessage: (message: Reply) => void
}

const scope = globalThis as unknown as Scope

let snapshotUrl: string | undefined

let mounting: Promise<void> | undefined

// one parse per module for the life of the worker, shared by the four targets and by every edit, so the stdlib
// closure of a program is parsed once rather than four times per keystroke. A memo is keyed by file and text, so
// it can only cost a re-parse, never a wrong tree (compile/load.ts)
const parsed = makeParseMemo()

function mount(): Promise<void> {
  if (mounting) {
    return mounting
  }

  if (!snapshotUrl) {
    return Promise.reject(new Error('no snapshot url: the page sends `start` first'))
  }

  mounting = fetch(snapshotUrl)
    .then(response => {
      if (!response.ok) {
        throw new Error(`the stdlib snapshot answered ${response.status}`)
      }

      return response.json() as Promise<Snapshot>
    })
    .then(snapshot => {
      mountFiles({ root: STDLIB_ROOT, file: snapshot.file })
    })

  // a failed fetch is tried again on the next edit rather than remembered
  mounting.catch(() => {
    mounting = undefined
  })

  return mounting
}

// does this program ask the resolver for anything? Read with the compiler's own import scan, so a `load` inside a
// text literal or a comment is not counted
function loadsAPackage(text: string): boolean {
  return importPathsOf({ file: ENTRY_FILE, text }, parsed).some(path => path.startsWith('@'))
}

// the stdlib resolver, memoized per path the way `projectResolver` memoizes, then the env's `{platform}` rung on top
function resolverFor(env: EmitTarget, stdlib: Resolver | undefined): Resolver {
  const memo = new Map<string, Source | undefined>()

  const base: Resolver = (importPath, fromFile, how) => {
    const key = `${importPath}\0${how?.base ?? ''}`

    if (memo.has(key)) {
      return memo.get(key)
    }

    const found = stdlib?.(importPath, fromFile, how)

    memo.set(key, found)

    return found
  }

  return withNativeEnv(env, base)
}

function readRuntime(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path) : undefined
}

function issueOf(diagnostic: Diagnostic, lines: string[]): Issue {
  const own = diagnostic.file === ENTRY_FILE

  return {
    severity: diagnostic.severity,
    name: diagnostic.name,
    message: diagnostic.message,
    ...(own
      ? {
          line: diagnostic.span.start.line,
          column: diagnostic.span.start.column,
          endLine: diagnostic.span.end.line,
          endColumn: diagnostic.span.end.column,
        }
      : {}),
    frame: renderKink(diagnostic, own ? lines : linesOf(diagnostic.file), false),
  }
}

function linesOf(file: string): string[] {
  return existsSync(file) ? readFileSync(file).split('\n') : []
}

// exported so a test can drive the worker under Node, with the snapshot mounted by `mountFiles` instead of fetched
export async function compileAll(id: number, text: string): Promise<Reply> {
  const started = performance.now()

  if (loadsAPackage(text) && mountedCount() === 0) {
    await mount()
  }

  // after the mount, so `stdlibBase()` sees the snapshot's directories. Undefined before it, which is the right
  // answer for a program that loads nothing
  const stdlib = mountedCount() > 0 ? stdlibResolver() : undefined
  const lines = text.split('\n')
  const output = {} as Record<EmitTarget, string>
  const warned = new Map<string, Issue>()
  const deckOf = projectDeckOf()
  const roleOf = projectRoleOf('/explore')
  const leanOf = projectLeanOf('/explore')

  for (const target of EMIT_TARGETS) {
    const result = compile(
      { file: ENTRY_FILE, text },
      {
        resolve: resolverFor(target, stdlib),
        parsed,
        env: target,
        deckOf,
        roleOf,
        leanOf,
      },
    )

    // the first target to refuse speaks for all four: a check error is the program's, not the backend's
    if (!result.ok) {
      return {
        form: 'refused',
        id,
        ms: performance.now() - started,
        issue: result.diagnostics.map(diagnostic => issueOf(diagnostic, lines)),
      }
    }

    if (result.program.length === 0) {
      return {
        form: 'refused',
        id,
        ms: performance.now() - started,
        issue: [
          {
            severity: 'error',
            name: 'not-a-program',
            message: 'this file is data or a stylesheet, so it has no target source',
            frame: 'kink <this file is data or a stylesheet, so it has no target source>',
          },
        ],
      }
    }

    output[target] = emitTarget({
      program: result.program,
      typescript: result.typescript,
      target,
      readRuntime,
    })

    // the same warning comes back from every target, so each is kept once
    for (const diagnostic of result.warnings) {
      const issue = issueOf(diagnostic, lines)

      warned.set(`${issue.name}\0${issue.line}\0${issue.column}\0${issue.message}`, issue)
    }
  }

  return {
    form: 'made',
    id,
    ms: performance.now() - started,
    output,
    issue: [...warned.values()],
  }
}

scope.onmessage = event => {
  const request = event.data

  if (request.form === 'start') {
    snapshotUrl = request.snapshot

    return
  }

  compileAll(request.id, request.text)
    .then(reply => scope.postMessage(reply))
    .catch((error: unknown) =>
      scope.postMessage({
        form: 'fault',
        id: request.id,
        message: error instanceof Error ? error.message : String(error),
      }),
    )
}
