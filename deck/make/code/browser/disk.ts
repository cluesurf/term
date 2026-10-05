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
//
// The snapshot and every decision on it are Term since 2026-10-04, browser/snapshot.tree. This file is what makes it
// look like Node's module: a URL taken where a path is, an Error with `code` for a missing path, the read-only writes,
// and a file's size as `.length`.

import {
  fileCount,
  fileText,
  hasFile,
  hasPath,
  isDirectory,
  listDirectory,
  makeSnapshot,
  mountFile,
  normalPath,
} from '@term/make/code/browser/snapshot'

type Stat = {
  isFile: () => boolean
  isDirectory: () => boolean
  isSymbolicLink: () => boolean
  mtimeMs: number
  size: number
}

const DISK = makeSnapshot()

// the error a Node caller expects from a missing path: an Error with `code` set, which the compiler's callers catch
function absence(path: string): Error {
  return Object.assign(new Error(`ENOENT: no such file or directory, ${path}`), { code: 'ENOENT' })
}

function readOnly(): never {
  throw Object.assign(new Error('the browser filesystem is read-only'), { code: 'EROFS' })
}

function textOf(path: string | URL): string {
  return typeof path === 'string' ? path : path.pathname
}

// put a set of files under `root`, keyed by their path relative to it. Called once, when the snapshot arrives
export function mountFiles(input: { root: string; file: Record<string, string> }): void {
  for (const [relative, text] of Object.entries(input.file)) {
    mountFile(DISK, input.root, relative, text)
  }
}

// how many files are mounted, for the worker's report
export function mountedCount(): number {
  return fileCount(DISK)
}

export function existsSync(path: string | URL): boolean {
  return hasPath(DISK, textOf(path))
}

export function readFileSync(path: string | URL, _encoding?: unknown): string {
  if (!hasFile(DISK, textOf(path))) {
    throw absence(String(path))
  }

  return fileText(DISK, textOf(path))
}

export function statSync(path: string | URL, _options?: unknown): Stat {
  const file = hasFile(DISK, textOf(path))

  if (!file && !isDirectory(DISK, textOf(path))) {
    throw absence(String(path))
  }

  const size = file ? fileText(DISK, textOf(path)).length : 0

  return {
    isFile: () => file,
    isDirectory: () => !file,
    isSymbolicLink: () => false,
    // a snapshot never changes while it is mounted, so every file is as old as every other
    mtimeMs: 0,
    size,
  }
}

export const lstatSync = statSync

export function readdirSync(path: string | URL, _options?: unknown): string[] {
  if (!isDirectory(DISK, textOf(path))) {
    throw absence(String(path))
  }

  return listDirectory(DISK, textOf(path))
}

// there are no links in a snapshot, so every path is already its own real path
export function realpathSync(path: string | URL): string {
  if (!hasPath(DISK, textOf(path))) {
    throw absence(String(path))
  }

  return normalPath(textOf(path))
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
