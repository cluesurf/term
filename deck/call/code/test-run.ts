// The Seed test runner. A test file is ordinary Seed with `test <phrase>` blocks, each lowering (via the
// preprocessor) to a zero-argument boolean task that ends in a `want`. This compiles the file, imports the module,
// runs each test task (awaiting async ones), and returns the per-test results. It is parameterized by the resolver
// and native-runtime reader so both the `seed test` CLI (project resolver) and the dev harness (stdlib tree) reuse
// it. Pure logic, no process exit, no printing. See note/library/seed/test-dsl.md.

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { transformSync } from 'esbuild'
import { parse } from '@cluesurf/make/code/parser/tree'
import { mill } from '@cluesurf/make/code/compile/mill'
import { compile } from '@cluesurf/make/code/compile/compile'
import { nativePrelude } from '@cluesurf/make/code/compile/native'
import type { NativeEnv } from '@cluesurf/make/code/compile/native'
import { render } from '@cluesurf/make/code/parser/diagnostic'
import { toCamel } from '@cluesurf/make/code/compile/typescript'
import type { Resolver } from '@cluesurf/make/code/compile/load'
import { preprocessTests } from '@cluesurf/call/code/test-preprocess'

export type TestResult = { name: string; label: string; held: boolean }
export type TestRun = {
  ok: boolean
  results: TestResult[]
  failure?: string
}

// the entry file's own top-level test tasks: a zero-argument task that returns a boolean. Imported helpers take
// arguments, so they are excluded. Order is source order.
function discoverTests(text: string): string[] {
  const parsed = parse({ file: 'main.tree', text })

  if (!parsed.ok) {return []}

  const built = mill(parsed.tree, 'main.tree')

  if (!built.ok) {return []}

  return built.program
    .filter(
      node =>
        node.form === 'function' &&
        node.params.length === 0 &&
        node.result?.kind === 'boolean',
    )
    .map(node => (node as { name: string }).name)
}

export async function runTestFile(input: {
  file: string
  source: string
  resolve: Resolver
  env: NativeEnv
  readRuntime: (path: string) => string | undefined
}): Promise<TestRun> {
  // expand `test <phrase>` blocks into top-level tasks; a file with none passes through unchanged
  const { text, labels } = preprocessTests(input.source)
  const names = discoverTests(text)
  const result = compile(
    { file: 'main.tree', text },
    { resolve: input.resolve },
  )

  if (!result.ok) {
    const lines = text.split('\n')
    const diag = result.diagnostics
      .map(d => render(d, lines, false))
      .join('\n')

    return {
      ok: false,
      results: [],
      failure: `${diag}\ndid not compile`,
    }
  }

  // a proof obligation that the compiler could not discharge is only a warning, but for `seed test` an unproven
  // `hold` is a failure: a stated proposition with no accepted proof must not pass. (A false proof is already a hard
  // `invalid-proof` error above.) So an unchecked hold fails the file, the same as a failing test.
  const unproven = (result.warnings ?? []).filter(
    d => d.name === 'unchecked-hold',
  )

  if (unproven.length > 0) {
    const lines = text.split('\n')
    const diag = unproven.map(d => render(d, lines, false)).join('\n')

    return {
      ok: false,
      results: [],
      failure: `${diag}\n${unproven.length} unproven hold${
        unproven.length === 1 ? '' : 's'
      }`,
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
    const held = Boolean(await mod[toCamel(name)]!())
    results.push({ name, label, held })
  }

  return { ok: results.every(r => r.held), results }
}
