// Module resolution shared by every front end (the CLI, the dev server, the language server). It maps a `@scope/pkg`
// import to a file on disk: `stdlibResolver` finds the stdlib that ships with this monorepo, `linkResolver` follows a
// project's `term link` symlinks, and `editorResolver` combines them for an opened file (so hover / completion see the
// same modules a build would). Living in the compiler (make) keeps every consumer one-way (call / flow -> make).
//
// The rules are Term, package-paths.tree (self-hosting, 2026-10-06): THE PACKAGE PATH RULE (`resolvePackagePath`,
// which every resolver calls), a manifest's code root, the definitions a module declares, the completions under a
// partial `load`, and the import an unknown name is offered. This face reads the disk and the process: `stat` and the
// code-root cache, `readdir`, `realpath`, the walk up from this file to the stdlib, `TERM_STDLIB`, and each resolver
// as a closure. Why it is shaped as it is:
//   - the code root is cached per directory against the manifest's mtime, so a long-lived language server sees an
//     edited manifest and a build does not re-parse one per import
//   - the stdlib is found by walking up from this file, ONE candidate (`deck/base`) on purpose: a second probe is how a
//     stale directory left by a rename quietly becomes the stdlib. A bundle that runs elsewhere is pinned by
//     `TERM_STDLIB`
//   - its two older spellings (`seed`, under the term scope and the cluesurf scope) are NOT aliases: the term-scoped
//     `seed` now names the math library, and an alias would hand every stale import the stdlib
//   - an in-tree package resolves by name after the link dir (`siblingResolver`), and only one that declares itself
//     with a deck.tree. The symlinks it replaced were absolute and gitignored, and @term/face carried 40 errors from them
//   - a linked file is canonicalized through `realpath`, so a package reached through `link/` and by its real path is
//     one module
//   - the search for a name walks each package ONCE, `@term` first, and skips `tmp/` and a package's own `link/`. On the
//     Term root it took 4.8 s for a missing name until 2026-10-05

import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs'
import type { Dirent } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { LoadHow, Resolver, Source } from '@term/make/code/compile/load'
import { packageRest } from '@term/make/code/deck/resolve'
import * as paths from '@term/make/code/package-paths'

type Maybe<T> = { form: 'some'; value: T } | { form: 'none' }

const maybeOf = <T>(value: T | undefined): Maybe<T> => (value === undefined ? { form: 'none' } : { form: 'some', value })
const given = <T>(value: Maybe<T>): T | undefined => (value.form === 'some' ? value.value : undefined)

const codeRootCache = new Map<string, { mtime: number; code: string }>()

export const DEFAULT_CODE_ROOT = 'code'

// the code root a package directory's manifest names, relative to it: the argument of `code <path>` under the
// `deck` statement, `code` when absent
export function codeRootOfText(text: string, file = 'deck.tree'): string {
  return paths.codeRootOfText(text, file)
}

export function codeRootOf(dir: string): string {
  const file = join(dir, 'deck.tree')

  let mtime: number

  try {
    mtime = statSync(file).mtimeMs
  } catch {
    return DEFAULT_CODE_ROOT
  }

  const hit = codeRootCache.get(dir)

  if (hit && hit.mtime === mtime) {
    return hit.code
  }

  let code = DEFAULT_CODE_ROOT

  try {
    code = codeRootOfText(readFileSync(file, 'utf8'), file)
  } catch {
    code = DEFAULT_CODE_ROOT
  }

  codeRootCache.set(dir, { mtime, code })

  return code
}

export type PackageHit = {
  // the file the path names, undefined when it names none
  file?: string
  // a SECOND file the path also names, in the package root, which the code root's `file` shadows. `term lint`
  // reports it (`ambiguous-load`), so a folder hidden by another is never silent
  shadowed?: string
  // why a `base` was refused, naming both the base and the path's first segment
  refused?: string
}

// the source a hit names, carrying the file it shadows (so `term lint` can say so) and read from disk
export function sourceOf(hit: PackageHit, real: (file: string) => string = file => file): Source | undefined {
  if (!hit.file) {
    return undefined
  }

  return {
    file: real(hit.file),
    text: readFileSync(hit.file, 'utf8'),
    ...(hit.shadowed ? { shadowed: hit.shadowed } : {}),
  }
}

export function resolvePackagePath(input: {
  // the package directory, P
  dir: string
  // the path after `@scope/name/`, '' for the package itself
  rest: string
  base?: string
  exists?: (file: string) => boolean
}): PackageHit {
  const hit = paths.resolvePackagePath(input.dir, input.rest, maybeOf(input.base), input.exists ?? existsSync, codeRootOf)
  // the hit's fields are `need false` maybes, which Term holds as the value itself or nothing
  const refused = hit.refused as string | undefined

  if (refused !== undefined) {
    return { refused }
  }

  const file = hit.file as string | undefined
  const shadowed = hit.shadowed as string | undefined

  return shadowed !== undefined ? { file, shadowed } : { file }
}

// the stdlib package directory (`deck/base`, next to the compiler), found by walking up from this file. Undefined
// when the compiler runs somewhere without its stdlib
export function stdlibBase(): string | undefined {
  const pinned = process.env.TERM_STDLIB

  if (pinned && existsSync(join(pinned, 'code'))) {
    return pinned
  }

  let dir = dirname(fileURLToPath(import.meta.url))

  for (let depth = 0; depth < 10; depth++) {
    const candidate = join(dir, 'deck', 'base')

    if (existsSync(join(candidate, 'code'))) {
      return candidate
    }

    const parent = dirname(dir)

    if (parent === dir) {
      break
    }

    dir = parent
  }

  return undefined
}

export function stdlibResolver(): Resolver | undefined {
  const base = stdlibBase()

  if (!base) {
    return undefined
  }

  return (path: string, _from: string, how?: LoadHow): Source | undefined => {
    const rest = given(paths.stdlibRest(path))

    if (rest === undefined) {
      return undefined
    }

    return sourceOf(resolvePackagePath({ dir: base, rest, base: how?.base }))
  }
}

// every package that lives in the SAME tree as the stdlib, resolved without a `link/` entry, tried AFTER the link dir
// so a project that links a different copy still wins
export function siblingResolver(): Resolver | undefined {
  const stdlib = stdlibBase()

  if (!stdlib) {
    return undefined
  }

  // the directory holding every in-tree package: the stdlib's own parent (`.../deck/base` -> `.../deck`)
  const deckRoot = paths.dirnameOf(stdlib)

  return (importPath: string, _from: string, how?: LoadHow): Source | undefined => {
    const sibling = given(paths.siblingOf(importPath))

    if (!sibling) {
      return undefined
    }

    const root = paths.joinTwo(deckRoot, sibling.pkg)

    // it is a package only if it declares itself one
    if (!existsSync(paths.joinTwo(root, 'deck.tree'))) {
      return undefined
    }

    return sourceOf(resolvePackagePath({ dir: root, rest: sibling.rest, base: how?.base }))
  }
}

// resolve any `@scope/pkg/sub/path` import via the package manager's link dir (`<root>/link/@scope/pkg/...`), where
// `term link` symlinks each dependency
export function linkResolver(root: string): Resolver {
  const linkDir = paths.joinTwo(root, 'link')

  return (importPath: string, _from: string, how?: LoadHow): Source | undefined => {
    const found = packageRest(importPath)

    if (!found.found) {
      return undefined
    }

    const base = paths.joinTwo(linkDir, found.pkg)

    if (!existsSync(base)) {
      return undefined
    }

    return sourceOf(resolvePackagePath({ dir: base, rest: found.rest, base: how?.base }), realpathSync)
  }
}

// the deck root for a file: the nearest ancestor directory holding a `link/` dir or a `deck.tree` manifest
export function findProjectRoot(fromFile: string): string | undefined {
  return given(paths.findProjectRoot(fromFile, existsSync))
}

// the resolver an editor (language server) uses for an opened file: its project's linked packages first, then the
// bundled stdlib. Returns undefined imports to be reported, never throws.
export function editorResolver(filePath: string): Resolver {
  const root = findProjectRoot(filePath)
  const linked = root ? linkResolver(root) : undefined
  const stdlib = stdlibResolver()

  return (importPath: string, fromFile: string, how?: LoadHow): Source | undefined =>
    linked?.(importPath, fromFile, how) ?? stdlib?.(importPath, fromFile, how)
}

// ---- the disk, as the Term side asks it ----

// collect every `.tree` file under a directory (recursively), as { absolute path, path relative to `base` }. Capped so
// a pathological tree cannot stall a code action. `tmp` is scratch and a package's own `link/` is its dependencies,
// which are searched as packages of their own
function treeFilesIn(
  dir: string,
  base: string,
  out: { path: string; rel: string }[],
  depth = 0,
): void {
  if (depth > 8 || out.length > 2000) {
    return
  }

  let entries: Dirent[]

  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }

  for (const dirent of entries) {
    const entry = dirent.name

    if (
      entry.startsWith('.') ||
      entry === 'node_modules' ||
      entry === 'host' ||
      entry === 'tmp' ||
      (entry === 'link' && dir === base)
    ) {
      continue
    }

    const full = join(dir, entry)

    // the entry's own type, read with the listing, and a stat only for a link (which is how `link/` holds a package)
    let isDir = dirent.isDirectory()

    if (dirent.isSymbolicLink()) {
      try {
        isDir = statSync(full).isDirectory()
      } catch {
        continue
      }
    }

    if (isDir) {
      treeFilesIn(full, base, out, depth + 1)
    } else if (entry.endsWith('.tree')) {
      out.push({ path: full, rel: relative(base, full) })
    }
  }
}

function realOf(dir: string): string {
  try {
    return realpathSync(dir)
  } catch {
    return dir
  }
}

const disk = {
  exists: existsSync,
  codeRootOf,
  readFile: (path: string): Maybe<string> => {
    try {
      return { form: 'some', value: readFileSync(path, 'utf8') }
    } catch {
      return { form: 'none' }
    }
  },
  readDir: (dir: string): Maybe<string[]> => {
    try {
      return { form: 'some', value: readdirSync(dir) }
    } catch {
      return { form: 'none' }
    }
  },
  isDir: (path: string): boolean => {
    try {
      return statSync(path).isDirectory()
    } catch {
      return false
    }
  },
  realOf,
  treeFilesIn: (dir: string): { path: string; rel: string }[] => {
    const files: { path: string; rel: string }[] = []

    treeFilesIn(dir, dir, files)

    return files
  },
  stdlibBase: (): Maybe<string> => maybeOf(stdlibBase()),
}

// the modules available under a partial `load` path, for import-path completion. Given `@scope/pkg/sub/partial`, list
// the entries in the resolved `<root>/link/@scope/pkg/sub/` directory: subdirectory names and `.tree` file basenames
export function moduleCompletions(
  root: string,
  partial: string,
): { name: string; isDir: boolean }[] {
  return paths.moduleCompletions(root, partial, disk as never)
}

// a module's top-level definitions, with where each is declared. Powers both `find` (export) completion and cross-file
// go-to-definition, so `line` and `column` are the 0-based position of the NAME
export type ModuleExport = {
  name: string
  kind: 'task' | 'form' | 'mask' | 'bind'
  line: number
  column: number
}

export function scanDefs(text: string): ModuleExport[] {
  return paths.scanDefs(text) as ModuleExport[]
}

// the one module an import of `name` should name first, for a caller that offers one
export function findModuleExporting(
  root: string,
  name: string,
): { importPath: string; kind: ModuleExport['kind'] } | undefined {
  return findModulesExporting(root, name)[0]
}

// every module of the stdlib and the project's `link/` packages that defines `name` at top level, as the import path
// to load it by (`@term/base/list`) and the kind, for the auto-import fix. On demand only (a code action, a scan of a
// file with an unknown name), so a full walk is acceptable
export function findModulesExporting(
  root: string,
  name: string,
): { importPath: string; kind: ModuleExport['kind'] }[] {
  return paths.findModulesExporting(root, name, disk as never).map(({ importPath, kind }) => ({
    importPath,
    kind: kind as ModuleExport['kind'],
  }))
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
