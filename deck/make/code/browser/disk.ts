// The filesystem the compiler sees in a browser: a snapshot of the standard library, held in memory, read-only.
//
// THE BUNDLE ALIASES `fs` AND `node:fs` TO THIS MODULE (make/code/browser/readme in build.mjs). The compiler's own
// resolver, `stdlibResolver` in make/code/resolve.ts, then runs unchanged over the snapshot: `resolvePackagePath`
// probes candidates with `existsSync`, `codeRootOf` reads the manifest with `statSync` and `readFileSync`, and
// `nativePrelude` reads a runtime shim the same way. So the browser resolves `load @term/base/list` by THE rule the
// CLI uses, rather than by a second copy of it that could drift.
//
// Every path is posix and absolute. A directory exists when some file lies under it. Anything that would write, watch
// or spawn throws `read-only`: the browser compile reads, and nothing in its path writes.

type Stat = {
  isFile: () => boolean
  isDirectory: () => boolean
  isSymbolicLink: () => boolean
  mtimeMs: number
  size: number
}

const FILE = new Map<string, string>()

const DIRECTORY = new Set<string>(['/'])

// the error a Node caller expects from a missing path: an Error with `code` set, which the compiler's callers catch
function absence(path: string): Error {
  return Object.assign(new Error(`ENOENT: no such file or directory, ${path}`), { code: 'ENOENT' })
}

function readOnly(): never {
  throw Object.assign(new Error('the browser filesystem is read-only'), { code: 'EROFS' })
}

function normal(path: string | URL): string {
  const text = typeof path === 'string' ? path : path.pathname
  const parts: string[] = []

  for (const part of text.split('/')) {
    if (part === '' || part === '.') {
      continue
    }

    if (part === '..') {
      parts.pop()
      continue
    }

    parts.push(part)
  }

  return `/${parts.join('/')}`
}

// put a set of files under `root`, keyed by their path relative to it. Called once, when the snapshot arrives
export function mountFiles(input: { root: string; file: Record<string, string> }): void {
  for (const [relative, text] of Object.entries(input.file)) {
    const path = normal(`${input.root}/${relative}`)

    FILE.set(path, text)

    let at = path.slice(0, path.lastIndexOf('/')) || '/'

    while (!DIRECTORY.has(at)) {
      DIRECTORY.add(at)
      at = at.slice(0, at.lastIndexOf('/')) || '/'
    }
  }
}

// how many files are mounted, for the worker's report
export function mountedCount(): number {
  return FILE.size
}

export function existsSync(path: string | URL): boolean {
  const at = normal(path)

  return FILE.has(at) || DIRECTORY.has(at)
}

export function readFileSync(path: string | URL, _encoding?: unknown): string {
  const text = FILE.get(normal(path))

  if (text === undefined) {
    throw absence(String(path))
  }

  return text
}

export function statSync(path: string | URL, _options?: unknown): Stat {
  const at = normal(path)
  const text = FILE.get(at)

  if (text === undefined && !DIRECTORY.has(at)) {
    throw absence(String(path))
  }

  return {
    isFile: () => text !== undefined,
    isDirectory: () => text === undefined,
    isSymbolicLink: () => false,
    // a snapshot never changes while it is mounted, so every file is as old as every other
    mtimeMs: 0,
    size: text?.length ?? 0,
  }
}

export const lstatSync = statSync

export function readdirSync(path: string | URL, _options?: unknown): string[] {
  const at = normal(path)

  if (!DIRECTORY.has(at)) {
    throw absence(String(path))
  }

  const prefix = at === '/' ? '/' : `${at}/`
  const names = new Set<string>()

  for (const each of [...FILE.keys(), ...DIRECTORY]) {
    if (each.startsWith(prefix) && each.length > prefix.length) {
      names.add(each.slice(prefix.length).split('/')[0]!)
    }
  }

  return [...names].sort()
}

// there are no links in a snapshot, so every path is already its own real path
export function realpathSync(path: string | URL): string {
  const at = normal(path)

  if (!existsSync(at)) {
    throw absence(String(path))
  }

  return at
}

export const writeFileSync = readOnly

export const mkdirSync = readOnly

export const appendFileSync = readOnly

export const rmSync = readOnly

export const renameSync = readOnly

export const watch = readOnly

export const openSync = readOnly

export const closeSync = readOnly

export const writeSync = readOnly

export const readSync = readOnly

export const createWriteStream = readOnly

export const createReadStream = readOnly

export const promises = {
  readFile: async (path: string) => readFileSync(path),
  writeFile: readOnly,
  mkdir: readOnly,
}

export default {
  existsSync,
  readFileSync,
  statSync,
  lstatSync,
  readdirSync,
  realpathSync,
  writeFileSync,
  mkdirSync,
  appendFileSync,
  rmSync,
  renameSync,
  watch,
  openSync,
  closeSync,
  writeSync,
  readSync,
  createWriteStream,
  createReadStream,
  promises,
}
