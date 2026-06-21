import {
  DeckLink,
  DeckManifest,
  FetchConfig,
  LockEntry,
  Lockfile,
  Mark,
  MarkHold,
  RegistryPackageMeta,
  ResolutionMap,
  ResolvedDeck,
} from './form'
import {
  compareMark,
  markMatch,
  parseMark,
  showMark,
  parseMarkHold,
  pickBestMark,
} from './mark'
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
  links: Array<DeckLink>
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

  if (ctx.seen.has(link.name)) return
  ctx.seen.add(link.name)

  // check workspace first
  const workspace = ctx.workspaces.get(link.name)
  if (workspace) {
    const wsVersion = workspace.mark
    if (markMatch(wsVersion, link.mark)) {
      const key = `${link.name}@${showMark(wsVersion)}`
      ctx.resolved.set(key, {
        name: link.name,
        mark: wsVersion,
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
    hold: link.mark,
    lockfile: ctx.lockfile,
  })

  if (locked) {
    const key = `${link.name}@${showMark(locked.mark)}`
    if (!ctx.resolved.has(key)) {
      ctx.resolved.set(key, {
        name: locked.name,
        mark: locked.mark,
        hash: locked.hash,
        site: locked.site,
        link: new Map(locked.link.map(l => [l.name, l.mark])),
      })

      // resolve transitive deps from lockfile
      const transLinks: Array<DeckLink> = locked.link.map(l => ({
        name: l.name,
        mark: { form: 'exact' as const, mark: parseMark(l.mark) },
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
  const best = pickBestMark({ versions, hold: link.mark })

  if (!best) {
    throw new Error(`No version of ${link.name} matches constraint`)
  }

  const markStr = showMark(best)
  const versionMeta = getVersionMeta({ meta, mark: markStr })

  if (!versionMeta) {
    throw new Error(
      `Version metadata not found for ${link.name}@${markStr}`,
    )
  }

  const key = `${link.name}@${markStr}`
  if (ctx.resolved.has(key)) return

  const depLinks = new Map<string, string>()
  const transLinks: Array<DeckLink> = []

  for (const [depName, depConstraint] of Object.entries(
    versionMeta.dependencies,
  )) {
    depLinks.set(depName, depConstraint)
    transLinks.push({
      name: depName,
      mark: parseMarkHold(depConstraint),
    })
  }

  ctx.resolved.set(key, {
    name: link.name,
    mark: best,
    hash: versionMeta.integrity,
    site: versionMeta.tarball,
    link: depLinks,
  })

  await resolveLinks({ links: transLinks, ctx })
}

function findLockedVersion(input: {
  name: string
  hold: MarkHold
  lockfile?: Lockfile
}): LockEntry | undefined {
  if (!input.lockfile) return undefined

  for (const entry of input.lockfile.decks) {
    if (
      entry.name === input.name &&
      markMatch(entry.mark, input.hold)
    ) {
      return entry
    }
  }

  return undefined
}

export function buildLockfile(input: {
  resolution: ResolutionMap
}): Lockfile {
  const decks: Array<LockEntry> = []

  for (const resolved of input.resolution.decks.values()) {
    decks.push({
      name: resolved.name,
      mark: resolved.mark,
      hash: resolved.hash,
      site: resolved.site,
      link: Array.from(resolved.link.entries()).map(([name, mark]) => ({
        name,
        mark,
      })),
    })
  }

  return { version: 1, decks }
}
