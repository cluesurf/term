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
import { writeCodeHold } from './manifest'
import { ociRouteOf, transportFor, trustDir, type OciRoute } from './oci/client'
import { listOciVersions, readOciVersion } from './oci/install'
import { pinnedReference, tagOfVersion } from './oci/reference'

type ResolveContext = {
  config: FetchConfig
  resolved: Map<string, ResolvedDeck>
  seen: Set<string>
  // every version range a deck was asked for, and who asked: the first link picks the version, and every other one
  // is held to it once the resolution is done
  holds: Map<string, { hold: CodeHold; from: string }[]>
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
    holds: new Map(),
    lockfile: input.lockfile,
    workspaces: input.workspaces ?? new Map(),
  }

  await resolveLinks({
    links: input.manifest.link,
    ctx,
    from: 'deck.tree',
  })

  checkHolds(ctx)

  return { decks: ctx.resolved }
}

// One version of a deck is installed, the first link's pick. Every other link to it must accept that version: two
// that do not were kept the first and dropped the second without a word, where npm and pnpm install a second copy
// and Cargo does across major versions (guides: packages/install, 2026-10-04). Term refuses, naming both.
function checkHolds(ctx: ResolveContext): void {
  for (const [name, holds] of ctx.holds) {
    const picked = [...ctx.resolved.values()].find(deck => deck.name === name)

    if (!picked) {
      continue
    }

    const refused = holds.find(one => !codeMatch(picked.code, one.hold))

    if (refused) {
      const first = holds.find(one => codeMatch(picked.code, one.hold)) ?? holds[0]!

      throw new Error(
        `${name}: ${first.from} accepts ${writeCodeHold({ hold: first.hold })} and ${refused.from} accepts ` +
          `${writeCodeHold({ hold: refused.hold })}, and one version of a deck is installed. ${showCode(picked.code)} ` +
          `fits only the first. Widen one of the two ranges`,
      )
    }
  }
}

async function resolveLinks(input: {
  links: DeckLink[]
  ctx: ResolveContext
  // who asked for these links: `deck.tree`, or the deck whose own links they are
  from: string
}): Promise<void> {
  const tasks = input.links.map(link =>
    resolveLink({ link, ctx: input.ctx, from: input.from }),
  )

  await Promise.all(tasks)
}

async function resolveLink(input: {
  link: DeckLink
  ctx: ResolveContext
  from: string
}): Promise<void> {
  const { link, ctx } = input

  ctx.holds.set(link.name, [...(ctx.holds.get(link.name) ?? []), { hold: link.mark, from: input.from }])

  if (ctx.seen.has(link.name)) {return}

  ctx.seen.add(link.name)

  // check workspace first
  const workspace = ctx.workspaces.get(link.name)

  if (workspace) {
    const wsVersion = workspace.mark

    if (codeMatch(wsVersion, link.mark)) {
      const key = `${link.name}@${showCode(wsVersion)}`
      ctx.resolved.set(key, {
        name: link.name,
        code: wsVersion,
        hash: '',
        site: '',
        link: new Map(workspace.link.map(l => [l.name, '*'])),
        ...('dir' in workspace && typeof workspace.dir === 'string' ? { local: workspace.dir } : {}),
      })
      await resolveLinks({ links: workspace.link, ctx, from: link.name })

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
    const key = `${link.name}@${showCode(locked.code)}`

    if (!ctx.resolved.has(key)) {
      ctx.resolved.set(key, {
        name: locked.name,
        code: locked.code,
        hash: locked.hash,
        site: locked.site,
        ...(locked.key ? { key: locked.key } : {}),
        link: new Map(locked.link.map(l => [l.name, l.code])),
      })

      // resolve transitive deps from lockfile
      const transLinks: DeckLink[] = locked.link.map(l => ({
        name: l.name,
        mark: { form: 'exact' as const, code: parseCode(l.code) },
      }))

      await resolveLinks({ links: transLinks, ctx, from: link.name })
    }

    return
  }

  // a scope on an `oci://` registry resolves over its tag list and its signed configs
  const route = ociRouteOf({ name: link.name, config: ctx.config })

  if (route) {
    await resolveOciLink({ link, ctx, route })

    return
  }

  // fetch from registry
  const meta = await fetchPackageMeta({
    name: link.name,
    config: ctx.config,
  })

  const versions = getVersionList({ meta })
  const best = pickBestCode({ versions, hold: link.mark })

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
      mark: parseCodeHold(depConstraint),
    })
  }

  ctx.resolved.set(key, {
    name: link.name,
    code: best,
    hash: versionMeta.integrity,
    site: versionMeta.tarball,
    link: depLinks,
  })

  await resolveLinks({ links: transLinks, ctx, from: link.name })
}

// Resolve one link against an OCI registry: the tags are the versions, `pickBestCode` chooses as it does over npm's
// `versions`, and the chosen version's manifest and config are read and VERIFIED before anything is recorded. The
// links that get followed are the signed config's, never the tag list's or the manifest's.
async function resolveOciLink(input: {
  link: DeckLink
  ctx: ResolveContext
  route: OciRoute
}): Promise<void> {
  const { link, ctx, route } = input
  const host = route.registry.host
  const transport = transportFor({ host, offline: ctx.config.offline })
  const versions: Code[] = []

  for (const version of await listOciVersions({
    transport,
    repository: route.repository.name,
  })) {
    try {
      versions.push(parseCode(version))
    } catch {
      // a tag that starts with a digit and is not a version is not one of ours
    }
  }

  const best = pickBestCode({ versions, hold: link.mark })

  if (!best) {
    throw new Error(
      `No version of ${link.name} matches constraint (${versions.length} published at ${transport.label}/${route.repository.name})`,
    )
  }

  const codeStr = showCode(best)
  const key = `${link.name}@${codeStr}`

  if (ctx.resolved.has(key)) {return}

  const version = await readOciVersion({
    transport,
    repository: route.repository.name,
    package: link.name,
    reference: tagOfVersion(codeStr),
    scope: route.scope,
    keysRepository: route.keysRepository,
    host,
    trustDir: trustDir(),
    expect: { version: codeStr },
    warn: message => console.warn(`  ${message}`),
  })

  ctx.resolved.set(key, {
    name: link.name,
    code: best,
    hash: version.digest,
    site: pinnedReference({
      repository: route.repository,
      digest: version.digest,
    }),
    key: version.config.key,
    link: new Map(version.config.link.map(l => [l.deck, l.code])),
  })

  await resolveLinks({
    links: version.config.link.map(l => ({
      name: l.deck,
      mark: parseCodeHold(l.code),
    })),
    ctx,
    from: link.name,
  })
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
      ...(resolved.key ? { key: resolved.key } : {}),
      link: Array.from(resolved.link.entries()).map(([name, code]) => ({
        name,
        code,
      })),
    })
  }

  return { version: 1, decks }
}
