// Directory reading for node, over `fs.promises.readdir`. `dirList` is one level or every level as relative
// paths; `dirWalk` is every level as `WalkEntry` records (path, kind, depth), which is the form the module that
// docks this declares. Reached only through the public file/directory API.
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

type Entry = { path: string; kind: string; depth: number }

const walkFile = {
  dirMake: async (at: string): Promise<void> => {
    try {
      await fs.mkdir(at, { recursive: true })
    } catch {
      return
    }
  },

  // one level, or every level below it as paths relative to `at`
  dirList: async (at: string, deep: boolean): Promise<string[]> => {
    const out: string[] = []

    const step = async (base: string, prefix: string): Promise<void> => {
      let entries

      try {
        entries = await fs.readdir(base, { withFileTypes: true })
      } catch {
        return
      }

      for (const entry of entries) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name
        out.push(relative)

        if (deep && entry.isDirectory()) {
          await step(path.join(base, entry.name), relative)
        }
      }
    }

    await step(at, '')

    return out
  },

  // every entry beneath `at`, with what it is and how far below the root it sits. `depth` 0 walks all the way
  // down, which is what node's own recursive readdir does.
  dirWalk: async (at: string, depth: number): Promise<Entry[]> => {
    const out: Entry[] = []

    const step = async (base: string, level: number): Promise<void> => {
      let entries

      try {
        entries = await fs.readdir(base, { withFileTypes: true })
      } catch {
        return
      }

      for (const entry of entries) {
        const whole = path.join(base, entry.name)
        const kind = entry.isDirectory()
          ? 'directory'
          : entry.isSymbolicLink()
            ? 'link'
            : entry.isFile()
              ? 'file'
              : 'other'

        out.push({ path: whole, kind, depth: level })

        if (kind === 'directory' && (depth === 0 || level + 1 < depth)) {
          await step(whole, level + 1)
        }
      }
    }

    await step(at, 0)

    return out
  },
}
