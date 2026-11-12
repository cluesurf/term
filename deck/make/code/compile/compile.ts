// The compile driver's face: source text to nice TypeScript, through parse, mill, resolve, check, and emit. Pure and
// browser-safe: returns the program (compile AST) and the emitted TypeScript. Running the result is a separate
// step (write the module and import it, hot-module-reload style).
// Pipeline: parse -> mill (mine/mint) -> resolve (fill name holes) -> check (types) -> emit.
// See note/project/term/archive/computation/plans/11-elaboration.md.
//
// THE DRIVER IS TERM, compile/program-driver.tree (item term-self-host-001-0269, decision 031 part I): the load, the
// cache key, the build and the five phases of `compileProgram` over one run. This face keeps what decision 031 section
// 6 leaves here: the exports and their TypeScript shapes, the lazy `typescript` getter, the closures compile/cache.ts
// takes (`cache.output` around the build, `cache.milledUnit` around each module's mill), each holding one job the port
// runs (`graph-job` and `mill-job`, item term-self-host-001-0950), and the positional
// `compileProgram` compile/separate.ts calls. It reads the options into the port's `compile-reading` and hands it the
// host values a phase takes as they are (`driver-given`)
//
// EVERY COMPILE BUT THE PER-MODULE MODE IS compile/program-entry.tree's `compile-text` since item term-self-host-001-1237
// (decision 142 rule 4): `compile` reads its options into a `compile-request`, hands what it holds as host values in
// the request's `hands` (the resolver, the parse and walk memos, the twins' mutant rewrite, the cache view's clean test,
// the census hook) and its process's instances in `state`, and turns the `compile-result` into a `CompileResult`. The
// per-module mode (the dev server's per-module URLs, its `Map` of modules) stays here until its callers port, and
// `milledModule` is the entry's `milled-module`, which compile/separate.ts mills through

import type { Diagnostic } from '@term/make/code/parser/diagnostic'
import type { Template } from '@term/make/code/compile/template'
import {
  entryWarnings as entryWarningsPort,
  graphTemplates as graphTemplatesPort,
} from '@term/make/code/compile/unit-mill'
import {
  checkMillSource as checkMillPort,
  isLookStylesheet as isLookPort,
  sideFile as sideFilePort,
} from '@term/make/code/compile/side-files'
import type {
  Maybe,
  MillChecked,
} from '@term/make/code/compile/side-files'
import {
  emitTypescript as emitTypescriptPort,
  entryFormAliases as entryFormAliasesPort,
} from '@term/make/code/compile/program-emit'
import type { PendingEmit } from '@term/make/code/compile/program-emit'
import {
  graphKey as graphKeyPort,
  loadGraph as loadGraphPort,
  rollOnlyKey as rollOnlyKeyPort,
  runGraphJob as runGraphJobPort,
  runProgram as runProgramPort,
} from '@term/make/code/compile/program-driver'
import type {
  CompileReading,
  DriverAnswer,
  DriverGiven,
  DriverMilled,
  GraphBuilt,
} from '@term/make/code/compile/program-driver'
import {
  compileText as compileTextPort,
  emitTypescript as entryTypescriptPort,
  milledModule as milledModulePort,
} from '@term/make/code/compile/program-entry'
import type { CompileResult as EntryResult } from '@term/make/code/compile/program-entry'
import { freshParseMemo } from '@term/make/code/compile/loading-parses'
import type { WakeGroup } from '@term/make/code/compile/program-warnings'
import type {
  RollKind,
  RollValue,
} from '@term/make/code/compile/rolling'
import {
  keepOverloadBound,
  overloadBound,
} from '@term/make/code/check/overload'
import type { Roll, RollEntry } from '@term/make/code/compile/roll'
import type { Tally } from '@term/make/code/check/holds'
import { checkerSwitches } from '@term/make/code/check/strict'
import type { CoverTarget } from '@term/make/code/ir/cover'
import type { ModuleEmit } from '@term/make/code/compile/modules'
import {
  makeParseMemo,
  portScan,
  scopeList,
} from '@term/make/code/compile/load'
import type {
  ImportScan,
  ImportScope,
  ParseMemo,
  Resolver,
  Source,
  WalkMemo,
} from '@term/make/code/compile/load'
import {
  cleanOf,
  TEXT_HASHES,
  writesOf,
  type CompileCache,
} from '@term/make/code/compile/cache'
import { refineState } from '@term/make/code/check/refine'
import {
  output as cachedOutput,
  scanned as cachedScan,
} from '@term/make/code/compile/cache-store'
import type {
  Program,
  Statement,
  Twin,
} from '@term/make/code/compile/node'
import { twinChoiceList } from '@term/make/code/ir/twin'
import type { TwinChoices } from '@term/make/code/ir/twin'

export type CompileResult =
  | {
      ok: true
      program: Program
      typescript: string
      // present only for a look stylesheet (.tree of `face` / `tone` rules): the emitted static CSS. The build writes
      // it to a sibling `.css` instead of `.ts`. See compile/look-css.ts.
      css?: string
      // beside `css`: the same sheet as the style table a host with no CSS engine applies, one line (look-table.ts,
      // styleTableText). The build writes it to a sibling `.style` (native-dom-0008)
      style?: string
      // and the dark scheme's table: `tone dark` over the base tokens and every `case dark` merged in, written to a
      // sibling `.dark.style` (native-dom-0048)
      styleDark?: string
      // present only in per-module mode (`options.modules`): one emitted ESM module per source file (file -> emit)
      modules?: Map<string, ModuleEmit>
      warnings: Diagnostic[]
      // the claims this book states that nobody has proven yet, in declaration order. Each one carried `note open`,
      // because an unfilled claim without it is an error and never reaches here. The build line reports the count
      // and a gate refuses on it: a book with an open claim compiles, but it is not proven. See check/claim.ts.
      openClaims?: string[]
      // TIER 0: what this file's own tasks were proven free of with nothing written (every list read inside its
      // list, every division by something other than zero), counted rather than failed. `failed` is what the gate
      // (`term hold`) holds to a baseline. note/project/term/proof/obligations.md
      obligations?: Tally
      // what the KERNEL did with this file's own tasks: proved the whole body as one term, checked it statement by
      // statement, or declined it (with the reason). A task nothing checked and a task the kernel proved looked the
      // same from outside until this was counted (proof-by-default-0005, 0012).
      kernel?: {
        proven: number
        commands: number
        declined: { name: string; reason: string }[]
        // each task checked statement by statement, with why the pure lowering did not make it one term
        // (proof-by-default-0009). Absent from a result cached before it was counted
        statementwise?: { name: string; reason: string }[]
      }
      // linear refutations the search found and the certificate checker refused during THIS compile. Carried on the
      // result so a cached compile still reports what its provers did (check/certificate.ts)
      uncertified?: number
      // present when `options.roll` was set: the roll of this entry's closure (compile/roll.ts)
      roll?: Roll
      // what wakes the hive, when the program holds `hive-wake`: every emitter's wake chain reads it, so a native
      // driver passes it as `{ wake: result.wake }` (term/hive decision 002). compile/program-warnings.tree's groups as
      // the warnings made them, each entry a roll value (decision 058)
      wake?: WakeGroup[]
      // the `twin` declarations of the closure, checked (check/twin.ts). Beside the program, never in it: nothing
      // here emits one yet, so every build runs the reference (note/project/term/optimize/archive/optimize-readme.md)
      twins?: Twin[]
      // present when `options.cover` was set: every key (`<path>:<line>`) a coverage probe was written for, in the
      // order written (ir/cover.tree). The program's probes are what report which of them ran
      cover?: string[]
    }
  | { ok: false; diagnostics: Diagnostic[] }

export type CompileOptions = {
  resolve?: Resolver
  cache?: CompileCache
  // a LIBRARY whose values host code also builds (a port TypeScript imports): no field-less case is tested by
  // identity with the module's one constant, since a caller's `{ t: "base" }` is not it (typescript.ts
  // `identityCases`, which broke check/cubical's own tests and pairing the day it landed, 2026-10-04)
  library?: boolean
  // a parse memo shared across a batch build, so the stdlib closure is parsed once for the whole run rather than
  // once per entry. The dependency walk runs before the output cache can be asked, so without this a warm build
  // still re-parses everything on its way to the hit. See makeParseMemo in compile/load.ts.
  parsed?: ParseMemo
  // per-module mode: when set, emit one ESM module per source file (file -> URL) instead of one merged blob. Used by
  // the dev server for lazy native-ESM serving + fine-grained HMR. See code/compile/modules.ts.
  modules?: (file: string) => string
  // skip the IR simplifier (forwarder-inlining, specialization, constant folding). The editor path (analyze) sets
  // this so the program keeps every call site for navigation / find-references rather than the optimized shape.
  optimize?: boolean
  // the target environment for route lowering: `browser` auto-runs `boot` (the client takeover) and `node` exports it
  // for the SSR server. Defaults to `node`. It also keys the output cache, so the node + browser compiles of one entry
  // never share a cached result.
  env?: string
  // tree-shaking: drop imported definitions the entry never uses before the check passes, so a tiny entry pulling
  // in a huge closure does not pay to check it all. ON by default for the optimized merged build (validated by
  // test/compile/shake-differential.ts across the stdlib corpus); off in per-module mode (the dev server serves
  // module boundaries lazily) and on the editor path (navigation wants every definition). Pass an explicit value
  // to override either default. See code/ir/prune.ts.
  treeShake?: boolean
  // application dead-code elimination: the declared entry points (e.g. `main`). When given, ONLY these are roots, so
  // even the entry module's OWN public functions are pruned when nothing reachable from an entry point calls them.
  // (Without it, every top-level function of the entry module is a root -- the right default for a library, whose
  // public surface is its API.) Setting this implies tree-shaking. See code/ir/prune.ts.
  entryPoints?: string[]
  // build the roll of the closure (every deck, exception, task, route and tell) and return it as `roll`
  roll?: boolean
  // with `roll`: answer the roll and the diagnostics only, cached on their own (the program and TypeScript left out)
  rollOnly?: boolean
  // with `roll` and `rollOnly`: the roll of an entry KNOWN TO BUILD, read off the checked program as soon as it is
  // typed and its async tasks are resolved, without the passes after that, which only refuse or warn (the kernel,
  // the provers, totality and the rest). Those are most of a compile, and `term make` already ran them on every
  // entry it asks this of. Held equal to the full roll on every file of every package (task/term/roll-fast.ts)
  rollFast?: boolean
  // each module's own part of the import walk, shared by a batch build's entries (compile/load.ts `WalkMemo`)
  walked?: WalkMemo
  // the deck a source file belongs to (name and root), from its nearest `deck.tree`. Names the `host` of every
  // raise and roll entry. The CLI supplies it; without it the deck is read off the path
  deckOf?: (file: string) => { name: string; root: string } | undefined
  // the role a project's `role.tree` gives a file (`host` for data, `code` for a program), overriding the content
  // rule below. Undefined or null means no role names the file, so its content decides. See deck/deck/code/role.ts
  roleOf?: (file: string) => string | null | undefined
  // whether a file's role rule carries `mark lean`: its bare heads are calls and its property heads are named
  // arguments. Off for every file no marked rule matches, which is almost all of them. See note/project/term/mill/lean.md
  // and deck/call/code/role-of.ts.
  leanOf?: (file: string) => boolean | undefined
  // which implementation of a task to build, for this target (ir/twin.ts): the reference, a twin by label, or a size
  // check between two. From `bake.json` (optimize-0014) or a test. Absent, every task is built as written
  twins?: TwinChoices
  // build every twin as a plain task beside its reference, and its conditions as a boolean task, with no call
  // redirected (ir/twin.ts `exposeTwins`): what admission compares (deck/test/code/twin-diff.ts)
  exposeTwins?: boolean
  // rewrite the closure's twins before they are built: how admission makes a deliberately WRONG twin (a mutant) and
  // checks its comparison catches it (deck/test/code/twin-diff.ts). Nothing else passes it
  adjustTwins?: (twins: Twin[]) => Twin[]
  // write a coverage probe before every executable statement of some files (ir/cover.tree), keyed by `.tree` line:
  // `true` measures the entry file alone, keys relative to its folder, and a target names the folder or file measured
  // and what a key's path is relative to. TypeScript writes the probe; the native backends write nothing until
  // coverage-0002. Part of the cache key
  cover?: true | CoverTarget
}

// AWAIT BY DEFAULT, outside every task: an un-awaited, un-ticked call to an async task there is refused, naming `tick`
// (check/effects.tree `check-calls-outside-tasks`). ON since 2026-10-03, after `pnpm term:await-migrate --commit`
// rewrote every such call in the repository to `tick`. A switch, not a constant, and the compile cache keys on it: the
// `await-outside` field of the one `checker-switches` record check/strict.ts holds (check/checker-switches.tree)
export function setAwaitOutsideTasks(on: boolean): void {
  checkerSwitches.awaitOutside = on
}

export function awaitsOutsideTasks(): boolean {
  return checkerSwitches.awaitOutside
}

// the build's resolver as compile/side-files.tree and the driver take it: none where it finds nothing
function resolverTask(
  resolve:
    | ((path: string, from: string) => Source | undefined)
    | undefined,
): (path: string, from: string) => Maybe<Source> {
  return (path, from) => {
    const found = resolve?.(path, from)

    return found ? { form: 'some', value: found } : { form: 'none' }
  }
}

// the build's deck lookup as the phases take it: none where the build knows no deck for a file, and for every file
// when it knows none at all
function deckTask(
  deckOf?: (file: string) => { name: string; root: string } | undefined,
): (file: string) => Maybe<{ name: string; root: string }> {
  return file => {
    const deck = deckOf?.(file)

    return deck
      ? { form: 'some', value: { name: deck.name, root: deck.root } }
      : { form: 'none' }
  }
}

// A MILL DEFINITION HELD TO WHAT IT OWES (compile/mill-check.tree), with its loads resolved through the build's
// resolver, in compile/side-files.tree (item term-self-host-001-0262). test/compile/mill-grammar.ts calls this
export function checkMillSource(
  source: Source,
  resolve?: (path: string, from: string) => Source | undefined,
): MillChecked {
  return checkMillPort(
    source,
    resolve !== undefined,
    resolverTask(resolve),
  )
}

// a .tree whose top-level statements are all `face` / `tone` / `base` rules compiles to a static stylesheet, not a
// program. Shared by the merged and separate build paths so both route look files to the CSS backend.
export function isLookStylesheet(source: {
  file: string
  text: string
}): boolean {
  return isLookPort(source)
}

const none = { form: 'none' } as const
const some = <T>(value: T) => ({ form: 'some', value }) as const

// a census run keeps the program this build loaded, its texts as read (task/term/census-keep.cjs, preloaded only under
// TERM_CENSUS_KEEP; decision 096 rule 8 of note/project/term/self-host/change/001-finish-self-host). A global, so
// this face stays browser-safe
function censusOf():
  | { sources?: (entry: string, sources: unknown) => void }
  | undefined {
  return (
    globalThis as {
      termCensusKeep?: {
        sources?: (entry: string, sources: unknown) => void
      }
    }
  ).termCensusKeep
}

// the parse memo a request's state carries, which the entry never reads while `hands` gives the caller's own
const UNREAD_PARSES = freshParseMemo(1)

export function compile(
  source: { file: string; text: string },
  options?: CompileOptions,
): CompileResult {
  if (options?.modules) {
    return compileModules(source, options)
  }

  return resultOf(compileTextPort(requestOf(source, options) as never))
}

// each answer's result, made once: an output-level hit hands back the answer it kept, so it is the same result object
// a caller got before, as compile.ts's cache handed back the result it kept (test/compile/cache.ts)
const RESULTS = new WeakMap<object, CompileResult>()

// WHAT `compile` ASKS THE ENTRY, from its options: each option as the request spells it, the caller's host values in
// `hands`, and the process's own instances in `state` (check/refine.ts's prover, this face's text hashes,
// check/overload.ts's bound and check/strict.ts's switches), which the phases still docked read (decision 142 rule 2)
function requestOf(
  source: { file: string; text: string },
  options?: CompileOptions,
): unknown {
  const resolve = options?.resolve
  const cache = options?.cache
  const cover = options?.cover
  const census = censusOf()

  return {
    file: source.file,
    source: some(source.text),
    resolver: none,
    deckOf: deckTask(options?.deckOf),
    roleOf: (file: string) => options?.roleOf?.(file) ?? '',
    leanOf: (file: string) => options?.leanOf?.(file) ?? false,
    library: options?.library === true,
    optimize: options?.optimize !== false,
    env: options?.env ?? '',
    treeShake:
      options?.treeShake === undefined ? none : some(options.treeShake),
    entryPoints: options?.entryPoints ?? [],
    roll: options?.roll === true,
    rollOnly: options?.rollOnly === true,
    rollFast: options?.rollFast === true,
    twins: twinChoiceList(options?.twins ?? {}),
    exposeTwins: options?.exposeTwins === true,
    cover:
      cover === undefined
        ? none
        : cover === true
          ? some({ kind: 'cover-entry-file' })
          : some({ kind: 'cover-target-of', target: cover }),
    budget: '',
    state: some({
      driver: { refine: refineState, hashes: TEXT_HASHES },
      bound: overloadBound,
      switches: checkerSwitches,
      parsed: UNREAD_PARSES,
    }),
    cache: cache ? some(cache.state) : none,
    hands: some({
      hasResolve: resolve !== undefined,
      resolve: (
        path: string,
        from: string,
        how: Maybe<{ base?: string }>,
      ) => {
        const found = resolve?.(
          path,
          from,
          how.form === 'some' ? how.value : undefined,
        )

        return found ? some(found) : none
      },
      parse: options?.parsed ?? makeParseMemo(),
      // a fresh memo per walk when the caller keeps none (compile/load.ts `collectModules`)
      walked: options?.walked ?? new Map(),
      keepsWalked: options?.walked !== undefined,
      adjusted: options?.adjustTwins !== undefined,
      adjust: options?.adjustTwins ?? ((twins: Twin[]) => twins),
      clean: cache ? cleanOf(cache) : () => true,
      onLoad: (file: string, graph: unknown) => {
        census?.sources?.(
          file,
          (graph as { sources?: unknown } | undefined)?.sources,
        )

        return true
      },
    }),
  }
}

// THE ENTRY'S ANSWER AS `compile` ANSWERED: a refusal, a file that is not a program, the roll alone, or a built
// program with each key where compile.ts wrote it and an optimized build's TypeScript written when it is first read
function resultOf(answer: EntryResult): CompileResult {
  const known = RESULTS.get(answer as object)

  if (known) {
    return known
  }

  const made = shapedResult(answer)

  RESULTS.set(answer as object, made)

  return made
}

function shapedResult(answer: EntryResult): CompileResult {
  const held = answer as unknown as {
    ok: boolean
    kind: string
    diagnostics: Diagnostic[]
    program: Program
    warnings: Diagnostic[]
    css: Maybe<string>
    style: Maybe<string>
    styleDark: Maybe<string>
    openClaims: string[]
    obligations?: Tally
    kernel: Maybe<NonNullable<Extract<CompileResult, { ok: true }>['kernel']>>
    uncertified: Maybe<number>
    roll: Maybe<RollKind[]>
    fastRoll: Maybe<Roll>
    wake?: WakeGroup[]
    twins: Maybe<Twin[]>
    cover: Maybe<string[]>
    written: Maybe<string>
    optimized: boolean
  }
  const valueOf = <T>(maybe: Maybe<T>): T | undefined =>
    maybe.form === 'some' ? maybe.value : undefined

  if (!held.ok) {
    return { ok: false, diagnostics: held.diagnostics }
  }

  switch (held.kind) {
    case 'look_result':
      return {
        ok: true,
        program: [],
        typescript: '',
        css: valueOf(held.css),
        style: valueOf(held.style),
        styleDark: valueOf(held.styleDark),
        warnings: [],
      }
    case 'data_result':
      return {
        ok: true,
        program: [],
        typescript: valueOf(held.written) ?? '',
        warnings: [],
      }
    case 'mill_result':
      return { ok: true, program: [], typescript: '', warnings: [] }

    case 'roll_result': {
      const roll =
        held.roll.form === 'some'
          ? rollOfKinds(held.roll.value)
          : valueOf(held.fastRoll)

      // the fast roll of a whole build carries the entry's own warnings and the twins as the build's result did, and
      // the roll alone neither
      return {
        ok: true,
        program: [],
        typescript: '',
        warnings: held.warnings,
        ...(roll ? { roll } : {}),
        ...(held.twins.form === 'some' ? { twins: held.twins.value } : {}),
      }
    }
  }

  const result: Record<string, unknown> = {
    ok: true,
    program: held.program,
  }

  if (!held.optimized) {
    result.typescript = valueOf(held.written) ?? ''
  }

  if (held.cover.form === 'some') {
    result.cover = held.cover.value
  }

  result.warnings = held.warnings

  if (held.openClaims.length) {
    result.openClaims = held.openClaims
  }

  result.obligations = held.obligations
  result.kernel = valueOf(held.kernel)
  result.uncertified = valueOf(held.uncertified)

  if (held.roll.form === 'some') {
    result.roll = rollOfKinds(held.roll.value)
  }

  if (held.optimized) {
    // what wakes the hive, computed once in the warnings: the TypeScript getter below and every native driver
    // (`emitRust(result.program, { wake: result.wake })`) read this one value (term/hive decision 002)
    result.wake = held.wake

    let typescript: string | undefined

    Object.defineProperty(result, 'typescript', {
      enumerable: true,
      get: () => (typescript ??= entryTypescriptPort(answer)),
    })
  }

  if (held.twins.form === 'some') {
    result.twins = held.twins.value
  }

  return result as CompileResult
}

// THE PER-MODULE MODE (`options.modules`), as compile.ts built it: one emitted ESM module per source file, through the
// mill level of the cache and never its output level, whose JSON cannot hold the `Map` of modules
function compileModules(
  source: { file: string; text: string },
  options: CompileOptions,
): CompileResult {
  const side = sideFile(source, options)

  if (side) {
    return side
  }

  const reading = readingOf(options)
  const loaded = loadGraphPort(source, reading)

  censusOf()?.sources?.(
    source.file,
    (loaded.graph as { sources?: unknown } | undefined)?.sources,
  )

  if (loaded.refused.form === 'some') {
    return {
      ok: false,
      diagnostics: loaded.refused.value as Diagnostic[],
    }
  }

  const cache = options?.cache
  const given = givenOf(options?.deckOf, options?.modules, undefined)
  const graphKey = graphKeyPort(source, reading, loaded.graph, given)

  // what the build captures, one `graph-job` (decision 031 section 6): the closure the cache runs on a miss holds it
  const job = {
    source,
    reading,
    graph: loaded.graph,
    given,
  }

  const build = (): CompileResult =>
    builtResult(runGraphJobPort(job), options?.env, options?.library)

  // THE ROLL ALONE, for a caller that reads nothing else (`term make`'s roll pass, call/code/roll.ts): its own small
  // cache entry, beside the full one
  if (options?.rollOnly) {
    const rollOf = (): CompileResult => {
      const full = build()

      return full.ok
        ? {
            ok: true,
            program: [],
            typescript: '',
            warnings: [],
            ...(full.roll ? { roll: full.roll } : {}),
          }
        : full
    }

    return cache
      ? (cachedOutput(
          cache.state,
          rollOnlyKeyPort(graphKey, options.rollFast === true),
          rollOf,
          'output',
        ) as CompileResult)
      : rollOf()
  }

  // the output cache stores a JSON-serialized result, which cannot hold the per-module `Map`, so per-module mode skips
  // the output level (and still gets mill-level reuse)
  return build()
}

// A FILE THAT IS NOT A PROGRAM, answered whole: a look stylesheet, a data file or a mill definition, in
// compile/side-files.tree (item term-self-host-001-0262). Undefined for a program
export function sideFile(
  source: { file: string; text: string },
  options?: CompileOptions,
): CompileResult | undefined {
  const answer = sideFilePort(
    source,
    file => options?.roleOf?.(file) ?? '',
    file => options?.leanOf?.(file) ?? false,
    options?.resolve !== undefined,
    resolverTask(options?.resolve),
  )

  if (answer.form === 'none') {
    return undefined
  }

  const side = answer.value

  switch (side.form) {
    case 'look-sheet':
      return {
        ok: true,
        program: [],
        typescript: '',
        css: side.css,
        style: side.style,
        styleDark: side.styleDark,
        warnings: [],
      }
    case 'data-module':
      return {
        ok: true,
        program: [],
        typescript: side.typescript,
        warnings: [],
      }
    case 'mill-sound':
      return { ok: true, program: [], typescript: '', warnings: [] }
    case 'side-refused':
      return { ok: false, diagnostics: side.diagnostics }
  }
}

// WHAT COMPILE READS OF ITS OPTIONS, as the driver takes it: one parse memo for the load and the build, the cache's
// closures, the import walk's resolver, scan and walk memo in compile/loading.tree's shapes, and every option with
// whether it was given
function readingOf(options?: CompileOptions): CompileReading {
  const parsed = options?.parsed ?? makeParseMemo()
  const cache = options?.cache
  const cover = options?.cover
  const resolve = options?.resolve

  return {
    hasResolve: resolve !== undefined,
    resolveLoad: (
      path: string,
      from: string,
      how: Maybe<{ base?: string }>,
    ) => {
      const found = resolve?.(
        path,
        from,
        how.form === 'some' ? how.value : undefined,
      )

      return found ? { form: 'some', value: found } : { form: 'none' }
    },
    resolveSource: resolverTask(resolve),
    parsed,
    scan: portScan(
      parsed,
      cache
        ? (unit, compute) =>
            writesOf(
              cache,
              unit.file,
              () =>
                cachedScan(
                  cache.state,
                  unit.file,
                  unit.text,
                  compute,
                ) as ImportScan,
            )
        : undefined,
    ),
    // a fresh memo per walk when the caller keeps none (compile/load.ts `collectModules`)
    walked: options?.walked ?? new Map(),
    keepsWalked: options?.walked !== undefined,
    roleOf: file => options?.roleOf?.(file) ?? '',
    leanOf: file => options?.leanOf?.(file) ?? false,
    hasEnv: options?.env !== undefined,
    env: options?.env ?? '',
    modules: options?.modules !== undefined,
    raw: options?.optimize === false,
    hasTreeShake: options?.treeShake !== undefined,
    treeShake: options?.treeShake ?? false,
    entryPoints: options?.entryPoints ?? [],
    roll: options?.roll === true,
    rollOnly: options?.rollOnly === true,
    rollFast: options?.rollFast === true,
    choices: twinChoiceList(options?.twins ?? {}),
    expose: options?.exposeTwins === true,
    adjusted: options?.adjustTwins !== undefined,
    adjust: options?.adjustTwins ?? (twins => twins),
    coverWhole: cover === true,
    cover:
      cover !== undefined && cover !== true
        ? { form: 'some', value: cover }
        : { form: 'none' },
    library: options?.library === true,
    // the mill cache's closure: one module milled once per text, role, lean and template set
    milled: (unit, templates, templateKey) =>
      milledModule(unit, {
        parsed,
        templates: templates as Map<string, Template>,
        templateKey,
        cache,
        role: options?.roleOf?.(unit.file) ?? undefined,
        lean: options?.leanOf?.(unit.file) ?? false,
      }) as DriverMilled,
  } as CompileReading
}

// WHAT A PHASE TAKES AS THE HOST HOLDS IT: the deck lookup, the per-module URL and the emitted files' set, the
// checker's switches, check/overload.ts's two tables (module state the checker reads after the gate), node identity,
// ir/simplify.ts's host-global test and the run's state
function givenOf(
  deckOf:
    | ((file: string) => { name: string; root: string } | undefined)
    | undefined,
  modulesUrl: ((file: string) => string) | undefined,
  emitOnly: Set<string> | undefined,
): DriverGiven {
  return {
    deckOf: deckTask(deckOf),
    hostDeckOf: deckOf,
    // the emitter spells an acronym word upper case (compile/program-driver.tree `modules-url`)
    modulesURL: modulesUrl,
    emitOnly,
    switches: checkerSwitches,
    keepBound: bound => {
      keepOverloadBound(bound.groups, bound.runtime)

      return true
    },
    sameNode: (left: unknown, right: unknown) => left === right,
    foreign: (statement: Statement) =>
      statement.form === 'let' && statement.foreign !== undefined,
    // the run's state, the one instance of each this process holds: check/refine.ts's prover state, which holds.ts and
    // totality.ts share, and compile/cache.ts's text hashes, which every cache shares (decision 142 rule 2)
    state: { refine: refineState, hashes: TEXT_HASHES },
  } as DriverGiven
}

// Every `tree` template the graph defines, and the fingerprint of the modules that define them. compile/separate.ts
// calls this. compile/unit-mill.tree (item term-self-host-001-0263)
export function graphTemplates(
  sources: { file: string; text: string }[],
  parsed: ParseMemo,
): { templates: Map<string, Template>; templateKey: string } {
  return graphTemplatesPort(sources, parsed)
}

// The warnings about the ENTRY file's own spelling, which a build gives once. compile/separate.ts calls this.
// compile/unit-mill.tree (item term-self-host-001-0263)
export function entryWarnings(
  source: { file: string; text: string },
  sources: { file: string; text: string }[],
  parsed: ParseMemo,
  templates?: Map<string, Template>,
): Diagnostic[] {
  return entryWarningsPort(source, sources, parsed, templates!)
}

// One module milled, through the mill cache when there is one: compile/program-entry.tree `milled-module` (item
// term-self-host-001-1237), the key, the template gate and the stored form there. The merged build and
// compile/separate.ts both mill there, so a module is one cache entry whichever path asked for it.
export function milledModule(
  unit: { file: string; text: string },
  options: {
    parsed: ParseMemo
    templates: Map<string, Template>
    // the fingerprint of every template-bearing module in the graph, '' when there is none
    templateKey: string
    cache?: CompileCache
    role?: string
    lean: boolean
  },
):
  | { ok: true; program: Program; twins?: Twin[] }
  | { ok: false; diagnostics: Diagnostic[] } {
  const { parsed, templates, templateKey, cache, role, lean } = options

  return milledModulePort({
    unit,
    parsed,
    templates,
    templateKey,
    cache: cache ? some(cache.state) : none,
    clean: cache ? cleanOf(cache) : () => true,
    role: role ?? '',
    lean,
  } as never) as unknown as
    | { ok: true; program: Program; twins?: Twin[] }
    | { ok: false; diagnostics: Diagnostic[] }
}

// What `compileProgram` is handed: the milled program and how to build it
export type ProgramInput = {
  program: Program
  file: string
  roots?: Set<string>
  merged?: boolean
  modulesUrl?: (file: string) => string
  optimize?: boolean
  env?: string
  treeShake?: boolean
  // `fast`: the roll alone, once the program is typed (compile's `rollFast`)
  wantRoll?: boolean | 'fast'
  deckOf?: (file: string) => { name: string; root: string } | undefined
  // what each module imports by name, so a call to a name two modules define binds to the one its file imported
  scope?: ImportScope
  // the chosen implementations, with the closure's twins (ir/twin.ts)
  selected?: { twins: Twin[]; choices: TwinChoices; expose?: boolean }
  // a library host code also builds values of (compile's `library`)
  library?: boolean
  // the file whose names are kept where two files define one, when that is not `file` (compile/separate.ts)
  naming?: string
  // the files whose modules are emitted, when not every file's (a separate unit, compile/separate.ts)
  emitOnly?: Set<string>
  // the file of the render runtime (@term/site/view/render) as the build's resolver finds it
  renderFile?: string
  // write coverage probes into the checked program (ir/cover.tree); the keys come back on the result as `cover`
  cover?: CoverTarget
}

// The checking pipeline: everything downstream of parse and mill, the five phases of compile/program-driver.tree, over
// an already-milled program. compile/separate.ts calls it with its arguments in this order (decision 031 section 6)
export function compileProgram(
  program: Program,
  file: string,
  roots?: Set<string>,
  merged?: boolean,
  modulesUrl?: (file: string) => string,
  optimize?: boolean,
  env?: string,
  treeShake?: boolean,
  wantRoll?: boolean | 'fast',
  deckOf?: (file: string) => { name: string; root: string } | undefined,
  scope?: ImportScope,
  selected?: { twins: Twin[]; choices: TwinChoices; expose?: boolean },
  library?: boolean,
  naming?: string,
  emitOnly?: Set<string>,
  renderFile?: string,
  cover?: CoverTarget,
): CompileResult {
  const answer = runProgramPort(
    {
      program,
      file,
      hasRoots: roots !== undefined,
      roots: [...(roots ?? [])],
      merged: merged === true,
      hasModules: modulesUrl !== undefined,
      raw: optimize === false,
      env: env ?? '',
      hasEnv: env !== undefined,
      treeShake: treeShake ?? false,
      wantRoll:
        wantRoll === 'fast'
          ? 'fast_roll'
          : wantRoll
            ? 'whole_roll'
            : 'no_roll',
      scopes: scopeList(scope),
      hasSelected: selected !== undefined,
      expose: selected?.expose ?? false,
      twins: selected?.twins ?? [],
      choices: selected ? twinChoiceList(selected.choices) : [],
      library: library === true,
      naming: naming ?? file,
      scoped: emitOnly !== undefined,
      emitOnly: [...(emitOnly ?? [])],
      renderFile: renderFile ?? '',
      cover: cover ? { form: 'some', value: cover } : { form: 'none' },
    } as never,
    givenOf(deckOf, modulesUrl, emitOnly),
  )

  // the roots the gate added, after the ones the caller's set had, in the order it added them
  const added = (
    answer.run as unknown as { roots?: Map<string, boolean> }
  ).roots

  for (const name of added?.keys() ?? []) {
    roots?.add(name)
  }

  return answerResult(answer, env, library)
}

// WHAT THE BUILD CAME TO, as the result: a refusal, or the five phases' result with the entry's own warnings after the
// build's and the checked twins beside it, each spread over the result as the original spread it
function builtResult(
  built: GraphBuilt,
  env: string | undefined,
  library: boolean | undefined,
): CompileResult {
  if (built.refused.form === 'some') {
    return {
      ok: false,
      diagnostics: built.refused.value as Diagnostic[],
    }
  }

  const compiled = answerResult(
    (built.answer as { form: 'some'; value: DriverAnswer }).value,
    env,
    library,
  )

  const spelled = built.warnings as Diagnostic[]
  const warned: CompileResult =
    compiled.ok && spelled.length > 0
      ? { ...compiled, warnings: [...compiled.warnings, ...spelled] }
      : compiled

  return built.twins.form === 'some' && warned.ok
    ? { ...warned, twins: built.twins.value as Twin[] }
    : warned
}

// WHAT THE FIVE PHASES CAME TO, as the result: a refusal, the fast roll, or the result of the pending emit
function answerResult(
  answer: DriverAnswer,
  env: string | undefined,
  library: boolean | undefined,
): CompileResult {
  if (answer.refused.form === 'some') {
    return {
      ok: false,
      diagnostics: answer.refused.value as Diagnostic[],
    }
  }

  if (answer.roll.form === 'some') {
    return {
      ok: true,
      program: [],
      typescript: '',
      warnings: [],
      roll: answer.roll.value as Roll,
    }
  }

  return emitResult(
    answer,
    (answer.pending as { form: 'some'; value: PendingEmit }).value,
    env,
    library,
  )
}

// a roll value as the plain value it stands for, as compile/roll.ts reads one back: a key holding `no-value` is there
// and holds undefined
function plainValue(value: RollValue): unknown {
  switch (value.form) {
    case 'no-value':
      return undefined
    case 'null-value':
      return null
    case 'text-value':
    case 'number-value':
    case 'flag-value':
      return value.value
    case 'item-values':
      return value.values.map(plainValue)

    case 'pair-values': {
      const out: Record<string, unknown> = {}

      for (const pair of value.pairs) {
        out[pair.key] = plainValue(pair.value)
      }

      return out
    }
  }
}

// compile/rolling.tree's roll as the plain roll compile/roll.ts answers
function rollOfKinds(kinds: RollKind[]): Roll {
  const out: Record<string, RollEntry[]> = {}

  for (const kind of kinds) {
    out[kind.name] = kind.entries.map(plainValue) as RollEntry[]
  }

  return out as Roll
}

// THE RESULT OF A PENDING EMIT, in the order the original spelled each: the per-module result carries the modules and
// an empty TypeScript, the raw one its TypeScript emitted at once, and the optimized one the hive's wake and its
// TypeScript built when it is first read.
//
// THE TYPESCRIPT IS BUILT WHEN IT IS FIRST READ. A Rust, Swift or Kotlin build emits from `program` and never reads
// it, and it was a quarter of every native compile (`tmp/prof-compile.ts`, 2026-10-05). It reads the program and
// writes nothing back. Enumerable, so a spread or `JSON.stringify` of the result still carries it
function emitResult(
  answer: DriverAnswer,
  pending: PendingEmit,
  env: string | undefined,
  library: boolean | undefined,
): CompileResult {
  const run = answer.run as unknown as {
    warnings: Diagnostic[]
    openClaims: string[]
    obligations: Tally
    kernel: NonNullable<Extract<CompileResult, { ok: true }>['kernel']>
    roll?: RollKind[]
    wake?: WakeGroup[]
  }

  const roll = run.roll ? rollOfKinds(run.roll) : undefined
  const wake = run.wake
  const options = { env, wake, ...(library ? { library: true } : {}) }
  const result: Record<string, unknown> = {
    ok: true,
    program: pending.program,
  }

  if (pending.kind === 'modules_emit') {
    result.typescript = ''
    result.modules = (
      pending.modules as {
        form: 'some'
        value: Map<string, ModuleEmit>
      }
    ).value
  }

  if (pending.kind === 'raw_emit') {
    result.typescript = emitTypescriptPort(pending, options)
  }

  if (pending.cover.form === 'some') {
    result.cover = pending.cover.value
  }

  result.warnings = run.warnings

  if (run.openClaims.length) {
    result.openClaims = run.openClaims
  }

  result.obligations = run.obligations
  result.kernel = run.kernel
  result.uncertified = answer.uncertified

  if (roll) {
    result.roll = roll
  }

  if (pending.kind === 'optimized_emit') {
    // what wakes the hive, computed once in the warnings: the TypeScript getter below and every native driver
    // (`emitRust(result.program, { wake: result.wake })`) read this one value (term/hive decision 002)
    result.wake = wake

    let typescript: string | undefined

    Object.defineProperty(result, 'typescript', {
      enumerable: true,
      get: () => (typescript ??= emitTypescriptPort(pending, options)),
    })
  }

  return result as CompileResult
}

// THE ENTRY'S RENAMED RECORD FORM IS EXPORTED BY ITS WRITTEN NAME TOO (decision 045), in compile/program-emit.tree
// (item term-self-host-001-0268)
export function entryFormAliases(
  program: Program,
  file: string,
): string {
  return entryFormAliasesPort(program, file)
}
