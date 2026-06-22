// Module loading: resolve a program's `load @path` directives so the stdlib (base.tree) is the single source of
// truth for `form` definitions, rather than redefining them ad-hoc in every file. The entry file plus every module
// it (transitively) loads are collected in dependency order, then compiled as one merged program. Circular loads
// are handled (each module is included exactly once). Browser-safe: file reading is delegated to a resolver.

import type { Diagnostic } from '@cluesurf/make/code/parser/diagnostic'

export type Source = { file: string; text: string }

// Dependency discovery only needs two facts per module: its `load`/`bear`
// import paths and whether it has a top-level `zone`. Building the full AST
// of every transitive module just to read those is the dominant cost of a
// cold compile (a tiny file can pull in the whole stdlib closure - ~1700
// modules / 2MB - and parsing them all dominated `collectModules`). A
// column-0 line scan recovers both facts without the AST. It mirrors the
// grammar: `load`/`bear`/`zone` are column-0 heads; a `#` line is a comment;
// and an unbalanced `<...>` text literal carries content lines that must not
// be mistaken for statements.
type ImportScan = { paths: string[]; hasZone: boolean }

function scanImports(text: string): ImportScan {
  const paths: string[] = []

  let hasZone = false
  let angleDepth = 0 // open `<` minus `>` across lines: inside a text literal

  for (const line of text.split('\n')) {
    // only column-0 (top-level) lines are statements; skip body / indented lines
    const topLevel =
      line.length > 0 && !line.startsWith(' ') && !line.startsWith('\t')

    if (topLevel && angleDepth === 0 && !line.startsWith('#')) {
      const head = /^(load|bear|zone)\b/.exec(line)

      if (head) {
        const kw = head[1]

        if (kw === 'zone') {
          hasZone = true
        } else {
          // the path is the first token after the keyword, up to a comma or space.
          // a `<...>` text / template path (e.g. `bear <./{{x}}>`) is NOT a plain
          // import path - the parser reads it as a text node and skips it, so we do too.
          const m = /^\s+([^\s,]+)/.exec(line.slice(kw!.length))

          if (m && !m[1]!.startsWith('<')) {
            paths.push(m[1]!)
          }
        }
      }
    }

    // track text-literal balance so a `<...>` spanning lines does not let its
    // content be read as statements (only `<`/`>` not preceded by a backslash)
    for (const ch of line.replace(/\\[<>]/g, '')) {
      if (ch === '<') {angleDepth++}
      else if (ch === '>' && angleDepth > 0) {angleDepth--}
    }
  }

  return { paths, hasZone }
}

// resolve an import path (e.g. `@cluesurf/base/code/maybe`) from the importing file to its source, or undefined
export type Resolver = (
  importPath: string,
  fromFile: string,
) => Source | undefined

// the render runtime backing a `zone`: a module with a zone calls `element` / `text` / `dynamic` / `show` / `each`,
// which the emitter synthesizes rather than the user importing. So a module containing a zone implicitly depends on it.
// `load @path` / `bear @path` (re-exports) both pull the target into the merged program; because the program is one
// flat namespace, a `bear`ed definition is visible to anything importing this module. `scanImports` (above) reads both.
const ZONE_RUNTIME_MODULE = '@cluesurf/site/code/zone/render'

// the entry plus every module it transitively loads, dependencies first (so forms are defined before use)
export function collectModules(
  entry: Source,
  resolve: Resolver,
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

    // discover dependencies by a cheap column-0 line scan instead of a full
    // parse: building the AST of every transitive module just to read its
    // imports was the dominant cost of a cold compile. The full parse still
    // happens once, later, for the modules actually compiled.
    const scan = scanImports(source.text)
    const paths = scan.paths

    // a module with a zone implicitly depends on the render runtime (the emitter synthesizes its calls). Inject it
    // unless the module already loads it or IS it (the render module itself must not depend on itself).
    if (
      scan.hasZone &&
      !paths.some(p => p.endsWith('zone/render')) &&
      !source.file.endsWith('zone/render.tree')
    ) {
      paths.push(ZONE_RUNTIME_MODULE)
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
