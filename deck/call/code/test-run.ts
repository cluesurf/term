// The Seed test runner. A test file is ordinary Seed with `test <phrase>` blocks, each lowering (via the
// preprocessor) to a zero-argument boolean task that ends in a `want`. This compiles the file, imports the module,
// runs each test task (awaiting async ones), and returns the per-test results. It is parameterized by the resolver
// and native-runtime reader so both the `term test` CLI (project resolver) and the dev harness (stdlib tree) reuse
// it. Pure logic, no process exit, no printing. See note/library/seed/test-dsl.md.

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { transformSync } from 'esbuild'
import { parse } from '@term/make/code/parser/tree'
import { mill } from '@term/make/code/compile/mill'
import { compile } from '@term/make/code/compile/compile'
import { nativePrelude } from '@term/make/code/compile/native'
import type { NativeEnv } from '@term/make/code/compile/native'
import { render } from '@term/make/code/parser/diagnostic'
import type { Diagnostic } from '@term/make/code/parser/diagnostic'
import { toCamel } from '@term/make/code/compile/typescript'
import type { Resolver } from '@term/make/code/compile/load'
import type { RoleOf } from '@term/call/code/role-of'
import { preprocessTests, readable, wantFailed, wantLine } from '@term/call/code/test-preprocess'

// one test: whether it held, how long it took in milliseconds, and the error it threw when it threw one
export type TestResult = { name: string; label: string; held: boolean; ms?: number; error?: string; line?: number }
export type TestRun = {
  ok: boolean
  results: TestResult[]
  failure?: string
  // the diagnostics behind a failure, whole, and the compiled text their spans point into (the test preprocessor
  // rewrote the file), so `term test` draws each as a Problem item with its code frame
  diagnostics?: Diagnostic[]
  text?: string
}

// the entry file's own top-level test tasks: a zero-argument task that returns a boolean. Imported helpers take
// arguments, so they are excluded. Order is source order.
function discoverTests(text: string, file: string): string[] {
  const parsed = parse({ file, text })

  if (!parsed.ok) {
    return []
  }

  const built = mill(parsed.tree, file)

  if (!built.ok) {
    return []
  }

  return built.program
    .filter(
      node =>
        node.form === 'function' &&
        node.params.length === 0 &&
        node.result?.kind === 'boolean',
    )
    .map(node => (node as { name: string }).name)
}

// a test file's diagnostics moved back onto the lines as written, and rendered against them: the rewritten text holds
// lines the reader never wrote (guides: commands/test, 2026-10-04)
function asWritten(
  found: Diagnostic[],
  input: { file: string; source: string },
): { diagnostics: Diagnostic[]; diag: string } {
  const { place } = readable(input.source)
  const lines = input.source.split('\n')
  const diagnostics = found.map(d => (d.file === input.file ? place(d).diagnostic : d))

  return { diagnostics, diag: diagnostics.map(d => render(d, lines, false)).join('\n') }
}

export async function runTestFile(input: {
  file: string
  source: string
  resolve: Resolver
  env: NativeEnv
  readRuntime: (path: string) => string | undefined
  // the project's role and lean readers (`term test` passes them, the dev harness has no role.tree). A test file
  // imports code units, and a unit under a `mark lean` rule has to be milled lean here exactly as `term make`
  // mills it, or every property head in it is an unknown name and the file "did not compile"
  roleOf?: RoleOf
  leanOf?: (file: string) => boolean
}): Promise<TestRun> {
  // expand `test <phrase>` blocks into top-level tasks; a file with none passes through unchanged
  // `heads`: each test task's 0-based line in the file as written, so a test that does not hold is placed (`at`)
  const { text, labels, heads } = preprocessTests(input.source)
  const names = discoverTests(text, input.file)
  const result = compile(
    // use the real file path as the entry so `@/...` local-package aliases resolve against this file's deck.tree
    { file: input.file, text },
    { resolve: input.resolve, roleOf: input.roleOf, leanOf: input.leanOf },
  )

  if (!result.ok) {
    const { diagnostics, diag } = asWritten(result.diagnostics, input)

    return {
      ok: false,
      results: [],
      failure: `${diag}\ndid not compile`,
      diagnostics,
      text: input.source,
    }
  }

  // a proof obligation that the compiler could not discharge is only a warning, but for `term test` an unproven
  // `hold` is a failure: a stated proposition with no accepted proof must not pass. (A false proof is already a hard
  // `invalid-proof` error above.) So an unchecked hold fails the file, the same as a failing test.
  const unproven = (result.warnings ?? []).filter(
    d => d.name === 'unchecked-hold',
  )

  if (unproven.length > 0) {
    const { diagnostics, diag } = asWritten(unproven, input)

    return {
      ok: false,
      results: [],
      failure: `${diag}\n${unproven.length} unproven hold${
        unproven.length === 1 ? '' : 's'
      }`,
      diagnostics,
      text: input.source,
    }
  }

  // a file with no runnable `test` tasks but a clean compile is a pass: any `hold` / `rule` proofs it carries were
  // checked during that compile (and an unproven or false one already failed above). So a proof-only file passes here.
  if (names.length === 0) {
    return { ok: true, results: [] }
  }

  const prelude = nativePrelude(
    result.program,
    input.env,
    input.readRuntime,
  )

  const js = transformSync(`${prelude}\n${result.typescript}`, {
    loader: 'ts',
    format: 'esm',
  }).code

  const dir = mkdtempSync(join(tmpdir(), 'seed-test-'))
  const out = join(dir, 'module.mjs')
  writeFileSync(out, js)

  const mod = (await import(pathToFileURL(out).href)) as Record<
    string,
    (() => Promise<boolean> | boolean) | undefined
  >

  const results: TestResult[] = []

  for (const name of names) {
    const label = labels.get(name) ?? name.replace(/-/g, ' ')
    const head = heads.get(name)
    const line = head === undefined ? undefined : head + 1
    const started = Date.now()

    // a test that throws is a test that failed, with what it threw, and the tests after it still run
    try {
      const held = Boolean(await mod[toCamel(name)]!())
      results.push({ name, label, held, ms: Date.now() - started, line })
    } catch (error) {
      // a failing `want` raises a marker naming its line, read back as the line itself, with the two values a
      // comparison held
      const why = wantFailed(error, input.source) ?? (error instanceof Error ? error.message : String(error))

      // the failing `want`'s own line when the marker names it, else the test's `test` line
      const wanted = wantLine(error)
      results.push({ name, label, held: false, ms: Date.now() - started, error: why, line: wanted !== undefined ? wanted + 1 : line })
    }
  }

  return { ok: results.every(r => r.held), results }
}
