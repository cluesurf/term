// The compile driver: source text to nice TypeScript, through parse, mill, resolve, check, and emit. Pure and
// browser-safe: returns the program (compile AST) and the emitted TypeScript. Running the result is a separate
// step (write the module and import it, hot-module-reload style).
// Pipeline: parse -> mill (mine/mint) -> resolve (fill name holes) -> check (types) -> emit.
// See note/research/vibe/computation/plans/11-elaboration.md.

import type { Diagnostic } from '@term/make/code/parser/diagnostic'
import { parse } from '@term/make/code/parser/tree'
import {
  expandTemplates,
  collectTemplates,
} from '@term/make/code/compile/template'
import type { Template } from '@term/make/code/compile/template'
import { mill } from '@term/make/code/compile/mill'
import { checkView, lowerView } from '@term/make/code/compile/view'
import { resolve } from '@term/make/code/check/resolve'
import { check } from '@term/make/code/check/infer'
import { resolveAsync } from '@term/make/code/check/async-resolve'
import {
  disambiguateOverloads,
  overloadGroups,
} from '@term/make/code/check/overload'
import { extendForms } from '@term/make/code/check/extend'
import { checkTells } from '@term/make/code/check/tell'
import { checkRaiseBounds } from '@term/make/code/check/effects'
import { buildRoll } from '@term/make/code/compile/roll'
import type { Roll } from '@term/make/code/compile/roll'
import { elaborateReport } from '@term/make/code/check/elaborate'
import { checkHolds } from '@term/make/code/check/holds'
import { checkTraits } from '@term/make/code/check/traits'
import { checkEffects } from '@term/make/code/check/effects'
import { checkTotality } from '@term/make/code/check/totality'
import { findUnused } from '@term/make/code/check/unused'
import { pruneToReachable } from '@term/make/code/ir/prune'
import { simplify } from '@term/make/code/ir/simplify'
import { passDictionaries } from '@term/make/code/ir/dictionary'
import { lowerZones } from '@term/make/code/compile/view-lower'
import { compileLookCss } from '@term/make/code/compile/look-css'
import {
  expandData,
  isDataFile,
  readDataText,
  toJsonValue,
} from '@term/make/code/compile/host'
import { emitTypeScript } from '@term/make/code/compile/typescript'
import { emitModules } from '@term/make/code/compile/modules'
import type { ModuleEmit } from '@term/make/code/compile/modules'
import { collectModules, makeParseMemo } from '@term/make/code/compile/load'
import type { ParseMemo } from '@term/make/code/compile/load'
import type { Resolver } from '@term/make/code/compile/load'
import { hashText } from '@term/make/code/compile/cache'
import type { CompileCache } from '@term/make/code/compile/cache'
import type {
  Program,
  Statement,
} from '@term/make/code/compile/node'

// The render-runtime helpers that `lowerZones` (compile/view-lower.ts)
// synthesizes calls to when it lowers a `zone` component. Because that
// lowering runs after the reachability prune, these must be pinned as roots
// whenever a program contains a zone, or they get shaken out and dangle. The
// prune follows references, so pinning the render helpers keeps the dom
// primitives (set-attribute, append, ...) they call, transitively.
const ZONE_RENDER_RUNTIME: string[] = [
  'element',
  'text',
  'attribute',
  'bind-attribute',
  'event',
  'dynamic',
  'dynamic-view',
  'show',
  'each',
  'each-keyed',
  'gate',
  'mount',
  'portal',
  'append',
  'remove',
  'replace',
  'open-scope',
  'close-scope',
  'make-signal',
  'read-signal',
  'dispose-scope',
]

export type CompileResult =
  | {
      ok: true
      program: Program
      typescript: string
      // present only for a look stylesheet (.tree of `face` / `tone` rules): the emitted static CSS. The build writes
      // it to a sibling `.css` instead of `.ts`. See compile/look-css.ts.
      css?: string
      // present only in per-module mode (`options.modules`): one emitted ESM module per source file (file -> emit)
      modules?: Map<string, ModuleEmit>
      warnings: Diagnostic[]
      // present when `options.roll` was set: the roll of this entry's closure (compile/roll.ts)
      roll?: Roll
    }
  | { ok: false; diagnostics: Diagnostic[] }

// a .tree whose top-level statements are all `face` / `tone` / `base` rules compiles to a static stylesheet, not a
// program. Shared by the merged and separate build paths so both route look files to the CSS backend.
export function isLookStylesheet(source: {
  file: string
  text: string
}): boolean {
  const looked = parse(source)

  return (
    looked.ok &&
    looked.tree.nodes.length > 0 &&
    looked.tree.nodes.every(node => {
      const first = node.nodes[0]
      const name =
        first?.kind === 'name'
          ? first.parts
              .map(part => (part.kind === 'chunk' ? part.text : ''))
              .join('')
          : ''

      return name === 'face' || name === 'tone' || name === 'base'
    })
  )
}

export function compile(
  source: { file: string; text: string },
  options?: {
    resolve?: Resolver
    cache?: CompileCache
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
    // the deck a source file belongs to (name and root), from its nearest `deck.tree`. Names the `host` of every
    // raise and roll entry. The CLI supplies it; without it the deck is read off the path
    deckOf?: (file: string) => { name: string; root: string } | undefined
    // the role a project's `role.tree` gives a file (`host` for data, `code` for a program), overriding the content
    // rule below. Undefined or null means no role names the file, so its content decides. See deck/deck/code/role.ts
    roleOf?: (file: string) => string | null | undefined
  },
): CompileResult {
  // a look stylesheet (.tree whose top-level statements are all `face` / `tone` / `base`) is not a normal compile
  // target: route it to the static-CSS backend and return the emitted stylesheet instead of TypeScript. See look-css.ts.
  if (isLookStylesheet(source)) {
    return {
      ok: true,
      program: [],
      typescript: '',
      css: compileLookCss(source),
      warnings: [],
    }
  }

  // a data file (the host dialect: `host` / `list` / `mesh` / `tree` / `fuse` and literals, no code) is not a program
  // either: it compiles to a module whose default export is the value as a JSON literal, keys in snake case,
  // anchors expanded. See code/compile/host.ts and note/term/host/.
  const role = options?.roleOf?.(source.file)

  if (role === 'host' || (!role && isDataFile(source))) {
    return compileData(source)
  }

  // collect the entry plus every module it loads (so the stdlib supplies the form definitions), dependencies
  // first, then mill each and merge into one program. Without a resolver this is just the single entry file.
  // one parse per module for the whole build: the dependency walk, the template scan and the mill all read from it.
  //
  // A BATCH DRIVER PASSES ITS OWN, shared across every entry it builds. Made here per compile otherwise, which is
  // right for one compile and ruinous for three thousand: see makeParseMemo in compile/load.ts.
  const parsed = options?.parsed ?? makeParseMemo()

  const sources = options?.resolve
    ? collectModules(source, options.resolve, parsed).sources
    : [source]

  const cache = options?.cache

  // the effective tree-shaking flag: on by default for the optimized merged build (differential-verified across the
  // stdlib corpus), off in per-module mode and on the editor (`optimize: false`) path, explicit option wins
  const treeShake =
    options?.treeShake ??
    (!options?.modules && options?.optimize !== false)

  // output cache: an exact module graph (every file at its current content) compiles to one result. A re-save with
  // no edits anywhere is an instant hit.
  const graphKey =
    sources
      .map(unit => `${unit.file}@${hashText(unit.text)}`)
      .join('|') +
    (options?.modules ? '|modules' : '') +
    (options?.optimize === false ? '|raw' : '') +
    (options?.env ? `|env:${options.env}` : '') +
    (treeShake ? '|shake' : '') +
    (options?.roll ? '|roll' : '') +
    (options?.entryPoints?.length
      ? `|entry:${[...options.entryPoints].sort().join(',')}`
      : '')

  const build = (): CompileResult => {
    // gather `tree` template definitions from every loaded module first, so a module's `fuse` can instantiate a
    // template that an imported module defines. The fingerprint of the template-bearing sources joins the mill cache
    // key, so editing a template correctly invalidates the modules that expand against it.
    const templates = new Map<string, Template>()

    let templateText = ''

    for (const unit of sources) {
      if (!/(^|\n)tree\s/.test(unit.text)) {
        continue
      }

      const tree = parsed(unit)

      if (!tree.ok) {
        continue
      }

      templateText += unit.text

      for (const [name, template] of collectTemplates(tree.tree)) {
        templates.set(name, template)
      }
    }

    const templateKey = templates.size ? hashText(templateText) : ''

    const program: Program = []
    const roots = new Set<string>()
    // statement->source-file map: the merged program loses per-module provenance, so downstream passes (resolve,
    // check) would otherwise blame the entry file for an error living in an imported module. Recording each
    // top-level statement's origin lets diagnostics point at the real file.
    const origin = new WeakMap<Statement, string>()

    for (const unit of sources) {
      // mill cache: reuse a module's parse + expand + mill when its text (and the template set) is unchanged
      // the role a project's `role.tree` gives this module. A `view` file is the sandboxed document dialect and is
      // read by compile/view.ts, not by the code mill. See note/term/view/06-mill.md.
      const unitRole = options?.roleOf?.(unit.file) ?? undefined

      const milled = cache
        ? cache.milledUnit(
            `${unit.file}\u0000${templateKey}\u0000${unitRole ?? ''}`,
            unit.text,
            () => millUnit(unit, parsed, templates, unitRole),
          )
        : millUnit(unit, parsed, templates, unitRole)

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
        origin.set(node, unit.file)
      }

      program.push(...milled.program)
    }

    return compileProgram(
      program,
      source.file,
      roots,
      origin,
      options?.modules,
      options?.optimize,
      options?.env,
      // explicit entry points imply pruning (application dead-code elimination)
      treeShake || (options?.entryPoints?.length ?? 0) > 0,
      options?.roll,
      options?.deckOf,
    )
  }

  // the output cache stores a JSON-serialized result, which cannot hold the per-module `Map`. So in per-module mode we
  // skip the output level (and still get mill-level reuse, used inside `build`). The merged path caches as before.
  return cache && !options?.modules
    ? cache.output(graphKey, build)
    : build()
}

// a data file to a TypeScript module: `export default <json>`. The value is also exported as `data`, so a Term
// program that loads the module through the per-module path has a name to find.
function compileData(source: { file: string; text: string }): CompileResult {
  const read = readDataText(source)

  if (!read.ok) {
    return { ok: false, diagnostics: read.diagnostics }
  }

  const expanded = expandData(read.data, source.file)

  if (!expanded.ok) {
    return { ok: false, diagnostics: expanded.diagnostics }
  }

  const json = JSON.stringify(toJsonValue(expanded.data), null, 2)

  return {
    ok: true,
    program: [],
    typescript: `// Term data, from ${source.file.split('/').pop() ?? source.file}. Keys are snake case, anchors are expanded.\nconst data = ${json} as const\n\nexport default data\n`,
    warnings: [],
  }
}

// parse, expand templates, and mill one module into a program (or the diagnostics that stopped it)
function millUnit(
  unit: { file: string; text: string },
  parseOf: ParseMemo,
  templates?: Map<string, Template>,
  role?: string,
):
  | { ok: true; program: Program }
  | { ok: false; diagnostics: Diagnostic[] } {
  const parsed = parseOf(unit)

  if (!parsed.ok) {
    return { ok: false, diagnostics: parsed.diagnostics }
  }

  // expand phase: tree/fuse templates (including those imported from other modules), so injected code goes through
  // the mill, resolver, and type checker. A document gets this too, which is where its macros go.
  // the `view` role: the sandboxed document dialect. Four statement heads, none of which declares anything the
  // author wrote. `checkView` is the ONE gate the compiler, `term view` and a save path all call, so the three
  // cannot answer differently about what a document may say. It is handed the tree already parsed and the whole
  // graph's templates, so a document is parsed once and a macro imported from another module expands.
  if (role === 'view') {
    const read = checkView(unit, { tree: parsed.tree, templates })

    if (!read.ok) {
      return { ok: false, diagnostics: read.diagnostics }
    }

    return { ok: true, program: lowerView(read.file) }
  }

  const expanded = expandTemplates(parsed.tree, templates)

  return mill(expanded, unit.file, role)
}

// The checking core: everything downstream of parse and mill. Takes an already-milled program so the editor path
// (analyze) and the build path (compile) share one parse and one mill. See plans/19-format-and-lint.
export function compileProgram(
  program: Program,
  file: string,
  roots?: Set<string>,
  origin?: WeakMap<Statement, string>,
  modulesUrl?: (file: string) => string,
  optimize?: boolean,
  env?: string,
  treeShake?: boolean,
  wantRoll?: boolean,
  deckOf?: (file: string) => { name: string; root: string } | undefined,
): CompileResult {
  // form extension: resolve every `form x` that is `like <base>` with children into an ordinary record, and finish
  // every `halt <form>` raise, before any name is bound. See code/check/extend.ts.
  const extendDiagnostics = extendForms(program, file, origin, { deckOf })

  if (extendDiagnostics.length) {
    return { ok: false, diagnostics: extendDiagnostics }
  }

  // arity overloading: rename same-name / different-arity functions (and their calls) to unique `name__<arity>` names,
  // so everything downstream sees one definition per name. See code/check/overload.ts.
  disambiguateOverloads(program)

  // hole-filling: bind names to definitions
  const resolveDiagnostics = resolve(program, file, origin)

  if (resolveDiagnostics.length) {
    return { ok: false, diagnostics: resolveDiagnostics }
  }

  // tree-shaking (opt-in): once names are bound, drop the imported definitions
  // the entry never uses, so the expensive check / elaborate passes below run
  // only on the reachable program. Needs `roots` (the entry's public surface)
  // to know the starting points. See code/ir/prune.ts.
  if (treeShake && roots) {
    // every member of a typed overload group is a root: calls target the first member until the checker picks one
    // by argument type, and the pick must still exist then
    for (const members of overloadGroups.values()) {
      for (const member of members) {
        roots.add(member)
      }
    }

    // the hive's entry points are called by the generated wake chain, which nothing in the source references
    for (const name of ['hive-wake', 'hive-tell']) {
      if (program.some(s => s.form === 'function' && s.name === name)) {
        roots.add(name)
      }
    }

    // View lowering (further below) rewrites `zone` components into calls to
    // the render runtime (element / text / attribute / dynamic / event /
    // append / show / each / ...). That lowering runs AFTER this prune, so the
    // helpers are not yet referenced by the still-unlowered zones and would be
    // pruned as unreachable, then dangle at runtime. When the program contains
    // any zone, pin the render-runtime helpers as roots so they, and
    // transitively the dom primitives they call, survive the shake.
    let pruneRoots = roots

    if (program.some(statement => statement.form === 'view')) {
      pruneRoots = new Set(roots)

      for (const helper of ZONE_RENDER_RUNTIME) {
        pruneRoots.add(helper)
      }
    }

    program = pruneToReachable(program, pruneRoots)
  }

  // formal type checking: the surface pass (gradual bidirectional inference) annotates the AST with types
  const checkDiagnostics = check(program, file, origin)
  // the checker's warnings (an unknown type name) ride with the build's other warnings; only its errors stop it
  const checkErrors = checkDiagnostics.filter(d => d.severity !== 'warning')
  const checkWarnings = checkDiagnostics.filter(d => d.severity === 'warning')

  if (checkErrors.length) {
    return { ok: false, diagnostics: checkErrors }
  }

  // async resolution: infer which functions are async from the call graph and await async calls by default, so callers
  // need no per-call `wait true`. Runs before the effect check so the inserted awaits satisfy the discipline. See
  // note/seed/compiler/async-inference.md.
  resolveAsync(program)

  // elaboration: lower the now-typed surface into the sound dependent kernel and let it verify. The kernel is the
  // single type-theoretic authority; the surface pass above is its inference front-end. See plans/12-type-systems.
  // It also discharges non-linear `hold` clauses by definitional equality (the kernel fallback for refinement).
  const elaboration = elaborateReport(program, file)

  if (elaboration.diagnostics.length) {
    return { ok: false, diagnostics: elaboration.diagnostics }
  }

  const kernelDischarged = new Set(
    elaboration.discharged.map(
      s => `${s.start.line}:${s.start.column}`,
    ),
  )

  // trait checking: instance completeness and trait-bound existence
  const traitDiagnostics = checkTraits(program, file)

  if (traitDiagnostics.length) {
    return { ok: false, diagnostics: traitDiagnostics }
  }

  // effect checking: async / await discipline (the surface slice of the effect system)
  const effectDiagnostics = checkEffects(program, file)

  if (effectDiagnostics.length) {
    return { ok: false, diagnostics: effectDiagnostics }
  }

  // refinement layer 2: discharge `hold` verification conditions. The linear prover handles the linear fragment;
  // holds the kernel already proved by definitional equality are dropped. Unprovable holds are errors; holds
  // outside the decidable fragment (and not kernel-discharged) are warnings (flagged, not silently skipped).
  const holdDiagnostics = checkHolds(program, file).filter(
    d =>
      !d.markers.some(m =>
        kernelDischarged.has(
          `${m.span.start.line}:${m.span.start.column}`,
        ),
      ),
  )

  const holdErrors = holdDiagnostics.filter(d => d.severity === 'error')

  if (holdErrors.length) {
    return { ok: false, diagnostics: holdErrors }
  }

  const holdWarnings = holdDiagnostics.filter(
    d => d.severity === 'warning',
  )

  // totality: strict positivity (hard error) keeps datatypes sound; termination (warning) flags recursion we
  // cannot show well-founded. Both are prerequisites for soundly making definitions proof-relevant.
  const totality = checkTotality(program, file)

  if (totality.errors.length) {
    return { ok: false, diagnostics: totality.errors }
  }

  // warnings do not fail the build (unused bindings, termination, unchecked holds, etc.)
  const warnings = [
    ...checkWarnings,
    ...findUnused(program, file),
    ...totality.warnings,
    ...holdWarnings,
  ]

  // the app's `tell` decisions: each must name an exception the program can raise, with props it declares
  const tellDiagnostics = checkTells(program, file, origin, deckOf)

  if (tellDiagnostics.length) {
    return { ok: false, diagnostics: tellDiagnostics }
  }

  // a task that bounds its raise set with `halt` lines on its signature is held to them
  const boundDiagnostics = checkRaiseBounds(program, file, origin)

  if (boundDiagnostics.length) {
    return { ok: false, diagnostics: boundDiagnostics }
  }

  // the roll is built from the checked, un-simplified program, so every task is still there to be listed
  const roll = wantRoll
    ? buildRoll(program, file, origin, { deckOf })
    : undefined

  // what wakes the hive: every deck with its exceptions and tells, whether or not a roll was asked for. Cheap, and
  // only emitted when the program loads the stdlib hive.
  const wake = program.some(s => s.form === 'function' && s.name === 'hive-wake')
    ? wakeGroups(buildRoll(program, file, origin, { deckOf }))
    : undefined

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
    const cloned = structuredClone(program)

    // the clone's statements are new objects: carry each one's origin over (index-paired, structuredClone preserves
    // order), or per-module emit below would find no origin and bucket everything under the entry
    if (origin) {
      program.forEach((s, i) => {
        const from = origin.get(s)

        if (from !== undefined && cloned[i]) {
          origin.set(cloned[i]!, from)
        }
      })
    }

    tsProgram = passDictionaries(cloned)
  }

  // per-module mode: emit one ESM module per source file from the checked (pre-simplify) program, so module boundaries
  // survive (no cross-module forwarder inlining). The dev server serves these lazily. See code/compile/modules.ts.
  if (modulesUrl) {
    return {
      ok: true,
      program: tsProgram,
      typescript: '',
      modules: emitModules(tsProgram, origin, modulesUrl),
      warnings,
      ...(roll ? { roll } : {}),
    }
  }

  // the editor path keeps the un-optimized program: navigation / find-references need every original call site, which
  // forwarder-inlining and specialization would collapse. The emitted TS is irrelevant there, so build it from the
  // checked program as-is.
  if (optimize === false) {
    return {
      ok: true,
      // keep the original program (zones intact) for the editor's navigation /
      // find-references; lower only the copy that feeds the TS emitter.
      program,
      typescript: emitTypeScript(lowerZones(program)),
      warnings,
      ...(roll ? { roll } : {}),
    }
  }

  // IR pass: simplify (forwarder inlining + constant folding + algebraic identities). Entry-module roots are preserved
  // even if unreferenced; only internal (imported) pass-through wrappers are inlined away. The returned program (which
  // the native backends emit from) keeps native trait calls; the TypeScript string is built from the dictionary clone.
  const optimized = simplify(program, roots)
  const tsOptimized = hasTraitGenerics
    ? simplify(tsProgram, roots)
    : optimized

  // View lowering: rewrite every `zone` into a plain `function` over the render
  // runtime (+ component calls / slots), so every backend emits components as
  // ordinary functions with no zone-specific codegen. Runs last, after simplify,
  // exactly where the zone emit used to happen. See code/compile/view-lower.ts.
  const loweredProgram = lowerZones(optimized)
  const loweredTs = hasTraitGenerics
    ? lowerZones(tsOptimized)
    : loweredProgram

  return {
    ok: true,
    program: loweredProgram,
    typescript: emitTypeScript(loweredTs, { env, wake }),
    warnings,
    ...(roll ? { roll } : {}),
  }
}

// the roll grouped by deck, in the shape `hiveWake` takes: exceptions and tells only, so the wake chain stays small
function wakeGroups(
  roll: Roll,
): { deck: string; entries: Record<string, unknown>[] }[] {
  const groups = new Map<string, Record<string, unknown>[]>()

  for (const deck of roll.deck) {
    groups.set(deck.name, [])
  }

  // the built-in kinds carry their declaration as `base`; a declared kind's entry carries a `ref`, the constant the
  // emitter binds as the live `base`
  const kinds = ['exception', 'tell', ...roll.kind.map(k => k.name)]

  for (const kind of kinds) {
    for (const entry of roll[kind] ?? []) {
      const { host, ...rest } = entry
      const list = groups.get(host) ?? []
      list.push({ host, kind: entry.kind, name: entry.name, site: entry.site, base: rest, ...(entry.ref ? { ref: entry.ref } : {}) })
      groups.set(host, list)
    }
  }

  return [...groups].map(([deck, entries]) => ({ deck, entries }))
}
