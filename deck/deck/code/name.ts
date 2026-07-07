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

// the term package registry base. `@term/*` scoped packages resolve
// here by default (a proxied DNS record onto the shared base.clue.surf
// backend). the client builds `${TERM_REGISTRY}/<scope>/<name>` for
// metadata and `${TERM_REGISTRY}/<scope>/<name>/-/<file>.tgz` for
// publish, landing on the root scoped-package routes (e.g.
// `https://base.term.surf/@term/base`). packages use their native
// name here, no `.tree` suffix. tarball URLs the metadata points at
// live on deck.term.surf (R2), fetched directly.
export const TERM_REGISTRY = 'https://base.term.surf'

// the default scope -> registry map. any scope not listed falls back to
// the config's `registry` field (npmjs.org unless overridden).
export const DEFAULT_SCOPE_REGISTRIES: Record<string, string> = {
  '@term': TERM_REGISTRY,
}

// pick the registry base URL for a given package name. a scoped package
// (`@scope/name`) uses `scopeRegistries[@scope]` when present, else the
// fallback `registry`. this is npm's `@scope:registry` routing, so
// `@term/*` hits the term registry while other scopes hit the default.
export function resolveRegistry(input: {
  name: string
  registry: string
  scopeRegistries?: Record<string, string>
}): string {
  const { scope } = parseScope({ name: input.name })

  if (scope && input.scopeRegistries?.[scope]) {
    return input.scopeRegistries[scope]
  }

  return input.registry
}

export function parseScope(input: { name: string }): {
  scope: string
  base: string
} {
  if (!input.name.startsWith('@')) {
    return { scope: '', base: input.name }
  }

  const slashIndex = input.name.indexOf('/')

  if (slashIndex === -1) {
    return { scope: input.name, base: '' }
  }

  return {
    scope: input.name.slice(0, slashIndex),
    base: input.name.slice(slashIndex + 1),
  }
}
