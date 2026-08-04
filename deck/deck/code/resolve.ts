import {
  DeckLink,
  DeckManifest,
  FetchConfig,
  LockEntry,
  Lockfile,
  Code,
  CodeHold,
  RegistryPackageMeta,
  ResolutionMap,
  ResolvedDeck,
} from './form'
import {
  compareCode,
  codeMatch,
  parseCode,
  showCode,
  parseCodeHold,
  pickBestCode,
} from './code'
import {
  fetchPackageMeta,
  getVersionList,
  getVersionMeta,
} from './fetch'

type ResolveContext = {
  config: FetchConfig
  resolved: Map<string, ResolvedDeck>
  seen: Set<string>
  lockfile?: Lockfile
  workspaces: Map<string, DeckManifest>
}

export async function resolve(input: {
  manifest: DeckManifest
  config: FetchConfig
  lockfile?: Lockfile
  workspaces?: Map<string, DeckManifest>
}): Promise<ResolutionMap> {
  const ctx: ResolveContext = {
    config: input.config,
    resolved: new Map(),
    seen: new Set(),
    lockfile: input.lockfile,
    workspaces: input.workspaces ?? new Map(),
  }

  await resolveLinks({
    links: input.manifest.link,
    ctx,
  })

  return { decks: ctx.resolved }
}

async function resolveLinks(input: {
  links: DeckLink[]
  ctx: ResolveContext
}): Promise<void> {
  const tasks = input.links.map(link =>
    resolveLink({ link, ctx: input.ctx }),
  )

  await Promise.all(tasks)
}

async function resolveLink(input: {
  link: DeckLink
  ctx: ResolveContext
}): Promise<void> {
  const { link, ctx } = input

  if (ctx.seen.has(link.name)) {return}

  ctx.seen.add(link.name)

  // check workspace first
  const workspace = ctx.workspaces.get(link.name)

  if (workspace) {
    const wsVersion = workspace.code

    if (codeMatch(wsVersion, link.code)) {
      const key = `${link.name}@${showCode(wsVersion)}`
      ctx.resolved.set(key, {
        name: link.name,
        code: wsVersion,
        hash: '',
        site: '',
        link: new Map(workspace.link.map(l => [l.name, '*'])),
      })
      await resolveLinks({ links: workspace.link, ctx })

      return
    }
  }

  // check lockfile for existing resolution
  const locked = findLockedVersion({
    name: link.name,
    hold: link.code,
    lockfile: ctx.lockfile,
  })

  if (locked) {
    const key = `${link.name}@${showCode(locked.code)}`

    if (!ctx.resolved.has(key)) {
      ctx.resolved.set(key, {
        name: locked.name,
        code: locked.code,
        hash: locked.hash,
        site: locked.site,
        link: new Map(locked.link.map(l => [l.name, l.code])),
      })

      // resolve transitive deps from lockfile
      const transLinks: DeckLink[] = locked.link.map(l => ({
        name: l.name,
        code: { form: 'exact' as const, code: parseCode(l.code) },
      }))

      await resolveLinks({ links: transLinks, ctx })
    }

    return
  }

  // fetch from registry
  const meta = await fetchPackageMeta({
    name: link.name,
    config: ctx.config,
  })

  const versions = getVersionList({ meta })
  const best = pickBestCode({ versions, hold: link.code })

  if (!best) {
    throw new Error(`No version of ${link.name} matches constraint`)
  }

  const codeStr = showCode(best)
  const versionMeta = getVersionMeta({ meta, code: codeStr })

  if (!versionMeta) {
    throw new Error(
      `Version metadata not found for ${link.name}@${codeStr}`,
    )
  }

  const key = `${link.name}@${codeStr}`

  if (ctx.resolved.has(key)) {return}

  const depLinks = new Map<string, string>()
  const transLinks: DeckLink[] = []

  for (const [depName, depConstraint] of Object.entries(
    versionMeta.dependencies,
  )) {
    depLinks.set(depName, depConstraint)
    transLinks.push({
      name: depName,
      code: parseCodeHold(depConstraint),
    })
  }

  ctx.resolved.set(key, {
    name: link.name,
    code: best,
    hash: versionMeta.integrity,
    site: versionMeta.tarball,
    link: depLinks,
  })

  await resolveLinks({ links: transLinks, ctx })
}

function findLockedVersion(input: {
  name: string
  hold: CodeHold
  lockfile?: Lockfile
}): LockEntry | undefined {
  if (!input.lockfile) {return undefined}

  for (const entry of input.lockfile.decks) {
    if (
      entry.name === input.name &&
      codeMatch(entry.code, input.hold)
    ) {
      return entry
    }
  }

  return undefined
}

export function buildLockfile(input: {
  resolution: ResolutionMap
}): Lockfile {
  const decks: LockEntry[] = []

  for (const resolved of input.resolution.decks.values()) {
    decks.push({
      name: resolved.name,
      code: resolved.code,
      hash: resolved.hash,
      site: resolved.site,
      link: Array.from(resolved.link.entries()).map(([name, code]) => ({
        name,
        code,
      })),
    })
  }

  return { version: 1, decks }
}
