// The compile driver: source text to nice TypeScript, through parse, mill, resolve, check, and emit. Pure and
// browser-safe: returns the program (compile AST) and the emitted TypeScript. Running the result is a separate
// step (write the module and import it, hot-module-reload style).
// Pipeline: parse -> mill (mine/mint) -> resolve (fill name holes) -> check (types) -> emit.
// See note/project/term/archive/computation/plans/11-elaboration.md.

import type { Diagnostic } from '@term/make/code/parser/diagnostic'
import { diagnose } from '@term/make/code/parser/diagnostic'
import type { Template } from '@term/make/code/compile/template'
import {
  entryWarnings as entryWarningsPort,
  graphTemplates as graphTemplatesPort,
  millUnit as millUnitPort,
} from '@term/make/code/compile/unit-mill'
import {
  checkMillSource as checkMillPort,
  isLookStylesheet as isLookPort,
  sideFile as sideFilePort,
} from '@term/make/code/compile/side-files'
import type { Maybe, MillChecked } from '@term/make/code/compile/side-files'
import { programGate as programGatePort } from '@term/make/code/compile/program-gate'
import type { ProgramRun as GateRun } from '@term/make/code/compile/program-gate'
import { programTypes as programTypesPort } from '@term/make/code/compile/program-types'
import type { ProgramRun as TypesRun } from '@term/make/code/compile/program-types'
import { programProofs as programProofsPort } from '@term/make/code/compile/program-proofs'
import type { ProgramRun as ProofsRun } from '@term/make/code/compile/program-proofs'
import { programWarnings as programWarningsPort } from '@term/make/code/compile/program-warnings'
import type {
  ProgramRun as WarningsRun,
  WakeGroup as WakeGroupTerm,
} from '@term/make/code/compile/program-warnings'
import type { RollKind, RollValue } from '@term/make/code/compile/rolling'
import type { WakeEntry, WakeGroup } from '@term/make/code/compile/wake'
import { resolve } from '@term/make/code/check/resolve'
import { overloadGroups, runtimeBound } from '@term/make/code/check/overload'
import { checkLoweredMembers } from '@term/make/code/check/lowered'
import type { Roll, RollEntry } from '@term/make/code/compile/roll'
import type { Tally } from '@term/make/code/check/holds'
import { checkerSwitches, unknownSeamOn } from '@term/make/code/check/strict'
import { inferStrict } from '@term/make/code/check/strict'
import { widthRanges } from '@term/make/code/check/width-range'
import { uncertifiedCount } from '@term/make/code/check/refine'

// AWAIT BY DEFAULT, outside every task: an un-awaited, un-ticked call to an async task there is refused, naming `tick`
// (check/effects.tree `check-calls-outside-tasks`). ON since 2026-10-03, after `pnpm term:await-migrate --commit`
// rewrote every such call in the repository to `tick`, each file proven to emit what it emitted before. The migration
// compiles under both settings, which is why it is a switch and not a constant, and the compile cache keys on it. It
// is the `await-outside` field of the one `checker-switches` record check/strict.ts holds (check/checker-switches.tree,
// item term-self-host-001-0261)

// the build's resolver as compile/side-files.tree takes it: none where it finds nothing
function resolverTask(
  resolve: ((path: string, from: string) => Source | undefined) | undefined,
): (path: string, from: string) => Maybe<Source> {
  return (path, from) => {
    const found = resolve?.(path, from)

    return found ? { form: 'some', value: found } : { form: 'none' }
  }
}

// A MILL DEFINITION HELD TO WHAT IT OWES (compile/mill-check.tree), with its loads resolved through the build's
// resolver, in compile/side-files.tree (item term-self-host-001-0262). An empty target and a resolver that throws
// find nothing, and without a resolver the three checks that need one are skipped. test/compile/mill-grammar.ts
// calls this
export function checkMillSource(
  source: Source,
  resolve?: (path: string, from: string) => Source | undefined,
): MillChecked {
  return checkMillPort(source, resolve !== undefined, resolverTask(resolve))
}

export function setAwaitOutsideTasks(on: boolean): void {
  checkerSwitches.awaitOutside = on
}

export function awaitsOutsideTasks(): boolean {
  return checkerSwitches.awaitOutside
}

// the build's deck lookup as compile/program-gate.tree takes it: none where the build knows no deck for a file, and for
// every file when it knows none at all
function deckTask(
  deckOf?: (file: string) => { name: string; root: string } | undefined,
): (file: string) => Maybe<{ name: string; root: string }> {
  return file => {
    const deck = deckOf?.(file)

    return deck ? { form: 'some', value: { name: deck.name, root: deck.root } } : { form: 'none' }
  }
}

import { simplify } from '@term/make/code/ir/simplify'
import { coverProgram } from '@term/make/code/ir/cover'
import type { CoverTarget } from '@term/make/code/ir/cover'
import { passDictionaries } from '@term/make/code/ir/dictionary'
import { lowerViews } from '@term/make/code/compile/view-lower'
import { emitTypeScript, toPascal } from '@term/make/code/compile/typescript'
import { emitModules } from '@term/make/code/compile/modules'
import type { ModuleEmit } from '@term/make/code/compile/modules'
import { collectModules, makeParseMemo, platformRefusals, scopeList } from '@term/make/code/compile/load'
import type { ImportScope, ParseMemo, Source, WalkMemo } from '@term/make/code/compile/load'
import type { Resolver } from '@term/make/code/compile/load'
import type { CompileCache } from '@term/make/code/compile/cache'
import { contentHash } from '@term/make/code/compile/cache'
import type {
  Program,
  Statement,
  Twin,
} from '@term/make/code/compile/node'
import { checkTwins } from '@term/make/code/check/twin'
import { exposeTwins, twinChoiceList } from '@term/make/code/ir/twin'
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
      // driver passes it as `{ wake: result.wake }` (term/hive decision 002, compile/wake.ts)
      wake?: WakeGroup[]
      // the `twin` declarations of the closure, checked (check/twin.ts). Beside the program, never in it: nothing
      // here emits one yet, so every build runs the reference (note/project/term/optimize/archive/optimize-readme.md)
      twins?: Twin[]
      // present when `options.cover` was set: every key (`<path>:<line>`) a coverage probe was written for, in the
      // order written (ir/cover.tree). The program's probes are what report which of them ran
      cover?: string[]
    }
  | { ok: false; diagnostics: Diagnostic[] }

// a .tree whose top-level statements are all `face` / `tone` / `base` rules compiles to a static stylesheet, not a
// program. Shared by the merged and separate build paths so both route look files to the CSS backend.
export function isLookStylesheet(source: {
  file: string
  text: string
}): boolean {
  return isLookPort(source)
}

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

// THE GRAPH A COMPILE BUILDS: the entry's closure, read once, and what the cache key and the build both take from
// it. Made by `loadGraph`, read by `graphKeyOf` and `buildGraph` (decision 031 of term/self-host/change/001)
export type CompileGraph = {
  parsed: ParseMemo
  collected: ReturnType<typeof collectModules> | undefined
  sources: Source[]
  // what a coverage build measures: `true` is the entry file alone, its keys relative to the folder it is in
  coverTarget: CoverTarget | undefined
  // the effective tree-shaking flag
  treeShake: boolean
}

export function compile(
  source: { file: string; text: string },
  options?: CompileOptions,
): CompileResult {
  const side = sideFile(source, options)

  if (side) {
    return side
  }

  const graph = loadGraph(source, options)

  if (!graph.ok) {
    return graph
  }

  const cache = options?.cache
  const graphKey = graphKeyOf(source, options, graph.graph)
  const build = (): CompileResult => buildGraph(source, options, graph.graph)

  // THE ROLL ALONE, for a caller that reads nothing else (`term make`'s roll pass, call/code/roll.ts). It cached the
  // whole result, program and TypeScript, to read one field of it back, so each warm entry of @term/bind's 3,091 was
  // unzipped and parsed whole: 64 s of a 147 s warm build (2026-10-05). Its own small entry, beside the full one
  if (options?.rollOnly) {
    const rollOf = (): CompileResult => {
      const full = build()

      return full.ok
        ? { ok: true, program: [], typescript: '', warnings: [], ...(full.roll ? { roll: full.roll } : {}) }
        : full
    }

    return cache ? cache.output(`${graphKey}|roll-only${options.rollFast ? '|fast' : ''}`, rollOf) : rollOf()
  }

  // the output cache stores a JSON-serialized result, which cannot hold the per-module `Map`. So in per-module mode we
  // skip the output level (and still get mill-level reuse, used inside `build`). The merged path caches as before.
  return cache && !options?.modules
    ? cache.output(graphKey, build)
    : build()
}

// A FILE THAT IS NOT A PROGRAM, answered whole: a look stylesheet, a data file or a mill definition. Undefined for a
// program, which `compile` goes on to load and build. The answer is compile/side-files.tree's (item
// term-self-host-001-0262), asking the build's role, lean and resolver readers where this asked them
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
      return { ok: true, program: [], typescript: '', css: side.css, style: side.style, styleDark: side.styleDark, warnings: [] }
    case 'data-module':
      return { ok: true, program: [], typescript: side.typescript, warnings: [] }
    case 'mill-sound':
      return { ok: true, program: [], typescript: '', warnings: [] }
    case 'side-refused':
      return { ok: false, diagnostics: side.diagnostics }
  }
}

// THE ENTRY'S CLOSURE, or the load errors that refuse it
export function loadGraph(
  source: { file: string; text: string },
  options?: CompileOptions,
): { ok: true; graph: CompileGraph } | { ok: false; diagnostics: Diagnostic[] } {
  // collect the entry plus every module it loads (so the stdlib supplies the form definitions), dependencies
  // first, then mill each and merge into one program. Without a resolver this is just the single entry file.
  // one parse per module for the whole build: the dependency walk, the template scan and the mill all read from it.
  //
  // A BATCH DRIVER PASSES ITS OWN, shared across every entry it builds. Made here per compile otherwise, which is
  // right for one compile and ruinous for three thousand: see makeParseMemo in compile/load.ts.
  const parsed = options?.parsed ?? makeParseMemo()

  const scanCache = options?.cache
  const collected = options?.resolve
    ? collectModules(
        source,
        options.resolve,
        parsed,
        scanCache ? (unit, compute) => scanCache.scanned(unit.file, unit.text, compute) : undefined,
        options.walked,
      )
    : undefined
  const sources = collected ? collected.sources : [source]

  // a load the build cannot answer and the checker would only meet as an unknown name: refused with its own cause
  const loadErrors = (collected?.diagnostics ?? []).filter(d => d.severity !== 'warning')

  // and a module the build's env has no native for, refused at its `{platform}` load by name
  if (loadErrors.length === 0 && collected && options?.resolve && options.env) {
    loadErrors.push(...platformRefusals(collected.sources, options.resolve, options.env, parsed))
  }

  if (loadErrors.length > 0) {
    return { ok: false, diagnostics: loadErrors }
  }

  // what a coverage build measures: `true` is the entry file alone, its keys relative to the folder it is in
  const coverTarget: CoverTarget | undefined =
    options?.cover === true
      ? { prefix: source.file, root: source.file.slice(0, Math.max(source.file.lastIndexOf('/'), 0)) }
      : options?.cover

  // the effective tree-shaking flag: on by default for the optimized merged build (differential-verified across the
  // stdlib corpus), off in per-module mode and on the editor (`optimize: false`) path, explicit option wins
  const treeShake =
    options?.treeShake ??
    (!options?.modules && options?.optimize !== false)

  return { ok: true, graph: { parsed, collected, sources, coverTarget, treeShake } }
}

// output cache: an exact module graph (every file at its current content) compiles to one result. A re-save with
// no edits anywhere is an instant hit.
//
// EACH UNIT'S ROLE AND LEAN ARE IN THE KEY, beside its text. The output level caches a FAILURE as readily as a
// success, and a caller that compiled the same graph without the readers (the roll pass, the test runner, a
// worker, all of which did on 2026-09-12) stored its unknown-name diagnostics under a key the fixed caller then
// hit, so the fix read as not working until `term wash deck`. Text alone cannot tell the two reads apart (lean-0034).
export function graphKeyOf(
  source: { file: string; text: string },
  options: CompileOptions | undefined,
  graph: CompileGraph,
): string {
  const { sources, coverTarget, treeShake } = graph

  return (
    sources
      .map(unit => {
        const role = options?.roleOf?.(unit.file) ?? ''
        const lean = options?.leanOf?.(unit.file) ? '#lean' : ''

        return `${unit.file}@${contentHash(unit.text)}${role ? `#${role}` : ''}${lean}`
      })
      .join('|') +
    (options?.modules ? '|modules' : '') +
    (options?.optimize === false ? '|raw' : '') +
    (options?.env ? `|env:${options.env}` : '') +
    (treeShake ? '|shake' : '') +
    // the await switch decides whether an un-ticked async call outside a task is refused, so a result cached under
    // one setting is not an answer under the other (`setAwaitOutsideTasks`, below)
    (awaitsOutsideTasks() ? '|await-outside' : '') +
    // and so do the gradual seam and the strict inference switch (check/seam.ts, check/strict.ts)
    (unknownSeamOn() ? '|seam' : '') +
    (inferStrict() ? '|strict' : '') +
    // and the width ranges, which add a tier-0 obligation at every width site (check/width-range.ts)
    (widthRanges() ? '|widths' : '') +
    (options?.roll ? '|roll' : '') +
    // a different choice of implementation is a different program
    (options?.twins && Object.keys(options.twins).length ? `|twins:${JSON.stringify(options.twins)}` : '') +
    (options?.exposeTwins ? '|expose' : '') +
    // probes are written into the program, so a covered build is never answered by an uncovered one
    (coverTarget ? `|cover:${coverTarget.prefix}@${coverTarget.root}` : '') +
    // a mutant is a different program every time it is asked for, so it is never answered from the cache
    (options?.adjustTwins ? `|adjusted:${Math.random()}` : '') +
    (options?.entryPoints?.length
      ? `|entry:${[...options.entryPoints].sort().join(',')}`
      : '')
  )
}

// THE BUILD OF ONE GRAPH: mill every module, merge them, and hand the program to `runProgram`. `observe`, when given,
// sees the program run at the entry of each phase (pairs/compile-phase-inputs.ts), and changes nothing
export function buildGraph(
  source: { file: string; text: string },
  options: CompileOptions | undefined,
  graph: CompileGraph,
  observe?: (phase: ProgramPhase, run: ProgramRun) => void,
): CompileResult {
  const { parsed, collected, sources, coverTarget, treeShake } = graph
  const cache = options?.cache

  // gather `tree` template definitions from every loaded module first, so a module's `fuse` can instantiate a
  // template that an imported module defines. The fingerprint of the template-bearing sources joins the mill cache
  // key, so editing a template correctly invalidates the modules that expand against it.
  const { templates, templateKey } = graphTemplates(sources, parsed)

  const program: Program = []
  const twins: Twin[] = []
  const roots = new Set<string>()
  // The merged program loses per-module provenance, so downstream passes (resolve, check) would otherwise blame
  // the entry file for an error living in an imported module. Each top-level statement's span records the file it
  // came from, and `merged` below tells the checker that the program is more than one module.

  for (const unit of sources) {
    // mill cache: reuse a module's parse + expand + mill when its text (and the template set) is unchanged
    // the role a project's `role.tree` gives this module. A `view` file is the sandboxed document dialect and is
    // read by compile/view.ts, not by the code mill. See note/project/term/view/06-mill.md.
    const milled = milledModule(unit, {
      parsed,
      templates,
      templateKey,
      cache,
      role: options?.roleOf?.(unit.file) ?? undefined,
      lean: options?.leanOf?.(unit.file) ?? false,
    })

    if (!milled.ok) {
      return { ok: false, diagnostics: milled.diagnostics }
    }

    // roots: the entry module's own top-level functions are the compiled unit's public surface, kept even when
    // nothing internal calls them (imported stdlib wrappers, by contrast, are internal and may be inlined away).
    // Under tree-shaking we also root the entry's record-types (a form-only file exports its forms); this is gated so
    // the normal build's `roots` (which the simplifier's dead-function pass also uses) is byte-for-byte unchanged.
    //
    // APPLICATION DCE: when explicit entry points are given, ONLY those functions are roots. The rest of the entry
    // module's public surface is then subject to reachability pruning, so a public function nothing reaches from an
    // entry point is dropped. Record-types are left to reachability (a form a kept function uses stays).
    if (unit.file === source.file) {
      const entryPoints = options?.entryPoints
      for (const node of milled.program) {
        const name = (node as { name: string }).name

        if (entryPoints && entryPoints.length > 0) {
          if (node.form === 'function' && entryPoints.includes(name)) {
            roots.add(name)
          }
        } else if (
          node.form === 'function' ||
          (treeShake && node.form === 'record-type')
        ) {
          roots.add(name)
        }
      }
    }

    for (const node of milled.program) {
      node.span.file = unit.file
    }

    program.push(...milled.program)

    for (const twin of milled.twins ?? []) {
      twin.span.file = unit.file
      twins.push(twin)
    }
  }

  const compiled = runProgram(
    {
      program,
      file: source.file,
      roots,
      merged: true,
      modulesUrl: options?.modules,
      optimize: options?.optimize,
      env: options?.env,
      // explicit entry points imply pruning (application dead-code elimination)
      treeShake: treeShake || (options?.entryPoints?.length ?? 0) > 0,
      wantRoll: options?.roll && options.rollOnly && options.rollFast ? 'fast' : options?.roll,
      deckOf: options?.deckOf,
      scope: collected?.scope,
      selected: (options?.twins && Object.keys(options.twins).length > 0) || options?.exposeTwins
        ? {
            twins: options?.adjustTwins ? options.adjustTwins(structuredClone(twins)) : twins,
            choices: options?.twins ?? {},
            expose: options?.exposeTwins,
          }
        : undefined,
      library: options?.library,
      naming: undefined,
      emitOnly: undefined,
      // the render runtime's own file, found as the build finds any load, so an app's own `view/render.tree` is not it
      renderFile: options?.resolve?.('@term/site/view/render', source.file)?.file,
      cover: coverTarget,
    },
    observe,
  )

  const spelled = compiled.ok ? entryWarnings(source, sources, parsed, templates) : []
  const warned: CompileResult =
    compiled.ok && spelled.length > 0 ? { ...compiled, warnings: [...compiled.warnings, ...spelled] } : compiled

  // a twin is checked against the program it twins a task of: what can be refused without running anything
  // (check/twin.ts). A refusal fails the build the way an unproven claim does
  if (twins.length === 0 || !warned.ok) {
    return warned
  }

  const refused = checkTwins(program, twins, source.file)

  return refused.length > 0 ? { ok: false, diagnostics: refused } : { ...warned, twins }
}

// Every `tree` template the graph defines, gathered before any module mills, so a module's `fuse` can instantiate one
// an import defines, and the fingerprint of the modules that define them (`templateKey`, '' when none does), which
// joins the mill key of a module that can expand one. Shared by `compile` and compile/separate.ts. The answer is
// compile/unit-mill.tree's (item term-self-host-001-0263)
export function graphTemplates(
  sources: { file: string; text: string }[],
  parsed: ParseMemo,
): { templates: Map<string, Template>; templateKey: string } {
  return graphTemplatesPort(sources, parsed)
}

// The warnings about the ENTRY file's own spelling, which a build gives once, for the file it was asked to build.
// `note <word>` written as metadata: the old spelling of `mark <word>`, read the same and warned about
// (check/note-metadata.ts). Only the entry's own, the way `note-private` is, so a build does not repeat every imported
// module's. `note private` keeps its own older warning. Shared by `compile` and compile/separate.ts
export function entryWarnings(
  source: { file: string; text: string },
  sources: { file: string; text: string }[],
  parsed: ParseMemo,
  templates?: Map<string, Template>,
): Diagnostic[] {
  // the empty fuse sites, the `note` metadata and the unreached `find`s, in compile/unit-mill.tree (item
  // term-self-host-001-0263)
  return entryWarningsPort(source, sources, parsed, templates as Map<string, Template>)
}

// One module milled, through the mill cache when there is one. The merged build (`compile`) and the separate one
// (compile/separate.ts) both mill here, so a module is one cache entry whichever path asked for it.
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
): ReturnType<typeof millUnit> {
  const { parsed, templates, templateKey, cache, role, lean } = options
  // `mark lean` on the matched role rule: this unit's bare heads are calls and its property heads are named
  // arguments. IN THE CACHE KEY BELOW, because it changes what the unit mills to. Left out, a file that gains
  // the mark keeps its old AST until its text changes, and the bug reads as the feature not working at all.
  // Prefixed rather than appended, so it cannot be confused with a role whose name ends in the same letters.
  const leanKey = lean ? 'lean:' : ''

  // THE TEMPLATE SET JOINS ONLY THE KEY OF A UNIT THAT CAN USE IT: one with a `fuse` (or a document, which
  // `checkView` hands the templates). Expansion reads another module's templates at a `fuse` and nowhere else
  // (compile/template.ts, `expandFuse`). It was in every unit's key, so editing any file that defines a `tree`
  // missed the mill entry of every module in the closure, and one standard library module had as many keys as
  // there are closures it sits in, which fragmented the machine-wide mill cache
  const usesTemplates = role === 'view' || /\bfuse\b/.test(unit.text)

  return cache
    ? cache.milledUnit(
        `${leanKey}${unit.file}\u0000${usesTemplates ? templateKey : ''}\u0000${role ?? ''}`,
        unit.text,
        () => millUnit(unit, parsed, templates, role, lean),
      )
    : millUnit(unit, parsed, templates, role, lean)
}

// parse, expand templates, and mill one module into a program (or the diagnostics that stopped it)
function millUnit(
  unit: { file: string; text: string },
  parseOf: ParseMemo,
  templates?: Map<string, Template>,
  role?: string,
  lean?: boolean,
):
  | { ok: true; program: Program; twins?: Twin[] }
  | { ok: false; diagnostics: Diagnostic[] } {
  // the parse, a document's view check, the template expansion and the mill, in compile/unit-mill.tree (item
  // term-self-host-001-0263). The role and the lean flag are handed on as they came, absent included
  return millUnitPort(unit, parseOf, templates as Map<string, Template>, role, lean) as
    | { ok: true; program: Program; twins?: Twin[] }
    | { ok: false; diagnostics: Diagnostic[] }
}

// What `compileProgram` is handed: the milled program and how to build it. The Term form of the same record is
// compile/program-run.tree's `program-run`, whose leading fields are these
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
  // the file whose names are kept where two files define one, when that is not `file`. Separate compilation names a
  // unit the same way whichever entry reached it, so the module it writes exports the same names every time
  // (compile/separate.ts); everywhere else it is `file`
  naming?: string
  // the files whose modules are emitted, when not every file's. A separate unit's program holds the stubs of its whole
  // closure, each under its own file, and their modules belong to the units that own them (compile/separate.ts)
  emitOnly?: Set<string>
  // the file of the render runtime (@term/site/view/render) as the build's resolver finds it, which names the runtime
  // for the view lowering's name binding. Absent, the binding looks for a file ending `/view/render.tree`
  renderFile?: string
  // write coverage probes into the checked program (ir/cover.tree); the keys come back on the result as `cover`
  cover?: CoverTarget
}

// what the kernel did with this file's own tasks (CompileResult's `kernel`)
export type ProgramKernel = {
  proven: number
  commands: number
  declined: { name: string; reason: string }[]
  statementwise: { name: string; reason: string }[]
}

// ONE RUN OF `compileProgram`: its input, and every value one phase hands a later one, each named once. The five
// phases read and write it in place, so it is `mark shared` in its Term form (compile/program-run.tree). A field a
// later phase fills starts empty
export type ProgramRun = ProgramInput & {
  // the certificate checker's refusals before this compile, so it can report its own
  uncertifiedBefore: number
  // the docks the route lowering replaced, kept for the roll alone (gate)
  pageDocks?: Statement[]
  // the type-name pass's diagnostics, refused or (in a host description) warned (gate)
  typeNameDiagnostics: Diagnostic[]
  // the file is in a deck that describes a host's API, @term/bind (gate, compile/program-gate.tree)
  describesHost: boolean
  // the warnings of the literal, pattern and bind checks (gate)
  literalWarnings: Diagnostic[]
  patternWarnings: Diagnostic[]
  bindWarnings: Diagnostic[]
  // the `find`s naming nothing their module defines, refused or warned (gate)
  staleFinds: Diagnostic[]
  // the overload groups as the arity pass left them (gate). check/overload.ts keeps them as module state, which the
  // checker and the resolver read, and this is that state at the gate's end, so a phase started from a copy of the run
  // can have it back (pairs/compile-phase-inputs.ts)
  overloadGroups: { name: string; members: string[] }[]
  // the render runtime names as the build bound them, and the ones it renamed (gate). check/views.ts reads the same
  // from check/overload.ts's module state
  runtimeNames: { name: string; bound: string }[]
  renamedRuntime: string[]
  // the checker's warnings (types)
  checkWarnings: Diagnostic[]
  // the claims left open, the tier-0 tally, the kernel's verdict and the warnings of the provers and totality (proofs)
  openClaims: string[]
  obligations: Tally
  kernel: ProgramKernel
  holdWarnings: Diagnostic[]
  totalityWarnings: Diagnostic[]
  // every warning of the build, the roll and the hive's wake (warnings)
  warnings: Diagnostic[]
  roll?: Roll
  wake?: WakeGroup[]
}

// the five phases, in the order they run
export type ProgramPhase = 'gate' | 'types' | 'proofs' | 'warnings' | 'emit'

export const PROGRAM_PHASES: ProgramPhase[] = ['gate', 'types', 'proofs', 'warnings', 'emit']

// The checking core: everything downstream of parse and mill. Takes an already-milled program so the editor path
// (analyze) and the build path (compile) share one parse and one mill. See plans/19-format-and-lint.
export function compileProgram(
  program: Program,
  file: string,
  roots?: Set<string>,
  merged?: boolean,
  modulesUrl?: (file: string) => string,
  optimize?: boolean,
  env?: string,
  treeShake?: boolean,
  // `fast`: the roll alone, once the program is typed (compile's `rollFast`)
  wantRoll?: boolean | 'fast',
  deckOf?: (file: string) => { name: string; root: string } | undefined,
  // what each module imports by name, so a call to a name two modules define binds to the one its file imported
  scope?: ImportScope,
  // the chosen implementations, with the closure's twins (ir/twin.ts)
  selected?: { twins: Twin[]; choices: TwinChoices; expose?: boolean },
  // a library host code also builds values of (compile's `library`)
  library?: boolean,
  // the file whose names are kept where two files define one, when that is not `file` (ProgramInput)
  naming?: string,
  // the files whose modules are emitted, when not every file's (ProgramInput)
  emitOnly?: Set<string>,
  // the file of the render runtime (ProgramInput)
  renderFile?: string,
  // write coverage probes into the checked program (ir/cover.tree); the keys come back on the result as `cover`
  cover?: CoverTarget,
): CompileResult {
  return runProgram({
    program,
    file,
    roots,
    merged,
    modulesUrl,
    optimize,
    env,
    treeShake,
    wantRoll,
    deckOf,
    scope,
    selected,
    library,
    naming,
    emitOnly,
    renderFile,
    cover,
  })
}

// a run at its start: the input, and every later field empty
export function startRun(input: ProgramInput): ProgramRun {
  return {
    ...input,
    // the certificate checker's refusals so far, so this compile can report its own
    uncertifiedBefore: uncertifiedCount(),
    typeNameDiagnostics: [],
    describesHost: false,
    literalWarnings: [],
    patternWarnings: [],
    bindWarnings: [],
    staleFinds: [],
    overloadGroups: [],
    runtimeNames: [],
    renamedRuntime: [],
    checkWarnings: [],
    openClaims: [],
    obligations: { total: 0, proven: 0, failed: [] },
    kernel: { proven: 0, commands: 0, declined: [], statementwise: [] },
    holdWarnings: [],
    totalityWarnings: [],
    warnings: [],
  }
}

// THE FIVE PHASES IN ORDER, each answering early with a refusal (or the fast roll), or handing the run on. `observe`,
// when given, sees the run at the entry of each phase, and changes nothing
export function runProgram(
  input: ProgramInput,
  observe?: (phase: ProgramPhase, run: ProgramRun) => void,
): CompileResult {
  const run = startRun(input)

  observe?.('gate', run)

  const gated = programGate(run)

  if (gated) {
    return gated
  }

  observe?.('types', run)

  const typed = programTypes(run)

  if (typed) {
    return typed
  }

  observe?.('proofs', run)

  const proved = programProofs(run)

  if (proved) {
    return proved
  }

  observe?.('warnings', run)

  const warned = programWarnings(run)

  if (warned) {
    return warned
  }

  observe?.('emit', run)

  return programEmit(run)
}

// STEPS 1 TO 10, THE GATE: module scope for forms, routes, form extension, the checks of the program as written, the
// overloads, the twins, the names and the shake. Undefined hands the run on. The gate is Term, compile/program-gate.tree
// (item term-self-host-001-0264): this face hands it the run in its Term form, writes back what the gate wrote, adds
// the roots it added, and keeps check/overload.ts's two tables, module state the phases after it read, as the binding
// left them
export function programGate(run: ProgramRun): CompileResult | undefined {
  const { file, roots, env, treeShake, deckOf, scope, selected, naming, emitOnly, renderFile } = run
  const scopes = scopeList(scope)
  const rootTable = new Map<string, boolean>([...(roots ?? [])].map(name => [name, true]))
  // the run as compile/program-run.tree declares it: the sets as hashes, the import scope and the twin choices in their
  // Term shapes, the deck lookup answering a maybe. The fields the gate neither reads nor writes are handed as they are
  const termRun = {
    ...run,
    roots: rootTable,
    modulesURL: run.modulesUrl,
    wantRoll: run.wantRoll === 'fast' ? 'fast_roll' : run.wantRoll ? 'whole_roll' : 'no_roll',
    deckOf: deckTask(deckOf),
    scope: scopes,
    selected: selected && { twins: selected.twins, choices: twinChoiceList(selected.choices), expose: selected.expose },
    emitOnly: emitOnly && new Map([...emitOnly].map(one => [one, true])),
  } as unknown as GateRun
  const answer = programGatePort(termRun, {
    hasRoots: roots !== undefined,
    treeShake: treeShake ?? false,
    env: env ?? '',
    hasEnv: env !== undefined,
    naming: naming ?? file,
    renderFile: renderFile ?? '',
    scopes,
    deckOf: deckTask(deckOf),
    scoped: emitOnly !== undefined,
    emitOnly: [...(emitOnly ?? [])],
    hasSelected: selected !== undefined,
    expose: selected?.expose ?? false,
    twins: selected?.twins ?? [],
    choices: selected ? twinChoiceList(selected.choices) : [],
  })
  const written = termRun as unknown as ProgramRun

  run.program = written.program

  if (written.pageDocks !== undefined) {
    run.pageDocks = written.pageDocks
  }

  run.typeNameDiagnostics = written.typeNameDiagnostics
  run.describesHost = written.describesHost
  run.literalWarnings = written.literalWarnings
  run.patternWarnings = written.patternWarnings
  run.bindWarnings = written.bindWarnings
  run.staleFinds = written.staleFinds
  run.runtimeNames = written.runtimeNames
  run.renamedRuntime = written.renamedRuntime
  run.overloadGroups = written.overloadGroups

  // the roots the gate added, after the ones the run had, in the order it added them
  for (const name of rootTable.keys()) {
    roots?.add(name)
  }

  // check/overload.ts's tables, as the binding left them, once it ran
  if (answer.bound.form === 'some') {
    overloadGroups.clear()
    runtimeBound.clear()

    for (const group of answer.bound.value.groups) {
      overloadGroups.set(group.name, group.members)
    }

    for (const pair of answer.bound.value.runtime) {
      runtimeBound.set(pair.name, pair.bound)
    }
  }

  return answer.refused.form === 'some' ? { ok: false, diagnostics: answer.refused.value as Diagnostic[] } : undefined
}

// STEPS 11 TO 14, THE TYPES: claims filled, the checker, the stamps, the affine checks, async resolution, and the fast
// roll's exit. Undefined hands the run on. The types are Term, compile/program-types.tree (item term-self-host-001-0265):
// this face hands it the run in its Term form, and writes back the program and the checker's warnings, the two fields
// the types write
export function programTypes(run: ProgramRun): CompileResult | undefined {
  const { deckOf, scope, selected, emitOnly, roots } = run
  // the run as compile/program-run.tree declares it, as the gate's face hands it
  const termRun = {
    ...run,
    roots: roots && new Map<string, boolean>([...roots].map(name => [name, true])),
    modulesURL: run.modulesUrl,
    wantRoll: run.wantRoll === 'fast' ? 'fast_roll' : run.wantRoll ? 'whole_roll' : 'no_roll',
    deckOf: deckTask(deckOf),
    scope: scopeList(scope),
    selected: selected && { twins: selected.twins, choices: twinChoiceList(selected.choices), expose: selected.expose },
    emitOnly: emitOnly && new Map([...emitOnly].map(one => [one, true])),
  } as unknown as TypesRun
  const answer = programTypesPort(termRun, {
    deckOf: deckTask(deckOf),
    scopes: scopeList(scope),
    hostDeckOf: deckOf,
  })
  const written = termRun as unknown as ProgramRun

  run.program = written.program
  run.checkWarnings = written.checkWarnings

  if (answer.refused.form === 'some') {
    return { ok: false, diagnostics: answer.refused.value as Diagnostic[] }
  }

  // the roll alone, for an entry already known to build
  if (answer.roll.form === 'some') {
    return { ok: true, program: [], typescript: '', warnings: [], roll: answer.roll.value as Roll }
  }

  return undefined
}

// STEPS 15 TO 19, THE PROOFS: the kernel, the effects, the claims, the holds and contracts, and totality. Undefined
// hands the run on. The proofs are Term, compile/program-proofs.tree (item term-self-host-001-0266): this face hands
// it the run in its Term form and the checker's switches, and writes back what the proofs write
export function programProofs(run: ProgramRun): CompileResult | undefined {
  const { deckOf, scope, selected, emitOnly, roots } = run
  // the run as compile/program-run.tree declares it, as the gate's face hands it
  const termRun = {
    ...run,
    roots: roots && new Map<string, boolean>([...roots].map(name => [name, true])),
    modulesURL: run.modulesUrl,
    wantRoll: run.wantRoll === 'fast' ? 'fast_roll' : run.wantRoll ? 'whole_roll' : 'no_roll',
    deckOf: deckTask(deckOf),
    scope: scopeList(scope),
    selected: selected && { twins: selected.twins, choices: twinChoiceList(selected.choices), expose: selected.expose },
    emitOnly: emitOnly && new Map([...emitOnly].map(one => [one, true])),
  } as unknown as ProofsRun
  const answer = programProofsPort(termRun, { switches: checkerSwitches })
  const written = termRun as unknown as ProgramRun

  run.program = written.program
  run.openClaims = written.openClaims
  run.obligations = written.obligations
  run.kernel = written.kernel
  run.holdWarnings = written.holdWarnings
  run.totalityWarnings = written.totalityWarnings

  return answer.refused.form === 'some' ? { ok: false, diagnostics: answer.refused.value as Diagnostic[] } : undefined
}

// STEPS 20 AND 21, THE WARNINGS: the build's warnings, the late refusals, the roll and the hive's wake. Undefined
// hands the run on. The warnings are Term, compile/program-warnings.tree (item term-self-host-001-0267): this face hands
// it the run in its Term form, the deck lookup and node identity, and writes back the warnings, and once it handed the
// run on, the roll and the wake as plain values (decision 040: a wake entry is a roll value, made a plain object here)
export function programWarnings(run: ProgramRun): CompileResult | undefined {
  const { deckOf, scope, selected, emitOnly, roots } = run
  // the run as compile/program-run.tree declares it, as the gate's face hands it, with no roll or wake yet
  const termRun = {
    ...run,
    roots: roots && new Map<string, boolean>([...roots].map(name => [name, true])),
    modulesURL: run.modulesUrl,
    wantRoll: run.wantRoll === 'fast' ? 'fast_roll' : run.wantRoll ? 'whole_roll' : 'no_roll',
    deckOf: deckTask(deckOf),
    scope: scopeList(scope),
    selected: selected && { twins: selected.twins, choices: twinChoiceList(selected.choices), expose: selected.expose },
    emitOnly: emitOnly && new Map([...emitOnly].map(one => [one, true])),
    roll: undefined,
    wake: undefined,
  } as unknown as WarningsRun
  const answer = programWarningsPort(termRun, {
    deckOf: deckTask(deckOf),
    sameNode: (left: unknown, right: unknown) => left === right,
    scoped: emitOnly !== undefined,
  } as never)
  const written = termRun as unknown as { warnings: ProgramRun['warnings']; roll?: RollKind[]; wake?: WakeGroupTerm[] }

  run.warnings = written.warnings

  if (answer.refused.form === 'some') {
    return { ok: false, diagnostics: answer.refused.value as Diagnostic[] }
  }

  run.roll = written.roll ? rollOfKinds(written.roll) : undefined
  run.wake = written.wake ? written.wake.map(plainWakeGroup) : undefined

  return undefined
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

// a wake group of compile/program-warnings.tree, its entries roll values, as the plain group compile/wake.ts names
function plainWakeGroup(group: WakeGroupTerm): WakeGroup {
  const entries = (values: RollValue[]): WakeEntry[] => values.map(value => plainValue(value) as WakeEntry)

  return {
    deck: group.deck,
    entries: entries(group.entries),
    typed: { exceptions: entries(group.typed.exceptions), tells: entries(group.typed.tells), docks: entries(group.typed.docks) },
  }
}

// STEPS 22 TO 25, THE EMIT: the internal marks, coverage, the dictionaries, the emit, the simplifier and the result
export function programEmit(run: ProgramRun): CompileResult {
  const { program, file, roots, modulesUrl, optimize, env, library, naming, emitOnly, cover } = run
  const { runtimeNames, renamedRuntime, warnings, openClaims, obligations, kernel, roll, wake } = run

  // every function outside the public surface is marked `internal`: every call it receives is in this program. Only
  // when the roots are known, so a compile that names none leaves every function callable from outside
  if (roots) {
    for (const node of program) {
      if (node.form === 'function' && !roots.has(node.name)) {
        node.internal = true
      }
    }
  }

  // COVERAGE PROBES, after every check above (purity, raise sets, async inference and twin admission never see one) and
  // before the simplifier (an inlined body keeps the keys it was written with). Spec: term/decisions-2026-10/coverage
  const coverKeys = cover ? coverProgram(program, cover) : undefined
  const covering = coverKeys ? { cover: coverKeys } : {}

  // trait-instance dictionary passing: thread a trait's instance through every trait-bounded generic call so generic
  // trait-method dispatch resolves to concrete code. This is the JavaScript-family lowering (records of functions); the
  // native backends instead keep trait calls in native form and emit traits / protocols / interfaces. So the dictionary
  // pass feeds ONLY the TypeScript emit, on a clone, leaving the returned program (and every native backend that emits
  // from it) with trait calls intact. It runs at all only when the program actually has trait-bounded generics, so the
  // stdlib and all non-trait code pay nothing. See code/ir/dictionary.ts.
  const hasTraitGenerics =
    program.some(s => s.form === 'mask') &&
    program.some(
      s =>
        s.form === 'function' &&
        s.generics.some(g => g.need !== undefined),
    )

  let tsProgram = program

  if (hasTraitGenerics) {
    // Each statement's origin rides along on its span, which `structuredClone` copies, so the clone needs no
    // fixup. The map this replaced needed an index-paired loop here, and would have misattributed an entire module
    // had the clone ever reordered.
    const cloned = structuredClone(program)

    tsProgram = passDictionaries(cloned)
  }

  // a statement the build made rather than read (a trait's dictionary) has no file, and per-module emit puts it in a
  // module of its own that a separate unit, emitting only its own files, never wrote: the unit's module imported
  // `traitDictScorerPlayer` from a file nothing made (guides: types/masks, 2026-10-05). In a unit it belongs to the
  // unit, so it goes in the unit's module, which is the only one that reads it
  if (emitOnly) {
    const home = naming ?? file

    for (const statement of tsProgram) {
      statement.span.file ??= home
    }
  }

  // per-module mode: emit one ESM module per source file from the checked (pre-simplify) program, so module boundaries
  // survive (no cross-module forwarder inlining). The dev server serves these lazily. See code/compile/modules.ts.
  if (modulesUrl) {
    return {
      ok: true,
      program: tsProgram,
      typescript: '',
      modules: emitModules(tsProgram, modulesUrl, emitOnly, runtimeNames),
      ...covering,
      warnings,
      ...(openClaims.length ? { openClaims } : {}),
      obligations,
      kernel,
      uncertified: uncertifiedCount() - run.uncertifiedBefore,
      ...(roll ? { roll } : {}),
    }
  }

  // the editor path keeps the un-optimized program: navigation / find-references need every original call site, which
  // forwarder-inlining and specialization would collapse. The emitted TS is irrelevant there, so build it from the
  // checked program as-is.
  if (optimize === false) {
    return {
      ok: true,
      // keep the original program (views intact) for the editor's navigation /
      // find-references; lower only the copy that feeds the TS emitter.
      program,
      typescript: emitTypeScript(lowerViews(program, runtimeNames)),
      ...covering,
      warnings,
      ...(openClaims.length ? { openClaims } : {}),
      obligations,
      kernel,
      uncertified: uncertifiedCount() - run.uncertifiedBefore,
      ...(roll ? { roll } : {}),
    }
  }

  // IR pass: simplify (forwarder inlining + constant folding + algebraic identities). Entry-module roots are preserved
  // even if unreferenced; only internal (imported) pass-through wrappers are inlined away. The returned program (which
  // the native backends emit from) keeps native trait calls; the TypeScript string is built from the dictionary clone.
  //
  // A program with a `view` is lowered after this pass into calls of the render runtime under their bound names, and a
  // `view` counts only the plain names, so a renamed runtime name is a root too (beat-term-0055, review 0045)
  const simplifyRoots =
    roots && renamedRuntime.length > 0 && program.some(statement => statement.form === 'view')
      ? new Set([...roots, ...renamedRuntime])
      : roots
  const optimized = simplify(program, simplifyRoots)
  const tsOptimized = hasTraitGenerics
    ? simplify(tsProgram, simplifyRoots)
    : optimized

  // View lowering: rewrite every `view` into a plain `function` over the render
  // runtime (+ component calls / slots), so every backend emits components as
  // ordinary functions with no view-specific codegen. Runs last, after simplify,
  // exactly where the view emit used to happen. See code/compile/view-lower.ts.
  const loweredProgram = lowerViews(optimized, runtimeNames)
  const loweredTs = hasTraitGenerics
    ? lowerViews(tsOptimized, runtimeNames)
    : loweredProgram

  // a member call on a list or a map that no native backend lowers, refused on Rust, Swift and Kotlin before anything is
  // emitted, where it used to be written as a host call for the toolchain to refuse (check/lowered.ts)
  const unlowered = checkLoweredMembers(loweredProgram, file, env ?? '')

  if (unlowered.length) {
    return { ok: false, diagnostics: unlowered }
  }

  const result = {
    ok: true as const,
    program: loweredProgram,
    ...covering,
    warnings,
    ...(openClaims.length ? { openClaims } : {}),
    obligations,
    kernel,
    uncertified: uncertifiedCount() - run.uncertifiedBefore,
    ...(roll ? { roll } : {}),
    // what wakes the hive, computed once above: the TypeScript getter below and every native driver
    // (`emitRust(result.program, { wake: result.wake })`) read this one value (term/hive decision 002)
    wake,
  }

  // THE TYPESCRIPT IS BUILT WHEN IT IS FIRST READ. A Rust, Swift or Kotlin build emits from `program` and never reads
  // it, and it was a quarter of every native compile: `emitTypeScript` and its arithmetic facts, 1,241 ms of 5,408
  // compiling the idiom gate's 48 programs to Rust twice (`tmp/prof-compile.ts`, 2026-10-05). It reads the program and
  // writes nothing back, which `tmp/ts-lazy-check.ts` holds: every native emission is the same whether the TypeScript
  // was built before it or not at all. Enumerable, so a spread or `JSON.stringify` of the result still carries it
  let typescript: string | undefined

  Object.defineProperty(result, 'typescript', {
    enumerable: true,
    get: () =>
      (typescript ??= `${emitTypeScript(loweredTs, { env, wake, ...(library ? { library: true } : {}) })}${entryFormAliases(loweredTs, file)}`),
  })

  return result as typeof result & { typescript: string }
}

// THE ENTRY'S RENAMED RECORD FORM IS EXPORTED BY ITS WRITTEN NAME TOO (decision 045). check/scope renames an entry's
// record form named like some case `<name>__form`, as it renames a loaded one, so a construction binds alike whichever
// file is the entry. The emitter writes the renamed name, and a face imports the form by the name it was written with
// (`TwinChoice`, never `TwinChoiceForm`), so each such form gets a type alias under that name. Nothing else in the
// program can be named so: every definition of the name was renamed, and a case is written inside its union's type
export function entryFormAliases(program: Program, file: string): string {
  const lines: string[] = []

  for (const statement of program) {
    if (statement.form !== 'record-type' || statement.span.file !== file || statement.variants.length > 0 || !statement.name.endsWith('__form')) {
      continue
    }

    const params = statement.params ?? []
    const heads = params.length ? `<${params.map(param => `${toPascal(param)} = any`).join(', ')}>` : ''
    const args = params.length ? `<${params.map(param => toPascal(param)).join(', ')}>` : ''
    lines.push(`export type ${toPascal(statement.name.slice(0, -'__form'.length))}${heads} = ${toPascal(statement.name)}${args}`)
  }

  return lines.length ? `\n${lines.join('\n')}\n` : ''
}
