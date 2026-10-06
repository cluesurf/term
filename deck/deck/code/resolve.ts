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

// one link waiting to be resolved, and who asked for it: `deck.tree`, or the deck whose own link it is
type Pending = { link: DeckLink; from: string }

// what looking one link up found: the deck to record under its key, and its own links, which are resolved next
type Found = { key: string; deck: ResolvedDeck; links: DeckLink[] }

// THE WHOLE GRAPH, BREADTH FIRST, IN DECLARED ORDER. A deck several decks link to is resolved by whichever link is
// reached first, so "first" must not depend on the network: until 2026-10-05 each link was resolved as its own
// promise under `Promise.all`, and the deck whose registry answered first walked its links first and picked the
// version. Now every link of one depth is LOOKED UP at once (the slow part, still concurrent), and the answers are
// RECORDED in the order the links were declared: a shallower link before a deeper one, then the order of their
// parents, then each parent's own order. One manifest and one lockfile resolve to one graph, however the registries
// answer, and a failure is the first in that order, not the first to arrive
async function resolveLinks(input: {
  links: DeckLink[]
  ctx: ResolveContext
  from: string
}): Promise<void> {
  const { ctx } = input
  let level: Pending[] = input.links.map(link => ({ link, from: input.from }))

  while (level.length > 0) {
    const fresh: Pending[] = []

    for (const one of level) {
      ctx.holds.set(one.link.name, [...(ctx.holds.get(one.link.name) ?? []), { hold: one.link.mark, from: one.from }])

      if (!ctx.seen.has(one.link.name)) {
        ctx.seen.add(one.link.name)
        fresh.push(one)
      }
    }

    const looked = await Promise.allSettled(fresh.map(one => lookUp({ link: one.link, ctx })))
    const next: Pending[] = []

    looked.forEach((answer, at) => {
      if (answer.status === 'rejected') {
        throw answer.reason
      }

      const found = answer.value

      if (ctx.resolved.has(found.key)) {
        return
      }

      ctx.resolved.set(found.key, found.deck)
      next.push(...found.links.map(link => ({ link, from: fresh[at]!.link.name })))
    })

    level = next
  }
}

// One link looked up: a workspace deck first, then the lockfile, then its registry. Reads `ctx` and never writes it,
// so the links of one depth can be looked up at once and recorded in order (`resolveLinks`)
async function lookUp(input: { link: DeckLink; ctx: ResolveContext }): Promise<Found> {
  const { link, ctx } = input

  // check workspace first
  const workspace = ctx.workspaces.get(link.name)

  if (workspace) {
    const wsVersion = workspace.mark

    if (codeMatch(wsVersion, link.mark)) {
      return {
        key: `${link.name}@${showCode(wsVersion)}`,
        deck: {
          name: link.name,
          code: wsVersion,
          hash: '',
          site: '',
          // each link as the workspace declares it, which a later lock hit reads back as that range
          link: new Map(workspace.link.map(l => [l.name, writeCodeHold({ hold: l.mark })])),
          ...('dir' in workspace && typeof workspace.dir === 'string' ? { local: workspace.dir } : {}),
        },
        links: workspace.link,
      }
    }
  }

  // check lockfile for existing resolution
  const locked = findLockedVersion({
    name: link.name,
    hold: link.mark,
    lockfile: ctx.lockfile,
  })

  if (locked) {
    return {
      key: `${link.name}@${showCode(locked.code)}`,
      deck: {
        name: locked.name,
        code: locked.code,
        hash: locked.hash,
        site: locked.site,
        ...(locked.key ? { key: locked.key } : {}),
        link: new Map(locked.link.map(l => [l.name, l.code])),
      },
      // A locked deck's links are the RANGES it declares (`0.1.x`, `1.2.0..2.0.0`), as the registry gave them, so
      // each is read as a range and finds its own lock entry. Read as an exact version, `0.1.x` was `0.1.0`: the
      // entry locked at `0.1.3` no longer matched, the registry was asked for `0.1.0`, and a second `term load`
      // rewrote the lock to it with no message. A band range did not parse at all (test/lock-transitive.test.ts)
      links: locked.link.map(l => ({ name: l.name, mark: lockedHold(l.code) })),
    }
  }

  // a scope on an `oci://` registry resolves over its tag list and its signed configs
  const route = ociRouteOf({ name: link.name, config: ctx.config })

  if (route) {
    return lookUpOci({ link, ctx, route })
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

  const depLinks = new Map<string, string>()
  const transLinks: DeckLink[] = []

  for (const [depName, depConstraint] of Object.entries(versionMeta.dependencies)) {
    depLinks.set(depName, depConstraint)
    transLinks.push({
      name: depName,
      mark: parseCodeHold(depConstraint),
    })
  }

  return {
    key: `${link.name}@${codeStr}`,
    deck: {
      name: link.name,
      code: best,
      hash: versionMeta.integrity,
      site: versionMeta.tarball,
      link: depLinks,
    },
    links: transLinks,
  }
}

// a link a lockfile holds, read as the range it is. `*` is what a workspace deck's links were written as before they
// carried their own ranges: any version
function lockedHold(text: string): CodeHold {
  return text.trim() === '*'
    ? { form: 'band', base: parseCode('0.0.0'), head: parseCode(`${Number.MAX_SAFE_INTEGER}.0.0`) }
    : parseCodeHold(text)
}

// Look one link up on an OCI registry: the tags are the versions, `pickBestCode` chooses as it does over npm's
// `versions`, and the chosen version's manifest and config are read and VERIFIED before anything is recorded. The
// links that get followed are the signed config's, never the tag list's or the manifest's.
async function lookUpOci(input: {
  link: DeckLink
  ctx: ResolveContext
  route: OciRoute
}): Promise<Found> {
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

  return {
    key: `${link.name}@${codeStr}`,
    deck: {
      name: link.name,
      code: best,
      hash: version.digest,
      site: pinnedReference({
        repository: route.repository,
        digest: version.digest,
      }),
      key: version.config.key,
      link: new Map(version.config.link.map(l => [l.deck, l.code])),
    },
    links: version.config.link.map(l => ({
      name: l.deck,
      mark: parseCodeHold(l.code),
    })),
  }
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
