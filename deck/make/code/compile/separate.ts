// Separate compilation with cross-boundary early cutoff: what `term make` runs since 2026-10-05 (`--merged` is the
// whole-program build). See note/term/incremental-compilation.md.
//
// Where `compile()` merges the whole import closure into one program and checks + emits it as a blob,
// `compileSeparate()` partitions the module graph into UNITS (the strongly connected components of the graph
// collectModules walked, injected runtimes included: a unit is a module or a cyclic module group), then checks and
// emits each unit separately, in dependency order:
//
//   - a unit is checked against the STUBS of the units it depends on (their checked, body-less surface, each task
//     carrying what the whole-program analyses found about its body, see compile/stub.ts), never against their bodies
//   - a unit emits only its OWN modules (per-module ESM, the same shape the dev server serves), with imports
//     reconnecting cross-unit references under the names each module exports
//   - a unit's result is cached keyed by its own content + the SURFACE hashes of its dependencies, so an edit that
//     leaves a dependency's surface unchanged replays every dependent unit from cache: EARLY CUTOFF
//   - a unit is named the same way whichever entry reached it, so its module is one module
//
// It agrees with `compile()` on what each file builds and refuses: `pnpm term:separate-diff` holds the two side by side
// over a package, and test/compile/separate.ts the cutoff, the names and the emitted modules running.
//
// The unit result (stubs included) is JSON-serializable, so the cache persists across processes and can be shared.

import type { Diagnostic } from '@term/make/code/parser/diagnostic'
import type {
  Program,
  Statement,
  Twin,
} from '@term/make/code/compile/node'
import { collectModules, makeParseMemo } from '@term/make/code/compile/load'
import type { ParseMemo, Resolver } from '@term/make/code/compile/load'
import { compileProgram, entryWarnings, graphTemplates, milledModule } from '@term/make/code/compile/compile'
import type { ModuleEmit } from '@term/make/code/compile/modules'
import { stubKnown, stubProgram, surfaceHash } from '@term/make/code/compile/stub'
import { contentHash, hashFields } from '@term/make/code/compile/cache'
import type { CompileCache } from '@term/make/code/compile/cache'
import { awaitsOutsideTasks } from '@term/make/code/check/effects'
import { checkTwins } from '@term/make/code/check/twin'
import type { Tally } from '@term/make/code/check/holds'

export type SeparateResult =
  | {
      ok: true
      // every emitted module across all units (file -> emit), in dependency order
      modules: Map<string, ModuleEmit>
      warnings: Diagnostic[]
      // the entry's own open claims and tier-0 obligations, as `compile()` reports them
      openClaims?: string[]
      obligations?: Tally
      // WHAT THE MERGED BUILD'S ARTIFACT EXPORTED: every public task, constant and type of the entry's whole closure,
      // the standard library's included, each the LAST definition of its name in dependency order (the merged emit's
      // dedup), with the module that exports it and the name it exports it by. The entry's classic artifact re-exports
      // these, so a TypeScript importer reading `tonePack` off `host/code/seal/base` still finds it (zone's tests)
      exports: { name: string; exported: string; file: string; type: boolean }[]
      // observability (and the early-cutoff tests): units rebuilt vs replayed from cache this run
      built: string[]
      reused: string[]
    }
  | { ok: false; diagnostics: Diagnostic[] }

// one unit's cached build: its own modules' emits, its public stub surface (for dependents), and its warnings.
// Everything is JSON-serializable so the entry persists.
export type UnitBuild = {
  files: [string, ModuleEmit][]
  stubs: [string, Statement[]][]
  interfaceHash: string
  warnings: Diagnostic[]
  openClaims?: string[]
  obligations?: Tally
}

// A unit's answer, a build or what stopped it. A project build hands the same map to every entry, so a unit the
// closure of many entries shares (the standard library's) is read once per run rather than once per entry
export type UnitMemo = Map<string, UnitBuild | { diagnostics: Diagnostic[] }>

// Tarjan strongly connected components over the file import graph. Returns units in REVERSE topological order of
// the condensation (dependencies first), which is exactly the build order.
function units(
  files: string[],
  edges: Map<string, string[]>,
): string[][] {
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const out: string[][] = []

  let counter = 0

  function strongConnect(v: string): void {
    index.set(v, counter)
    low.set(v, counter)
    counter++
    stack.push(v)
    onStack.add(v)

    for (const w of edges.get(v) ?? []) {
      if (!index.has(w)) {
        strongConnect(w)
        low.set(v, Math.min(low.get(v)!, low.get(w)!))
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, index.get(w)!))
      }
    }

    if (low.get(v) === index.get(v)) {
      const component: string[] = []

      let w: string

      do {
        w = stack.pop()!
        onStack.delete(w)
        component.push(w)
      } while (w !== v)

      out.push(component)
    }
  }

  for (const f of files) {
    if (!index.has(f)) {
      strongConnect(f)
    }
  }

  // Tarjan emits components in reverse topological order of the condensation already (a component is finished only
  // after everything it reaches), which is dependencies-first: the build order.
  return out
}

export function compileSeparate(
  source: { file: string; text: string },
  options: {
    resolve: Resolver
    cache?: CompileCache
    // maps a source file to the URL/path its emitted module is imported by (same contract as compile()'s `modules`)
    modules: (file: string) => string
    env?: string
    // the role a project's role.tree gives a file, same contract as compile()'s `roleOf`. The mill needs it to
    // tell a CLI `hook` from a route one (`role call` vs `role site`), so a unit compiled here must be asked the
    // same question a unit compiled through compile() is, or the two paths disagree about what a file means.
    roleOf?: (file: string) => string | null | undefined
    // `mark lean` on the unit's role rule, same contract as compile()'s `leanOf`. Asked here for the same reason
    // roleOf is: a unit compiled separately must read the way one compiled through the merged path reads.
    leanOf?: (file: string) => boolean | undefined
    // the deck a file belongs to, same contract as compile()'s `deckOf`: it names the host of every raise
    deckOf?: (file: string) => { name: string; root: string } | undefined
    // a parse memo shared across a batch build, same contract as compile()'s `parsed`
    parsed?: ParseMemo
    // the unit answers of this run, shared across the entries of a batch build (`UnitMemo`)
    units?: UnitMemo
  },
): SeparateResult {
  // one parse per module, shared by the dependency walk, the edge graph, the templates and the mill
  const parsed = options.parsed ?? makeParseMemo()
  const cache = options.cache
  const collected = collectModules(
    source,
    options.resolve,
    parsed,
    cache ? (unit, compute) => cache.scanned(unit.file, unit.text, compute) : undefined,
  )
  const { sources } = collected

  // a load the build cannot answer is refused with its own cause, as compile() refuses it
  const loadErrors = collected.diagnostics.filter(d => d.severity !== 'warning')

  if (loadErrors.length > 0) {
    return { ok: false, diagnostics: loadErrors }
  }

  // the edges the walk itself followed, injected runtimes included: reading the written imports again missed the route
  // runtime a `hook` table is given, so a route's unit never saw the `view` form its dispatcher names
  const edges = collected.edges
  const order = units(
    sources.map(s => s.file),
    edges,
  )

  const byFile = new Map(sources.map(s => [s.file, s]))

  // templates are global (a module's `fuse` can expand a template an import defines), so gather them once, exactly
  // as compile() does. The fingerprint joins the key of a unit only when one of its modules can expand a template
  const { templates, templateKey } = graphTemplates(sources, parsed)

  // transitive dependency units of each unit, from the condensation
  const unitOf = new Map<string, number>()
  order.forEach((files, i) =>
    files.forEach(f => unitOf.set(f, i)),
  )

  const unitDeps: Set<number>[] = order.map((files, i) => {
    const deps = new Set<number>()

    for (const f of files) {
      for (const d of edges.get(f) ?? []) {
        const u = unitOf.get(d)!

        if (u !== i) {
          deps.add(u)
        }
      }
    }

    return deps
  })

  // close over transitivity (a unit sees the stubs of everything it reaches: the flat namespace means a module may
  // reference names its direct imports re-surface)
  const reach: Set<number>[] = order.map(() => new Set<number>())

  for (let i = 0; i < order.length; i++) {
    for (const d of unitDeps[i]!) {
      reach[i]!.add(d)

      for (const t of reach[d]!) {
        reach[i]!.add(t)
      }
    }
  }

  const builds: UnitBuild[] = []
  const built: string[] = []
  const reused: string[] = []
  const allModules = new Map<string, ModuleEmit>()
  const allWarnings: Diagnostic[] = []

  let openClaims: string[] | undefined
  let obligations: Tally | undefined
  const surface = new Map<string, { name: string; exported: string; file: string; type: boolean }>()

  for (let i = 0; i < order.length; i++) {
    const files = order[i]!
    const label = files.join('+')

    // THE ENTRY'S OWN UNIT IS CHECKED AS THE ENTRY. compile() holds the file it was asked to build to everything a
    // file owes (its binds, its finds, its duplicates, its claims) and an imported module only to what the program as
    // a whole owes, which that module meets again when it is built as an entry itself. A unit compiled here is asked
    // the same way: as the entry when the entry is in it, and otherwise under a name no statement carries, so a
    // dependency unit's answer does not depend on which entry reached it and is shared by every one that does
    const entry = files.includes(source.file)
    const asImport = `${files[0]}#unit`
    // A ONE-FILE UNIT IS CHECKED AS ITSELF, whichever entry reached it, since that is the build its own file gets
    // when it is the entry. Compiled once as itself and once as an import, @term/bind's 3,091 files were each checked
    // twice. Checked as itself it is held to more, never less, so an answer that builds is the import's answer too,
    // and only one that fails is asked again as an import, which may build (`answer` below)
    const asSelf = entry ? source.file : files.length === 1 ? files[0]! : undefined

    // the unit key: own content (with each module's role and lean, which change what it mills to) + the interface
    // hash of every reachable dependency unit + whatever else shapes the answer. A body-only dependency edit leaves
    // its interface hash unchanged, so this key, and the cached build it points at, survive: early cutoff.
    const depHashes = [...reach[i]!]
      .map(d => builds[d]!.interfaceHash)
      .sort()

    const usesTemplates = files.some(f => options.roleOf?.(f) === 'view' || /\bfuse\b/.test(byFile.get(f)!.text))

    const keyAs = (checkedAs: string): string => hashFields([
      'separate',
      usesTemplates ? templateKey : '',
      options.env ?? '',
      checkedAs === asImport ? '' : `entry:${checkedAs}`,
      // the await switch decides whether an un-ticked async call outside a task is refused (check/effects.ts)
      awaitsOutsideTasks() ? 'await-outside' : '',
      ...files.map(f => {
        const role = options.roleOf?.(f) ?? ''
        const lean = options.leanOf?.(f) ? '#lean' : ''

        return `${f}@${contentHash(byFile.get(f)!.text)}${role ? `#${role}` : ''}${lean}`
      }),
      ...depHashes,
    ])

    const make = (checkedAs: string): UnitBuild | { diagnostics: Diagnostic[] } => {
      // dependency context: the stubs of every reachable unit, dependency order preserved. Copied, because the checker
      // annotates what it is handed and one unit's stubs are read by every unit after it
      const program: Program = []
      for (const d of [...reach[i]!].sort((a, b) => a - b)) {
        for (const [file, statements] of builds[d]!.stubs) {
          for (const s of structuredClone(statements)) {
            s.span.file = file
            program.push(s)
          }
        }
      }

      const ownStart = program.length
      const twins: Twin[] = []

      for (const f of files) {
        const unit = byFile.get(f)!
        const milled = milledModule(unit, {
          parsed,
          templates,
          templateKey,
          cache,
          role: options.roleOf?.(unit.file) ?? undefined,
          lean: options.leanOf?.(unit.file) ?? false,
        })

        if (!milled.ok) {
          return { diagnostics: milled.diagnostics }
        }

        for (const s of milled.program) {
          s.span.file = unit.file
          program.push(s)
        }

        for (const twin of milled.twins ?? []) {
          twin.span.file = unit.file
          twins.push(twin)
        }
      }

      const ownStatements = program.slice(ownStart)
      // ONE NAMING PER UNIT, whichever entry reached it: the unit's own (first) file keeps its names, as the merged
      // build keeps the entry's. Where two files define a name, the merged build keeps the entry's and renames the rest
      // (check/overload.ts), so the same module compiled as an entry and as a dependency exported two sets of names,
      // and the `.unit` artifact both write held whichever came first. Named under no file at all it was stable but
      // wrong: a module's own task `for-of` was renamed beside a case `for-of` of an imported form, and its own calls
      // reached the case (make's test/engine.tree). A cycle of several files keeps its first file's, and a task of
      // another file in it that is renamed is re-exported under its written name by an entry's shim (`renamed`
      // below). No roots either: in a unit every task is reachable from outside it, so none is marked internal
      const result = compileProgram(
        program,
        checkedAs,
        undefined,
        true,
        options.modules,
        undefined,
        options.env,
        false,
        false,
        options.deckOf,
        collected.scope,
        undefined,
        undefined,
        files[0],
      )

      if (!result.ok) {
        return { diagnostics: result.diagnostics }
      }

      // a twin is checked against the program it twins a task of, as compile() checks it
      const refused = twins.length > 0 ? checkTwins(program, twins, checkedAs) : []

      if (refused.length > 0) {
        return { diagnostics: refused }
      }

      // this unit's emits: only its own files (stub buckets belong to their owning units)
      const own = new Set(files)
      const filesOut: [string, ModuleEmit][] = []

      for (const [file, emit] of result.modules ?? []) {
        if (own.has(file)) {
          filesOut.push([file, emit])
        }
      }

      // the stub surface dependents will check against, per own file, from the in-place annotated statements (the
      // checker zonks types onto these objects, so inferred signatures are part of the surface), each task carrying
      // what the whole-program analyses found about it here, where its body is (compile/stub.ts `stubKnown`)
      const known = stubKnown(program)
      const stubbed: [string, Statement[]][] = files.map(f => [
        f,
        stubProgram(ownStatements.filter(s => s.span.file === f), known),
      ])

      const surface = stubbed.flatMap(([, list]) => list)

      return {
        files: filesOut,
        stubs: stubbed,
        interfaceHash: surfaceHash(surface),
        warnings: result.warnings,
        // what the file states and owes, which compile() reports when it is the entry
        ...(checkedAs !== asImport && result.openClaims?.length ? { openClaims: result.openClaims } : {}),
        ...(checkedAs !== asImport && result.obligations ? { obligations: result.obligations } : {}),
      }
    }

    let ran = false

    // the unit checked as `checkedAs`: this run's answer first, then the cache (memory, then disk), then a build
    const answer = (checkedAs: string): UnitBuild | { diagnostics: Diagnostic[] } => {
      const key = keyAs(checkedAs)
      const memo = options.units?.get(key)
      const wrapped = (): UnitBuild | { diagnostics: Diagnostic[] } => {
        ran = true

        return make(checkedAs)
      }
      const found =
        memo ??
        (cache
          ? cache.output<UnitBuild | { diagnostics: Diagnostic[] }>(`unit:${key}`, wrapped)
          : wrapped())

      options.units?.set(key, found)

      return found
    }

    let cached = answer(asSelf ?? asImport)

    // a one-file unit that fails as itself may still build as an import: an import is held only to what the program
    // as a whole owes, as the merged build holds a module it reaches
    if ('diagnostics' in cached && !entry && asSelf !== undefined) {
      cached = answer(asImport)
    }

    if ('diagnostics' in cached) {
      return { ok: false, diagnostics: cached.diagnostics }
    }

    ;(ran ? built : reused).push(label)
    builds.push(cached)

    for (const [file, emit] of cached.files) {
      allModules.set(file, emit)
    }

    allWarnings.push(...cached.warnings)

    if (entry) {
      openClaims = cached.openClaims
      obligations = cached.obligations
    }

    // the surface, in dependency order, so a later definition of a name replaces an earlier one (`exports`)
    for (const [file, statements] of cached.stubs) {
      for (const s of statements) {
        if (s.form === 'function' || s.form === 'let') {
          surface.set(`value:${s.name}`, { name: s.name, exported: s.stubExport ?? s.name, file, type: false })
        } else if (s.form === 'record-type' || s.form === 'mask') {
          surface.set(`type:${s.name}`, { name: s.name, exported: s.stubExport ?? s.name, file, type: true })
        }
      }
    }
  }

  // the entry's own spelling, warned about once, for the file the build was asked for
  allWarnings.push(...entryWarnings(source, sources, parsed))

  return {
    ok: true,
    modules: allModules,
    warnings: allWarnings,
    ...(openClaims ? { openClaims } : {}),
    ...(obligations ? { obligations } : {}),
    exports: [...surface.values()],
    built,
    reused,
  }
}
