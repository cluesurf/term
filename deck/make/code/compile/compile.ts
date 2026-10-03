// The compile driver: source text to nice TypeScript, through parse, mill, resolve, check, and emit. Pure and
// browser-safe: returns the program (compile AST) and the emitted TypeScript. Running the result is a separate
// step (write the module and import it, hot-module-reload style).
// Pipeline: parse -> mill (mine/mint) -> resolve (fill name holes) -> check (types) -> emit.
// See note/research/vibe/computation/plans/11-elaboration.md.

import type { Diagnostic } from '@term/make/code/parser/diagnostic'
import { diagnose } from '@term/make/code/parser/diagnostic'
import { parse } from '@term/make/code/parser/tree'
import { noteMetadataSites } from '@term/make/code/check/note-metadata'
import {
  expandTemplates,
  collectTemplates,
} from '@term/make/code/compile/template'
import type { Template } from '@term/make/code/compile/template'
import { mill } from '@term/make/code/compile/mill'
import { checkView, lowerView } from '@term/make/code/compile/view'
import { checkMillDefinition } from '@term/make/code/compile/mill-check'
import { resolve } from '@term/make/code/check/resolve'
import { check } from '@term/make/code/check/infer'
import { resolveAsync } from '@term/make/code/check/async-resolve'
import {
  disambiguateOverloads,
  overloadGroups,
} from '@term/make/code/check/overload'
import { extendForms } from '@term/make/code/check/extend'
import { bindFormsByImport } from '@term/make/code/check/scope'
import {
  checkPrivateFinds,
  checkPrivateReferences,
  warnPrivateNotes,
} from '@term/make/code/check/private'
import { checkTells } from '@term/make/code/check/tell'
import { checkRaiseBounds } from '@term/make/code/check/effects'
import { checkMissingBacks } from '@term/make/code/check/returns'
import { checkTypeNames } from '@term/make/code/check/type-names'
import { checkSupervision } from '@term/make/code/check/supervise'
import { buildRoll } from '@term/make/code/compile/roll'
import type { Roll } from '@term/make/code/compile/roll'
import { elaborateReport } from '@term/make/code/check/elaborate'
import { checkHolds } from '@term/make/code/check/holds'
import type { Tally } from '@term/make/code/check/holds'
import { checkTraits } from '@term/make/code/check/traits'
import { awaitsOutsideTasks, checkCallsOutsideTasks, checkEffects } from '@term/make/code/check/effects'
import {
  checkClaims,
  fillClaims,
  stampGrounded,
} from '@term/make/code/check/claim'
import {
  checkTotality,
  terminatingFunctions,
} from '@term/make/code/check/totality'
import {
  lengthKeepingFunctions,
  pureFunctions,
  returnsFreshFunctions,
  stateFreeFunctions,
} from '@term/make/code/check/facts'
import { uncertifiedCount } from '@term/make/code/check/refine'
import {
  hasContracts,
  lowerContracts,
} from '@term/make/code/check/contract'

// the terminating tasks, or none when the analysis fails: a crash there must cost proofs, never pass one
function safeTerminating(program: Program): Set<string> {
  try {
    return terminatingFunctions(program)
  } catch {
    return new Set()
  }
}
import { findUnused } from '@term/make/code/check/unused'
import { pruneToReachable } from '@term/make/code/ir/prune'
import { simplify } from '@term/make/code/ir/simplify'
import { passDictionaries } from '@term/make/code/ir/dictionary'
import { lowerZones } from '@term/make/code/compile/view-lower'
import { lowerRoutes } from '@term/make/code/compile/route-lower'
import { RENDER } from '@term/make/code/compile/render-names'
import { compileLookCss } from '@term/make/code/compile/look-css'
import { compileLookTable, styleTableText } from '@term/make/code/compile/look-table'
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
import type { ImportScope, ParseMemo } from '@term/make/code/compile/load'
import type { Resolver } from '@term/make/code/compile/load'
import { hashText } from '@term/make/code/term/hash'
import type { CompileCache } from '@term/make/code/compile/cache'
import type {
  Program,
  Statement,
  Twin,
} from '@term/make/code/compile/node'
import { checkTwins } from '@term/make/code/check/twin'
import { applyTwins, exposeTwins, guardTask, twinTask } from '@term/make/code/ir/twin'
import type { TwinChoices } from '@term/make/code/ir/twin'

// The render-runtime helpers that `lowerZones` (compile/view-lower.ts)
// synthesizes calls to when it lowers a `zone` component. Because that
// lowering runs after the reachability prune, these must be pinned as roots
// whenever a program contains a zone, or they get shaken out and dangle. The
// prune follows references, so pinning the render helpers keeps the dom
// primitives (set-attribute, append, ...) they call, transitively.
const ZONE_RENDER_RUNTIME: string[] = [
  ...Object.values(RENDER),
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
      // (`term hold`) holds to a baseline. note/term/proof-by-default/obligations.md
      obligations?: Tally
      // what the KERNEL did with this file's own tasks: proved the whole body as one term, checked it statement by
      // statement, or declined it (with the reason). A task nothing checked and a task the kernel proved looked the
      // same from outside until this was counted (proof-by-default-0005, 0012).
      kernel?: {
        proven: number
        commands: number
        declined: { name: string; reason: string }[]
      }
      // linear refutations the search found and the certificate checker refused during THIS compile. Carried on the
      // result so a cached compile still reports what its provers did (check/certificate.ts)
      uncertified?: number
      // present when `options.roll` was set: the roll of this entry's closure (compile/roll.ts)
      roll?: Roll
      // the `twin` declarations of the closure, checked (check/twin.ts). Beside the program, never in it: nothing
      // here emits one yet, so every build runs the reference (note/term/optimize/readme.md)
      twins?: Twin[]
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
    // whether a file's role rule carries `mark lean`: its bare heads are calls and its property heads are named
    // arguments. Off for every file no marked rule matches, which is almost all of them. See note/term/lean.md
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
      style: styleTableText(compileLookTable(source)),
      styleDark: styleTableText(compileLookTable(source, { scheme: 'dark' })),
      warnings: [],
    }
  }

  // a data file (the host dialect: `host` / `list` / `mesh` / `tree` / `fuse` and literals, no code) is not a program
  // either: it compiles to a module whose default export is the value as a JSON literal, keys in snake case,
  // anchors expanded. See code/compile/host.ts and note/term/host/.
  const role = options?.roleOf?.(source.file)

  if (role === 'host' || (!role && isDataFile(source))) {
    // the lean surface for data: only ever under the mark, since the content rule does not know it
    return compileData(source, role === 'host' && (options?.leanOf?.(source.file) ?? false))
  }

  // a mill DEFINITION (the `mill` role, deck/mill/role.tree): a dialect's `mine` and `mint` rules, which the
  // toolchain reads as a grammar and nothing runs. Held to what such a file owes (compile/mill-check.ts) and never
  // milled as code, which read every rule as a call to an undefined task and compiled every grammar file it loads.
  if (role === 'mill') {
    const checked = checkMillDefinition(source, options?.resolve)

    return checked.diagnostics.length > 0
      ? { ok: false, diagnostics: checked.diagnostics }
      : { ok: true, program: [], typescript: '', warnings: [] }
  }

  // collect the entry plus every module it loads (so the stdlib supplies the form definitions), dependencies
  // first, then mill each and merge into one program. Without a resolver this is just the single entry file.
  // one parse per module for the whole build: the dependency walk, the template scan and the mill all read from it.
  //
  // A BATCH DRIVER PASSES ITS OWN, shared across every entry it builds. Made here per compile otherwise, which is
  // right for one compile and ruinous for three thousand: see makeParseMemo in compile/load.ts.
  const parsed = options?.parsed ?? makeParseMemo()

  const collected = options?.resolve
    ? collectModules(source, options.resolve, parsed)
    : undefined
  const sources = collected ? collected.sources : [source]

  const cache = options?.cache

  // the effective tree-shaking flag: on by default for the optimized merged build (differential-verified across the
  // stdlib corpus), off in per-module mode and on the editor (`optimize: false`) path, explicit option wins
  const treeShake =
    options?.treeShake ??
    (!options?.modules && options?.optimize !== false)

  // output cache: an exact module graph (every file at its current content) compiles to one result. A re-save with
  // no edits anywhere is an instant hit.
  //
  // EACH UNIT'S ROLE AND LEAN ARE IN THE KEY, beside its text. The output level caches a FAILURE as readily as a
  // success, and a caller that compiled the same graph without the readers (the roll pass, the test runner, a
  // worker, all of which did on 2026-09-12) stored its unknown-name diagnostics under a key the fixed caller then
  // hit, so the fix read as not working until `term wash deck`. Text alone cannot tell the two reads apart (lean-0034).
  const graphKey =
    sources
      .map(unit => {
        const role = options?.roleOf?.(unit.file) ?? ''
        const lean = options?.leanOf?.(unit.file) ? '#lean' : ''

        return `${unit.file}@${hashText(unit.text)}${role ? `#${role}` : ''}${lean}`
      })
      .join('|') +
    (options?.modules ? '|modules' : '') +
    (options?.optimize === false ? '|raw' : '') +
    (options?.env ? `|env:${options.env}` : '') +
    (treeShake ? '|shake' : '') +
    // the await switch decides whether an un-ticked async call outside a task is refused, so a result cached under
    // one setting is not an answer under the other (check/effects.ts, `setAwaitOutsideTasks`)
    (awaitsOutsideTasks() ? '|await-outside' : '') +
    (options?.roll ? '|roll' : '') +
    // a different choice of implementation is a different program
    (options?.twins && Object.keys(options.twins).length ? `|twins:${JSON.stringify(options.twins)}` : '') +
    (options?.exposeTwins ? '|expose' : '') +
    // a mutant is a different program every time it is asked for, so it is never answered from the cache
    (options?.adjustTwins ? `|adjusted:${Math.random()}` : '') +
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
    const twins: Twin[] = []
    const roots = new Set<string>()
    // The merged program loses per-module provenance, so downstream passes (resolve, check) would otherwise blame
    // the entry file for an error living in an imported module. Each top-level statement's span records the file it
    // came from, and `merged` below tells the checker that the program is more than one module.

    for (const unit of sources) {
      // mill cache: reuse a module's parse + expand + mill when its text (and the template set) is unchanged
      // the role a project's `role.tree` gives this module. A `view` file is the sandboxed document dialect and is
      // read by compile/view.ts, not by the code mill. See note/term/view/06-mill.md.
      const unitRole = options?.roleOf?.(unit.file) ?? undefined
      // `mark lean` on the matched role rule: this unit's bare heads are calls and its property heads are named
      // arguments. IN THE CACHE KEY BELOW, because it changes what the unit mills to. Left out, a file that gains
      // the mark keeps its old AST until its text changes, and the bug reads as the feature not working at all.
      // Prefixed rather than appended, so it cannot be confused with a role whose name ends in the same letters.
      const unitLean = options?.leanOf?.(unit.file) ?? false
      const leanKey = unitLean ? 'lean:' : ''

      const milled = cache
        ? cache.milledUnit(
            `${leanKey}${unit.file}\u0000${templateKey}\u0000${unitRole ?? ''}`,
            unit.text,
            () => millUnit(unit, parsed, templates, unitRole, unitLean),
          )
        : millUnit(unit, parsed, templates, unitRole, unitLean)

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

    const compiled = compileProgram(
      program,
      source.file,
      roots,
      true,
      options?.modules,
      options?.optimize,
      options?.env,
      // explicit entry points imply pruning (application dead-code elimination)
      treeShake || (options?.entryPoints?.length ?? 0) > 0,
      options?.roll,
      options?.deckOf,
      collected?.scope,
      (options?.twins && Object.keys(options.twins).length > 0) || options?.exposeTwins
        ? {
            twins: options?.adjustTwins ? options.adjustTwins(structuredClone(twins)) : twins,
            choices: options?.twins ?? {},
            expose: options?.exposeTwins,
          }
        : undefined,
    )

    // `note <word>` written as metadata in the ENTRY file: the old spelling of `mark <word>`, read the same and warned
    // about (check/note-metadata.ts). Only the entry's own, the way `note-private` is, so a build does not repeat
    // every imported module's. `note private` keeps its own older warning
    const entryTree = parsed(source)
    const spelled =
      compiled.ok && entryTree.ok
        ? noteMetadataSites(entryTree.tree, source.text)
            .filter(site => site.word !== 'private')
            .map(site =>
              diagnose('note-metadata', {
                file: source.file,
                span: { ...site.span, file: source.file },
                message: `\`note ${site.word}\` is the old spelling of \`mark ${site.word}\``,
              }),
            )
        : []
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

  // the output cache stores a JSON-serialized result, which cannot hold the per-module `Map`. So in per-module mode we
  // skip the output level (and still get mill-level reuse, used inside `build`). The merged path caches as before.
  return cache && !options?.modules
    ? cache.output(graphKey, build)
    : build()
}

// a data file to a TypeScript module: `export default <json>`. The value is also exported as `data`, so a Term
// program that loads the module through the per-module path has a name to find.
function compileData(source: { file: string; text: string }, lean = false): CompileResult {
  const read = readDataText(source, lean)

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
  lean?: boolean,
):
  | { ok: true; program: Program; twins?: Twin[] }
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
    const read = checkView(unit, { tree: parsed.tree, templates, lean })

    if (!read.ok) {
      return { ok: false, diagnostics: read.diagnostics }
    }

    return { ok: true, program: lowerView(read.file) }
  }

  const expanded = expandTemplates(parsed.tree, templates)

  return mill(expanded, unit.file, role, lean)
}

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
  wantRoll?: boolean,
  deckOf?: (file: string) => { name: string; root: string } | undefined,
  // what each module imports by name, so a call to a name two modules define binds to the one its file imported
  scope?: ImportScope,
  // the chosen implementations, with the closure's twins (ir/twin.ts)
  selected?: { twins: Twin[]; choices: TwinChoices; expose?: boolean },
): CompileResult {
  // the certificate checker's refusals so far, so this compile can report its own
  const uncertifiedBefore = uncertifiedCount()

  // module scope for forms: a form two files define is split by file, and every reference bound by its file's import,
  // before anything below reads a form by name (module-scope-0003, check/scope.ts)
  const formScope = bindFormsByImport(program, scope, file)

  if (formScope.length) {
    return { ok: false, diagnostics: formScope }
  }

  // ROUTE TABLES LOWER HERE, before names are bound and checked (native-navigation-0002). The lowering used to run
  // inside the TypeScript emitter alone, after the checker, so Swift, Kotlin and Rust got no `route` and no `boot` (a
  // native app could not use a `hook` table), the dispatcher's parameters were never typed, and the helpers it calls
  // could be shaken out first. Lowered here, every backend receives a checked dispatcher, and the route runtime it
  // calls arrives through compile/load.ts's injection. The two functions are the app's entry: nothing in the program
  // calls them, the platform does, so they are roots
  const routed = lowerRoutes(program, env ?? 'node')

  if (routed !== program) {
    program = routed
    roots?.add('route')
    roots?.add('boot')
  }

  // form extension: resolve every `form x` that is `like <base>` with children into an ordinary record, and finish
  // every `halt <form>` raise, before any name is bound. See code/check/extend.ts.
  const extendDiagnostics = extendForms(program, file, { deckOf })

  if (extendDiagnostics.length) {
    return { ok: false, diagnostics: extendDiagnostics }
  }

  // every type a task or form of this file names is one the program has, read before seeding turns an unknown name
  // into a hole (check/type-names.ts)
  const typeNameDiagnostics = checkTypeNames(program, file)

  if (typeNameDiagnostics.length) {
    return { ok: false, diagnostics: typeNameDiagnostics }
  }

  // arity overloading: rename same-name / different-arity functions (and their calls) to unique `name__<arity>` names,
  // so everything downstream sees one definition per name. See code/check/overload.ts. It refuses two bodied
  // definitions of one name from two files that a call's own imports do not tell apart (native-dom-0031)
  // `mark private`: a `find` of a name private to the file it names is refused, before overloads rename anything,
  // so the found name is compared as written (check/private.ts)
  const privateFinds = checkPrivateFinds(program, scope, deckOf)

  if (privateFinds.length) {
    return { ok: false, diagnostics: privateFinds }
  }

  const ambiguities = disambiguateOverloads(program, scope, file)

  if (ambiguities.length) {
    return { ok: false, diagnostics: ambiguities }
  }

  // the chosen implementations, BEFORE names are bound, so the twins and the dispatch are checked like any task
  if (selected) {
    if (selected.expose) {
      // and kept: nothing calls them, so dead-code removal would take them back out
      for (const twin of exposeTwins(program, selected.twins)) {
        roots?.add(twinTask(twin.of, twin.name))
        roots?.add(guardTask(twin.of, twin.name))
        roots?.add(twin.of)
      }
    }

    const refused = applyTwins(program, selected.twins, selected.choices, env, file)

    if (refused.length) {
      return { ok: false, diagnostics: refused }
    }
  }

  // hole-filling: bind names to definitions
  const resolveDiagnostics = resolve(program, file)

  if (resolveDiagnostics.length) {
    return { ok: false, diagnostics: resolveDiagnostics }
  }

  // `mark private`: a call to, or a value reference of, a task private to another file. After the resolver, so a
  // local that shares the name is bound to itself and never refused (check/private.ts)
  const privateReferences = checkPrivateReferences(program, file, deckOf)

  if (privateReferences.length) {
    return { ok: false, diagnostics: privateReferences }
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

  // a claim's fill inherits the claim's signature, so a proof states the name and its parameters and the type is
  // written once, on the rule. Runs BEFORE the checker so the fill's body is checked against the claim. claim.ts.
  fillClaims(program)

  // the types as written, before the surface pass seeds them (lossily, on purpose), for the kernel. node.ts `declared`
  for (const statement of program) {
    if (statement.form === 'function') {
      statement.declared = {
        params: statement.params.map(p =>
          p.type ? structuredClone(p.type) : undefined,
        ),
        ...(statement.result
          ? { result: structuredClone(statement.result) }
          : {}),
      }
    }
  }

  // formal type checking: the surface pass (gradual bidirectional inference) annotates the AST with types
  const checkDiagnostics = check(program, file, merged)
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
  // and outside every task, where nothing can wait, a call to an async task is `tick`ed or refused (behind the
  // switch until the repository is migrated: check/effects.ts, `setAwaitOutsideTasks`)
  const effectDiagnostics = [...checkEffects(program, file), ...checkCallsOutsideTasks(program, file)]

  if (effectDiagnostics.length) {
    return { ok: false, diagnostics: effectDiagnostics }
  }

  // the claim wall: a `rule` states a claim and a `task` of the same name proves it. An unfilled claim is refused,
  // and code that runs may not call one. `note open` leaves a claim deliberately open, counted here so the build
  // line and the gate can report it rather than pass it in silence. See check/claim.ts.
  const claimEvidence = {
    verified: new Set(elaboration.proven),
    terminating: safeTerminating(program),
    pure: pureFunctions(program),
    declined: new Map(elaboration.declined.map(d => [d.name, d.reason])),
  }

  // every task records whether it may carry a proof, so a stub taken from this unit tells a dependent unit, which
  // sees the signature only (check/claim.ts groundingOf)
  stampGrounded(program, claimEvidence)

  const claims = checkClaims(program, file, claimEvidence)

  if (claims.diagnostics.length) {
    return { ok: false, diagnostics: claims.diagnostics }
  }

  // refinement layer 2: discharge `hold` verification conditions. The linear prover handles the linear fragment, and
  // holds the kernel already proved by definitional equality are dropped. BOTH remaining outcomes are errors since
  // 2026-09-18: a hold the prover refutes, and a hold it could not reach. Not proven is not proven, and a claim
  // nobody checked must not compile as though somebody had. See note/term/project/law-proof-gate.md.
  const undischarged = (d: Diagnostic): boolean =>
    !d.markers.some(m =>
      kernelDischarged.has(`${m.span.start.line}:${m.span.start.column}`),
    )

  // THIS FILE'S OWN TASKS are checked in the checker's copy below, where a task's `have` wraps its body and a
  // callee's `must` follows its call, so the holds the programmer wrote may use both. Every other task (an import,
  // whose own file checks its contracts) is checked here, as written.
  const checked = lowerContracts(program, { file, tier0: true })
  const holdDiagnostics = checkHolds(program, file, {
    skip: checked.lowered,
  }).filter(undischarged)

  // contracts: every `have` / `must` / `down` lowered into holds in a copy of the program only the checker reads,
  // and discharged by the same provers. A contract the programmer wrote is owed like a hold they wrote, so an
  // unproven one fails the build. check/contract.ts.
  //
  // TIER 0 rides in the same copy: every list read and division in this file's own tasks owes a hold, counted in
  // `obligations` rather than failed. The copy is skipped only when there is neither a contract nor a task of this
  // file to write obligations for.
  const obligations: Tally = { total: 0, proven: 0, failed: [] }

  // the kernel's verdict on this file's own tasks, by name
  const stampedProgram = program.some(
    s => s.form === 'function' && s.span.file !== undefined,
  )
  const ownNames = new Set(
    program
      .filter(
        s =>
          s.form === 'function' &&
          !s.claim &&
          !s.stub &&
          (stampedProgram ? s.span.file === file : true),
      )
      .map(s => (s as { name: string }).name),
  )
  const provenSet = new Set(elaboration.proven)
  const kernel = {
    proven: elaboration.proven.filter(n => ownNames.has(n)).length,
    commands: elaboration.verified.filter(
      n => ownNames.has(n) && !provenSet.has(n),
    ).length,
    declined: elaboration.declined.filter(d => ownNames.has(d.name)),
  }

  holdDiagnostics.push(
    ...checkHolds(checked.program, file, {
      tally: obligations,
      // this file's own tasks, every hold in them: the programmer's and the checker's
      only: checked.lowered,
      // the holds written into the copy call nothing the real tasks did not, so purity is the real program's
      pure: pureFunctions(program),
      stateFree: stateFreeFunctions(program),
      keeping: lengthKeepingFunctions(program),
      returning: returnsFreshFunctions(program),
    }).filter(undischarged),
  )

  // the running counter is how ordinals were assigned, not part of the answer, and a Map does not survive the
  // output cache's JSON anyway
  delete obligations.seen

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
    ...warnPrivateNotes(program, file),
    ...totality.warnings,
    ...holdWarnings,
  ]

  // the app's `tell` decisions: each must name an exception the program can raise, with props it declares
  const tellDiagnostics = checkTells(program, file, deckOf)

  if (tellDiagnostics.length) {
    return { ok: false, diagnostics: tellDiagnostics }
  }

  // a task that bounds its raise set with `halt` lines on its signature is held to them
  const boundDiagnostics = checkRaiseBounds(program, file)

  if (boundDiagnostics.length) {
    return { ok: false, diagnostics: boundDiagnostics }
  }

  // every path through a task that promises a value sends one back (check/returns.ts)
  const backDiagnostics = checkMissingBacks(program, file)

  if (backDiagnostics.length) {
    return { ok: false, diagnostics: backDiagnostics }
  }

  // supervision trees: a transient worker whose work can raise nothing never restarts (check/supervise.ts)
  const supervisionDiagnostics = checkSupervision(program, file)

  if (supervisionDiagnostics.length) {
    return { ok: false, diagnostics: supervisionDiagnostics }
  }

  // the roll is built from the checked, un-simplified program, so every task is still there to be listed
  const roll = wantRoll
    ? buildRoll(program, file, { deckOf })
    : undefined

  // what wakes the hive: every deck with its exceptions and tells, whether or not a roll was asked for. Cheap, and
  // only emitted when the program loads the stdlib hive.
  const wake = program.some(s => s.form === 'function' && s.name === 'hive-wake')
    ? wakeGroups(buildRoll(program, file, { deckOf }))
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
    // Each statement's origin rides along on its span, which `structuredClone` copies, so the clone needs no
    // fixup. The map this replaced needed an index-paired loop here, and would have misattributed an entire module
    // had the clone ever reordered.
    const cloned = structuredClone(program)

    tsProgram = passDictionaries(cloned)
  }

  // per-module mode: emit one ESM module per source file from the checked (pre-simplify) program, so module boundaries
  // survive (no cross-module forwarder inlining). The dev server serves these lazily. See code/compile/modules.ts.
  if (modulesUrl) {
    return {
      ok: true,
      program: tsProgram,
      typescript: '',
      modules: emitModules(tsProgram, modulesUrl),
      warnings,
      ...(claims.open.length ? { openClaims: claims.open } : {}),
    obligations,
    kernel,
    uncertified: uncertifiedCount() - uncertifiedBefore,
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
      ...(claims.open.length ? { openClaims: claims.open } : {}),
    obligations,
    kernel,
    uncertified: uncertifiedCount() - uncertifiedBefore,
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
    ...(claims.open.length ? { openClaims: claims.open } : {}),
    obligations,
    kernel,
    uncertified: uncertifiedCount() - uncertifiedBefore,
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
