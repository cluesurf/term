// Module loading: the entry file plus every module it (transitively) loads, collected in dependency order and compiled
// as one merged program. The import scan and the walk are Term, compile/loading.tree (self-hosting, 2026-10-06), and its
// header says what each part reads. This face keeps what Term cannot hold: the parse memo (module state, one per
// build), the build cache's hook that hands back a module's scan without parsing it, and the shapes its callers hold,
// where an absent alias is `undefined` rather than `none`. Browser-safe: file reading is delegated to a resolver.

import type { Diagnostic, Span } from '@term/make/code/parser/diagnostic'
import { parse } from '@term/make/code/parser/tree'
import type { ParseResult } from '@term/make/code/parser/tree'
import * as port from '@term/make/code/compile/loading'

// `shadowed` is set by a resolver when a package path named a file in the package's code root AND one in its package
// root: `file` is the code root's, and the other is what `term lint` names in `ambiguous-load`
export type Source = { file: string; text: string; shadowed?: string }

// what a module's text imports, read from its parse tree (compile/loading.tree `import-scan`)
export type ImportScan = {
  paths: string[]
  hasZone: boolean
  // a top-level web route (`hook /path`), whose lowering calls the route runtime
  hasRoute: boolean
  // the built-in bit words the module names, which reach @term/base/bit with no `load`. Absent in a scan kept from
  // before they were built in, which is read as none
  bits?: string[]
  // per import path, whether it is a `bear` (a re-export) and the names its `find` lines ask for, with where each
  // `find` line is, and the name each is bound under here when the line aliases it (`find x, name y` -> `y`)
  finds: {
    path: string
    bear: boolean
    names: string[]
    spans: Span[]
    aliases: (string | undefined)[]
    // `base <dir>` under the load: resolve from the package root (it imports nothing)
    base?: string
    // where the path is written, for a refusal of a load that resolves to nothing
    at?: Span
  }[]
}

// What each module imports BY NAME, resolved to files (compile/loading.tree `module-scope`). Read by check/overload.ts
// and check/private.ts
export type ImportScope = Map<
  string,
  { finds: Map<string, string[]>; bears: string[]; at?: Map<string, Span>; aliases?: Map<string, string[]>; plain?: Map<string, string[]> }
>

// one entry of a file's finds, as a Term pass takes it (compile/import-scope.tree)
export type ScopeFind = { name: string; targets: string[]; at?: Span }

// a file's import scope as a Term pass takes it: each map a list, in the map's order
// `hasPlain`: whether the scope kept a `plain` map at all, which check/overload reads apart from an empty one
export type FileScope = { file: string; finds: ScopeFind[]; bears: string[]; aliases?: ScopeFind[]; plain?: ScopeFind[]; hasPlain?: boolean }

// the import scope as the ported passes take it (check/private.tree, check/scope.tree), none for none
export function scopeList(scope: ImportScope | undefined): FileScope[] {
  return port.scopeList((scope ?? new Map()) as Map<string, port.ModuleScope>) as FileScope[]
}

// One parse per module per build. Keyed by file, holding the text it was parsed from, so a resolver that hands back
// a changed file re-parses rather than serving a stale tree.
export type ParseMemo = (source: Source) => ParseResult

// The default cap. A memo is a pure function of (file, text), so eviction can only ever cost a re-parse, never a
// wrong answer; the cap exists so a memo SHARED ACROSS A WHOLE BUILD cannot grow without bound.
export const PARSE_MEMO_CAP = 2048

// SHARE ONE ACROSS THE BUILD, not one per entry: a project build calls `compile()` once per file, and the dependency
// walk runs BEFORE the output cache can be consulted, so a memo per entry re-parses every file's whole closure.
export function makeParseMemo(cap: number = PARSE_MEMO_CAP): ParseMemo {
  const seen = new Map<string, { text: string; result: ParseResult }>()

  return source => {
    const hit = seen.get(source.file)

    if (hit && hit.text === source.text) {
      // least-recently-used: re-insert so the hot closure survives eviction
      seen.delete(source.file)
      seen.set(source.file, hit)

      return hit.result
    }

    const result = parse(source)

    seen.set(source.file, { text: source.text, result })

    while (seen.size > cap) {
      const oldest = seen.keys().next()

      if (oldest.done) {
        break
      }

      seen.delete(oldest.value)
    }

    return result
  }
}

type PortFind = port.ImportScan['finds'][number]

function fromPortScan(scan: port.ImportScan): ImportScan {
  return {
    ...scan,
    finds: scan.finds.map((find: PortFind) => ({
      ...find,
      aliases: find.aliases.map(alias => (alias.form === 'some' ? alias.value : undefined)),
    })),
  } as ImportScan
}

// a scan read back from the build cache's JSON has a hole where an alias was absent (its reviver deletes the `null`),
// which `Array.from` visits and `map` would skip
function toPortScan(scan: ImportScan): port.ImportScan {
  return {
    ...scan,
    finds: scan.finds.map(find => ({
      ...find,
      aliases: Array.from(find.aliases, alias => (alias === undefined ? { form: 'none' } : { form: 'some', value: alias })),
    })),
  } as port.ImportScan
}

// the `load` / `bear` paths a module names, read from its tree. The ONE way to ask that question: `collectModules`
// walks the graph with it and `separate.ts` orders the graph with it
export function importPathsOf(source: Source, parsed: ParseMemo): string[] {
  return port.scanParsed(parsed(source)).paths
}

// the `load` / `bear` blocks a module declares, each with the names its `find` lines ask for and where each `find`
// line is: the scan the dependency walk reads, so the language server's workspace references cannot disagree with it
export function importFindsOf(source: Source, parsed: ParseMemo): ImportScan['finds'] {
  return fromPortScan(port.scanParsed(parsed(source))).finds
}

// how one `load` asks for its path: `base <dir>` written under it forces the PACKAGE root
export type LoadHow = { base?: string }

// resolve an import path (e.g. `@term/base/maybe`) from the importing file to its source, or undefined
export type Resolver = (
  importPath: string,
  fromFile: string,
  how?: LoadHow,
) => Source | undefined

// One module's own part of an import walk (compile/loading.tree `walked-module`)
export type WalkedModule = {
  text: string
  own: ImportScope extends Map<string, infer V> ? V : never
  deps: Source[]
  asks: { path: string; how?: LoadHow }[]
  edges: string[]
  diagnostics: Diagnostic[]
}

export type WalkMemo = Map<string, WalkedModule>

// the entry plus every module it transitively loads, dependencies first (so forms are defined before use)
export function collectModules(
  entry: Source,
  resolve: Resolver,
  // the build's shared parse memo. Omitted (the editor and the tests), a private one is made.
  parsed: ParseMemo = makeParseMemo(),
  // where a module's import scan comes from: the build cache's (`CompileCache.scanned`), so a module whose text is
  // unchanged is not parsed to find its loads. Omitted, it is computed here
  scanOf: (source: Source, compute: () => ImportScan) => ImportScan = (_source, compute) => compute(),
  // what each module's own part of the walk found, kept across walks
  walked?: WalkMemo,
): { sources: Source[]; diagnostics: Diagnostic[]; scope: ImportScope; edges: Map<string, string[]> } {
  const result = port.collectModules(
    entry,
    (path, from, how) => {
      const found = resolve(path, from, how.form === 'some' ? how.value : undefined)

      return found ? { form: 'some', value: found } : { form: 'none' }
    },
    source => toPortScan(scanOf(source, () => fromPortScan(port.scanParsed(parsed(source))))),
    (walked ?? new Map()) as Map<string, port.WalkedModule>,
    walked !== undefined,
  )

  return { sources: result.sources, diagnostics: result.diagnostics, scope: result.scope as ImportScope, edges: result.edges }
}
