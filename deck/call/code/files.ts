import fs from 'fs/promises'
import path from 'path'

const SKIP = new Set(['node_modules', 'host', 'tail', '.git'])

// Collect `.tree` files from the given paths. A path may be a file (taken as-is) or a directory (walked
// recursively, skipping build and dependency folders). With no paths, walk the root.
export async function collectTreeFiles(
  paths: string[],
  root: string,
): Promise<string[]> {
  const targets =
    paths.length > 0 ? paths.map(p => path.resolve(root, p)) : [root]

  const found: string[] = []

  async function walk(target: string): Promise<void> {
    const stat = await fs.stat(target).catch(() => undefined)

    if (!stat) {return}

    if (stat.isFile()) {
      if (target.endsWith('.tree')) {found.push(target)}

      return
    }

    if (stat.isDirectory()) {
      const entries = await fs.readdir(target, { withFileTypes: true })

      for (const entry of entries) {
        if (entry.isDirectory() && SKIP.has(entry.name)) {continue}

        await walk(path.join(target, entry.name))
      }
    }
  }

  for (const target of targets) {await walk(target)}

  return found.sort()
}
