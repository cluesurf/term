// Whole-path file calls for node that never await, over fs's *Sync calls. `statPath` and `listPath` build the emitted
// `StatRaw` and `EntryRaw` records directly (the shim is prepended to the module that declares them, so the types are
// in scope), one call each. `changed` is `mtimeMs`, which keeps the fraction.
//
// The import is NOT called `fs`: the prelude puts every shim's imports in one scope and keeps the first `fs` it meets,
// and a program that also loads the asynchronous file module has `fs` as `node:fs/promises`, so `fs.existsSync` was
// not a function.
//
// Reached only through the public file/blocking API, which has already ruled out a missing path.
import * as blockingFs from 'node:fs'

const blocking = {
  readPath: (at: string): string => blockingFs.readFileSync(at, 'utf8'),

  // a symbolic link is followed, so a link to nothing is not there
  existsPath: (at: string): boolean => blockingFs.existsSync(at),

  statPath: (at: string): { kind: string; size: number; changed: number } => {
    const stats = blockingFs.statSync(at)
    const kind = stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : 'other'

    return { kind, size: stats.size, changed: stats.mtimeMs }
  },

  // the platform's own order, no `.` or `..`, each kind the entry's own with links not followed
  listPath: (at: string): { name: string; kind: string }[] =>
    blockingFs.readdirSync(at, { withFileTypes: true }).map(entry => ({
      name: entry.name,
      kind: entry.isDirectory()
        ? 'directory'
        : entry.isSymbolicLink()
          ? 'link'
          : entry.isFile()
            ? 'file'
            : 'other',
    })),

  realPath: (at: string): string => blockingFs.realpathSync(at),
}
