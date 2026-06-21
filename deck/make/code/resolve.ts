// Module resolution shared by every front end (the CLI, the dev server, the language server). It maps a `@scope/pkg`
// import to a file on disk: `stdlibResolver` finds the stdlib that ships with this monorepo, `linkResolver` follows a
// project's `seed link` symlinks, and `editorResolver` combines them for an opened file (so hover / completion see the
// same modules a build would). Living in the compiler (make) keeps every consumer one-way (call / flow -> make).

import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Resolver, Source } from '@cluesurf/make/code/compile/load'

// resolve `@cluesurf/base/...` imports to the stdlib that ships with this package, if it can be found on disk
export function stdlibResolver(): Resolver | undefined {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    // base is a sub-package of the seed monorepo: deck/make/code -> ../../../deck/base (the seed root, then deck/base)
    join(here, '..', '..', '..', 'deck', 'base'),
    // legacy sibling location, kept as a fallback during the move
    join(here, '..', '..', '..', '..', 'base.tree'),
  ]

  const base = candidates.find(c => existsSync(c))

  if (!base) {
    return undefined
  }

  return (path: string): Source | undefined => {
    const prefix = '@cluesurf/base/'

    if (!path.startsWith(prefix)) {
      return undefined
    }

    const file = join(base, `${path.slice(prefix.length)}.tree`)

    return existsSync(file)
      ? { file, text: readFileSync(file, 'utf8') }
      : undefined
  }
}

// resolve any `@scope/pkg/sub/path` import via the package manager's link dir (`<root>/link/@scope/pkg/...`), where
// `seed link` symlinks each dependency. Follows the file-resolution rules (foo.tree, then foo/base.tree, foo/note.tree).
// This is how a project resolves its linked packages (@cluesurf/base, @cluesurf/bind, @cluesurf/term, @cluesurf/site).
export function linkResolver(root: string): Resolver {
  const linkDir = join(root, 'link')

  return (importPath: string): Source | undefined => {
    const match = /^(@[^/]+\/[^/]+)\/(.+)$/.exec(importPath)

    if (!match) {
      return undefined
    }

    const [, pkg, rest] = match
    const base = join(linkDir, pkg!)

    for (const candidate of [
      join(base, `${rest}.tree`),
      join(base, rest!, 'base.tree'),
      join(base, rest!, 'note.tree'),
    ]) {
      // canonicalize through the `link/` symlink so a file reached via a linked package and via its real path dedup
      // to one module (lets a package reference itself by name, e.g. `bear @cluesurf/site/code/dom/view`)
      if (existsSync(candidate)) {
        return {
          file: realpathSync(candidate),
          text: readFileSync(candidate, 'utf8'),
        }
      }
    }

    return undefined
  }
}

// the deck root for a file: the nearest ancestor directory holding a `link/` dir or a `deck.tree` manifest
export function findProjectRoot(fromFile: string): string | undefined {
  let dir = dirname(fromFile)

  for (;;) {
    if (existsSync(join(dir, 'link')) || existsSync(join(dir, 'deck.tree'))) {
      return dir
    }

    const up = dirname(dir)

    if (up === dir) {
      return undefined
    }

    dir = up
  }
}

// the resolver an editor (language server) uses for an opened file: its project's linked packages first, then the
// bundled stdlib. Returns undefined imports to be reported, never throws.
export function editorResolver(filePath: string): Resolver {
  const root = findProjectRoot(filePath)
  const linked = root ? linkResolver(root) : undefined
  const stdlib = stdlibResolver()

  return (importPath: string, fromFile: string): Source | undefined =>
    linked?.(importPath, fromFile) ?? stdlib?.(importPath, fromFile)
}

// the modules available under a partial `load` path, for import-path completion. Given `@scope/pkg/sub/partial`, list
// the entries in the resolved `<root>/link/@scope/pkg/sub/` directory: subdirectory names and `.tree` file basenames.
export function moduleCompletions(
  root: string,
  partial: string,
): Array<{ name: string; isDir: boolean }> {
  const match = /^(@[^/]+\/[^/]+)\/(.*)$/.exec(partial)

  if (!match) {
    return []
  }

  const [, pkg, rest] = match
  const slash = rest!.lastIndexOf('/')
  const subDir = slash >= 0 ? rest!.slice(0, slash) : ''
  const dir = join(root, 'link', pkg!, subDir)

  let entries: string[]

  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }

  const out: Array<{ name: string; isDir: boolean }> = []

  for (const entry of entries) {
    if (entry.startsWith('.')) {
      continue
    }

    let isDir = false

    try {
      isDir = statSync(join(dir, entry)).isDirectory()
    } catch {
      // a dangling entry: skip it
    }

    if (isDir) {
      out.push({ name: entry, isDir: true })
    } else if (entry.endsWith('.tree')) {
      out.push({ name: entry.slice(0, -'.tree'.length), isDir: false })
    }
  }

  return out
}

// a module's top-level definitions, with where each is declared. Powers both `find` (export) completion and cross-file
// go-to-definition: the resolved file plus each definition's line / column. A scan, not a full parse, so it stays cheap
// and tolerant of in-progress edits; top-level definitions sit at column 0.
export type ModuleExport = {
  name: string
  kind: 'task' | 'form' | 'mask' | 'bind'
  line: number
  column: number
}

// the top-level definitions declared in a source, by a line scan (top-level definitions sit at column 0). Shared by
// export completion, cross-file go-to-definition, and the document's own definition lookup. `column` is the 0-based
// start of the name (past `task ` / `form ` / ...).
export function scanDefs(text: string): ModuleExport[] {
  const defs: ModuleExport[] = []

  text.split('\n').forEach((line, index) => {
    const match = /^(task|form|mask|bind) ([a-z][A-Za-z0-9-]*)/.exec(line)

    if (match) {
      defs.push({
        name: match[2]!,
        kind: match[1] as ModuleExport['kind'],
        line: index,
        column: match[1]!.length + 1,
      })
    }
  })

  return defs
}

// collect every `.tree` file under a directory (recursively), as { absolute path, path relative to `base` }. Capped so
// a pathological tree cannot stall a code action.
function treeFilesIn(
  dir: string,
  base: string,
  out: Array<{ path: string; rel: string }>,
  depth = 0,
): void {
  if (depth > 8 || out.length > 2000) {
    return
  }

  let entries: string[]

  try {
    entries = readdirSync(dir)
  } catch {
    return
  }

  for (const entry of entries) {
    if (entry.startsWith('.') || entry === 'node_modules' || entry === 'host') {
      continue
    }

    const full = join(dir, entry)
    let isDir = false

    try {
      isDir = statSync(full).isDirectory()
    } catch {
      continue
    }

    if (isDir) {
      treeFilesIn(full, base, out, depth + 1)
    } else if (entry.endsWith('.tree')) {
      out.push({ path: full, rel: relative(base, full) })
    }
  }
}

// find a linked package module that defines `name` at top level, for the auto-import code action. Searches the
// project's `link/` packages and returns the import path to load it by (e.g. `@cluesurf/base/code/text`) plus the kind.
// On-demand only (a code-action invocation), so a full scan is acceptable; it stops at the first match.
export function findModuleExporting(
  root: string,
  name: string,
): { importPath: string; kind: ModuleExport['kind'] } | undefined {
  const linkDir = join(root, 'link')

  let scopes: string[]

  try {
    scopes = readdirSync(linkDir)
  } catch {
    return undefined
  }

  for (const scope of scopes) {
    if (!scope.startsWith('@')) {
      continue
    }

    const scopeDir = join(linkDir, scope)

    let pkgs: string[]

    try {
      pkgs = readdirSync(scopeDir)
    } catch {
      continue
    }

    for (const pkg of pkgs) {
      const pkgBase = join(scopeDir, pkg)
      const files: Array<{ path: string; rel: string }> = []
      treeFilesIn(pkgBase, pkgBase, files)

      for (const file of files) {
        const def = scanDefs(readFileSync(file.path, 'utf8')).find(
          d => d.name === name,
        )

        if (def) {
          const rel = file.rel
            .replace(/\.tree$/, '')
            .split(sep)
            .join('/')
          return { importPath: `${scope}/${pkg}/${rel}`, kind: def.kind }
        }
      }
    }
  }

  return undefined
}

export function moduleExports(
  importPath: string,
  resolve: Resolver,
): { file: string; defs: ModuleExport[] } | undefined {
  const source = resolve(importPath, '')

  if (!source) {
    return undefined
  }

  return { file: source.file, defs: scanDefs(source.text) }
}
