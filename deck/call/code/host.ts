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
} from '@cluesurf/deck.tree'
import type { DeckManifest, Keypair, OciRoute } from '@cluesurf/deck.tree'

import { existsSync } from 'fs'
import nodePath from 'path'

import { callBoot } from '@term/call/code/boot'
import { keptAt, userHome, legacyUserHome } from '@term/call/code/home'
import {
  logGood,
  logFail,
  logStep,
  formatError,
  fade,
} from '@term/make/code/tint'

// `term host`: publish this package to its scope's OCI registry, or with `--trust` / `--untrust` rotate the scope's
// key set instead. Credentials come from TERM_OCI_TOKEN (for TERM_OCI_HOST, default ghcr.io), GHCR_TOKEN (ghcr.io,
// what `zone load cluesurf` casts), or the docker config that `oras login` writes. See
// note/term/registry/18-oci-registry-default.md.
export async function callHost(input: {
  root: string
  dryRun?: boolean
  // `oci://<host>/<namespace>`, overriding the scope's registry: a local zot, a mirror, a staging namespace
  registry?: string
  // a public key to add to, or remove from, the scope's key set
  trust?: string
  untrust?: string
}): Promise<void> {
  logStep('Reading deck.tree...')

  try {
    const manifest = await loadManifest({ dir: input.root })
    const errors = await validateManifest({ manifest })

    if (errors.length > 0) {
      for (const err of errors) {
        logFail(err)
      }

      process.exit(1)
    }

    const name = manifest.host
      ? `@${manifest.host}/${manifest.name}`
      : manifest.name
    const version = showCode(manifest.code)
    const route = routeOf({ name, registry: input.registry, manifest })

    if (input.trust || input.untrust) {
      const keypair = await loadPublishKeypair({ mint: false })

      if (!keypair) {
        logFail('No signing key on this machine, so it cannot sign a new key set. Publish once first')
        process.exit(1)
      }

      const rotated = await rotateKeys({
        transport: transportFor({ host: route.registry.host }),
        repository: route.keysRepository,
        scope: route.scope,
        keypair,
        add: input.trust ? [input.trust] : [],
        remove: input.untrust ? [input.untrust] : [],
      })

      logGood(
        `Key set of ${route.scope} is generation ${rotated.sequence}, ${rotated.keys.length} keys, at ${route.registry.host}/${route.keysRepository}:keys`,
      )

      return
    }

    // A package with a `line` console ships it BUILT, so an installed copy runs with `node` alone and needs no Term
    // CLI beside it. That is `term boot <line>/base.tree --out host/line`, the one generated directory a publish
    // carries (note/term/plan/split-base-zone-and-rename-seed.md, step 4).
    const include: string[] = []

    if (manifest.line) {
      const entry = nodePath.join(input.root, manifest.line, 'base.tree')

      if (existsSync(entry)) {
        logStep(`Building the ${manifest.line} console into host/line...`)
        await callBoot({ root: input.root, entry, out: nodePath.join(input.root, 'host', 'line') })
        include.push('host/line')
      }
    }

    const local = localObjectStore()
    const link = manifest.link.map(dep => ({
      deck: dep.name,
      code: writeCodeHold({ hold: dep.code }),
    }))
    const annotations: Record<string, string> = {}

    if (manifest.site?.startsWith('https://')) {
      annotations['org.opencontainers.image.source'] = manifest.site
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
      const { release, artifact } = await buildOciArtifact({ ...common, keypair })

      console.log('')
      console.log(fade(`  Dry run. Nothing uploaded. Would push to ${route.registry.host}/${route.repository.name}:${artifact.config.tag}`))
      console.log(fade(`  commit   ${release.commit}`))
      console.log(fade(`  manifest ${artifact.digest}, ${artifact.manifest.length} bytes`))
      console.log(
        fade(
          `  ${release.files.length} files, ${release.closure.length} objects: ${artifact.packed} packed into ${artifact.files.packs.length} packs, ${artifact.loose} loose`,
        ),
      )
      console.log('')
      console.log(JSON.stringify(JSON.parse(artifact.manifest.toString('utf8')), null, 2))

      return
    }

    const keypair = (await loadPublishKeypair({ mint: true }))!

    logStep(`Publishing ${name}@${version} to ${route.registry.host}/${route.repository.name}...`)

    const result = await publishToOci({
      ...common,
      transport: transportFor({ host: route.registry.host }),
      repository: route.repository,
      scope: route.scope,
      keysRepository: route.keysRepository,
      keypair,
      log: message => console.log(fade(`  ${message}`)),
    })

    if (result.unchanged) {
      logGood(`${name}@${version} is already published as ${result.digest}. Nothing moved`)

      return
    }

    logGood(`Published ${result.reference}`)
    console.log(
      fade(
        `  ${result.blobs.uploaded} of ${result.blobs.total} blobs uploaded (${result.bytes.uploaded} of ${result.bytes.total} bytes), ` +
          `${result.layers} layers, manifest ${result.manifestSize} bytes, signature referrer ${result.referrer}`,
      ),
    )
  } catch (err) {
    logFail(formatError(err))
    process.exit(1)
  }
}

// The registry a package publishes to: `--registry` when given, else the package's own `base` line for its scope,
// else the scope's default (`@term`'s built in, any other `ghcr.io/<scope>`). Every one must be OCI.
function routeOf(input: { name: string; registry?: string; manifest: DeckManifest }): OciRoute {
  const flag = input.registry === undefined ? undefined : normalizeRegistry(input.registry)

  if (flag !== undefined && !isOciRegistry(flag)) {
    throw new Error(
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

  if (!route) {
    throw new Error(`${input.name} is not on an oci:// registry. Pass --registry oci://<host>/<namespace>`)
  }

  return route
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
