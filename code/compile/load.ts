// Module loading: resolve a program's `load @path` directives so the stdlib (base.tree) is the single source of
// truth for `form` definitions, rather than redefining them ad-hoc in every file. The entry file plus every module
// it (transitively) loads are collected in dependency order, then compiled as one merged program. Circular loads
// are handled (each module is included exactly once). Browser-safe: file reading is delegated to a resolver.

import type { Diagnostic } from '@/code/parser/diagnostic'
import type { Node, RootNode } from '@/code/parser/tree'
import { parse } from '@/code/parser/tree'

export type Source = { file: string; text: string }
// resolve an import path (e.g. `@cluesurf/base/code/maybe`) from the importing file to its source, or undefined
export type Resolver = (
  importPath: string,
  fromFile: string,
) => Source | undefined

// the text of a name node (a keyword or an import-path token), or a group's head name
function nameText(node: Node | undefined): string | undefined {
  if (!node) return undefined
  if (node.kind === 'name')
    return node.parts
      .map(p => (p.kind === 'chunk' ? p.text : ''))
      .join('')
  if (node.kind === 'group') return nameText(node.nodes[0])
  return undefined
}

// the import paths a tree depends on: `load @path` (imports for local use) and `bear @path` (re-exports). Both pull
// the target module into the merged program; because the program is one flat namespace, a `bear`ed definition is then
// automatically visible to anything that imports this module (the re-export). The native bindings (bind.tree) lead
// every wrapper with a run of `bear @...` lines that surface the platform's types.
function loadPaths(tree: RootNode): Array<string> {
  const paths: Array<string> = []
  for (const group of tree.nodes) {
    const keyword = nameText(group.nodes[0])
    if (keyword !== 'load' && keyword !== 'bear') continue
    const path = nameText(group.nodes[1])
    if (path) paths.push(path)
  }
  return paths
}

// the render runtime backing a `zone`: a module with a zone calls `element` / `text` / `dynamic` / `show` / `each`,
// which the emitter synthesizes rather than the user importing. So a module containing a zone implicitly depends on it.
const ZONE_RUNTIME_MODULE = '@cluesurf/site/code/zone/render'

function hasZone(tree: RootNode): boolean {
  return tree.nodes.some(group => nameText(group.nodes[0]) === 'zone')
}

// the entry plus every module it transitively loads, dependencies first (so forms are defined before use)
export function collectModules(
  entry: Source,
  resolve: Resolver,
): { sources: Array<Source>; diagnostics: Array<Diagnostic> } {
  const diagnostics: Array<Diagnostic> = []
  const ordered: Array<Source> = []
  const done = new Set<string>()
  const active = new Set<string>()

  function visit(source: Source): void {
    if (done.has(source.file) || active.has(source.file)) return // already included, or a cycle: stop
    active.add(source.file)
    const parsed = parse(source)
    if (parsed.ok) {
      const paths = loadPaths(parsed.tree)
      // a module with a zone implicitly depends on the render runtime (the emitter synthesizes its calls). Inject it
      // unless the module already loads it or IS it (the render module itself must not depend on itself).
      if (
        hasZone(parsed.tree) &&
        !paths.some(p => p.endsWith('zone/render')) &&
        !source.file.endsWith('zone/render.tree')
      )
        paths.push(ZONE_RUNTIME_MODULE)
      for (const path of paths) {
        const dependency = resolve(path, source.file)
        if (dependency) visit(dependency) // unresolved imports are left to the checker's unknown-name diagnostics
      }
    }
    active.delete(source.file)
    done.add(source.file)
    ordered.push(source) // pushed after its dependencies, so they come first
  }

  visit(entry)
  return { sources: ordered, diagnostics }
}
