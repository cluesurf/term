// .tree code references packages without the `.tree` suffix,
// but in the registry they are published with the `.tree` suffix.
// e.g. `@term/deck` in .tree code -> `@term/deck.tree` in the registry

export function toRegistryName(input: { name: string }): string {
  if (input.name.endsWith('.tree')) {return input.name}

  return `${input.name}.tree`
}

export function toTreeName(input: { name: string }): string {
  if (input.name.endsWith('.tree')) {
    return input.name.slice(0, -5)
  }

  return input.name
}

export function isScoped(input: { name: string }): boolean {
  return input.name.startsWith('@')
}

// The custom registry at `tool.base.surf`, with its object store at
// `land.base.surf`, was never deployed and is retired: `@term` publishes to and
// installs from an OCI registry (note/term/registry/18-oci-registry-default.md).
// `object/http.ts` and `object/serve.ts` survive as the in-process registry the
// object tests run against.

// Where the `@term` packages are published: an OCI registry, with each package a
// repository under the namespace (`@term/bind` is `ghcr.io/cluesurf/term/bind`) and
// the scope's key set at the namespace itself (`ghcr.io/cluesurf/term:keys`). See
// note/term/registry/18-oci-registry-default.md.
export const TERM_REGISTRY = 'oci://ghcr.io/cluesurf/term'

// the default scope -> registry map. any scope not listed falls back to the
// config's `registry` field (npmjs.org unless overridden), which is what
// keeps a mixed dependency tree working. a value is an npm-style https
// registry or an `oci://<host>/<namespace>` one.
export const DEFAULT_SCOPE_REGISTRIES: Record<string, string> = {
  '@term': TERM_REGISTRY,
}

// The OCI host a scope no project names comes from. `@alice/x` is `ghcr.io/alice/x`, which only the GitHub
// account `alice` can push to: the registry's own ownership is the claim on the name, and nothing has to store a
// mapping from scopes to registries.
export const DEFAULT_OCI_HOST = 'ghcr.io'

/**
 * A registry as a `base` line or a scope map writes it. A bare `host/path` is an OCI registry, so
 * `<ghcr.io/alice-gh/term>` is `oci://ghcr.io/alice-gh/term`. `oci://` and `https://` pass through unchanged.
 */
export function normalizeRegistry(value: string): string {
  const trimmed = value.trim()

  if (/^(oci|https?):\/\//.test(trimmed)) {
    return trimmed
  }

  return `oci://${trimmed.replace(/^\/+/, '')}`
}

// pick the registry for a given package name. a scoped package (`@scope/name`)
// uses `scopeRegistries[@scope]` when present, then its root space's entry,
// then `oci://ghcr.io/<root space>`. an unscoped package uses the fallback
// `registry` (npmjs.org), which is what keeps a plain npm dependency working.
export function resolveRegistry(input: {
  name: string
  registry: string
  scopeRegistries?: Record<string, string>
}): string {
  const { scope } = parseScope({ name: input.name })

  if (scope && input.scopeRegistries?.[scope]) {
    return normalizeRegistry(input.scopeRegistries[scope])
  }

  // a nested scope routes by its root space when the full path is not listed
  const root = rootScope(scope)

  if (root && root !== scope && input.scopeRegistries?.[root]) {
    return normalizeRegistry(input.scopeRegistries[root])
  }

  if (root) {
    return `oci://${DEFAULT_OCI_HOST}/${root.slice(1)}`
  }

  return input.registry
}

// The scope is the SPACE PATH, which nests: `@cluesurf/@wordsurf/@alice/x` is the
// repository `x` in the space `@cluesurf/@wordsurf/@alice`. Every leading `@` segment
// belongs to the scope and the first bare segment starts the base, so the two-layer
// `@scope/name` is the depth-one case and parses as it always did. The scope is what
// routes to a registry (`resolveRegistry`), and it routes by its FIRST segment, the root
// space, so `@cluesurf/@wordsurf/...` goes where `@cluesurf` goes.
export function parseScope(input: { name: string }): {
  scope: string
  base: string
} {
  if (!input.name.startsWith('@')) {
    return { scope: '', base: input.name }
  }

  const parts = input.name.split('/')
  let at = 0

  while (at < parts.length && parts[at]!.startsWith('@')) {
    at += 1
  }

  return {
    scope: parts.slice(0, at).join('/'),
    base: parts.slice(at).join('/'),
  }
}

/** A scope as a `base` line names it, `alice` or `@alice`, always written back with its `@`. */
export function scopeName(word: string): string {
  const bare = word.trim().replace(/^@/, '')

  return bare ? `@${bare}` : ''
}

/** The root space of a scope, the segment a registry is chosen by: `@cluesurf` of `@cluesurf/@wordsurf`. */
export function rootScope(scope: string): string {
  const slash = scope.indexOf('/')

  return slash === -1 ? scope : scope.slice(0, slash)
}
