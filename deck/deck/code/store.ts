import fsp from 'fs/promises'
import path from 'path'
import os from 'os'
import { hashFile } from './hash'
import { existsSync } from 'fs'

// The toolchain's directory under `.base`, scoped the way the packages are. Spelled out rather than imported from
// deck/call/code/home.ts on purpose: @term/deck is PUBLISHED and consumed as an installed package, so it must not
// reach back into the CLI's source. Keep the two in step; home.ts is the source of truth.
const HOME = path.join('@cluesurf', 'term')
const LEGACY_HOME = 'term'
const TERM_DIR = path.join('.base', HOME)

// use the pre-rename location when it is the one that exists, so a link registry is never lost
function keptAt(current: string, legacy: string): string {
  return !existsSync(current) && existsSync(legacy) ? legacy : current
}

export function getStoreRoot(): string {
  return keptAt(
    path.join(os.homedir(), TERM_DIR),
    path.join(os.homedir(), '.base', LEGACY_HOME),
  )
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
