// THE READ TRACE behind task/port-build.ts's skip (term-cli-in-term-0002).
//
// A port's output is a function of the compiler (fingerprinted apart, from the bundle's inputs) and of every file the
// compile reads. Rather than predict that set, which spans the load closure, the stdlib, role and lean files, mill
// grammars, native files the prelude reads and any cache the compiler keeps on disk, this module WATCHES it: it wraps
// the synchronous `fs` reads every importer of `node:fs` / `fs` reaches (named ESM imports too, through
// `syncBuiltinESMExports`), and writes down each observation once, as what was seen: a content hash for a read, a yes or
// no for `existsSync`, a kind and size for a stat, the sorted entries for a directory. A later run re-performs every
// observation and skips a module only when each one still sees the same thing.
//
// It must be imported BEFORE the compiler, so a read a compiler module makes while it loads is in the trace too: ESM
// evaluates imports in order, and port-build.ts imports this first.
//
// SOUNDNESS (decision 038 of note/project/term/self-host/change/001-finish-self-host/decision/). Each module is keyed
// by the observations ITS OWN compile made (beginModule / endModule), every one of them, a repeat of an observation an
// earlier module made first included, so a file read while building module k is no key of module k + 1. That holds
// only while no in-memory cache carries one module's reads into another, and the decision lists every cache of the
// stage0 bundle that could: port-build makes the resolver, the role reader and the parse and walk memos per module, and
// the one cache it cannot reach, resolve.ts `codeRootCache` (keyed by a deck.tree's mtime, which it stats on every
// call), is attributed here: a stat that sees a file also records that file's read. Whatever the process observed
// OUTSIDE every module (stage0 loading, port-build between modules) is a key of every later module. A read the trace
// cannot describe (a file descriptor, `openSync`, a stream) marks the process UNTRACKABLE from that point on, and an
// untrackable module is never skipped.
//
// It also keeps, per compile, the `.tree` sources that compile read (openWindow / closeWindow), which port-build
// checks again just before it writes the port, so a run never writes output of a source that has since changed.

import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { syncBuiltinESMExports } from 'node:module'
import { resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

// the unwrapped functions, for port-build's own IO (the module list, reading and writing outputs, the manifest) and for
// checking an observation, none of which belongs in a trace
export const real = {
  readFileSync: fs.readFileSync,
  writeFileSync: fs.writeFileSync,
  existsSync: fs.existsSync,
  statSync: fs.statSync,
  lstatSync: fs.lstatSync,
  readdirSync: fs.readdirSync,
  realpathSync: fs.realpathSync,
  accessSync: fs.accessSync,
  mkdirSync: fs.mkdirSync,
  renameSync: fs.renameSync,
}

// the key an observation is filed under: the operation and the absolute path, `\0` between
export const UNTRACKABLE = 'untrackable\0'

// every distinct observation this process made, in the order first made, with what it saw
const seen = new Map<string, string>()
let recording = true
let depth = 0

export function sha(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

function absolute(path: unknown): string | undefined {
  if (typeof path === 'string') {
    return resolvePath(path)
  }

  if (path instanceof URL) {
    return fileURLToPath(path)
  }

  if (Buffer.isBuffer(path)) {
    return resolvePath(path.toString())
  }

  return undefined
}

function thrown(error: unknown): string {
  return `throw:${(error as { code?: string }).code ?? 'unknown'}`
}

// what the operation sees at the path NOW, through the unwrapped functions. The same function records an observation
// and checks one, so the two can never disagree about what counts as the same
export function observe(op: string, path: string): string {
  return untraced(() => look(op, path))
}

// run port-build's own IO with nothing recorded: Node's `readFileSync` of a Buffer opens the file through the module
// object, which would otherwise mark the process untrackable
export function untraced<T>(run: () => T): T {
  depth++

  try {
    return run()
  } finally {
    depth--
  }
}

function look(op: string, path: string): string {
  try {
    switch (op) {
      case 'read':
        return sha(real.readFileSync(path))
      case 'exists':
        return real.existsSync(path) ? '1' : '0'
      case 'stat':
      case 'lstat': {
        const stat = op === 'stat' ? real.statSync(path) : real.lstatSync(path)
        const kind = stat.isFile() ? 'f' : stat.isDirectory() ? 'd' : stat.isSymbolicLink() ? 'l' : 'o'

        // a file's size, which is what a reader could learn of it without reading it. Never its time: the key is content
        return stat.isFile() ? `${kind}:${stat.size}` : kind
      }
      case 'list':
        return real
          .readdirSync(path, { withFileTypes: true })
          .map(entry => `${entry.name}/${entry.isFile() ? 'f' : entry.isDirectory() ? 'd' : entry.isSymbolicLink() ? 'l' : 'o'}`)
          .sort()
          .join('\n')
      case 'real':
        return real.realpathSync(path)
      case 'access':
        real.accessSync(path)
        return 'ok'
      default:
        return 'unknown-op'
    }
  } catch (error) {
    return thrown(error)
  }
}

function note(op: string, path: unknown): void {
  if (!recording || depth > 0) {
    return
  }

  const at = absolute(path)

  if (at === undefined) {
    seen.set(UNTRACKABLE, 'never')
    return
  }

  touch(op, at)

  // THE STAT-KEYED CACHE (decision 038): resolve.ts `codeRootOf` stats `<dir>/deck.tree` on every call and reads it
  // only when its mtime moved, so a module served from that cache shows the stat and never the read. Any stat that sees
  // a file stands for the read behind it
  if ((op === 'stat' || op === 'lstat') && seen.get(`${op}\0${at}`)?.startsWith('f:')) {
    touch('read', at)
  }
}

// one observation, written down the first time the process makes it, and a key of the module being built (or of every
// later module, outside one) every time
function touch(op: string, at: string): void {
  const key = `${op}\0${at}`

  if (!seen.has(key)) {
    seen.set(key, observe(op, at))
  }

  ;(own ?? outside).add(key)
}

// THE KEY OF ONE MODULE (decision 038): what its own compile observed, and what the process observed outside any
// module, which every module after it carries
let own: Set<string> | undefined
const outside = new Set<string>()

export function beginModule(): void {
  own = new Set()
}

// the module's keys: its own observations, everything observed outside a module so far, and UNTRACKABLE once the
// process has made a read it cannot describe. Each is checked again now, and one that no longer sees what the process
// first saw (a file changed while the run went on) gives UNTRACKABLE, so the entry can never claim a file's old content
// for an output built from its new one. Such a module alone is marked: the process stays trackable for the others
export function endModule(): string[] {
  const keys = new Set([...outside, ...(own ?? [])])
  own = undefined

  for (const key of keys) {
    if (key === UNTRACKABLE) {
      continue
    }

    const cut = key.indexOf('\0')

    if (observe(key.slice(0, cut), key.slice(cut + 1)) !== seen.get(key)) {
      keys.add(UNTRACKABLE)
      break
    }
  }

  if (seen.has(UNTRACKABLE)) {
    keys.add(UNTRACKABLE)
  }

  return [...keys]
}

// THE SOURCES OF ONE COMPILE (term-cli-in-term-0151), for port-build's check at write time. While a window is open,
// every `.tree` file read is written down with the hash of what it held then, the first read of each, whether or not
// the trace saw it before (the trace keeps only a file's FIRST observation in the process). A port is emitted whole,
// with every module it loads, so its output is stale once any of these has changed
let window: Map<string, string> | undefined

export function openWindow(): void {
  window = new Map()
}

export function closeWindow(): Map<string, string> {
  const read = window ?? new Map<string, string>()
  window = undefined
  return read
}

// a wrapper that records the observation, then calls through. Calls the original makes into `fs` itself (Node's
// `readFileSync` opens, stats and reads through the module object) are inside it and not observed again
function wrap<F extends (...args: any[]) => any>(original: F, op: string | null): F {
  return function (this: unknown, ...args: any[]) {
    if (op === null) {
      if (recording && depth === 0) {
        seen.set(UNTRACKABLE, 'never')
      }
    } else {
      note(op, args[0])

      if (op === 'read' && window && depth === 0) {
        const at = absolute(args[0])

        if (at?.endsWith('.tree') && !window.has(at)) {
          window.set(at, observe('read', at))
        }
      }
    }

    depth++

    try {
      return original.apply(this, args)
    } finally {
      depth--
    }
  } as F
}

const target = fs as unknown as Record<string, (...args: any[]) => any>

target.readFileSync = wrap(fs.readFileSync, 'read')
target.existsSync = wrap(fs.existsSync, 'exists')
target.statSync = wrap(fs.statSync, 'stat')
target.lstatSync = wrap(fs.lstatSync, 'lstat')
target.readdirSync = wrap(fs.readdirSync, 'list')
target.realpathSync = wrap(fs.realpathSync, 'real')
target.accessSync = wrap(fs.accessSync, 'access')

;(target.realpathSync as unknown as { native: unknown }).native = wrap(fs.realpathSync.native, 'real')

// reads the trace cannot describe as content at a path, and every asynchronous read, which could land at any time:
// one made while recording marks the process untrackable, so no module after it is skipped
const UNTRACKED = [
  'openSync',
  'readSync',
  'readvSync',
  'fstatSync',
  'opendirSync',
  'readlinkSync',
  'createReadStream',
  'readFile',
  'readdir',
  'stat',
  'lstat',
  'access',
  'open',
  'opendir',
  'realpath',
  'exists',
  'readlink',
]

for (const name of UNTRACKED) {
  if (typeof target[name] === 'function') {
    target[name] = wrap(target[name]!, null)
  }
}

const promises = fs.promises as unknown as Record<string, (...args: any[]) => any>

for (const name of ['readFile', 'readdir', 'stat', 'lstat', 'access', 'open', 'opendir', 'realpath', 'readlink']) {
  if (typeof promises[name] === 'function') {
    promises[name] = wrap(promises[name]!, null)
  }
}

syncBuiltinESMExports()

// stop or resume recording: port-build pauses it around its own bookkeeping that reaches `fs` through another module
export function setRecording(on: boolean): void {
  recording = on
}

// every observation so far, in the order first made
export function observations(): [string, string][] {
  return [...seen]
}

export function observationCount(): number {
  return seen.size
}
