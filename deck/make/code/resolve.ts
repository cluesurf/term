// Module resolution shared by every front end (the CLI, the dev server, the language server). It maps a `@scope/pkg`
// import to a file on disk: `stdlibResolver` finds the stdlib that ships with this monorepo, `linkResolver` follows a
// project's `term link` symlinks, and `editorResolver` combines them for an opened file (so hover / completion see the
// same modules a build would). Living in the compiler (make) keeps every consumer one-way (call / flow -> make).
//
// A thin face (item 0074). The rules are package-paths.tree, and what reads the disk and the process is
// package-paths-disk.tree: `stat` and the code-root cache, `readdir`, `realpath`, the walk up to the stdlib,
// `TERM_STDLIB`, and each resolver as a case of `package-resolver`, with the reasons for each. This file holds the one
// code-root cache (spec.md section 4.8) and hands its own module address to the stdlib walk, which starts from it.

import type {
  LoadHow,
  Resolver,
  Source,
} from '@term/make/code/compile/load'
import * as paths from '@term/make/code/package-paths'
import * as disk from '@term/make/code/package-paths-disk'

type Maybe<T> = { form: 'some'; value: T } | { form: 'none' }

const maybeOf = <T>(value: T | undefined): Maybe<T> =>
  value === undefined ? { form: 'none' } : { form: 'some', value }

const given = <T>(value: Maybe<T>): T | undefined =>
  value.form === 'some' ? value.value : undefined

// the one code-root cache of the process, keyed by directory and valid while its deck.tree's change time holds
const roots = disk.makeCodeRoots()

export const DEFAULT_CODE_ROOT = 'code'

// the code root a package directory's manifest names, relative to it: the argument of `code <path>` under the
// `deck` statement, `code` when absent
export function codeRootOfText(
  text: string,
  file = 'deck.tree',
): string {
  return paths.codeRootOfText(text, file)
}

export function codeRootOf(dir: string): string {
  return disk.codeRootOnDisk(roots, dir)
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
export function sourceOf(
  hit: PackageHit,
  real: (file: string) => string = file => file,
): Source | undefined {
  if (!hit.file) {
    return undefined
  }

  return {
    file: real(hit.file),
    text: disk.readWhole(hit.file),
    ...(hit.shadowed ? { shadowed: hit.shadowed } : {}),
  }
}

// THE PACKAGE PATH RULE in a package directory (P), for the path after `@scope/name/` ('' for the package itself)
export function resolvePackagePath(input: {
  dir: string
  rest: string
  base?: string
  exists?: (file: string) => boolean
}): PackageHit {
  const exists = input.exists ?? disk.pathExists
  const hit = paths.resolvePackagePath(
    input.dir,
    input.rest,
    maybeOf(input.base),
    exists,
    codeRootOf,
  )

  // the hit's fields are `need false` maybes, which Term holds as the value itself or nothing
  const refused = hit.refused

  if (refused !== undefined) {
    return { refused }
  }

  const file = hit.file
  const shadowed = hit.shadowed

  return shadowed !== undefined ? { file, shadowed } : { file }
}

// the stdlib package directory (`deck/base`, next to the compiler), found by walking up from this file. Undefined
// when the compiler runs somewhere without its stdlib
export function stdlibBase(): string | undefined {
  return given(stdlibBaseOf())
}

function stdlibBaseOf(): Maybe<string> {
  return disk.stdlibBaseFrom(import.meta.url)
}

// a resolver the port holds, as the function a caller runs
function resolverOf(held: disk.PackageResolver): Resolver {
  return (
    path: string,
    _from: string,
    how?: LoadHow,
  ): Source | undefined =>
    given(disk.applyPackageResolver(held, path, maybeOf(how?.base))) as
      | Source
      | undefined
}

function heldResolver(
  held: Maybe<disk.PackageResolver>,
): Resolver | undefined {
  return held.form === 'some' ? resolverOf(held.value) : undefined
}

export function stdlibResolver(): Resolver | undefined {
  return heldResolver(
    disk.stdlibResolverFrom(import.meta.url, codeRootOf),
  )
}

// every package that lives in the SAME tree as the stdlib, resolved without a `link/` entry, tried AFTER the link dir
// so a project that links a different copy still wins
export function siblingResolver(): Resolver | undefined {
  return heldResolver(
    disk.siblingResolverFrom(import.meta.url, codeRootOf),
  )
}

// resolve any `@scope/pkg/sub/path` import via the package manager's link dir (`<root>/link/@scope/pkg/...`), where
// `term link` symlinks each dependency
export function linkResolver(root: string): Resolver {
  return resolverOf(disk.linkResolverOf(root, codeRootOf))
}

// the deck root for a file: the nearest ancestor directory holding a `link/` dir or a `deck.tree` manifest
export function findProjectRoot(fromFile: string): string | undefined {
  return given(paths.findProjectRoot(fromFile, disk.pathExists))
}

// the resolver an editor (language server) uses for an opened file: its project's linked packages first, then the
// bundled stdlib. Returns undefined imports to be reported, never throws.
export function editorResolver(filePath: string): Resolver {
  return resolverOf(
    disk.editorResolverOf(filePath, import.meta.url, codeRootOf),
  )
}

// the modules available under a partial `load` path, `@scope/pkg/sub/partial`, for import-path completion
export function moduleCompletions(
  root: string,
  partial: string,
): { name: string; isDir: boolean }[] {
  return paths.moduleCompletions(
    root,
    partial,
    disk.diskOf(codeRootOf, stdlibBaseOf),
  )
}

// a module's top-level definitions, with where each is declared (`line` and `column` the 0-based position of the NAME)
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
// to load it by (`@term/base/list`) and the kind, for the auto-import fix. On demand only
export function findModulesExporting(
  root: string,
  name: string,
): { importPath: string; kind: ModuleExport['kind'] }[] {
  const offers = paths.findModulesExporting(
    root,
    name,
    disk.diskOf(codeRootOf, stdlibBaseOf),
  )

  return offers.map(({ importPath, kind }) => ({
    importPath,
    kind: kind as ModuleExport['kind'],
  }))
}

export function moduleExports(
  importPath: string,
  resolve: Resolver,
): { file: string; defs: ModuleExport[] } | undefined {
  const source = resolve(importPath, '')

  return source
    ? { file: source.file, defs: scanDefs(source.text) }
    : undefined
}
