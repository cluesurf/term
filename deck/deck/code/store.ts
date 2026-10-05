import fsp from 'fs/promises'
import path from 'path'
import os from 'os'
import { hashFile } from './hash'
import { existsSync, renameSync } from 'fs'

// The toolchain's directory under `.base`, the toolchain package's own name. Spelled out rather than imported from
// deck/call/code/home.ts on purpose: @term/deck is PUBLISHED and consumed as an installed package, so it must not
// reach back into the CLI's source. Keep the two in step; home.ts is the source of truth.
//
// Every name it has had, newest first: `@term/code` since 2026-10-05, `@cluesurf/term` before that, `term` before
// 2026-08-30. The CLI MOVES the second to the first (home.ts `settle`); this package only reads, so it never races
// the CLI's move, and until that move has happened it uses the folder that exists, whole.
const HOMES = [path.join('@term', 'code'), path.join('@cluesurf', 'term'), 'term']

export function getStoreRoot(): string {
  const all = HOMES.map(home => path.join(os.homedir(), '.base', home))

  return all.find(dir => existsSync(dir)) ?? all[0]!
}

/**
 * `~/.base/@term/code/base/`: the machine's shared store. The installed decks as an OCI image layout (`blobs/`,
 * `index.json`), which an offline install reads, and in `mill/` the parsed modules every project shares.
 *
 * It was `store/` until 2026-10-04. The installed decks are not a cache, so the old folder is MOVED, whole, by one
 * rename the first time anything asks: a rename is atomic, so it cannot half-migrate, and afterwards there is one
 * folder rather than a fallback read forever. A rename that fails (another filesystem, a permission) leaves the old
 * folder in use whole, the way `keptAt` does.
 */
export function getBaseDir(): string {
  const root = getStoreRoot()
  const current = path.join(root, 'base')
  const legacy = path.join(root, 'store')

  if (!existsSync(current) && existsSync(legacy)) {
    try {
      renameSync(legacy, current)
    } catch {
      return existsSync(current) ? current : legacy
    }
  }

  return current
}

export function getTreeDir(): string {
  return path.join(getStoreRoot(), 'tree')
}

export function getDeckDir(): string {
  return path.join(getStoreRoot(), 'deck')
}

export function getFilePath(input: { hash: string }): string {
  const prefix = input.hash.slice(0, 2)

  return path.join(getTreeDir(), prefix, input.hash)
}

export async function initStore(): Promise<void> {
  await fsp.mkdir(getTreeDir(), { recursive: true })
  await fsp.mkdir(getDeckDir(), { recursive: true })
}

export async function hasFile(input: {
  hash: string
}): Promise<boolean> {
  const filePath = getFilePath({ hash: input.hash })

  try {
    await fsp.access(filePath)

    return true
  } catch {
    return false
  }
}

export async function storeFile(input: {
  data: Buffer
  hash: string
}): Promise<string> {
  const filePath = getFilePath({ hash: input.hash })
  const dir = path.dirname(filePath)
  await fsp.mkdir(dir, { recursive: true })

  const exists = await hasFile({ hash: input.hash })

  if (!exists) {
    await fsp.writeFile(filePath, input.data)
  }

  return filePath
}

export async function storeDeckMeta(input: {
  registry: string
  name: string
  code: string
  data: string
}): Promise<void> {
  const dir = path.join(
    getDeckDir(),
    'link',
    input.registry,
    input.name,
    input.code,
  )

  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(path.join(dir, 'deck.tree'), input.data, 'utf-8')
}

export async function loadDeckMeta(input: {
  registry: string
  name: string
  code: string
}): Promise<string | undefined> {
  const file = path.join(
    getDeckDir(),
    'link',
    input.registry,
    input.name,
    input.code,
    'deck.tree',
  )

  try {
    return await fsp.readFile(file, 'utf-8')
  } catch {
    return undefined
  }
}

export async function pruneStore(input: {
  usedHashes: Set<string>
}): Promise<{ removed: number; bytes: number }> {
  const treeDir = getTreeDir()

  let removed = 0
  let bytes = 0

  try {
    const prefixes = await fsp.readdir(treeDir)

    for (const prefix of prefixes) {
      const prefixDir = path.join(treeDir, prefix)
      const stat = await fsp.stat(prefixDir)

      if (!stat.isDirectory()) {continue}

      const files = await fsp.readdir(prefixDir)

      for (const file of files) {
        if (!input.usedHashes.has(file)) {
          const filePath = path.join(prefixDir, file)
          const fileStat = await fsp.stat(filePath)
          bytes += fileStat.size
          await fsp.unlink(filePath)
          removed++
        }
      }
    }
  } catch {
    // store may not exist yet
  }

  return { removed, bytes }
}
