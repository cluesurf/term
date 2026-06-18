// Module loading: resolve a program's `load @path` directives so the stdlib (base.tree) is the single source of
// truth for `form` definitions, rather than redefining them ad-hoc in every file. The entry file plus every module
// it (transitively) loads are collected in dependency order, then compiled as one merged program. Circular loads
// are handled (each module is included exactly once). Browser-safe: file reading is delegated to a resolver.

import type { Diagnostic } from '@/code/parser/diagnostic'
import type { Node, RootNode } from '@/code/parser/tree'
import { parse } from '@/code/parser/tree'

export type Source = { file: string; text: string }
// resolve an import path (e.g. `@cluesurf/base/code/maybe`) from the importing file to its source, or undefined
export type Resolver = (importPath: string, fromFile: string) => Source | undefined

// the text of a name node (a keyword or an import-path token), or a group's head name
function nameText(node: Node | undefined): string | undefined {
  if (!node) return undefined
  if (node.kind === 'name') return node.parts.map((p) => (p.kind === 'chunk' ? p.text : '')).join('')
  if (node.kind === 'group') return nameText(node.nodes[0])
  return undefined
}

// the import paths a tree loads (top-level `load @path` directives)
function loadPaths(tree: RootNode): Array<string> {
  const paths: Array<string> = []
  for (const group of tree.nodes) {
    if (nameText(group.nodes[0]) !== 'load') continue
    const path = nameText(group.nodes[1])
    if (path) paths.push(path)
  }
  return paths
}

// the entry plus every module it transitively loads, dependencies first (so forms are defined before use)
export function collectModules(entry: Source, resolve: Resolver): { sources: Array<Source>; diagnostics: Array<Diagnostic> } {
  const diagnostics: Array<Diagnostic> = []
  const ordered: Array<Source> = []
  const done = new Set<string>()
  const active = new Set<string>()

  function visit(source: Source): void {
    if (done.has(source.file) || active.has(source.file)) return // already included, or a cycle: stop
    active.add(source.file)
    const parsed = parse(source)
    if (parsed.ok) {
      for (const path of loadPaths(parsed.tree)) {
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
