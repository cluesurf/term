// File metadata for node, over `fs.promises.stat`. It builds the emitted `FileMetadata` record directly (the shim
// is prepended to the module that declares it, so the type is in scope), which is what keeps one stat from
// becoming seven. Reached only through the public file/metadata API.
import * as fs from 'node:fs/promises'

const stat = {
  metaRead: async (
    at: string,
    follow: boolean,
  ): Promise<{
    size: number
    kind: string
    made: number
    changed: number
    opened: number
    mode: number
    link: boolean
  }> => {
    try {
      const stats = follow ? await fs.stat(at) : await fs.lstat(at)
      const kind = stats.isDirectory()
        ? 'directory'
        : stats.isSymbolicLink()
          ? 'link'
          : stats.isFile()
            ? 'file'
            : 'other'

      return {
        size: stats.size,
        kind,
        made: Math.trunc(stats.birthtimeMs),
        changed: Math.trunc(stats.mtimeMs),
        opened: Math.trunc(stats.atimeMs),
        mode: stats.mode,
        link: stats.isSymbolicLink(),
      }
    } catch {
      // a missing path reads as the zero record rather than throwing: the public API is total
      return {
        size: 0,
        kind: 'other',
        made: 0,
        changed: 0,
        opened: 0,
        mode: 0,
        link: false,
      }
    }
  },
}
