// Module resolution shared by every front end (the CLI, the dev server, the language server). It maps a `@scope/pkg`
// import to a file on disk: `stdlibResolver` finds the stdlib that ships with this monorepo, `linkResolver` follows a
// project's `term link` symlinks, and `editorResolver` combines them for an opened file (so hover / completion see the
// same modules a build would). Living in the compiler (make) keeps every consumer one-way (call / flow -> make).

import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs'
import type { Dirent } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { LoadHow, Resolver, Source } from '@term/make/code/compile/load'
import { parse, renderHead } from '@term/make/code/parser/tree'
import { groupsOf } from '@term/make/code/parser/narrow'
import type { Node } from '@term/make/code/parser/tree'
import { spanOfNode } from '@term/make/code/compile/mill-run'
import { baseRefusal, fileCandidates, packageRest } from '@term/make/code/deck/resolve'

// ---- THE PACKAGE PATH RULE (note/term/plan/manifest-mark-and-code-root.md) ----
//
// A load of `@scope/name/<path>` names a file in ONE package, with package root P (the directory holding its
// deck.tree) and code root C (what the manifest's `code ./dir` names, `./code` when absent):
//
//   1. try C/<path>, by the usual file resolution (`.tree`, `/base.tree`, `/note.tree`)
//   2. otherwise try P/<path>
//
// `base <dir>` under the load forces the package root, and its value must be the path's first segment. A bare
// package path (`@scope/name`, a manifest's `link`) names the package's entry: C/note.tree, C/base.tree, then the
// same two under P.
//
// EVERY RESOLVER CALLS THIS. The stdlib, a sibling package in this tree, a `link/` dependency, a package loading
// itself by name, the mill's own grammar loads, the language server, `term look`, `term scan` and the manifest
// grammar bundler all reach a package path through `resolvePackagePath`. When the rule changes, it changes here.

// the file candidates for one path with no extension, in order. The same order `fileCandidates` in
// deck/resolve.ts states for the browser-safe classifier.
function candidatesOf(base: string, rest: string): string[] {
  if (rest === '') {
    return [join(base, 'note.tree'), join(base, 'base.tree')]
  }

  return fileCandidates(join(base, rest))
}

// the code root a package directory's manifest names, relative to it: the argument of `code <path>` under the
// `deck` statement. A `code <0.0.1>` is the version's OLD spelling and is told apart by FORM: a text literal is not
// a path. `bear <path>` is the older spelling of the same field. Absent means `code`.
//
// Read with the real parser (note/term/one-parser.md), cached per directory against the manifest's mtime, so a
// long-lived language server sees an edited manifest and a build does not re-parse one per import.
const codeRootCache = new Map<string, { mtime: number; code: string }>()

export const DEFAULT_CODE_ROOT = 'code'

export function codeRootOfText(text: string, file = 'deck.tree'): string {
  const parsed = parse({ file, text })

  if (!parsed.ok) {
    return DEFAULT_CODE_ROOT
  }

  const headOf = (node: Node | undefined): string | undefined => {
    const first = node?.kind === 'group' ? node.nodes[0] : undefined

    return first?.kind === 'name' ? renderHead(first) : undefined
  }

  for (const statement of groupsOf(parsed.tree.nodes)) {
    if (headOf(statement) !== 'deck') {
      continue
    }

    let older: string | undefined

    for (const child of statement.nodes.slice(1)) {
      const head = headOf(child)

      if (child.kind !== 'group' || (head !== 'code' && head !== 'bear')) {
        continue
      }

      // a path argument parses as a group; `code <1.4.2>` is a text node and is the version, not a folder
      const value = headOf(child.nodes[1])

      if (value === undefined) {
        continue
      }

      const dir = value.replace(/^\.\//, '').replace(/\/+$/, '')

      if (head === 'code') {
        return dir === '' || dir === '.' ? '.' : dir
      }

      older ??= dir === '' || dir === '.' ? '.' : dir
    }

    if (older !== undefined) {
      return older
    }
  }

  return DEFAULT_CODE_ROOT
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
  const exists = input.exists ?? existsSync
  const firstOf = (base: string): string | undefined =>
    candidatesOf(base, input.rest).find(candidate => exists(candidate))

  if (input.base !== undefined) {
    const first = input.rest.split('/')[0] ?? ''
    const refused = first === input.base ? undefined : baseRefusal(`@/${input.rest}`, input.base)

    return refused ? { refused } : { file: firstOf(input.dir) }
  }

  const code = codeRootOf(input.dir)
  const codeDir = code === '.' ? input.dir : join(input.dir, code)
  const inPackage = firstOf(input.dir)

  if (codeDir === input.dir) {
    return { file: inPackage }
  }

  const inCode = firstOf(codeDir)

  if (inCode) {
    return inPackage && inPackage !== inCode ? { file: inCode, shadowed: inPackage } : { file: inCode }
  }

  return { file: inPackage }
}

// resolve `@term/base/...` imports to the stdlib that ships with this package, if it can be found on disk. The
// stdlib is `deck/base` under the term package root. We walk up from this module's directory looking for it, rather
// than assuming a fixed depth, so it is found whether this code runs from source (deck/make/code) or from the bundled
// CLI (host/line.js) -- the two sit at different depths under the package root.
// the stdlib package directory (`deck/base`, next to the compiler), found by walking up from this file. Undefined
// when the compiler runs somewhere without its stdlib.
export function stdlibBase(): string | undefined {
  // a bundle that runs from somewhere else (the build worker under /tmp) cannot walk up to the stdlib from its own
  // file, so the process that spawned it pins the path here first
  const pinned = process.env.TERM_STDLIB

  if (pinned && existsSync(join(pinned, 'code'))) {
    return pinned
  }

  const here = dirname(fileURLToPath(import.meta.url))

  let base: string | undefined
  let dir = here

  for (let depth = 0; depth < 10; depth++) {
    // the stdlib, `@term/base` at deck/base/code. It was named `seed` and lived at deck/seed until 2026-10-02, when the
    // record system that held deck/base moved out to mesh/deck/save. There is ONE candidate on purpose: a second
    // probe is how a stale directory left behind by a rename quietly becomes the stdlib.
    for (const candidate of [join(dir, 'deck', 'base')]) {
      if (existsSync(join(candidate, 'code'))) {
        base = candidate
        break
      }
    }

    if (base) {
      break
    }

    const parent = dirname(dir)

    if (parent === dir) {
      break
    }

    dir = parent
  }

  return base
}

// the stdlib's one name. Its two older spellings, `seed` under the term scope and under the cluesurf scope, are NOT
// kept as aliases: the term-scoped `seed` now names the math library, and an alias here would hand every stale
// import the stdlib instead of failing where it is written.
const STDLIB_PREFIXES = ['@term/base/']
const STDLIB_PACKAGES = STDLIB_PREFIXES.map(p => p.slice(0, -1))

export function stdlibResolver(): Resolver | undefined {
  const base = stdlibBase()

  if (!base) {
    return undefined
  }

  const prefixes = STDLIB_PREFIXES

  return (path: string, _from: string, how?: LoadHow): Source | undefined => {
    const prefix = prefixes.find(p => path.startsWith(p) || path === p.slice(0, -1))

    if (!prefix) {
      return undefined
    }

    return sourceOf(resolvePackagePath({ dir: base, rest: path.slice(prefix.length), base: how?.base }))
  }
}

// Every package that lives in the SAME tree as the stdlib, resolved without a `link/` entry.
//
// `@term/base` used to be the only package that resolved on its own (STDLIB_PREFIXES above named it and nothing
// else), so every other in-tree `@term/*` import needed a `link/@term/<name>` symlink in the importing package. Those
// symlinks are gitignored and were written with ABSOLUTE paths, so on any other checkout they do not exist and the
// import resolves to NOTHING - and an import that resolves to nothing fails silently, as a pile of unknown names in
// files that never mention the missing package. @term/face carried 40 such errors from exactly this.
//
// The packages in `<deck root>/<name>` are one repository and one version. They should reach each other by name, the
// way the stdlib already did. This is tried AFTER the link dir, so a project that really does link a different copy
// of a package still wins.
export function siblingResolver(): Resolver | undefined {
  const stdlib = stdlibBase()

  if (!stdlib) {
    return undefined
  }

  // the directory holding every in-tree package: the stdlib's own parent (`.../deck/base` -> `.../deck`)
  const deckRoot = dirname(stdlib)

  return (importPath: string, _from: string, how?: LoadHow): Source | undefined => {
    const match = /^@(?:term|cluesurf)\/([^/]+)(?:\/(.*))?$/.exec(importPath)

    if (!match) {
      return undefined
    }

    const [, pkg, rest] = match
    const root = join(deckRoot, pkg!)

    // it is a package only if it declares itself one. Without this, `@term/anything/...` would resolve against any
    // directory that happens to share the name.
    if (!existsSync(join(root, 'deck.tree'))) {
      return undefined
    }

    return sourceOf(resolvePackagePath({ dir: root, rest: rest ?? '', base: how?.base }))
  }
}

// resolve any `@scope/pkg/sub/path` import via the package manager's link dir (`<root>/link/@scope/pkg/...`), where
// `term link` symlinks each dependency. Follows the file-resolution rules (foo.tree, then foo/base.tree, foo/note.tree).
// This is how a project resolves its linked packages (@term/base, @cluesurf/bind, @cluesurf/term, @cluesurf/site).
export function linkResolver(root: string): Resolver {
  const linkDir = join(root, 'link')

  return (importPath: string, _from: string, how?: LoadHow): Source | undefined => {
    const found = packageRest(importPath)

    if (!found.found) {
      return undefined
    }

    const base = join(linkDir, found.pkg)

    if (!existsSync(base)) {
      return undefined
    }

    // canonicalize through the `link/` symlink so a file reached via a linked package and via its real path dedup
    // to one module (lets a package reference itself by name, e.g. `bear @cluesurf/site/dom/view`)
    return sourceOf(resolvePackagePath({ dir: base, rest: found.rest, base: how?.base }), realpathSync)
  }
}

// the deck root for a file: the nearest ancestor directory holding a `link/` dir or a `deck.tree` manifest
export function findProjectRoot(fromFile: string): string | undefined {
  let dir = dirname(fromFile)

  for (;;) {
    if (
      existsSync(join(dir, 'link')) ||
      existsSync(join(dir, 'deck.tree'))
    ) {
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

  return (importPath: string, fromFile: string, how?: LoadHow): Source | undefined =>
    linked?.(importPath, fromFile, how) ?? stdlib?.(importPath, fromFile, how)
}

// the modules available under a partial `load` path, for import-path completion. Given `@scope/pkg/sub/partial`, list
// the entries in the resolved `<root>/link/@scope/pkg/sub/` directory: subdirectory names and `.tree` file basenames.
export function moduleCompletions(
  root: string,
  partial: string,
): { name: string; isDir: boolean }[] {
  const match = /^(@[^/]+\/[^/]+)\/(.*)$/.exec(partial)

  if (!match) {
    return []
  }

  const [, pkg, rest] = match
  const slash = rest!.lastIndexOf('/')
  const subDir = slash >= 0 ? rest!.slice(0, slash) : ''
  // the stdlib needs no `link/` entry to resolve (stdlibResolver finds it next to the compiler), so it needs none to
  // complete either: a project that has not linked it still sees its modules
  const linkedPkg = join(root, 'link', pkg!)
  const stdlib = STDLIB_PACKAGES.includes(pkg!) && !existsSync(linkedPkg) ? stdlibBase() : undefined
  const pkgDir = stdlib ?? linkedPkg
  const code = codeRootOf(pkgDir)
  // what a path under the package can name: the code root first, then the package root, the order a load
  // resolves in (resolvePackagePath), each name once
  const dirs = [...new Set([join(pkgDir, code, subDir), join(pkgDir, subDir)])]
  const out: { name: string; isDir: boolean }[] = []
  const seen = new Set<string>()

  for (const dir of dirs) {
    let entries: string[]

    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }

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

      const name = isDir ? entry : entry.endsWith('.tree') ? entry.slice(0, -'.tree'.length) : undefined

      if (name === undefined || seen.has(`${name}:${isDir}`)) {
        continue
      }

      seen.add(`${name}:${isDir}`)
      out.push({ name, isDir })
    }
  }

  return out
}

// the shortest load path for a file inside a package: `<code root>/<rest>` written as `<rest>` when the short path
// resolves to the SAME file, which it does unless the package root holds a file the code root would shadow
function shortRest(pkgDir: string, rel: string, file: string): string {
  const code = codeRootOf(pkgDir)

  if (code === '.' || !rel.startsWith(`${code}/`)) {
    return rel
  }

  const short = rel.slice(code.length + 1)

  return resolvePackagePath({ dir: pkgDir, rest: short }).file === file ? short : rel
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

// the top-level definitions a source declares. Shared by export completion, cross-file go-to-definition, and the
// document's own definition lookup, so `line` and `column` are the 0-based position of the NAME.
//
// Read with the parser, not a per-line regex anchored on the four definition keywords. There is ONE parser for
// `.tree` (note/term/one-parser.md): the line scan found a definition written inside a `text <...>` literal whose
// content happened to start with `task `, and missed one whose name carried an interpolation. A file mid-edit does
// not parse, and then there are no definitions to offer, which is what the editor wants anyway.
const DEFINITION_KINDS = new Set(['task', 'form', 'mask', 'bind'])

export function scanDefs(text: string): ModuleExport[] {
  const defs: ModuleExport[] = []
  const parsed = parse({ file: '<scan>', text })

  if (!parsed.ok) {
    return defs
  }

  for (const group of groupsOf(parsed.tree.nodes)) {
    const head = group.nodes[0]
    const kind = head?.kind === 'name' ? renderHead(head) : undefined

    if (kind === undefined || !DEFINITION_KINDS.has(kind)) {
      continue
    }

    const nameNode = group.nodes[1]

    if (nameNode?.kind !== 'group') {
      continue
    }

    const name = nameNode.nodes[0]

    if (name?.kind !== 'name') {
      continue
    }

    const span = spanOfNode(name)

    if (!span) {
      continue
    }

    defs.push({
      name: renderHead(name),
      kind: kind as ModuleExport['kind'],
      line: span.start.line,
      column: span.start.column,
    })
  }

  return defs
}

// collect every `.tree` file under a directory (recursively), as { absolute path, path relative to `base` }. Capped so
// a pathological tree cannot stall a code action.
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

    // `tmp` is scratch and a package's own `link/` is its dependencies, which are searched as packages of their own:
    // a linked package's `tmp/` held tens of thousands of scratch files, and the walk entered every one
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

// the definition of `name` a file holds at top level. A file whose text does not contain the name cannot define it,
// and is never parsed: the search used to parse every stdlib file and up to 2,000 of every linked package's for each
// name asked, 8.6 s for one code action on the Term root (2026-10-05), where reading them all is a fraction of that
function definitionIn(file: string, name: string): ModuleExport | undefined {
  let text: string

  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return undefined
  }

  return text.includes(name) ? scanDefs(text).find(d => d.name === name) : undefined
}

function realOf(dir: string): string {
  try {
    return realpathSync(dir)
  } catch {
    return dir
  }
}

// find a linked package module that defines `name` at top level, for the auto-import code action. Searches the
// project's `link/` packages and returns the import path to load it by (e.g. `@term/base/code/text`) plus the kind.
// On-demand only (a code-action invocation), so a full scan is acceptable; it stops at the first match.
export function findModuleExporting(
  root: string,
  name: string,
): { importPath: string; kind: ModuleExport['kind'] } | undefined {
  // the stdlib first: it is the canonical home of a name, and it resolves without a `link/` entry
  const stdlib = stdlibBase()

  if (stdlib) {
    const files: { path: string; rel: string }[] = []
    treeFilesIn(stdlib, stdlib, files)

    for (const file of files) {
      const def = definitionIn(file.path, name)

      if (def) {
        const rel = file.rel.replace(/\.tree$/, '').split(sep).join('/')

        return { importPath: `@term/base/${shortRest(stdlib, rel, file.path)}`, kind: def.kind }
      }
    }
  }

  const linkDir = join(root, 'link')

  let scopes: string[]

  try {
    scopes = readdirSync(linkDir)
  } catch {
    return undefined
  }

  // EACH PACKAGE ONCE, and only a package. On the Term root `link/` holds every package twice, under `@term` and the
  // old `@cluesurf`, `@term/base` is the stdlib searched above, and `bind` points at a folder of generator inputs with
  // no manifest and no `.tree` file, which took 4.2 s of the 4.8 s a missing name cost (2026-10-05). `@term` is read
  // first so a name is offered under the current scope
  const seen = new Set<string>(stdlib ? [realOf(stdlib)] : [])

  scopes.sort((a, b) => Number(b === '@term') - Number(a === '@term') || a.localeCompare(b))

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
      const real = realOf(pkgBase)

      if (seen.has(real) || !existsSync(join(pkgBase, 'deck.tree'))) {
        continue
      }

      seen.add(real)

      const files: { path: string; rel: string }[] = []
      treeFilesIn(pkgBase, pkgBase, files)

      for (const file of files) {
        const def = definitionIn(file.path, name)

        if (def) {
          const rel = file.rel
            .replace(/\.tree$/, '')
            .split(sep)
            .join('/')

          return {
            importPath: `${scope}/${pkg}/${shortRest(pkgBase, rel, file.path)}`,
            kind: def.kind,
          }
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
