// Resolution for the `load` term. `load` is a mill (it mints a load record); this module resolves that record's
// target to a concrete module: a local file, a package in the store, or a host-native module. It is the semantic
// step the elaboration resolver runs for import holes (see note/research/vibe/computation/plans/16-package-manager.md
// and 11-elaboration.md). Browser-safe: no host APIs. A file-existence check is injected, so it is testable and
// usable in the sandbox.

export type LoadKind =
  | 'relative'
  | 'absolute'
  | 'package'
  | 'native'
  | 'glob'

export type Resolution =
  | { kind: 'file'; path: string }
  | { kind: 'package'; host: string; name: string; subpath?: string }
  | { kind: 'native'; module: string }
  | { kind: 'glob'; pattern: string; base: string }
  | { kind: 'missing'; target: string }

export type Exists = (path: string) => boolean

// ---- posix-style path helpers (browser-safe, no node path) ----
function dirname(path: string): string {
  const i = path.lastIndexOf('/')
  return i <= 0 ? (i === 0 ? '/' : '.') : path.slice(0, i)
}

function joinPath(base: string, rest: string): string {
  const parts = (base + '/' + rest).split('/')
  const out: Array<string> = []
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop()
      else out.push('..')
    } else out.push(part)
  }
  const prefix = base.startsWith('/') ? '/' : ''
  return prefix + out.join('/')
}

// ---- classification ----
export function classifyLoad(target: string, native = false): LoadKind {
  if (native) return 'native'
  if (target.includes('*')) return 'glob'
  if (target.startsWith('./') || target.startsWith('../'))
    return 'relative'
  if (target.startsWith('/')) return 'absolute'
  return 'package' // @host/deck or a bare name
}

// the candidate files to try for a path with no extension, in order
export function fileCandidates(path: string): Array<string> {
  if (path.endsWith('.tree')) return [path]
  return [`${path}.tree`, `${path}/base.tree`, `${path}/note.tree`]
}

// resolve a relative or absolute file path, trying the extension fallbacks
export function resolveFile(
  target: string,
  fromFile: string,
  exists: Exists,
): Resolution {
  const base = target.startsWith('/')
    ? target
    : joinPath(dirname(fromFile), target)
  for (const candidate of fileCandidates(base)) {
    if (exists(candidate)) return { kind: 'file', path: candidate }
  }
  return { kind: 'missing', target }
}

// parse a package target: @host/name, or @host/name/sub/path
export function parsePackage(target: string): {
  host: string
  name: string
  subpath?: string
} {
  if (target.startsWith('@')) {
    const parts = target.slice(1).split('/')
    const host = parts[0] ?? ''
    const name = parts[1] ?? ''
    const subpath =
      parts.length > 2 ? parts.slice(2).join('/') : undefined
    return { host, name, subpath }
  }
  const parts = target.split('/')
  return {
    host: '',
    name: parts[0] ?? '',
    subpath: parts.length > 1 ? parts.slice(1).join('/') : undefined,
  }
}

// walk up from a file to find the enclosing deck root (the directory holding deck.tree)
export function findDeckRoot(
  fromFile: string,
  exists: Exists,
): string | undefined {
  let dir = dirname(fromFile)
  while (true) {
    if (exists(`${dir}/deck.tree`)) return dir
    const parent = dirname(dir)
    if (parent === dir || parent === '.') break
    dir = parent
  }
  return undefined
}

// the global content-addressed store path for a package version
export function storePath(
  home: string,
  host: string,
  deck: string,
  version: string,
): string {
  return `${home}/.seed/deck/link/${host}/${deck}/${version}`
}

// the content-addressed file path in the shared tree store
export function treePath(home: string, hash: string): string {
  return `${home}/.seed/deck/tree/${hash.slice(0, 2)}/${hash}`
}

// the unified entry: resolve any load target
export function resolveLoad(
  target: string,
  fromFile: string,
  exists: Exists,
  native = false,
): Resolution {
  switch (classifyLoad(target, native)) {
    case 'native':
      return { kind: 'native', module: target.replace(/^<|>$/g, '') }
    case 'glob':
      return { kind: 'glob', pattern: target, base: dirname(fromFile) }
    case 'relative':
    case 'absolute':
      return resolveFile(target, fromFile, exists)
    case 'package': {
      const { host, name, subpath } = parsePackage(target)
      return { kind: 'package', host, name, subpath }
    }
  }
}
