// Where a package's OCI registry is, how to talk to it, and where the local store lives.

import path from 'path'

import type { FetchConfig } from '../form'
import { parseScope, resolveRegistry, rootScope } from '../name'
import { getBaseDir, getStoreRoot } from '../store'
import { credentialsFor } from './auth'
import { layoutObjectStore, layoutTransport } from './layout'
import { isOciRegistry, parseOciRegistry, repositoryOf, type OciRegistryReference, type OciRepository } from './reference'
import { httpTransport, type OciTransport } from './transport'

/** The OCI image layout every install fills and every offline install reads: `~/.base/@term/code/base`. */
export function storeDir(): string {
  return process.env['TERM_STORE']?.trim() || getBaseDir()
}

/** Where scope key pins are kept, beside the store. Not a cache: deleting it re-trusts every scope on first use. */
export function trustDir(): string {
  return process.env['TERM_TRUST_DIR']?.trim() || path.join(getStoreRoot(), 'trust')
}

export function localStore() {
  return layoutObjectStore({ dir: storeDir() })
}

/** The local store read as a registry for one host, which is what an offline install resolves against. */
export function storeTransport(host: string): OciTransport {
  return layoutTransport({ dir: storeDir(), prefix: host })
}

const transports = new Map<string, OciTransport>()

/** One transport per host for the life of the process, so tokens are reused across every package of a resolve. */
export function transportFor(input: { host: string; offline?: boolean }): OciTransport {
  if (input.offline) {
    return storeTransport(input.host)
  }

  const known = transports.get(input.host)

  if (known) {
    return known
  }

  const made = httpTransport({ host: input.host, credentials: () => credentialsFor({ host: input.host }) })
  transports.set(input.host, made)

  return made
}

export type OciRoute = {
  registry: OciRegistryReference
  repository: OciRepository
  // the scope the registry was chosen by, which the namespace's key set governs
  scope: string
  // `<namespace>/name`: where the scope's key set lives
  keysRepository: string
}

// The repository below every namespace that holds the scope's key set, so no package may be called this. It sits
// BELOW the namespace rather than at it because GHCR, like most registries, has no repository at the bare owner:
// `ghcr.io/alice` is not a repository, and `ghcr.io/alice/name` is.
//
// `name`, not `keys`, since 2026-10-04: the key set is what says who may publish under the scope's NAME, and that is
// what a person browsing `ghcr.io/cluesurf/term/` should read it as. The mesh index reads the same repository
// (`KEYS_REPOSITORY` in mesh/deck/back/code/resource/package/oci.ts), and the two must change together. The tag inside
// it is still `keys` (`KEYS_TAG`), and its media types are still `...term.keys.v1`: those are wire formats a key set
// is signed under, not a name anybody browses.
export const KEYS_REPOSITORY = 'name'

/**
 * The OCI route of a package under a fetch config, or undefined when it is not on an `oci://` registry. The scope
 * is matched the way `resolveRegistry` matches it, the full space path and then its leading space, and a scope no
 * project names comes from `ghcr.io/<scope>` (`resolveRegistry`).
 */
export function ociRouteOf(input: { name: string; config: Pick<FetchConfig, 'registry' | 'scopeRegistries'> }): OciRoute | undefined {
  const { scope } = parseScope({ name: input.name })
  const map = input.config.scopeRegistries ?? {}
  // the leading space of a nested scope, `@cluesurf` of `@cluesurf/@wordsurf`
  const leading = rootScope(scope)
  const key = scope && map[scope] ? scope : leading && map[leading] ? leading : undefined
  const registry = resolveRegistry({ name: input.name, registry: input.config.registry, scopeRegistries: map })

  if (!isOciRegistry(registry)) {
    return undefined
  }

  const reference = parseOciRegistry(registry)

  if (!reference.namespace) {
    throw new Error(`OCI registry ${registry} needs a namespace, so its packages and key set have repositories to live in`)
  }

  const repository = repositoryOf({ package: input.name, registry: reference, scope: key })
  const keysRepository = `${reference.namespace}/${KEYS_REPOSITORY}`

  if (repository.name === keysRepository) {
    throw new Error(`${input.name}: \`${KEYS_REPOSITORY}\` is reserved for the scope's key set, so no package can be named it`)
  }

  return { registry: reference, repository, scope: key ?? leading, keysRepository }
}
