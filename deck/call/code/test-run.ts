// The Seed test runner. A test file is ordinary Seed with `test <phrase>` blocks, each lowering (via the
// preprocessor) to a zero-argument boolean task that ends in a `want`. This compiles the file, imports the module,
// runs each test task (awaiting async ones), and returns the per-test results. It is parameterized by the resolver
// and native-runtime reader so both the `term test` CLI (project resolver) and the dev harness (stdlib tree) reuse
// it. Pure logic, no process exit, no printing. See note/library/seed/test-dsl.md.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { hashText } from '@term/make/code/term/hash'
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve as resolvePath,
} from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build, version as esbuildVersion } from 'esbuild'
import type { Plugin } from 'esbuild'
import { findProjectRoot } from '@term/make/code/resolve'
import { nodeBanner } from '@term/call/code/boot-plan'
import { projectCacheDir } from '@term/call/code/cache-store'
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
import {
  preprocessTests,
  readable,
  wantFailed,
  wantLine,
} from '@term/call/code/test-preprocess'
import type { Snapshots } from '@term/call/code/test-preprocess'
// what the runner decides beside its build and its module: `--case`, a test's label, the unproven note, `--update`
import * as words from '@term/call/code/test-run-words'

// one test: whether it held, how long it took in milliseconds, and the error it threw when it threw one
export type TestResult = {
  name: string
  label: string
  held: boolean
  ms?: number
  error?: string
  line?: number
}
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
      exports: {
        name: string
        exported: string
        file: string
        type: boolean
      }[]
    }
  | { ok: false; diagnostics: Diagnostic[] }

// a test file built through units. `program` is only the native modules its closure docks, which is all the prelude
// reads of a program
function compileUnits(
  source: { file: string; text: string },
  input: {
    resolve: Resolver
    roleOf?: RoleOf
    leanOf?: (file: string) => boolean
  },
  units: TestUnits,
): UnitsBuilt {
  const names = (file: string): string =>
    unitSlug(units.root, file, units.deckOf)

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

// ---- a program's docks, resolved as the project's own build resolves them (decision 009) ----
//
// `term test` and `term boot` bundle a program INSIDE its project and resolve every bare dock by one rule: a specifier
// the project's nearest tsconfig.json `paths` maps is inlined from source, as make:line inlines a port that docks
// `@term/make/code/...`, and every other bare one stays external and resolves from the project at run time (its own
// node_modules, then the install's linked beside the module). A module in os.tmpdir() found neither.

// the nearest tsconfig.json at or above `root`, none when no folder up to the disk's root holds one
export function nearestTsconfig(root: string): string | undefined {
  let dir = root

  for (;;) {
    const file = join(dir, 'tsconfig.json')

    if (existsSync(file)) {
      return file
    }

    const up = dirname(dir)

    if (up === dir) {
      return undefined
    }

    dir = up
  }
}

// a tsconfig's text as JSON: its comments and trailing commas taken out, strings kept whole
function tsconfigJson(text: string): Record<string, unknown> {
  let out = ''
  let at = 0

  while (at < text.length) {
    const char = text[at]!

    if (char === '"') {
      let end = at + 1

      while (end < text.length && text[end] !== '"') {
        end += text[end] === '\\' ? 2 : 1
      }

      out += text.slice(at, end + 1)
      at = end + 1
    } else if (char === '/' && text[at + 1] === '/') {
      while (at < text.length && text[at] !== '\n') {at++}
    } else if (char === '/' && text[at + 1] === '*') {
      const end = text.indexOf('*/', at + 2)
      at = end < 0 ? text.length : end + 2
    } else {
      out += char
      at++
    }
  }

  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1')) as Record<
    string,
    unknown
  >
}

// the specifiers a tsconfig's `paths` maps, each key as written (`@term/make/*`), following a relative `extends` (eight
// deep at most) when a file has no `paths`. Unreadable: none
export function tsconfigPathKeys(tsconfig: string): string[] {
  let file = tsconfig

  try {
    for (let depth = 0; depth < 8; depth++) {
      const json = tsconfigJson(readFileSync(file, 'utf8'))
      const options = (json.compilerOptions ?? {}) as {
        paths?: Record<string, unknown>
      }

      if (options.paths !== undefined) {
        return Object.keys(options.paths)
      }

      const base =
        typeof json.extends === 'string' && json.extends.startsWith('.')
          ? json.extends
          : ''

      if (base === '') {
        return []
      }

      file = resolvePath(
        dirname(file),
        base.endsWith('.json') ? base : `${base}.json`,
      )

      if (!existsSync(file)) {
        return []
      }
    }
  } catch {
    // unreadable: none
  }

  return []
}

// whether a `paths` key maps a specifier: `x/*` every specifier under `x/`, a key with no star that one alone
export function pathKeyMaps(key: string, specifier: string): boolean {
  const star = key.indexOf('*')

  if (star < 0) {
    return specifier === key
  }

  return (
    specifier.length >= key.length - 1 &&
    specifier.startsWith(key.slice(0, star)) &&
    specifier.endsWith(key.slice(star + 1))
  )
}

// the esbuild options of a bundle that resolves its docks by the rule: the tsconfig, and a plugin that leaves a mapped
// specifier to esbuild (which applies the tsconfig's paths) and marks every other bare one external. esbuild's own
// `packages: 'external'` is not used: it decides by the specifier's look, before any tsconfig
export function dockOptions(root: string): {
  tsconfig?: string
  plugins: Plugin[]
} {
  const tsconfig = nearestTsconfig(root)
  const keys = tsconfig ? tsconfigPathKeys(tsconfig) : []
  const plugin: Plugin = {
    name: 'term-docks',
    setup(on) {
      // a bare specifier: neither relative nor absolute
      on.onResolve({ filter: /^[^./]/ }, args => {
        if (
          isAbsolute(args.path) ||
          keys.some(key => pathKeyMaps(key, args.path))
        ) {
          return undefined
        }

        return { path: args.path, external: true }
      })
    },
  }

  return { ...(tsconfig ? { tsconfig } : {}), plugins: [plugin] }
}

// the `require` a node bundle is given, anchored at the project and not the bundle (boot-plan.tree `node-banner`)
export function projectBanner(root: string): string {
  return nodeBanner(JSON.stringify(join(root, 'index.js')))
}

// one source a bundle inlined, and its content's hash
export type InlinedSource = { path: string; hash: string }

// the content hash of each file read this process, by path, size and time, so a warm run reads a file it inlined once
const HASHES = new Map<
  string,
  { size: number; time: number; hash: string }
>()

// a file's content hash, the empty text when it cannot be read
export function sourceHash(file: string): string {
  try {
    const stat = statSync(file)
    const known = HASHES.get(file)

    if (
      known?.size === stat.size &&
      known.time === stat.mtimeMs
    ) {
      return known.hash
    }

    const hash = createHash('sha256')
      .update(readFileSync(file))
      .digest('hex')

    HASHES.set(file, { size: stat.size, time: stat.mtimeMs, hash })

    return hash
  } catch {
    return ''
  }
}

// a program bundled by the rule: its text, and every source outside `own` (the folder its entry was written in) that it
// inlined, with each one's hash, which a kept bundle is checked against
export async function bundleDocks(input: {
  root: string
  entry: string
  own: string
  banner?: string
  platform?: 'node' | 'browser'
}): Promise<{ text: string; inlined: InlinedSource[] }> {
  const bundled = await build({
    entryPoints: [input.entry],
    absWorkingDir: input.root,
    bundle: true,
    format: 'esm',
    platform: input.platform ?? 'node',
    write: false,
    metafile: true,
    ...dockOptions(input.root),
    ...(input.banner ? { banner: { js: input.banner } } : {}),
  })

  const inlined: InlinedSource[] = []

  for (const key of Object.keys(bundled.metafile.inputs).sort()) {
    const file = resolvePath(input.root, key)
    const inside = relative(input.own, file)

    // the program's own modules are named by the key it is kept under; a namespaced input is no file
    if (
      (!inside.startsWith('..') && !isAbsolute(inside)) ||
      key.includes(':')
    ) {
      continue
    }

    const hash = sourceHash(file)

    if (hash !== '') {
      inlined.push({ path: file, hash })
    }
  }

  return { text: bundled.outputFiles[0]!.text, inlined }
}

// whether every source a kept bundle inlined still holds what it held
export function inlinedHold(inlined: InlinedSource[]): boolean {
  return inlined.every(one => sourceHash(one.path) === one.hash)
}

// the node_modules of the toolchain running this, linked beside a module so a dock the project does not carry resolves
// through the install (call/code/boot.ts does the same beside a boot bundle)
export function linkInstallModules(dir: string): void {
  const install = installModules()
  const beside = join(dir, 'node_modules')

  if (install === undefined || existsSync(beside)) {
    return
  }

  try {
    symlinkSync(install, beside, 'dir')
  } catch {
    // a link made meanwhile, or none allowed: the project's own node_modules still resolve
  }
}

// the nearest node_modules above this module: the install's, or the checkout's
function installModules(): string | undefined {
  let dir = dirname(fileURLToPath(import.meta.url))

  for (;;) {
    const at = join(dir, 'node_modules')

    if (existsSync(at)) {
      return at
    }

    const up = dirname(dir)

    if (up === dir) {
      return undefined
    }

    dir = up
  }
}

// a text written whole or not at all, so a reader never meets half a file
function writeWhole(file: string, text: string): void {
  const part = `${file}.${process.pid}.part`
  writeFileSync(part, text)
  renameSync(part, file)
}

// every module of a unit build written beside one another, and bundled from the test file's own into one module with
// the native prelude in front of it, which every module's shims are then in scope of. A bundle is decided by the test
// file's closure, its prelude and every source it inlined, so it is kept under the project's cache by all three and
// reused while none moves, which leaves a warm run nothing to do for a file but run it. Answers the file to import
async function bundleUnits(
  built: Extract<UnitsBuilt, { ok: true }>,
  prelude: string,
  root: string,
  units: TestUnits,
): Promise<string> {
  // the closure key names what was built and not what built it, so the compiler's own fingerprint goes in beside it
  const kept = units.bundles
  const key = hashText(
    `${BUNDLE_EPOCH}\nesbuild@${esbuildVersion}\n${units.cache.versionOf('unit')}\n${built.closureKey}\n${prelude}`,
  )

  const at = join(kept, `${key}.mjs`)
  const listed = join(kept, `${key}.inputs.json`)

  if (existsSync(at) && existsSync(listed)) {
    try {
      if (
        inlinedHold(
          JSON.parse(readFileSync(listed, 'utf8')) as InlinedSource[],
        )
      ) {
        linkInstallModules(kept)

        return at
      }
    } catch {
      // an unreadable list is a bundle built again
    }
  }

  // the prelude is a module of the bundle, and the entry re-exports the closure's public tasks (call/code/unit-bundle.ts)
  const dir = runFolder(root, key)
  const bundled = await bundleDocks({
    root,
    own: dir,
    banner: projectBanner(root),
    entry: writeUnitBundle({
      dir,
      entry: built.entry,
      modules: [...built.modules],
      slug: built.names,
      exports: built.exports,
      prelude,
    }),
  })

  try {
    mkdirSync(kept, { recursive: true })
    // the list first: a bundle on disk always has its list beside it
    writeWhole(listed, JSON.stringify(bundled.inlined))
    writeWhole(at, bundled.text)
    linkInstallModules(kept)

    return at
  } catch {
    // a bundle not kept is built again next run, never a failed test: it runs from its own folder
    const out = join(dir, 'module.mjs')
    writeFileSync(out, bundled.text)
    linkInstallModules(dir)

    return out
  }
}

// a folder of its own for one build of a test module, inside the project's cache (`<cache>/test/run/<key>-*`), so a
// bare dock in it resolves from the project, never from os.tmpdir()
function runFolder(root: string, key: string): string {
  const runs = join(projectCacheDir(root), 'test', 'run')
  mkdirSync(runs, { recursive: true })

  return mkdtempSync(join(runs, `${key.slice(0, 16)}-`))
}

// moved when the bundling itself changes, so a kept bundle from before is never run
// 3: the prelude is a module of the bundle, imported by each module that docks a shim, and the entry the closure's shim
// 4: built inside the project with its tsconfig's paths inlined (decision 009), kept beside the list of what it inlined
const BUNDLE_EPOCH = 'test-bundle-4'

// each import of a test module is a new instance of it, as each run's own folder made it before
let imports = 0

// a test file's tests in source order, each with its label and the line its `test` stands on as written, and the
// file as `term test` rewrites it (`term test --case`, `term test --env`)
export function testsOf(
  file: string,
  source: string,
  // as `preprocessTests` takes it: a native run writes every `want` as the plain marker, and `term test` hands in the
  // file's snapshots
  options: { plainWants?: boolean; snapshots?: Snapshots } = {},
): {
  text: string
  tests: { name: string; label: string; line?: number }[]
} {
  const { text, labels, heads } = preprocessTests(source, options)
  const tests = discoverTests(text, file).map(name => {
    const head = heads.get(name)

    return {
      name,
      label: labelOf(labels, name),
      ...(head === undefined ? {} : { line: head + 1 }),
    }
  })

  return { text, tests }
}

// whether a test is one `term test --case <phrase>` asked for: the phrase in its label or its task's name, in any case
export function caseMatches(
  phrase: string,
  test: { name: string; label: string },
): boolean {
  return words.caseMatches(phrase, test.name, test.label)
}

// a test's label: its phrase, or its task's name with every dash a space
function labelOf(labels: Map<string, string>, name: string): string {
  const label = labels.get(name)

  return words.testLabel(name, label !== undefined, label ?? '')
}

// a test file's diagnostics moved back onto the lines as written, and rendered against them: the rewritten text holds
// lines the reader never wrote (guides: commands/test, 2026-10-04)
function asWritten(
  found: Diagnostic[],
  input: { file: string; source: string; snapshots?: Snapshots },
): { diagnostics: Diagnostic[]; diag: string } {
  const { place } = readable(input.source, input.snapshots)
  const lines = input.source.split('\n')
  const diagnostics = found.map(d =>
    d.file === input.file ? place(d).diagnostic : d,
  )

  return {
    diagnostics,
    diag: diagnostics.map(d => render(d, lines, false)).join('\n'),
  }
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
  // kept for the next (note/project/term/incremental-best-in-class.md, step 10). A project's test files all reach the
  // standard library, and each merged compile checked it again
  units?: TestUnits
  // run only the tests this answers yes for (`term test --case`); every test when absent
  select?: (test: { name: string; label: string }) => boolean
  // the file's stored snapshots, and whether to record new ones (call/code/test-snapshot.ts)
  snapshots?: Snapshots
}): Promise<TestRun> {
  // expand `test <phrase>` blocks into top-level tasks; a file with none passes through unchanged
  // `heads`: each test task's 0-based line in the file as written, so a test that does not hold is placed (`at`)
  const { text, labels, heads } = preprocessTests(input.source, {
    snapshots: input.snapshots,
  })

  const names = discoverTests(text, input.file).filter(
    name =>
      !input.select ||
      input.select({ name, label: labelOf(labels, name) }),
  )

  const result = input.units
    ? compileUnits({ file: input.file, text }, input, input.units)
    : compile(
        // use the real file path as the entry so `@/...` local-package aliases resolve against this file's deck.tree
        { file: input.file, text },
        {
          resolve: input.resolve,
          roleOf: input.roleOf,
          leanOf: input.leanOf,
        },
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
      failure: words.unprovenNote(diag, unproven.length),
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

  // the module is built and imported inside the project (decision 009): the units' project, else the nearest folder
  // above the file holding a `link/` or a `deck.tree`, else the file's own folder
  const root =
    input.units?.root ??
    findProjectRoot(input.file) ??
    dirname(input.file)

  let out: string

  if ('closureKey' in result) {
    out = await bundleUnits(result, prelude, root, input.units!)
  } else {
    // the merged program goes through the same bundle step as the units, from an entry written in its own folder
    const dir = runFolder(root, 'merged')
    const entry = join(dir, 'module.ts')
    writeFileSync(entry, `${prelude}\n${result.typescript}`)
    out = join(dir, 'module.mjs')
    writeFileSync(
      out,
      (
        await bundleDocks({
          root,
          entry,
          own: dir,
          banner: projectBanner(root),
        })
      ).text,
    )
    linkInstallModules(dir)
  }

  imports++

  const mod = (await import(
    `${pathToFileURL(out).href}?run=${imports}`
  )) as Record<string, (() => Promise<boolean> | boolean) | undefined>

  const results: TestResult[] = []

  for (const name of names) {
    const label = labelOf(labels, name)
    const head = heads.get(name)
    const line = head === undefined ? undefined : head + 1
    const started = Date.now()

    // a test that throws is a test that failed, with what it threw, and the tests after it still run
    try {
      const held = Boolean(await mod[toCamel(name)]!())
      results.push({
        name,
        label,
        held,
        ms: Date.now() - started,
        line,
      })
    } catch (error) {
      // a failing `want` raises a marker naming its line, read back as the line itself, with the two values a
      // comparison held
      const why =
        wantFailed(error, input.source) ??
        (error instanceof Error ? error.message : String(error))

      // the failing `want`'s own line when the marker names it, else the test's `test` line
      const wanted = wantLine(error)
      results.push({
        name,
        label,
        held: false,
        ms: Date.now() - started,
        error: why,
        line: wanted !== undefined ? wanted + 1 : line,
      })
    }
  }

  // under `--update`, what each `want snapshot` saw, by its test's phrase, in the order taken
  const taken = new Map<string, string[]>()

  if (input.snapshots?.update) {
    const keys = (await mod.termSnapshotTakenKeys?.()) as unknown as
      | string[]
      | undefined

    const values =
      (await mod.termSnapshotTakenValues?.()) as unknown as
        | string[]
        | undefined

    for (const one of words.takenOf(keys ?? [], values ?? [])) {
      taken.set(one.phrase, one.values)
    }
  }

  return {
    ok: results.every(r => r.held),
    results,
    ...(taken.size > 0 ? { taken } : {}),
  }
}
