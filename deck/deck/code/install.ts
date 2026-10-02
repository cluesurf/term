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
import { parseCodeHold, showCode } from './code'
import { initStore } from './store'
import { parseScope, rootScope } from './name'
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
  const loaded = await loadManifest({ dir: input.root })

  // a `host <registry>` group routes its links' scopes to that registry, so a third-party scope on its own OCI
  // namespace installs, and its links resolve beside the plain ones
  config.scopeRegistries = {
    ...config.scopeRegistries,
    ...hostScopeRegistries({ manifest: loaded }),
  }

  const manifest: DeckManifest = {
    ...loaded,
    link: [
      ...loaded.link,
      ...(loaded.hostLink ?? []).flatMap(group => group.link),
    ],
  }

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

// The scope -> registry routes a manifest's `host` groups declare. Every link in a group names the scope it routes,
// and one scope routed to two registries is refused rather than decided by file order.
export function hostScopeRegistries(input: {
  manifest: DeckManifest
}): Record<string, string> {
  const routes: Record<string, string> = {}

  for (const group of input.manifest.hostLink ?? []) {
    for (const link of group.link) {
      const scope = rootScope(parseScope({ name: link.name }).scope)

      if (!scope) {
        throw new Error(
          `host ${group.registry}: ${link.name} has no scope, so it cannot be routed to a registry`,
        )
      }

      if (routes[scope] && routes[scope] !== group.registry) {
        throw new Error(
          `${scope} is routed to two registries in deck.tree: ${routes[scope]} and ${group.registry}`,
        )
      }

      routes[scope] = group.registry
    }
  }

  return routes
}

export async function addDependency(input: {
  root: string
  name: string
  constraint?: string
}): Promise<void> {
  const manifest = await loadManifest({ dir: input.root })
  const hold = input.constraint
    ? parseCodeHold(input.constraint)
    : { form: 'wild' as const, major: 0 }

  // check if already exists
  const existing = manifest.link.findIndex(l => l.name === input.name)

  if (existing >= 0) {
    manifest.link[existing] = { name: input.name, code: hold }
  } else {
    manifest.link.push({ name: input.name, code: hold })
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
  missing: string[]
  outdated: string[]
}> {
  const lockfile = await loadLockfile({ dir: input.root })

  if (!lockfile) {
    return { ok: false, missing: ['lock.tree not found'], outdated: [] }
  }

  const missing: string[] = []
  const outdated: string[] = []

  for (const entry of lockfile.decks) {
    const codeStr = showCode(entry.code)
    const linkPath = path.join(
      input.root,
      'link',
      '.base/@cluesurf/term',
      `${entry.name}@${codeStr}`,
    )

    try {
      await fsp.access(linkPath)
    } catch {
      missing.push(`${entry.name}@${codeStr}`)
    }
  }

  return {
    ok: missing.length === 0 && outdated.length === 0,
    missing,
    outdated,
  }
}
