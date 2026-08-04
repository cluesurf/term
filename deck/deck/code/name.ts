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

// TWO hosts, and only two.
//
//   tool.base.surf  the API, for the registry and for ALL content
//   mesh.base.surf  the object store, one flat namespace
//
// This is not a package-registry host that happens to serve other things.
// It is the API, and the registry is one surface on it. The client builds
// `${BASE_API}/<scope>/<name>` for metadata and
// `${BASE_API}/<scope>/<name>/-/<file>.tgz` to publish, so both land on the
// API. Packages use their native name here, with no `.tree` suffix.
//
// The API never serves bytes. Metadata points at the object store, and the
// client fetches the tarball from there directly.
export const BASE_API = 'https://tool.base.surf'

// The object store: the ONE place every ClueSurf product's bytes live, not
// a package-registry bucket. `land.<domain>` is the object store the way
// `tool.<domain>` is the API and the bare domain is the frontend.
//
// Keys are FLAT: `<id>.<ext>`, where the id is the content hash. No
// directories, no package name in the path, no version in the path. Two
// packages that publish byte-identical content share one object, and an
// object's name proves its content.
//
// This supersedes the per-brand `mesh.<domain>` stores, including the old
// registry bucket at mesh.term.surf.
export const OBJECT_STORE = 'https://land.base.surf'

// Where a stored object lives. The extension is carried so a store fetch
// can be content-typed without a lookup.
export function objectUrl(input: {
  id: string
  extension: string
}): string {
  return `${OBJECT_STORE}/${input.id}.${input.extension}`
}

// the default scope -> host map. any scope not listed falls back to the
// config's `registry` field (npmjs.org unless overridden), which is what
// keeps a mixed dependency tree working.
export const DEFAULT_SCOPE_REGISTRIES: Record<string, string> = {
  '@term': BASE_API,
}

// pick the host for a given package name. a scoped package (`@scope/name`)
// uses `scopeRegistries[@scope]` when present, else the fallback `registry`.
// this is npm's `@scope:registry` routing, so `@term/*` hits the base API
// while other scopes hit the default.
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
