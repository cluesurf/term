import {
  loadManifest,
  validateManifest,
  showCode,
  writeCodeHold,
  localObjectStore,
  generateKeypair,
  makeDefaultFetchConfig,
  ociRouteOf,
  transportFor,
  publishToOci,
  buildOciArtifact,
  rotateKeys,
  isOciRegistry,
  normalizeRegistry,
  hostScopeRegistries,
  pingIndex,
  ensurePublisher,
} from '@cluesurf/deck.tree'
import type { DeckManifest, Keypair, OciRoute } from '@cluesurf/deck.tree'

import { execFileSync } from 'child_process'
import { existsSync } from 'fs'
import nodePath from 'path'

import { callBoot } from '@term/call/code/boot'
import { env, keptAt, userHome, legacyUserHome } from '@term/call/code/home'
import { closeRun, count, failRun, field, location, openRun, printData, report } from '@term/call/code/output'

// `term host`: publish this package to its scope's OCI registry, or with `--trust` / `--untrust` rotate the scope's
// key set instead. Registry credentials come from TERM_OCI_TOKEN (for TERM_OCI_HOST, default ghcr.io), GHCR_TOKEN
// (ghcr.io, what `zone load cluesurf` casts), or the docker config that `oras login` writes. See
// note/term/registry/18-oci-registry-default.md. A term.surf token (TERM_TOKEN, or the user-level `auth` file) is a
// different thing: it never reaches a registry, and only credits the version to an account in the package index
// (note/term/registry/19-package-index.md).
export async function callHost(input: {
  root: string
  dryRun?: boolean
  // `oci://<host>/<namespace>`, overriding the scope's registry: a local zot, a mirror, a staging namespace
  registry?: string
  // a public key to add to, or remove from, the scope's key set
  trust?: string
  untrust?: string
  // announce the already-published version to the package index, and build and push nothing
  ping?: boolean
}): Promise<void> {
  openRun({ verb: 'host', root: input.root, facts: input.dryRun ? ['--dry'] : input.ping ? ['--ping'] : [] })

  try {
    const manifest = await loadManifest({ dir: input.root })
    const errors = await validateManifest({ manifest })

    if (errors.length > 0) {
      // each a Problem item, `at` the manifest (section 12)
      for (const err of errors) {
        report({ glyph: 'failed', kind: 'problem', verb: 'check', subject: sentence(err), fields: [location('deck.tree')] })
      }

      closeRun({ verdict: 'Nothing was published', counts: [count(errors.length, 'errors', 'error')] })

      return
    }

    const name = manifest.host
      ? `@${manifest.host}/${manifest.name}`
      : manifest.name
    const version = showCode(manifest.mark)
    const route = routeOf({ name, registry: input.registry, manifest })

    if (input.trust || input.untrust) {
      const keypair = await loadPublishKeypair({ mint: false })

      if (!keypair) {
        report({ glyph: 'failed', kind: 'problem', verb: 'sign', subject: 'There is no signing key on this machine, so it cannot sign a new key set' })
        closeRun({ verdict: 'The key set was not changed', next: 'term host, once, to publish and make a key', failure: 'environment' })

        return
      }

      const started = Date.now()
      const rotated = await rotateKeys({
        transport: transportFor({ host: route.registry.host }),
        repository: route.keysRepository,
        scope: route.scope,
        keypair,
        add: input.trust ? [input.trust] : [],
        remove: input.untrust ? [input.untrust] : [],
      })

      report({
        glyph: 'changed',
        kind: 'change',
        verb: 'rotate',
        subject: `key set of ${route.scope}`,
        duration: Date.now() - started,
        counts: [count(rotated.keys.length, 'keys', 'key')],
        facts: [`generation ${rotated.sequence}`],
        fields: [field('ref', `${route.registry.host}/${route.keysRepository}:keys`)],
      })
      closeRun({ verdict: 'Key set rotated' })

      return
    }

    // `--ping`: announce the version the registry already holds, and build and push nothing. For a ping that failed
    // after its push landed (a package still private, the index down): a rebuild cannot repeat the push, because a
    // build carries its own time, so it is a new digest under a write-once tag and is refused
    if (input.ping) {
      const keypair = await loadPublishKeypair({ mint: false })
      const held = await transportFor({ host: route.registry.host }).getManifest({ repository: route.repository.name, reference: version })

      if (!held) {
        report({ glyph: 'failed', kind: 'problem', verb: 'ping', subject: `${name}@${version} is not published at ${route.registry.host}/${route.repository.name}` })
        closeRun({ verdict: 'Nothing was announced', next: 'term host', failure: 'usage' })

        return
      }

      if (!keypair) {
        report({ glyph: 'failed', kind: 'problem', verb: 'ping', subject: 'There is no signing key on this machine, so it cannot claim the version' })
        closeRun({ verdict: 'Nothing was announced', failure: 'environment' })

        return
      }

      report({ glyph: 'info', verb: 'read', subject: `${name}@${version}`, fields: [field('digest', held.digest)] })

      // the index checks the signer against the scope's key set, so it must exist, and this key must be in it. The
      // same step a publish runs: created on the scope's first use, a refusal when this key is not a member. A ping
      // after the key set's repository is renamed is the case that needs it
      const keys = await ensurePublisher({
        transport: transportFor({ host: route.registry.host }),
        repository: route.keysRepository,
        scope: route.scope,
        keypair,
      })

      if (keys.created) {
        report({ glyph: 'changed', kind: 'change', verb: 'create', subject: `key set of ${route.scope}`, fields: [field('ref', `${route.registry.host}/${route.keysRepository}`)] })
      }

      const sent = await announce({ route, digest: held.digest, keypair })

      closeRun({ verdict: sent ? `Announced ${name}@${version}` : 'The index did not take it', failure: sent ? undefined : 'environment' })

      return
    }

    // A package with a `line` console ships it BUILT, so an installed copy runs with `node` alone and needs no Term
    // CLI beside it. That is `term boot <line>/base.tree --out host/line`, the one generated directory a publish
    // carries (note/term/plan/split-base-zone-and-rename-seed.md, step 4).
    const include: string[] = []

    if (manifest.line) {
      const entry = nodePath.join(input.root, manifest.line, 'base.tree')

      if (existsSync(entry)) {
        // built inside this run: callBoot reports its own `build` item into it rather than opening another
        await callBoot({ root: input.root, entry, out: nodePath.join(input.root, 'host', 'line') })
        include.push('host/line')
      }
    }

    const local = localObjectStore()
    // the signed config keeps the JSON key `code` for a link's constraint: the signature covers those bytes and every
    // published version carries them, so the wire format is not the manifest's spelling and does not follow it
    const link = manifest.link.map(dep => ({
      deck: dep.name,
      code: writeCodeHold({ hold: dep.mark }),
    }))
    const annotations: Record<string, string> = {}

    // the package's source repository. GHCR reads this annotation to LINK the package to that repository (its readme,
    // its contributors, and the repository's access), which otherwise is a click on every new package. `site` in
    // deck.tree wins; without one, the git remote the package directory pushes to
    const source = manifest.site?.startsWith('https://') ? manifest.site : gitSource(input.root)

    if (source) {
      annotations['org.opencontainers.image.source'] = source
    }

    if (manifest.lock) {
      annotations['org.opencontainers.image.licenses'] = manifest.lock
    }

    // what a catalog or a search index reads without fetching any blob: the `head` and `make` lines of deck.tree.
    // Not `term`, which the grammar defines as "a licence or keyword term" and so cannot be read as either
    if (manifest.head) {
      annotations['org.opencontainers.image.description'] = manifest.head
    }

    if (manifest.make && manifest.make.length > 0) {
      annotations['surf.clue.term.keywords'] = manifest.make.join(',')
    }

    const common = {
      dir: input.root,
      package: name,
      version,
      target: { kind: 'version' as const, version },
      link,
      local,
      author: manifest.mind?.[0]?.name ?? 'unknown',
      time: new Date().toISOString(),
      message: `${name} ${version}`,
      annotations,
      include,
    }

    if (input.dryRun) {
      // a dry run never mints a key: an existing one signs, or a throwaway one does
      const keypair = (await loadPublishKeypair({ mint: false })) ?? generateKeypair()
      const started = Date.now()
      const { release, artifact } = await buildOciArtifact({ ...common, keypair })
      const target = `${route.registry.host}/${route.repository.name}:${artifact.config.tag}`

      report({
        glyph: 'done',
        verb: 'build',
        subject: `${name}@${version}`,
        duration: Date.now() - started,
        bytes: artifact.manifest.length,
        counts: [
          count(release.files.length, 'files', 'file'),
          count(release.closure.length, 'objects', 'object'),
          count(artifact.packed, 'packed'),
          count(artifact.files.packs.length, 'packs', 'pack'),
          count(artifact.loose, 'loose'),
        ],
        fields: [field('commit', release.commit), field('digest', artifact.digest)],
      })
      report({
        glyph: 'info',
        verb: 'ping',
        subject: 'package index',
        message: [
          (await readIndexToken())
            ? 'A term.surf token was found, so the ping would credit the version to its account.'
            : 'There is no term.surf token (TERM_TOKEN or the auth file), so the ping would be anonymous.',
        ],
      })
      closeRun({ verdict: 'Dry run, nothing uploaded', facts: [target] })
      // the manifest itself is the data a dry run is asked for: stdout, as it is
      printData(`${JSON.stringify(JSON.parse(artifact.manifest.toString('utf8')), null, 2)}\n`)

      return
    }

    const keypair = (await loadPublishKeypair({ mint: true }))!
    const started = Date.now()

    const result = await publishToOci({
      ...common,
      transport: transportFor({ host: route.registry.host }),
      repository: route.repository,
      scope: route.scope,
      keysRepository: route.keysRepository,
      keypair,
      // each step of the push, a debug item: shown under --verbose
      log: message => report({ glyph: 'info', verb: 'push', subject: sentence(message), level: 'debug' }),
    })

    if (result.unchanged) {
      report({ glyph: 'skipped', verb: 'push', subject: `${name}@${version}`, duration: Date.now() - started, facts: ['already published'], fields: [field('digest', result.digest)] })
      // the index may still lack it: the first ping can fail (a private package) after the push landed, and this is
      // the run that follows the fix
      await announce({ route, digest: result.digest, keypair })
      closeRun({ verdict: 'Already published, nothing moved' })

      return
    }

    report({
      glyph: 'done',
      verb: 'push',
      subject: result.reference,
      duration: Date.now() - started,
      bytes: result.bytes.uploaded,
      counts: [count(result.blobs.uploaded, 'blobs', 'blob', result.blobs.total), count(result.layers, 'layers', 'layer')],
      fields: [field('manifest', `${result.manifestSize} B`), field('signed', result.referrer)],
    })

    await announce({ route, digest: result.digest, keypair })
    closeRun({ verdict: `Published ${name}@${version}` })
  } catch (err) {
    failRun(err, input.root)
  }
}

// A hint to the package index; its crawl finds what a lost ping misses, so this never fails a publish. A term.surf
// token, when there is one, credits the version to its account. Reports the outcome and returns whether it was sent
async function announce(input: { route: OciRoute; digest: string; keypair: Keypair }): Promise<boolean> {
  const token = await readIndexToken()
  const ping = await pingIndex({ repository: input.route.repository, digest: input.digest, token, keypair: input.keypair })

  report(
    ping.form === 'sent'
      ? {
          glyph: 'done',
          verb: 'ping',
          subject: 'package index',
          facts: [ping.outcome, ping.publisher ? `credited to account ${ping.publisher}` : token ? '' : 'anonymous, no term.surf token'].filter(Boolean),
        }
      : { glyph: 'warning', verb: 'ping', subject: 'package index', facts: [ping.form], message: [sentence(ping.reason)] },
  )

  return ping.form === 'sent'
}

// a message from a library as a sentence: capital first, no trailing period (section 7)
function sentence(text: string): string {
  const trimmed = text.trim().replace(/\.$/, '')

  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1)
}

// The registry a package publishes to: `--registry` when given, else the package's own `base` line for its scope,
// else the scope's default (`@term`'s built in, any other `ghcr.io/<scope>`). Every one must be OCI.
function routeOf(input: { name: string; registry?: string; manifest: DeckManifest }): OciRoute {
  const flag = input.registry === undefined ? undefined : normalizeRegistry(input.registry)

  if (flag !== undefined && !isOciRegistry(flag)) {
    throw refusal(
      `--registry must be an OCI registry, <host>/<namespace>. The custom https registry is retired (note/term/registry/18-oci-registry-default.md)`,
    )
  }

  const defaults = makeDefaultFetchConfig()
  const config = flag
    ? { registry: flag, scopeRegistries: {} }
    : {
        ...defaults,
        scopeRegistries: {
          ...defaults.scopeRegistries,
          ...hostScopeRegistries({ manifest: input.manifest }),
        },
      }
  const route = ociRouteOf({ name: input.name, config })

  // An UNSCOPED package (`deck hello`, which is what `term wake hello` writes) has no scope to pick a registry by.
  // It builds and runs as one, and it publishes once it is told where: a scope in deck.tree, or --registry. Said in
  // those words, because "not on an oci:// registry" read as a broken registry rather than a missing scope.
  if (!route && !flag && !input.name.startsWith('@')) {
    throw refusal(
      `${input.name} has no scope, so there is no registry to publish it to. Name it \`deck @<scope>/${input.name}\` in deck.tree (a scope publishes to ghcr.io/<scope> unless a \`base\` line says otherwise), or pass --registry oci://<host>/<namespace>`,
    )
  }

  if (!route) {
    throw refusal(`${input.name} is not on an oci:// registry. Pass --registry oci://<host>/<namespace>`)
  }

  return route
}

// `git@github.com:owner/repo.git`, `ssh://git@github.com/owner/repo`, and the https spellings
const SCP_REMOTE = /^[^@/]+@([^:/]+):(.+?)(?:\.git)?\/?$/
const URL_REMOTE = /^(?:ssh|https?|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/

// The https address of the repository this package directory pushes to (`remote.origin.url`), or undefined when it is
// not in a git repository or has no origin. Credentials in an https remote (`https://x-access-token:...@github.com/`)
// are dropped, because this is written into a public manifest, and only the host and the path are kept.
export function gitSource(dir: string): string | undefined {
  let remote: string

  try {
    remote = execFileSync('git', ['-C', dir, 'config', '--get', 'remote.origin.url'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return undefined
  }

  const found = SCP_REMOTE.exec(remote) ?? URL_REMOTE.exec(remote)

  return found ? `https://${found[1]}/${found[2]}` : undefined
}

// an error a person can act on, not a bug in Term: `expected` keeps failRun from reporting it as a crash (exit 70)
function refusal(message: string): Error {
  return Object.assign(new Error(message), { expected: true })
}

// The term.surf token that credits a publish to an account in the package index: `TERM_TOKEN` (`SEED_TOKEN` still
// honored), else the user-level `auth` file, which holds the token and nothing else. Made at
// https://term.surf/settings/tokens with the `package:publish` scope. It is sent to the index only, never to a
// registry. Absent, the ping is anonymous and the version is indexed all the same.
async function readIndexToken(): Promise<string | undefined> {
  const fromEnv = env('TOKEN')?.trim()

  if (fromEnv) {
    return fromEnv
  }

  const fs = await import('fs/promises')

  try {
    const fromFile = (await fs.readFile(keptAt(userHome('auth'), legacyUserHome('auth')), 'utf-8')).trim()

    return fromFile || undefined
  } catch {
    return undefined
  }
}

// The signing keypair. A release is signed so authorship cannot be forged, and the scope's key set says which keys
// may sign it. Minted on the first publish from this machine, at mode 0600.
async function loadPublishKeypair(input: { mint: boolean }): Promise<Keypair | undefined> {
  const fs = await import('fs/promises')
  const file = keptAt(userHome('key'), legacyUserHome('key'))

  try {
    return JSON.parse(await fs.readFile(file, 'utf-8')) as Keypair
  } catch {
    if (!input.mint) {
      return undefined
    }

    const pair = generateKeypair()
    await fs.mkdir(nodePath.dirname(file), { recursive: true, mode: 0o700 })
    await fs.writeFile(file, JSON.stringify(pair, null, 2), { mode: 0o600, flag: 'wx' })

    return pair
  }
}
