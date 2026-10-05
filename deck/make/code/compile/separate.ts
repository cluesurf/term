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
import type { ImportScope, ParseMemo, Resolver, WalkMemo } from '@term/make/code/compile/load'
import { compileProgram, entryWarnings, graphTemplates, milledModule } from '@term/make/code/compile/compile'
import type { ModuleEmit } from '@term/make/code/compile/modules'
import { nameDefs, namesUsed, stubKnown, stubProgram, surfaceHash } from '@term/make/code/compile/stub'
import type { NameDef } from '@term/make/code/compile/stub'
import { namesPrinted, namesReachedIndexed } from '@term/make/code/compile/names'
import type { DefAt } from '@term/make/code/compile/names'

// more definitions than any one unit holds, so a place's key (`unit * span + at`) sorts by unit and then by place
const NAME_SPAN = 1_000_000
import { why } from '@term/make/code/compile/explain'
import type { UnitInputs } from '@term/make/code/compile/explain'

// `term make --explain` (step 6): the inputs each unit was last built from, kept under the unit's identity, and why
// each unit built this run was built, by its label
export type UnitExplain = {
  recall: (id: string) => UnitInputs | undefined
  remember: (id: string, inputs: UnitInputs) => void
  reasons: Map<string, string[]>
}
import { contentHash, hashFields, reviveBigint, storeBigint } from '@term/make/code/compile/cache'
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
      // every unit's key in the entry's closure, as one: it moves exactly when a file the entry reaches, a role, a
      // lean or a setting does, so what is computed from the whole closure (the roll) is cached by it
      // (note/term/plan/incremental-best-in-class.md, step 8)
      closureKey: string
      // every native module the closure docks, from its units' stubs, which carry them whole: what a program built from
      // these modules needs in front of it (compile/native.ts `nativePrelude`), as the merged program's statements gave
      natives: Statement[]
      // every route and command the closure declares, each unit's own `dock` statements in dependency order
      docks: Statement[]
      // with `keepProgram`: the entry unit's checked program, its stubs before its own statements, when that unit was
      // built this run (an editor's keystroke always builds it), and the stubs of every unit the entry reaches, typed,
      // which is every signature the closure offers
      program?: Program
      surface?: Program
    }
  | { ok: false; diagnostics: Diagnostic[] }

// one unit's cached build: its own modules' emits, its public stub surface (for dependents), and its warnings.
// Everything is JSON-serializable so the entry persists.
export type UnitBuild = {
  files: [string, ModuleEmit][]
  stubs: [string, Statement[]][]
  interfaceHash: string
  // each stub definition as the name-level cutoff reads it, in the order of `stubs` (compile/names.tree)
  defs: NameDef[]
  // the unit's own routes and commands (`dock` statements, checked): what a program built from units dispatches on
  // (call/code/boot.ts `commandRoutes`), which a stub does not carry
  docks?: Statement[]
  warnings: Diagnostic[]
  openClaims?: string[]
  obligations?: Tally
}

// A unit's answer, a build or what stopped it. A project build hands the same map to every entry, so a unit the
// closure of many entries shares (the standard library's) is read once per run rather than once per entry
export type UnitMemo = Map<string, UnitBuild | { diagnostics: Diagnostic[] }>

// A deck's root written as a token (`␞@term/base␞`), and read back as this machine's. Longest root first, so a deck
// nested inside another is written as itself. The token's mark is a character no path and no compiler output holds
const ROOT_MARK = '␞'

export type Portable = { out: (text: string) => string; in: (text: string) => string }

export function portableBy(decks: { name: string; root: string }[]): Portable {
  const named = new Map<string, string>()

  for (const deck of decks) {
    named.set(deck.root, deck.name)
  }

  const roots = [...named].sort((a, b) => b[0].length - a[0].length)

  return {
    out: text => roots.reduce((into, [root, name]) => into.split(root).join(`${ROOT_MARK}${name}${ROOT_MARK}`), text),
    in: text =>
      text.includes(ROOT_MARK) ? roots.reduce((into, [root, name]) => into.split(`${ROOT_MARK}${name}${ROOT_MARK}`).join(root), text) : text,
  }
}

// Tarjan strongly connected components over the file import graph. Returns units in REVERSE topological order of
// the condensation (dependencies first), which is exactly the build order.
export function units(
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
    // each module's own part of the import walk, shared across the entries of a batch build (compile/load.ts)
    walked?: WalkMemo
    // why each unit this run builds was built (`term make --explain`)
    explain?: UnitExplain
    // hand back what the editor reads (`program`, `surface`): the language server (flow/code/server.ts)
    keepProgram?: boolean
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
    options.walked,
  )
  const { sources } = collected

  // a load the build cannot answer is refused with its own cause, as compile() refuses it
  const loadErrors = collected.diagnostics.filter(d => d.severity !== 'warning')

  if (loadErrors.length > 0) {
    return { ok: false, diagnostics: loadErrors }
  }

  // THE SAME UNIT IS THE SAME ENTRY ON EVERY MACHINE (step 13). A unit's key, its fingerprints and its stored answer
  // name files by where they are on this disk, so a second clone of the repository at another path missed every one.
  // Each deck's root is written as a token in all three, and read back as this machine's
  const portable = portableBy(sources.map(s => options.deckOf?.(s.file)).filter(deck => deck !== undefined))

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

  // WHAT A UNIT IS CHECKED WITH IS ITS OWN, and what it reaches. The walk's import scope holds every file the entry
  // reached, the files that IMPORT a unit among them, and handed whole to a unit's check it let an importer decide the
  // unit's answer: `a.tree`, checked inside `main.tree`'s build, failed with main's `find` of a private task of a, and
  // that answer was kept and handed to `public.tree`, which imports a and refers to nothing private (the language
  // server's suite found it). Neither the unit's key nor its cache knew the importer was there
  const scopeOf = (unit: number): ImportScope => {
    const sees = new Set([...order[unit]!, ...[...reach[unit]!].flatMap(d => order[d]!)])

    return new Map([...collected.scope].filter(([file]) => sees.has(file)))
  }

  const builds: UnitBuild[] = []
  const built: string[] = []

  // THE BUILD'S NAME INDEX (step 4, compile/names.tree `names-reached-indexed`): each name to where it is defined,
  // unit by unit, grown as units are answered. A unit reaches only units answered before it, so the index holds
  // everything its walk can take
  const nameIndex = new Map<string, DefAt[]>()
  const unitDefs: NameDef[][] = []

  const indexNames = (upTo: number): void => {
    while (unitDefs.length < upTo) {
      const unit = unitDefs.length
      const defs = builds[unit]!.defs ?? nameDefs(builds[unit]!.stubs.flatMap(([, list]) => list), portable.out)
      unitDefs.push(defs)

      defs.forEach((def, at) => {
        for (const name of def.gives) {
          let places = nameIndex.get(name)

          if (!places) {
            places = []
            nameIndex.set(name, places)
          }

          places.push({ unit, at })
        }
      })
    }
  }
  const reused: string[] = []
  const allModules = new Map<string, ModuleEmit>()
  const allWarnings: Diagnostic[] = []

  let openClaims: string[] | undefined
  let obligations: Tally | undefined
  const surface = new Map<string, { name: string; exported: string; file: string; type: boolean }>()
  const closureKeys: string[] = []
  const natives: Statement[] = []
  const docks: Statement[] = []
  // `keepProgram`: the entry unit's checked program, and every unit's stubs
  let entryProgram: Program | undefined
  const surfaceProgram: Program = []

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

    const ownKey = (checkedAs: string): string[] => [
      'separate',
      usesTemplates ? templateKey : '',
      options.env ?? '',
      checkedAs === asImport ? '' : `entry:${portable.out(checkedAs)}`,
      // the await switch decides whether an un-ticked async call outside a task is refused (check/effects.ts)
      awaitsOutsideTasks() ? 'await-outside' : '',
      ...files.map(f => {
        const role = options.roleOf?.(f) ?? ''
        const lean = options.leanOf?.(f) ? '#lean' : ''
        // the deck a file belongs to names the host of every raise and roll entry it makes, and comes from a
        // manifest, not from the file
        const deck = options.deckOf?.(f)?.name ?? ''
        // and the name its module is imported by, which the unit's emitted imports are written with: units are shared
        // machine-wide, so a unit named one way is never handed to a build that names it another
        const module = options.modules(f)

        return `${portable.out(f)}@${contentHash(byFile.get(f)!.text)}${role ? `#${role}` : ''}${lean}${deck ? `@${deck}` : ''}>${module}`
      }),
    ]

    // the run's key, for the memo: the whole surface of everything reached. Cheap, and exact within a run
    const keyAs = (checkedAs: string): string => hashFields([...ownKey(checkedAs), ...depHashes])

    // THE CACHE'S KEY, BY NAME (step 4, compile/names.tree): the fingerprints of only the dependency definitions this
    // unit can reach by name, from the names its own modules write. An edit to a task it never names leaves the key,
    // and so its stored answer, where they were. Asked only when the memo has no answer, since it mills the unit
    let used: string[] | undefined
    let defs: NameDef[] | undefined

    const reached = (): { used: string[]; defs: NameDef[] } => {
      used ??= namesOfUnit()

      if (defs === undefined) {
        defs = []

        for (const d of [...reach[i]!].sort((a, b) => a - b)) {
          defs.push(...(builds[d]!.defs ?? nameDefs(builds[d]!.stubs.flatMap(([, list]) => list), portable.out)))
        }
      }

      return { used, defs }
    }

    // the same fingerprints `namesReached` gives over `reached().defs`, from the build's index (`indexNames`), so a
    // unit's walk costs the names it reaches and not every definition of everything it reaches
    const namedKeyAs = (checkedAs: string): string => {
      used ??= namesOfUnit()
      indexNames(i)

      const sees = new Map([...reach[i]!].map(d => [d, true]))

      return hashFields(['names', ...ownKey(checkedAs), ...namesReachedIndexed(nameIndex, unitDefs, sees, used, NAME_SPAN)])
    }

    // the name key, through a pointer kept under the whole-surface key. The same surface always gives the same name
    // key, so a warm build reads the pointer and the unit and works out no names, and the names are worked out only
    // when a surface moved, which is when they can spare a rebuild. Without it a new process milled every unit and
    // walked its whole reach before it could ask the cache anything: a warm `term test` of the standard library was
    // no faster through units than whole
    const namedKeyOf = (checkedAs: string, surfaceKey: string): string =>
      cache ? cache.unit<{ portable: string }>(`surface:${surfaceKey}`, () => ({ portable: namedKeyAs(checkedAs) })).portable : namedKeyAs(checkedAs)

    // what the unit is built from, as `term make --explain` compares it: the same inputs its key is made of, each kept
    // apart so a change can be named
    const inputsAs = (checkedAs: string): UnitInputs => {
      const { used, defs } = reached()
      const key = ownKey(checkedAs)

      return {
        compiler: cache?.versionOf('unit') ?? '',
        own: new Map(files.map(f => [f, contentHash(byFile.get(f)!.text)])),
        // everything else the key says of the file, after its text's fingerprint
        read: new Map(files.map((f, at) => [f, key[5 + at]!.slice(portable.out(f).length + 1 + contentHash(byFile.get(f)!.text).length)])),
        settings: hashFields(key.slice(0, 5)),
        names: namesPrinted(defs, used),
      }
    }

    // the names the unit's own modules write, and the names their loads find. A module that does not mill uses
    // nothing: its answer is the mill's refusal, which its own text decides
    const namesOfUnit = (): string[] => {
      const out = new Set<string>()

      for (const f of files) {
        const milled = milledModule(byFile.get(f)!, {
          parsed,
          templates,
          templateKey,
          cache,
          role: options.roleOf?.(f) ?? undefined,
          lean: options.leanOf?.(f) ?? false,
        })

        if (milled.ok) {
          namesUsed(milled.program).forEach(name => out.add(name))
        }

        for (const name of collected.scope.get(f)?.finds.keys() ?? []) {
          out.add(name)
        }
      }

      return [...out]
    }

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
        scopeOf(i),
        undefined,
        undefined,
        files[0],
      )

      if (!result.ok) {
        return { diagnostics: result.diagnostics }
      }

      if (options.keepProgram && checkedAs === source.file) {
        entryProgram = result.program
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
        interfaceHash: surfaceHash(surface, portable.out),
        defs: nameDefs(surface, portable.out),
        docks: (result.program ?? []).filter(s => s.form === 'dock' && own.has(s.span.file ?? '')),
        warnings: result.warnings,
        // what the file states and owes, which compile() reports when it is the entry
        ...(checkedAs !== asImport && result.openClaims?.length ? { openClaims: result.openClaims } : {}),
        ...(checkedAs !== asImport && result.obligations ? { obligations: result.obligations } : {}),
      }
    }

    let ran = false

    // a unit's answer as the cache keeps it, every deck's root a token, so the entry serves every clone (step 13)
    const toStore = (value: UnitBuild | { diagnostics: Diagnostic[] }): { portable: string } => ({
      portable: portable.out(JSON.stringify(value, storeBigint)),
    })

    // and back, with this machine's roots. One that does not read back as a unit's answer is built again rather than
    // trusted (compile/cache.ts `usable` checks only the wrapper)
    const fromStore = (stored: { portable: string }): UnitBuild | { diagnostics: Diagnostic[] } => {
      try {
        const value = JSON.parse(portable.in(stored.portable), reviveBigint) as Record<string, unknown>

        if (Array.isArray(value.diagnostics) || (Array.isArray(value.files) && Array.isArray(value.stubs) && typeof value.interfaceHash === 'string')) {
          return value as UnitBuild | { diagnostics: Diagnostic[] }
        }
      } catch {
        // read as a miss, below
      }

      ran = true

      return make(answering)
    }

    // the `checkedAs` the cache is being asked for, which a stored answer that cannot be read is built as
    let answering = asSelf ?? asImport

    // the unit checked as `checkedAs`: this run's answer first, then the cache (memory, then disk), then a build
    const answer = (checkedAs: string): UnitBuild | { diagnostics: Diagnostic[] } => {
      answering = checkedAs
      const key = keyAs(checkedAs)
      const memo = options.units?.get(key)
      const wrapped = (): UnitBuild | { diagnostics: Diagnostic[] } => {
        ran = true

        if (options.explain) {
          const now = inputsAs(checkedAs)
          const before = options.explain.recall(checkedAs)
          const reasons = before ? why(before, now) : ['nothing recorded: its first build, or the record was washed']

          options.explain.reasons.set(label, reasons.length > 0 ? reasons : ['its stored answer was missing'])
          options.explain.remember(checkedAs, now)
        }

        return make(checkedAs)
      }
      const found = memo ?? (cache ? fromStore(cache.unit<{ portable: string }>(namedKeyOf(checkedAs, key), () => toStore(wrapped()))) : wrapped())

      options.units?.set(key, found)

      return found
    }

    closureKeys.push(keyAs(asSelf ?? asImport))

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

    docks.push(...(cached.docks ?? []))

    allWarnings.push(...cached.warnings)

    if (entry) {
      openClaims = cached.openClaims
      obligations = cached.obligations
    }

    // the surface, in dependency order, so a later definition of a name replaces an earlier one (`exports`)
    for (const [file, statements] of cached.stubs) {
      for (const s of statements) {
        if (s.form === 'native') {
          natives.push(s)
        }

        if (options.keepProgram) {
          surfaceProgram.push(s)
        }

        // a private task is in the stub for the privacy checks, and is no part of what an entry's shim exports
        if ((s.form === 'function' && !s.private) || s.form === 'let') {
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
    closureKey: hashFields(closureKeys),
    natives,
    docks,
    ...(options.keepProgram ? { surface: surfaceProgram, ...(entryProgram ? { program: entryProgram } : {}) } : {}),
  }
}
