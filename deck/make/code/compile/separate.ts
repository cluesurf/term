// Separate compilation with cross-boundary early cutoff (the pending step of incremental compilation, see
// note/term/incremental-compilation.md "What is live vs pending").
//
// Where `compile()` merges the whole import closure into one program and checks + emits it as a blob,
// `compileSeparate()` partitions the module graph into UNITS (the strongly connected components of the import
// graph: cross-package edges are acyclic, so a unit is a package or a cyclic module group within one), then checks
// and emits each unit separately, in dependency order:
//
//   - a unit is checked against the interface STUBS of the units it depends on (their checked, body-less public
//     surface, see code/compile/stub.ts), never against their bodies
//   - a unit emits only its OWN modules (per-module ESM, the same shape the dev server serves), with imports
//     reconnecting cross-unit references
//   - a unit's result is cached keyed by its own content + the INTERFACE hashes of its dependencies, so a body-only
//     edit in a dependency (interface unchanged) replays every dependent unit from cache: EARLY CUTOFF, live
//
// The unit result (stubs included) is JSON-serializable, so the cache persists across processes and can be shared.

import type { Diagnostic } from '@term/make/code/parser/diagnostic'
import type {
  Program,
  Statement,
} from '@term/make/code/compile/node'
import { parse } from '@term/make/code/parser/tree'
import { mill } from '@term/make/code/compile/mill'
import {
  expandTemplates,
  collectTemplates,
} from '@term/make/code/compile/template'
import type { Template } from '@term/make/code/compile/template'
import { collectModules, importPathsOf, makeParseMemo } from '@term/make/code/compile/load'
import type { ParseMemo, Resolver, Source } from '@term/make/code/compile/load'
import { compileProgram } from '@term/make/code/compile/compile'
import type { ModuleEmit } from '@term/make/code/compile/modules'
import { stubProgram } from '@term/make/code/compile/stub'
import { interfaceHash } from '@term/make/code/compile/interface'
import {
  hashText,
  hashFields,
} from '@term/make/code/compile/cache'
import type { CompileCache } from '@term/make/code/compile/cache'

export type SeparateResult =
  | {
      ok: true
      // every emitted module across all units (file -> emit), in dependency order
      modules: Map<string, ModuleEmit>
      warnings: Diagnostic[]
      // observability (and the early-cutoff tests): units rebuilt vs replayed from cache this run
      built: string[]
      reused: string[]
    }
  | { ok: false; diagnostics: Diagnostic[] }

// one unit's cached build: its own modules' emits, its public stub surface (for dependents), and its warnings.
// Everything is JSON-serializable so the entry persists.
type UnitBuild = {
  files: [string, ModuleEmit][]
  stubs: [string, Statement[]][]
  interfaceHash: string
  warnings: Diagnostic[]
}

// import edges between FILES, read from the same parse trees collectModules walks, so the two cannot disagree about
// what a file imports
function fileEdges(
  sources: Source[],
  resolve: Resolver,
  parsed: ParseMemo,
): Map<string, string[]> {
  const known = new Set(sources.map(s => s.file))
  const edges = new Map<string, string[]>()

  for (const unit of sources) {
    const deps: string[] = []

    for (const path of importPathsOf(unit, parsed)) {
      const dep = resolve(path, unit.file)

      if (dep && known.has(dep.file) && dep.file !== unit.file) {
        deps.push(dep.file)
      }
    }

    edges.set(unit.file, deps)
  }

  return edges
}

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
  },
): SeparateResult {
  // one parse per module, shared by the dependency walk and the edge graph
  const parsed = makeParseMemo()
  const { sources } = collectModules(source, options.resolve, parsed)
  const edges = fileEdges(sources, options.resolve, parsed)
  const order = units(
    sources.map(s => s.file),
    edges,
  )

  const byFile = new Map(sources.map(s => [s.file, s]))

  // templates are global (a module's `fuse` can expand a template an import defines), so gather them once, exactly
  // as compile() does, and fold their fingerprint into every unit key.
  const templates = new Map<string, Template>()

  let templateText = ''

  for (const unit of sources) {
    if (!/(^|\n)tree\s/.test(unit.text)) {
      continue
    }

    const parsed = parse(unit)

    if (!parsed.ok) {
      continue
    }

    templateText += unit.text

    for (const [name, template] of collectTemplates(parsed.tree)) {
      templates.set(name, template)
    }
  }

  const templateKey = templates.size ? hashText(templateText) : ''

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

  for (let i = 0; i < order.length; i++) {
    const files = order[i]!
    const label = files.join('+')

    // the unit key: own content + the interface hash of every reachable dependency unit + the options that shape
    // output. A body-only dependency edit leaves its interface hash unchanged, so this key -- and the cached build
    // it points at -- survive: early cutoff.
    const depHashes = [...reach[i]!]
      .map(d => builds[d]!.interfaceHash)
      .sort()

    const key = hashFields([
      'separate',
      templateKey,
      options.env ?? '',
      ...files.map(f => `${f}@${hashText(byFile.get(f)!.text)}`),
      ...depHashes,
    ])

    const make = (): UnitBuild | { diagnostics: Diagnostic[] } => {
      // dependency context: the stubs of every reachable unit, dependency order preserved
      const program: Program = []
      const origin = new WeakMap<Statement, string>()

      for (const d of [...reach[i]!].sort((a, b) => a - b)) {
        for (const [file, statements] of builds[d]!.stubs) {
          for (const s of statements) {
            origin.set(s, file)
            program.push(s)
          }
        }
      }

      const ownStart = program.length

      for (const f of files) {
        const unit = byFile.get(f)!
        const parsed = parse(unit)

        if (!parsed.ok) {
          return { diagnostics: parsed.diagnostics }
        }

        const milled = mill(
          expandTemplates(parsed.tree, templates),
          unit.file,
          options.roleOf?.(unit.file) ?? undefined,
        )

        if (!milled.ok) {
          return { diagnostics: milled.diagnostics }
        }

        for (const s of milled.program) {
          origin.set(s, unit.file)
          program.push(s)
        }
      }

      const ownStatements = program.slice(ownStart)
      const result = compileProgram(
        program,
        source.file,
        undefined,
        origin,
        options.modules,
        undefined,
        options.env,
      )

      if (!result.ok) {
        return { diagnostics: result.diagnostics }
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
      // checker zonks types onto these objects, so inferred signatures are part of the surface)
      const stubbed: [string, Statement[]][] = files.map(f => [
        f,
        stubProgram(ownStatements.filter(s => origin.get(s) === f)),
      ])

      const surface = stubbed.flatMap(([, list]) => list)

      return {
        files: filesOut,
        stubs: stubbed,
        interfaceHash: interfaceHash(surface),
        warnings: result.warnings,
      }
    }

    let ran = false

    const wrapped = (): UnitBuild | { diagnostics: Diagnostic[] } => {
      ran = true

      return make()
    }

    const cached = options.cache
      ? options.cache.output<UnitBuild | { diagnostics: Diagnostic[] }>(
          `unit:${key}`,
          wrapped,
        )
      : wrapped()

    if ('diagnostics' in cached) {
      return { ok: false, diagnostics: cached.diagnostics }
    }

    ;(ran ? built : reused).push(label)
    builds.push(cached)

    for (const [file, emit] of cached.files) {
      allModules.set(file, emit)
    }

    allWarnings.push(...cached.warnings)
  }

  return {
    ok: true,
    modules: allModules,
    warnings: allWarnings,
    built,
    reused,
  }
}
