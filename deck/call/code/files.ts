import fs from 'fs/promises'
import path from 'path'
import { declaresDraft } from '@term/call/code/draft'

// `link` is where `term link` puts a DEPENDENCY's source. Walking into it means formatting, linting and timing
// another package's files, which is never what a command run in this project was asked to do: the three
// `deck/zone/link/@term/base/...` entries in `term form deck --check` were @term/base's own files reported twice.
const SKIP = new Set(['node_modules', 'host', 'tail', 'link', '.git'])

// does this file declare itself unfinished? The same answer the build walk gives (call/code/draft.ts)
async function isDraft(file: string): Promise<boolean> {
  try {
    return declaresDraft(await fs.readFile(file, 'utf8'))
  } catch {
    return false
  }
}

// Collect `.tree` files from the given paths. A path may be a file (taken as-is) or a directory (walked
// recursively, skipping build and dependency folders).  With no paths, walk the root.
//
// A SHELVED FILE IS SKIPPED WHEN WALKING, the same two ways the build shelves one: `mark draft` on its own line
// near the top of a file, and a `draft.tree` in a directory, which shelves that directory and everything under
// it. Without this, `term form deck --check` could never reach zero — it reported 33 files it could not parse,
// and 32 of them were deliberately shelved drafts, several of them not written in Term at all. A check that
// cannot reach zero is a check nobody can put in a gate.
//
// A FILE NAMED EXPLICITLY IS ALWAYS TAKEN. Walking a directory is "everything here that counts"; naming a file is
// a direct request, and refusing to format a draft somebody pointed at would be answering a question they did not
// ask.
export async function collectTreeFiles(
  paths: string[],
  root: string,
): Promise<string[]> {
  const targets =
    paths.length > 0 ? paths.map(p => path.resolve(root, p)) : [root]

  const found: string[] = []

  async function walk(target: string, named: boolean): Promise<void> {
    const stat = await fs.stat(target).catch(() => undefined)

    if (!stat) {
      return
    }

    if (stat.isFile()) {
      if (target.endsWith('.tree') && (named || !(await isDraft(target)))) {
        found.push(target)
      }

      return
    }

    if (stat.isDirectory()) {
      // a `draft.tree` shelves this directory and everything under it, in one place instead of per file
      const shelved = await fs
        .stat(path.join(target, 'draft.tree'))
        .then(() => true)
        .catch(() => false)

      if (shelved) {
        return
      }

      const entries = await fs.readdir(target, { withFileTypes: true })

      for (const entry of entries) {
        if (entry.isDirectory() && SKIP.has(entry.name)) {
          continue
        }

        await walk(path.join(target, entry.name), false)
      }
    }
  }

  for (const target of targets) {
    await walk(target, paths.length > 0)
  }

  return found.sort()
}
