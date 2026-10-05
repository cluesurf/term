// Module loading: resolve a program's `load @path` directives so the stdlib (base.tree) is the single source of
// truth for `form` definitions, rather than redefining them ad-hoc in every file. The entry file plus every module
// it (transitively) loads are collected in dependency order, then compiled as one merged program. Circular loads
// are handled (each module is included exactly once). Browser-safe: file reading is delegated to a resolver.

import type { Diagnostic, Span } from '@term/make/code/parser/diagnostic'
import { diagnose } from '@term/make/code/parser/diagnostic'
import { spanOfWhole } from '@term/make/code/compile/mill-run'
import { parse, renderHead } from '@term/make/code/parser/tree'
import type { GroupNode, ParseResult, RootNode } from '@term/make/code/parser/tree'

// another deck's module: `@scope/name/...`, outside `@term`, whose decks ship with the compiler, and not the local
// `@/` alias. Only such a path that resolves to nothing is refused at the load: it can only mean the deck is missing
function thirdParty(path: string): boolean {
  return /^@[^/]+\/[^/]+/.test(path) && !path.startsWith('@term/') && !path.startsWith('@/')
}

// `shadowed` is set by a resolver when a package path named a file in the package's code root AND one in its
// package root: `file` is the code root's, and the other is what `term lint` names in `ambiguous-load`
export type Source = { file: string; text: string; shadowed?: string }

// Dependency discovery needs two facts per module: its `load` / `bear` import paths, and whether it has a top-level
// `view` (a component, whose emitter synthesizes render-runtime calls). Both are read from the real parse tree.
//
// This USED to be a hand-rolled column-0 line scan, kept because parsing every transitive module just to read its
// imports was the dominant cost of a cold compile. It drifted from the grammar exactly the way a second
// implementation always does, and silently: it counted the `<` and `>` on comment lines toward text-literal
// balance, so one bare `<` in an English sentence left the depth stuck at 1, every column-0 line after it read as
// literal content, and the file's `load` directives vanished. The resolver was never called, every imported name
// failed later as `unknown-name`, and a same-file forward reference failed with it. Found in @term/face
// code/logic/scope.tree on 2026-08-30, whose header comment reads "(cell < row < list/selection < ...)".
//
// There is ONE parser for `.tree` in this codebase. The cost that motivated the scan is paid back by `makeParseMemo`
// below: the dependency walk, the template scan and the mill all take their tree from the same memo, so a module is
// parsed once per build instead of the two or three times it was before.
type ImportScan = {
  paths: string[]
  hasZone: boolean
  // a top-level web route (`hook /path`), whose lowering calls the route runtime (ROUTE_RUNTIME_MODULE)
  hasRoute: boolean
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

// What each module imports BY NAME, resolved to files: a `find`ed name -> every file a `load` / `bear` that finds it
// resolved to, and the files the module re-exports with `bear`. Names are package-global, so this is the only record
// of WHICH definition a call site meant when two modules define one name (native-dom-0031). Read by
// check/overload.ts, which binds such a call by it, and by check/private.ts, which refuses a `find` of a name that
// is private to the file it names. `at` is where each name's first `find` line is, for that diagnostic.
export type ImportScope = Map<
  string,
  // `aliases`: the files each ALIAS a find names reached (`find to-number, name decimal-to-number` -> the module
  // it was found in), since two aliases of one imported name may come from two modules
  // `plain`: the files a name was found in WITHOUT an alias, what a reference written as the bare name reaches
  { finds: Map<string, string[]>; bears: string[]; at?: Map<string, Span>; aliases?: Map<string, string[]>; plain?: Map<string, string[]> }
>

// the parser's own renderer, so an interpolated path keeps its braces: `load @term/base/code/native/{platform}/float`
// has to reach the resolver with `{platform}` intact for `withNativeEnv` to fill it in. Reading only the chunks drops
// the interpolation and asks for `.../native//float`, which resolves to nothing.
function headName(group: GroupNode): string | undefined {
  const first = group.nodes[0]

  return first?.kind === 'name' ? renderHead(first) : undefined
}

// One parse per module per build. Keyed by file, holding the text it was parsed from, so a resolver that hands back
// a changed file re-parses rather than serving a stale tree.
export type ParseMemo = (source: Source) => ParseResult

// The default cap. A memo is a pure function of (file, text), so eviction can only ever cost a re-parse, never a
// wrong answer; the cap exists so a memo SHARED ACROSS A WHOLE BUILD cannot grow without bound.
export const PARSE_MEMO_CAP = 2048

// SHARE ONE ACROSS THE BUILD, not one per entry.
//
// `compile()` makes its own when it is not given one, which is right for a single compile and wrong for a batch: a
// project build calls `compile()` once per file, and the dependency walk in `collectModules` runs BEFORE the output
// cache can be consulted (the cache key is the content of every module in the graph, so the graph has to be walked
// to know it). With a memo per entry, every one of `@term/bind`'s 3,091 files re-parses its whole stdlib closure,
// and no cache hit can save it because the parsing happens on the way to asking.
//
// That is most of what a bind build costs. Serving one of its cached entries takes 2.1 ms against the 165 ms it
// takes to compile the file, so a warm build ought to be nearly free, and it was not: 771s then 549s.
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

// the `load` / `bear` paths a module names, read from its tree. The ONE way to ask that question: `collectModules`
// walks the graph with it and `separate.ts` orders the graph with it, so the two cannot disagree about what a file
// imports (separate.ts used to line-scan for `^(load|bear)` with no text-literal tracking at all).
export function importPathsOf(source: Source, parsed: ParseMemo): string[] {
  const tree = parsed(source)

  return tree.ok ? scanImports(tree.tree).paths : []
}

// the `load` / `bear` blocks a module declares, each with the names its `find` lines ask for and where each `find`
// line is. The same scan the dependency walk reads, so the language server's workspace references (which ask "does
// this file import that name from that module") cannot disagree with the build about what a file imports.
export function importFindsOf(source: Source, parsed: ParseMemo): ImportScan['finds'] {
  const tree = parsed(source)

  return tree.ok ? scanImports(tree.tree).finds : []
}

function scanImports(tree: RootNode): ImportScan {
  const paths: string[] = []
  const finds: ImportScan['finds'] = []

  let hasZone = false
  let hasRoute = false

  for (const group of tree.nodes) {
    const keyword = headName(group)

    // `view` is the component head in both roles, and means the emitter will synthesize render-runtime calls. A
    // top-level `view` is only ever a document, because the code role's own `view` head is a stale grammar nothing
    // uses. See note/term/view/06-mill.md.
    if (keyword === 'view') {
      hasZone = true
      continue
    }

    // a web route: `hook` whose name is a path. A CLI command (`hook make`) is not one
    if (keyword === 'hook') {
      const first = group.nodes[1]
      const named = first?.kind === 'group' ? headName(first) : undefined

      if (named?.startsWith('/')) {
        hasRoute = true
      }

      continue
    }

    if (keyword !== 'load' && keyword !== 'bear') {
      continue
    }

    // the path is the first child. A `<...>` text / template path (`bear <./{{x}}>`) parses as a text node, not a
    // name, and is not a plain import path, so it is skipped the way the checker skips it.
    const first = group.nodes[1]

    if (first?.kind !== 'group') {
      continue
    }

    const path = headName(first)

    if (path !== undefined) {
      paths.push(path)

      // `find <name>` lines under the path, an alias (`find x, name y`) recorded by the name it imports
      const names: string[] = []
      const spans: Span[] = []
      const aliases: (string | undefined)[] = []
      let base: string | undefined

      for (const child of group.nodes.slice(2)) {
        // `base <dir>` beside the `find` lines. Not a find: it names where the path resolves, and imports nothing
        if (child.kind === 'group' && headName(child) === 'base' && keyword === 'load') {
          const value = child.nodes[1]
          base = value?.kind === 'group' ? headName(value) : undefined
          continue
        }

        if (child.kind !== 'group' || headName(child) !== 'find') {
          continue
        }

        const target = child.nodes[1]
        const name = target?.kind === 'group' ? headName(target) : undefined

        if (name !== undefined) {
          names.push(name)
          spans.push(spanOfWhole(child))

          // `find x, name y`: the comma leaves `name y` a sibling of `x` under the `find`
          const alias = child.nodes
            .slice(2)
            .find((n): n is GroupNode => n.kind === 'group' && headName(n) === 'name')
          const aliasName = alias?.nodes[1]?.kind === 'group' ? headName(alias.nodes[1]) : undefined
          aliases.push(aliasName)
        }
      }

      finds.push({ path, bear: keyword === 'bear', names, spans, aliases, at: spanOfWhole(first), ...(base !== undefined ? { base } : {}) })
    }
  }

  return { paths, hasZone, hasRoute, finds }
}

// how one `load` asks for its path: `base <dir>` written under it forces the PACKAGE root, where a package path
// otherwise tries the package's code root first (note/term/plan/manifest-mark-and-code-root.md, and
// `resolvePackagePath` in make/code/resolve.ts, which is the rule)
export type LoadHow = { base?: string }

// resolve an import path (e.g. `@term/base/maybe`) from the importing file to its source, or undefined
export type Resolver = (
  importPath: string,
  fromFile: string,
  how?: LoadHow,
) => Source | undefined

// the render runtime backing a `zone` (and a view-role document, whose `view` lowers to one): such a module calls
// `make-element` / `make-text` / `make-dynamic-text` / `show` / `render-each` (compile/render-names.ts),
// which the emitter synthesizes rather than the user importing. So a module containing a zone implicitly depends on it.
// `load @path` / `bear @path` (re-exports) both pull the target into the merged program; because the program is one
// flat namespace, a `bear`ed definition is visible to anything importing this module. `scanImports` (above) reads both.
const VIEW_RUNTIME_MODULE = '@cluesurf/site/code/view/render'

// what a lowered route table calls (compile/route-lower.ts): the env's `host`, the page's `set-title` / `set-meta` /
// `set-proxy`, and the navigation contract's `route-matches` / `route-param`. Injected like the render runtime
const ROUTE_RUNTIME_MODULE = '@cluesurf/site/code/view/route-runtime'

// the entry plus every module it transitively loads, dependencies first (so forms are defined before use)
export function collectModules(
  entry: Source,
  resolve: Resolver,
  // the build's shared parse memo. Passing the compile's own means each module is parsed once for the whole build
  // rather than once here and again in the mill. Omitted (the editor and the tests), a private one is made.
  parsed: ParseMemo = makeParseMemo(),
): { sources: Source[]; diagnostics: Diagnostic[]; scope: ImportScope } {
  const diagnostics: Diagnostic[] = []
  const ordered: Source[] = []
  const scope: ImportScope = new Map()
  const done = new Set<string>()
  const active = new Set<string>()

  function visit(source: Source): void {
    if (done.has(source.file) || active.has(source.file)) {
      return
    } // already included, or a cycle: stop

    active.add(source.file)

    // discover dependencies from the module's parse tree. A module that does not parse contributes no dependencies:
    // its own diagnostics are raised where it is compiled, and guessing at its imports here would only bury them.
    const tree = parsed(source)
    const scan: ImportScan = tree.ok
      ? scanImports(tree.tree)
      : { paths: [], hasZone: false, hasRoute: false, finds: [] }
    const paths = scan.paths
    const own = {
      finds: new Map<string, string[]>(),
      bears: [] as string[],
      at: new Map<string, Span>(),
      aliases: new Map<string, string[]>(),
      plain: new Map<string, string[]>(),
    }
    scope.set(source.file, own)

    // a module with a zone implicitly depends on the render runtime (the emitter synthesizes its calls). Inject it
    // unless the module already loads it or IS it (the render module itself must not depend on itself).
    // (it moved from `zone/render` to `view/render`, and this test named the old place, so a module that loaded the
    // runtime itself had it injected again, harmless only because both paths resolve to one file)
    if (
      scan.hasZone &&
      !paths.some(p => p.endsWith('view/render')) &&
      !source.file.endsWith('view/render.tree')
    ) {
      paths.push(VIEW_RUNTIME_MODULE)
    }

    // a module with a web route implicitly depends on the route runtime: the route lowering (compile/route-lower.ts)
    // synthesizes calls to the env's `host`, the page's title and meta, and the navigation contract's matching, which
    // the author never imports (native-navigation-0002)
    if (scan.hasRoute && !paths.some(p => p.endsWith('view/route-runtime')) && !source.file.endsWith('view/route-runtime.tree')) {
      paths.push(ROUTE_RUNTIME_MODULE)
    }

    for (const path of paths) {
      const base = scan.finds.find(f => f.path === path && f.base !== undefined)?.base
      const dependency = resolve(path, source.file, base !== undefined ? { base } : undefined)

      if (dependency) {
        for (const entry of scan.finds.filter(f => f.path === path)) {
          if (entry.bear) {
            own.bears.push(dependency.file)
          }

          entry.names.forEach((name, i) => {
            own.finds.set(name, [...(own.finds.get(name) ?? []), dependency.file])

            const alias = entry.aliases[i]

            if (alias !== undefined) {
              own.aliases.set(alias, [...(own.aliases.get(alias) ?? []), dependency.file])
            } else {
              own.plain.set(name, [...(own.plain.get(name) ?? []), dependency.file])
            }

            if (!own.at.has(name) && entry.spans[i]) {
              own.at.set(name, { ...entry.spans[i]!, file: source.file })
            }
          })
        }

        visit(dependency)
      } else if (thirdParty(path) && base === undefined) {
        // (a load with `base` that resolves to nothing has the more exact cause the bridge names: a `base` that is
        // not the path's first segment)
        // another deck's module that nothing answers: the deck is not installed. Refused here, at the load, where it
        // was left to the first use of an imported name to fail as `unknown-name` (guides: packages/install,
        // 2026-10-04). Anything else unresolved (a stdlib module a platform lacks, a relative path) is still left to
        // the checker, which names what is missing where it is used
        const at = scan.finds.find(f => f.path === path)?.at
        const deck = path.split('/').slice(0, 2).join('/')

        diagnostics.push(
          diagnose('unresolved-load', {
            file: source.file,
            span: at ? { ...at, file: source.file } : { file: source.file, start: { line: 0, column: 0 }, end: { line: 0, column: 0 } },
            message: `${deck} is not installed, so nothing answers \`load ${path}\``,
          }),
        )
      }
    }

    active.delete(source.file)
    done.add(source.file)
    ordered.push(source) // pushed after its dependencies, so they come first
  }

  visit(entry)

  return { sources: ordered, diagnostics, scope }
}
