import {
  DeckLink,
  DeckManifest,
  FetchConfig,
  InstallConfig,
} from './form'
import { loadManifest, writeManifest, parseManifest } from './manifest'
import { loadLockfile, saveLockfile } from './lock'
import { resolve, buildLockfile } from './resolve'
import { linkPackages, cleanLinks } from './link'
import { makeDefaultFetchConfig } from './fetch'
import { findWorkspaces } from './workspace'
import { parseMarkHold, showMark } from './mark'
import { initStore } from './store'
import fsp from 'fs/promises'
import path from 'path'

export async function install(input: {
  root: string
  clean?: boolean
  offline?: boolean
}): Promise<void> {
  const config: FetchConfig = makeDefaultFetchConfig()
  if (input.offline) {
    config.offline = true
  }

  await initStore()

  // step 1: read manifest
  const manifest = await loadManifest({ dir: input.root })

  // step 2: discover workspaces
  const workspaces = await findWorkspaces({ root: input.root })

  // step 3: read lockfile
  const lockfile = await loadLockfile({ dir: input.root })

  // step 4: clean if requested
  if (input.clean) {
    await cleanLinks({ root: input.root })
  }

  // step 5: resolve dependencies
  const resolution = await resolve({
    manifest,
    config,
    lockfile: lockfile ?? undefined,
    workspaces,
  })

  // step 6: link packages
  await linkPackages({
    root: input.root,
    resolution,
    config,
  })

  // step 7: write lockfile
  const newLockfile = buildLockfile({ resolution })
  await saveLockfile({ dir: input.root, lockfile: newLockfile })

  console.log(`Installed ${resolution.decks.size} packages`)
}

export async function addDependency(input: {
  root: string
  name: string
  constraint?: string
}): Promise<void> {
  const manifest = await loadManifest({ dir: input.root })
  const hold = input.constraint
    ? parseMarkHold(input.constraint)
    : { form: 'wild' as const, major: 0 }

  // check if already exists
  const existing = manifest.link.findIndex(l => l.name === input.name)
  if (existing >= 0) {
    manifest.link[existing] = { name: input.name, mark: hold }
  } else {
    manifest.link.push({ name: input.name, mark: hold })
  }

  // write updated manifest
  const text = writeManifest({ manifest })
  await fsp.writeFile(path.join(input.root, 'deck.tree'), text, 'utf-8')

  // re-install
  await install({ root: input.root })
}

export async function removeDependency(input: {
  root: string
  name: string
}): Promise<void> {
  const manifest = await loadManifest({ dir: input.root })

  manifest.link = manifest.link.filter(l => l.name !== input.name)

  // write updated manifest
  const text = writeManifest({ manifest })
  await fsp.writeFile(path.join(input.root, 'deck.tree'), text, 'utf-8')

  // re-install
  await install({ root: input.root })
}

export async function verifyInstall(input: { root: string }): Promise<{
  ok: boolean
  missing: Array<string>
  outdated: Array<string>
}> {
  const lockfile = await loadLockfile({ dir: input.root })
  if (!lockfile) {
    return { ok: false, missing: ['lock.tree not found'], outdated: [] }
  }

  const missing: Array<string> = []
  const outdated: Array<string> = []

  for (const entry of lockfile.decks) {
    const markStr = showMark(entry.mark)
    const linkPath = path.join(
      input.root,
      'link',
      '.seed',
      `${entry.name}@${markStr}`,
    )

    try {
      await fsp.access(linkPath)
    } catch {
      missing.push(`${entry.name}@${markStr}`)
    }
  }

  return {
    ok: missing.length === 0 && outdated.length === 0,
    missing,
    outdated,
  }
}
