// Module loading: resolve a program's `load @path` directives so the stdlib (base.tree) is the single source of
// truth for `form` definitions, rather than redefining them ad-hoc in every file. The entry file plus every module
// it (transitively) loads are collected in dependency order, then compiled as one merged program. Circular loads
// are handled (each module is included exactly once). Browser-safe: file reading is delegated to a resolver.

import type { Diagnostic } from '@term/make/code/parser/diagnostic'
import { parse, renderHead } from '@term/make/code/parser/tree'
import type { GroupNode, ParseResult, RootNode } from '@term/make/code/parser/tree'

export type Source = { file: string; text: string }

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
type ImportScan = { paths: string[]; hasZone: boolean }

// the parser's own renderer, so an interpolated path keeps its braces: `load @term/seed/code/native/{platform}/float`
// has to reach the resolver with `{platform}` intact for `withNativeEnv` to fill it in. Reading only the chunks drops
// the interpolation and asks for `.../native//float`, which resolves to nothing.
function headName(group: GroupNode): string | undefined {
  const first = group.nodes[0]

  return first?.kind === 'name' ? renderHead(first) : undefined
}

// One parse per module per build. Keyed by file, holding the text it was parsed from, so a resolver that hands back
// a changed file re-parses rather than serving a stale tree.
export type ParseMemo = (source: Source) => ParseResult

export function makeParseMemo(): ParseMemo {
  const seen = new Map<string, { text: string; result: ParseResult }>()

  return source => {
    const hit = seen.get(source.file)

    if (hit && hit.text === source.text) {
      return hit.result
    }

    const result = parse(source)

    seen.set(source.file, { text: source.text, result })

    return result
  }
}

function scanImports(tree: RootNode): ImportScan {
  const paths: string[] = []

  let hasZone = false

  for (const group of tree.nodes) {
    const keyword = headName(group)

    // `view` is the component head in both roles, and means the emitter will synthesize render-runtime calls. A
    // top-level `view` is only ever a document, because the code role's own `view` head is a stale grammar nothing
    // uses. See note/term/view/06-mill.md.
    if (keyword === 'view') {
      hasZone = true
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
    }
  }

  return { paths, hasZone }
}

// resolve an import path (e.g. `@cluesurf/seed/code/maybe`) from the importing file to its source, or undefined
export type Resolver = (
  importPath: string,
  fromFile: string,
) => Source | undefined

// the render runtime backing a `zone` (and a view-role document, whose `view` lowers to one): such a module calls
// `element` / `text` / `dynamic` / `show` / `each`,
// which the emitter synthesizes rather than the user importing. So a module containing a zone implicitly depends on it.
// `load @path` / `bear @path` (re-exports) both pull the target into the merged program; because the program is one
// flat namespace, a `bear`ed definition is visible to anything importing this module. `scanImports` (above) reads both.
const VIEW_RUNTIME_MODULE = '@cluesurf/site/code/view/render'

// the entry plus every module it transitively loads, dependencies first (so forms are defined before use)
export function collectModules(
  entry: Source,
  resolve: Resolver,
  // the build's shared parse memo. Passing the compile's own means each module is parsed once for the whole build
  // rather than once here and again in the mill. Omitted (the editor and the tests), a private one is made.
  parsed: ParseMemo = makeParseMemo(),
): { sources: Source[]; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = []
  const ordered: Source[] = []
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
    const scan = tree.ok
      ? scanImports(tree.tree)
      : { paths: [], hasZone: false }
    const paths = scan.paths

    // a module with a zone implicitly depends on the render runtime (the emitter synthesizes its calls). Inject it
    // unless the module already loads it or IS it (the render module itself must not depend on itself).
    if (
      scan.hasZone &&
      !paths.some(p => p.endsWith('zone/render')) &&
      !source.file.endsWith('zone/render.tree')
    ) {
      paths.push(VIEW_RUNTIME_MODULE)
    }

    for (const path of paths) {
      const dependency = resolve(path, source.file)

      if (dependency) {
        visit(dependency)
      } // unresolved imports are left to the checker's unknown-name diagnostics
    }

    active.delete(source.file)
    done.add(source.file)
    ordered.push(source) // pushed after its dependencies, so they come first
  }

  visit(entry)

  return { sources: ordered, diagnostics }
}
