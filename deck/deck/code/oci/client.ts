// Where a package's OCI registry is, how to talk to it, and where the local store lives.

import path from 'path'

import type { FetchConfig } from '../form'
import { parseScope, rootScope } from '../name'
import { getStoreRoot } from '../store'
import { credentialsFor } from './auth'
import { layoutObjectStore, layoutTransport } from './layout'
import { isOciRegistry, parseOciRegistry, repositoryOf, type OciRegistryReference, type OciRepository } from './reference'
import { httpTransport, type OciTransport } from './transport'

/** The OCI image layout every install fills and every offline install reads: `~/.base/@cluesurf/term/store`. */
export function storeDir(): string {
  return process.env['TERM_STORE']?.trim() || path.join(getStoreRoot(), 'store')
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
  // the scope the registry was chosen by, which the namespace repository's key set governs
  scope: string
  // the namespace repository: where the scope's key set lives
  keysRepository: string
}

/**
 * The OCI route of a package under a fetch config, or undefined when its scope is not on an `oci://` registry. The
 * scope is matched the way `resolveRegistry` matches it: the full space path, then the root space.
 */
export function ociRouteOf(input: { name: string; config: Pick<FetchConfig, 'registry' | 'scopeRegistries'> }): OciRoute | undefined {
  const { scope } = parseScope({ name: input.name })
  const map = input.config.scopeRegistries ?? {}
  const root = rootScope(scope)
  const key = scope && map[scope] ? scope : root && map[root] ? root : undefined
  const registry = key ? map[key] : input.config.registry

  if (!isOciRegistry(registry)) {
    return undefined
  }

  const reference = parseOciRegistry(registry!)

  if (!reference.namespace) {
    throw new Error(`OCI registry ${registry} needs a namespace, so its key set has a repository to live in`)
  }

  return {
    registry: reference,
    repository: repositoryOf({ package: input.name, registry: reference, scope: key }),
    scope: key ?? root,
    keysRepository: reference.namespace,
  }
}
