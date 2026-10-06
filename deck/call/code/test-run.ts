// The Seed test runner. A test file is ordinary Seed with `test <phrase>` blocks, each lowering (via the
// preprocessor) to a zero-argument boolean task that ends in a `want`. This compiles the file, imports the module,
// runs each test task (awaiting async ones), and returns the per-test results. It is parameterized by the resolver
// and native-runtime reader so both the `term test` CLI (project resolver) and the dev harness (stdlib tree) reuse
// it. Pure logic, no process exit, no printing. See note/library/seed/test-dsl.md.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { hashText } from '@term/make/code/term/hash'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildSync, transformSync, version as esbuildVersion } from 'esbuild'
import { compileSeparate } from '@term/make/code/compile/separate'
import type { UnitMemo } from '@term/make/code/compile/separate'
import type { CompileCache } from '@term/make/code/compile/cache'
import type { ModuleEmit } from '@term/make/code/compile/modules'
import type { Program } from '@term/make/code/compile/node'
import type { DeckOf } from '@term/make/code/compile/roll'
import type { ParseMemo, WalkMemo } from '@term/make/code/compile/load'
import { unitSlug } from '@term/call/code/make'
import { writeUnitBundle } from '@term/call/code/unit-bundle'
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
import type { Snapshots } from '@term/call/code/test-preprocess'

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
  // under `term test --update`, what each test's `want snapshot`s saw, by its phrase
  taken?: Map<string, string[]>
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

// what one test file's unit build may keep for the next: the project's cache and the memos of a build session
// (call/code/make.ts `BuildSession`)
export type TestUnits = {
  root: string
  cache: CompileCache
  // where a test file's bundle is kept between runs
  bundles: string
  deckOf: DeckOf
  parsed: ParseMemo
  units: UnitMemo
  walked: WalkMemo
}

type UnitsBuilt =
  | {
      ok: true
      program: Program
      warnings: Diagnostic[]
      modules: Map<string, ModuleEmit>
      names: (file: string) => string
      entry: string
      closureKey: string
      exports: { name: string; exported: string; file: string; type: boolean }[]
    }
  | { ok: false; diagnostics: Diagnostic[] }

// a test file built through units. `program` is only the native modules its closure docks, which is all the prelude
// reads of a program
function compileUnits(
  source: { file: string; text: string },
  input: { resolve: Resolver; roleOf?: RoleOf; leanOf?: (file: string) => boolean },
  units: TestUnits,
): UnitsBuilt {
  const names = (file: string): string => unitSlug(units.root, file, units.deckOf)
  const result = compileSeparate(source, {
    resolve: input.resolve,
    cache: units.cache,
    modules: file => `./${names(file)}`,
    roleOf: input.roleOf,
    leanOf: input.leanOf,
    deckOf: units.deckOf,
    parsed: units.parsed,
    units: units.units,
    walked: units.walked,
  })

  if (!result.ok) {
    return result
  }

  return {
    ok: true,
    program: result.natives,
    warnings: result.warnings,
    modules: result.modules,
    names,
    entry: source.file,
    closureKey: result.closureKey,
    exports: result.exports,
  }
}

// every module of a unit build written beside one another, and bundled from the test file's own into one module with
// the native prelude in front of it, which every module's shims are then in scope of. A bundle is decided by the test
// file's closure and its prelude, so it is kept under the project's cache by both and reused while neither moves,
// which leaves a warm run nothing to do for a file but run it
function bundleUnits(built: Extract<UnitsBuilt, { ok: true }>, prelude: string, dir: string, units: TestUnits): string {
  // the closure key names what was built and not what built it, so the compiler's own fingerprint goes in beside it
  const kept = units.bundles
  const at = join(
    kept,
    `${hashText(`${BUNDLE_EPOCH}\nesbuild@${esbuildVersion}\n${units.cache.versionOf('unit')}\n${built.closureKey}\n${prelude}`)}.mjs`,
  )

  if (existsSync(at)) {
    return readFileSync(at, 'utf8')
  }

  // the prelude is a module of the bundle, and the entry re-exports the closure's public tasks (call/code/unit-bundle.ts)
  const bundled = buildSync({
    entryPoints: [
      writeUnitBundle({
        dir,
        entry: built.entry,
        modules: [...built.modules],
        slug: built.names,
        exports: built.exports,
        prelude,
      }),
    ],
    bundle: true,
    format: 'esm',
    platform: 'node',
    packages: 'external',
    write: false,
  })

  const text = bundled.outputFiles[0]!.text

  try {
    mkdirSync(kept, { recursive: true })
    writeFileSync(at, text)
  } catch {
    // a bundle not kept is built again next run, never a failed test
  }

  return text
}

// moved when the bundling itself changes, so a kept bundle from before is never run
// 3: the prelude is a module of the bundle, imported by each module that docks a shim, and the entry the closure's shim
const BUNDLE_EPOCH = 'test-bundle-3'

// a test file's tests in source order, each with its label and the line its `test` stands on as written, and the
// file as `term test` rewrites it (`term test --case`, `term test --env`)
export function testsOf(
  file: string,
  source: string,
  // as `preprocessTests` takes it: a native run writes every `want` as the plain marker, and `term test` hands in the
  // file's snapshots
  options: { plainWants?: boolean; snapshots?: Snapshots } = {},
): { text: string; tests: { name: string; label: string; line?: number }[] } {
  const { text, labels, heads } = preprocessTests(source, options)
  const tests = discoverTests(text, file).map(name => {
    const head = heads.get(name)

    return { name, label: labels.get(name) ?? name.replace(/-/g, ' '), ...(head === undefined ? {} : { line: head + 1 }) }
  })

  return { text, tests }
}

// whether a test is one `term test --case <phrase>` asked for: the phrase in its label or its task's name, in any case
export function caseMatches(phrase: string, test: { name: string; label: string }): boolean {
  const wanted = phrase.toLowerCase()

  return test.label.toLowerCase().includes(wanted) || test.name.toLowerCase().includes(wanted)
}

// a test file's diagnostics moved back onto the lines as written, and rendered against them: the rewritten text holds
// lines the reader never wrote (guides: commands/test, 2026-10-04)
function asWritten(
  found: Diagnostic[],
  input: { file: string; source: string; snapshots?: Snapshots },
): { diagnostics: Diagnostic[]; diag: string } {
  const { place } = readable(input.source, input.snapshots)
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
  // build through units, one at a time against the stubs of what each loads, with what one test file's build learns
  // kept for the next (note/term/plan/incremental-best-in-class.md, step 10). A project's test files all reach the
  // standard library, and each merged compile checked it again
  units?: TestUnits
  // run only the tests this answers yes for (`term test --case`); every test when absent
  select?: (test: { name: string; label: string }) => boolean
  // the file's stored snapshots, and whether to record new ones (call/code/test-snapshot.ts)
  snapshots?: Snapshots
}): Promise<TestRun> {
  // expand `test <phrase>` blocks into top-level tasks; a file with none passes through unchanged
  // `heads`: each test task's 0-based line in the file as written, so a test that does not hold is placed (`at`)
  const { text, labels, heads } = preprocessTests(input.source, { snapshots: input.snapshots })
  const names = discoverTests(text, input.file).filter(
    name => !input.select || input.select({ name, label: labels.get(name) ?? name.replace(/-/g, ' ') }),
  )
  const result = input.units
    ? compileUnits({ file: input.file, text }, input, input.units)
    : compile(
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

  const dir = mkdtempSync(join(tmpdir(), 'seed-test-'))
  const out = join(dir, 'module.mjs')

  if ('closureKey' in result) {
    writeFileSync(out, bundleUnits(result, prelude, dir, input.units!))
  } else {
    writeFileSync(out, transformSync(`${prelude}\n${result.typescript}`, { loader: 'ts', format: 'esm' }).code)
  }

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

  // under `--update`, what each `want snapshot` saw, by its test's phrase, in the order taken
  const taken = new Map<string, string[]>()

  if (input.snapshots?.update) {
    const keys = (await mod.termSnapshotTakenKeys?.()) as unknown as string[] | undefined
    const values = (await mod.termSnapshotTakenValues?.()) as unknown as string[] | undefined

    keys?.forEach((key, at) => taken.set(key, [...(taken.get(key) ?? []), values?.[at] ?? '']))
  }

  return { ok: results.every(r => r.held), results, ...(taken.size > 0 ? { taken } : {}) }
}
