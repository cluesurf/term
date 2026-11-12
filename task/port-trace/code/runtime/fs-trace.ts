// THE FS WRAP under port-build's skip (decision 140 section 3 of change 001-finish-self-host, trap T-1041), the
// platform half of task/port-trace.tree. An F1 runtime shim, prepended to the program by the native prelude, so it
// patches node's `fs` when the program starts, before the program loads stage0 (which it does only by a dynamic import).
//
// It decides nothing. Each synchronous read, existence, stat, directory and path call made outside `untraced` while
// recording is on is handed to the listener as what it is: its kind and its absolute path. A call it cannot describe as
// content at a path (a descriptor it never saw opened for reading, an open for writing, a stream, any asynchronous
// read) is handed on as `untrackable`. What counts as the same, which module an observation keys, the windows, the
// attribution of a stat to a read and every SOUNDNESS rule are Term, in task/port-trace.tree.
//
// A READ-ONLY DESCRIPTOR (item term-self-host-001-1041). An `openSync` of a path for reading is a read of that path:
// whatever is read through the descriptor is the file's content, and an `fstatSync` of it learns the kind and size a
// stat would. Node's own `readFileSync` opens and reads through the module object, and from node 23 the ESM loader
// under tsx's synchronous hooks loads a module's source with the ORIGINAL `readFileSync`, at depth 0, so its `openSync`
// and `readSync` reach here. So a read-only open is handed on as a read, its descriptor is remembered until it is
// closed, and a read or fstat through a remembered descriptor is nothing. Any other open stays untrackable.
//
// Calls the original makes into `fs` itself (node's `readFileSync` opens, stats and reads through the module object)
// run at a depth above 0 and are not handed on again, and so is everything the listener itself does.
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { resolve as resolveFsTracePath } from 'node:path'
import { fileURLToPath as fsTraceFilePath } from 'node:url'

const fsTrace = (() => {
  // the unwrapped functions, for the program's own IO and for checking an observation
  const real = {
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

  let recording = true
  let depth = 0
  let listener: ((kind: string, path: string) => void) | undefined

  const untraced = <T>(run: () => T): T => {
    depth++

    try {
      return run()
    } finally {
      depth--
    }
  }

  const absolute = (path: unknown): string | undefined => {
    if (typeof path === 'string') {
      return resolveFsTracePath(path)
    }

    if (path instanceof URL) {
      return fsTraceFilePath(path)
    }

    if (Buffer.isBuffer(path)) {
      return resolveFsTracePath(path.toString())
    }

    return undefined
  }

  const live = (): boolean => recording && depth === 0

  const tell = (kind: string, path: string): void => {
    if (listener) {
      untraced(() => listener!(kind, path))
    }
  }

  // a call of `kind` on its first argument, or one the trace cannot describe (`kind` null)
  const noted = (kind: string | null, path: unknown): void => {
    if (!live()) {
      return
    }

    const at = kind === null ? undefined : absolute(path)

    tell(at === undefined ? 'untrackable' : kind!, at ?? '')
  }

  const wrap = <F extends (...args: any[]) => any>(original: F, kind: string | null): F =>
    function (this: unknown, ...args: any[]) {
      noted(kind, args[0])
      depth++

      try {
        return original.apply(this, args)
      } finally {
        depth--
      }
    } as F

  const target = fs as unknown as Record<string, (...args: any[]) => any>

  target.readFileSync = wrap(fs.readFileSync, 'read')
  target.existsSync = wrap(fs.existsSync, 'exists')
  target.statSync = wrap(fs.statSync, 'stat')
  target.lstatSync = wrap(fs.lstatSync, 'lstat')
  target.readdirSync = wrap(fs.readdirSync, 'list')
  target.realpathSync = wrap(fs.realpathSync, 'real')
  target.accessSync = wrap(fs.accessSync, 'access')
  ;(target.realpathSync as unknown as { native: unknown }).native = wrap(fs.realpathSync.native, 'real')

  const readOnly = new Set<number>()

  const readOnlyFlags = (flags: unknown): boolean => {
    if (flags === undefined || flags === null) {
      return true
    }

    if (typeof flags === 'string') {
      return flags === 'r' || flags === 'rs' || flags === 'sr'
    }

    if (typeof flags === 'number') {
      const { O_WRONLY, O_RDWR, O_CREAT, O_TRUNC, O_APPEND } = fs.constants

      return (flags & (O_WRONLY | O_RDWR | O_CREAT | O_TRUNC | O_APPEND)) === 0
    }

    return false
  }

  const openSync = fs.openSync

  target.openSync = function (this: unknown, ...args: any[]) {
    const at = absolute(args[0])
    const filed = live() && at !== undefined && readOnlyFlags(args[1])

    if (filed) {
      tell('read', at!)
    } else if (live()) {
      tell('untrackable', '')
    }

    depth++

    let fd: number

    try {
      fd = openSync.apply(fs, args as Parameters<typeof fs.openSync>)
    } finally {
      depth--
    }

    if (filed) {
      readOnly.add(fd)
    }

    return fd
  } as typeof fs.openSync

  for (const name of ['readSync', 'readvSync', 'fstatSync']) {
    const original = target[name]!

    target[name] = function (this: unknown, ...args: any[]) {
      if (live() && !readOnly.has(args[0])) {
        tell('untrackable', '')
      }

      depth++

      try {
        return original.apply(this, args)
      } finally {
        depth--
      }
    }
  }

  const closeSync = fs.closeSync

  target.closeSync = function (this: unknown, ...args: any[]) {
    readOnly.delete(args[0])
    return closeSync.apply(fs, args as Parameters<typeof fs.closeSync>)
  } as typeof fs.closeSync

  // reads with no content at a path to describe, and every asynchronous read, which could land at any time
  for (const name of ['opendirSync', 'readlinkSync', 'createReadStream', 'readFile', 'readdir', 'stat', 'lstat', 'access', 'open', 'opendir', 'realpath', 'exists', 'readlink']) {
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

  // the same, each run untraced: node's own `readFileSync` of a Buffer opens the file through the module object, which
  // would otherwise be handed on
  const quiet = Object.fromEntries(
    Object.entries(real).map(([name, original]) => [name, (...args: any[]) => untraced(() => (original as (...a: any[]) => any)(...args))]),
  ) as typeof real

  return {
    real,
    quiet,
    untraced,
    // the one listener every observation goes to, in the order made
    listen(heard: (kind: string, path: string) => void): void {
      listener = heard
    },
    setRecording(on: boolean): void {
      recording = on
    },
  }
})()
