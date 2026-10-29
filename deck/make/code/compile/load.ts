// Module loading: the entry file plus every module it (transitively) loads, collected in dependency order and compiled
// as one merged program. The import scan and the walk are compile/loading.tree, the parse memo and the `{platform}`
// refusals compile/loading-parses.tree (item 0082). This face keeps the shapes its callers hold, where an absent alias
// is `undefined` rather than `none`, and hands the port a resolver, a parse and the build cache's scan as tasks.
// Browser-safe: file reading is delegated to a resolver.

import type {
  Diagnostic,
  Span,
} from '@term/make/code/parser/diagnostic'
import type { ParseResult } from '@term/make/code/parser/tree'
import * as port from '@term/make/code/compile/loading'
import * as parses from '@term/make/code/compile/loading-parses'

// `shadowed`: a package path named a file in the package's code root AND one in its package root. `file` is the code
// root's, and the other is what `term lint` names in `ambiguous-load`
export type Source = { file: string; text: string; shadowed?: string }

// what a module's text imports, read from its parse tree (compile/loading.tree `import-scan`). `bits` absent in a scan
// kept from before they were built in reads as none
export type ImportScan = {
  paths: string[]
  hasZone: boolean
  hasRoute: boolean
  bits?: string[]
  finds: {
    path: string
    bear: boolean
    names: string[]
    spans: Span[]
    // the name each `find` is bound under here when the line aliases it (`find x, name y` -> `y`)
    aliases: (string | undefined)[]
    // `base <dir>` under the load: resolve from the package root (it imports nothing)
    base?: string
    // where the path is written, for a refusal of a load that resolves to nothing
    at?: Span
  }[]
}

// What each module imports BY NAME, resolved to files (compile/loading.tree `module-scope`)
export type ImportScope = Map<
  string,
  {
    finds: Map<string, string[]>
    bears: string[]
    at?: Map<string, Span>
    aliases?: Map<string, string[]>
    plain?: Map<string, string[]>
  }
>

// a file's import scope as a Term pass takes it (compile/import-scope.tree), each map a list in its order. `hasPlain`:
// whether the scope kept a `plain` map at all, which check/overload reads apart from an empty one
export type ScopeFind = { name: string; targets: string[]; at?: Span }
export type FileScope = {
  file: string
  finds: ScopeFind[]
  bears: string[]
  aliases?: ScopeFind[]
  plain?: ScopeFind[]
  hasPlain?: boolean
}

export const scopeList = (
  scope: ImportScope | undefined,
): FileScope[] =>
  port.scopeList(
    (scope ?? new Map()) as Map<string, port.ModuleScope>,
  ) as FileScope[]

// One parse per module per build (compile/loading-parses.tree `parse-remembered`). SHARE ONE ACROSS THE BUILD: a
// project build calls `compile()` once per file, and the dependency walk runs before the output cache is consulted
export type ParseMemo = (source: Source) => ParseResult

export const PARSE_MEMO_CAP = 2048

export function makeParseMemo(cap: number = PARSE_MEMO_CAP): ParseMemo {
  const memo = parses.freshParseMemo(cap)

  return source =>
    parses.parseRemembered(memo, source as never) as ParseResult
}

type PortFind = port.ImportScan['finds'][number]

const fromPortScan = (scan: port.ImportScan): ImportScan =>
  ({
    ...scan,
    finds: scan.finds.map((find: PortFind) => ({
      ...find,
      aliases: find.aliases.map(alias =>
        alias.form === 'some' ? alias.value : undefined,
      ),
    })),
  }) as ImportScan

// a scan read back from the build cache's JSON has a hole where an alias was absent (its reviver deletes the `null`),
// which `Array.from` visits and `map` would skip
const toPortScan = (scan: ImportScan): port.ImportScan =>
  ({
    ...scan,
    finds: scan.finds.map(find => ({
      ...find,
      aliases: Array.from(find.aliases, alias =>
        alias === undefined
          ? { form: 'none' }
          : { form: 'some', value: alias },
      ),
    })),
  }) as port.ImportScan

// the `load` / `bear` paths a module names, read from its tree: the ONE way to ask that question
export const importPathsOf = (
  source: Source,
  parsed: ParseMemo,
): string[] => port.scanParsed(parsed(source)).paths

// the `load` / `bear` blocks a module declares, each with the names its `find` lines ask for and where each is
export const importFindsOf = (
  source: Source,
  parsed: ParseMemo,
): ImportScan['finds'] =>
  fromPortScan(port.scanParsed(parsed(source))).finds

// how one `load` asks for its path: `base <dir>` written under it forces the PACKAGE root
export type LoadHow = { base?: string }

// resolve an import path (e.g. `@term/base/maybe`) from the importing file to its source, or undefined
export type Resolver = (
  importPath: string,
  fromFile: string,
  how?: LoadHow,
) => Source | undefined

const some = <T>(value: T | undefined): port.Maybe<T> =>
  value ? { form: 'some', value } : { form: 'none' }

// The `{platform}` loads of a closure that the build's env answers with no file, each refused AT THE LOAD
export const platformRefusals = (
  sources: Source[],
  resolve: Resolver,
  env: string,
  parsed: ParseMemo,
): Diagnostic[] =>
  parses.platformRefusals(
    sources as never,
    (path, from) => some(resolve(path, from)) as never,
    env,
    source => parsed(source) as never,
  ) as Diagnostic[]

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

// the entry plus every module it transitively loads, dependencies first (so forms are defined before use). `parsed`
// omitted (the editor and the tests) makes a private memo, `scanOf` is the build cache's scan of an unchanged module,
// and `walked` keeps each module's own part across walks
export function collectModules(
  entry: Source,
  resolve: Resolver,
  parsed: ParseMemo = makeParseMemo(),
  scanOf: (source: Source, compute: () => ImportScan) => ImportScan = (
    _source,
    compute,
  ) => compute(),
  walked?: WalkMemo,
): {
  sources: Source[]
  diagnostics: Diagnostic[]
  scope: ImportScope
  edges: Map<string, string[]>
} {
  const result = port.collectModules(
    entry,
    (path, from, how) =>
      some(
        resolve(
          path,
          from,
          how.form === 'some' ? how.value : undefined,
        ),
      ),
    source =>
      toPortScan(
        scanOf(source, () =>
          fromPortScan(port.scanParsed(parsed(source))),
        ),
      ),
    (walked ?? new Map()) as Map<string, port.WalkedModule>,
    walked !== undefined,
  )

  return {
    sources: result.sources,
    diagnostics: result.diagnostics,
    scope: result.scope as ImportScope,
    edges: result.edges,
  }
}
