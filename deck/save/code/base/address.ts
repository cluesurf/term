// The address grammar of the host: a chain of spaces, then a repository.
//
//   /@cluesurf                                                  a space
//   /@cluesurf/@wordsurf/@alice                                 a nested space
//   /@cluesurf/@wordsurf/@alice/repositories/x                  a repository with no resource key
//   /@cluesurf/@wordsurf/resources/language/repositories/tune   a repository keyed by a form
//   .../repositories/x@1.2.0                                    a published version
//   .../repositories/x/records/<mark>                           a record inside it
//
// A space segment is `@`-prefixed, so it is self-delimiting: no space slug can collide
// with `repositories`, `resources`, or a host word added later, and the boundary between
// the space chain and the rest is unambiguous without a reserved list. A repository slug
// and a form slug are never `@`-prefixed.
//
// Slugs are DNS labels (at most 63 characters), so a space can be a subdomain one day
// without renaming. The chain is capped at DEPTH_MAX, which with 63-character slugs keeps
// a full path under 600 characters and a whole URL with a version and a record mark under
// 1,000, well inside the 2,000 some proxies still enforce.
//
// The same grammar without the leading slash and the host words is a PACKAGE NAME, the
// coordinate a deck's `link` line uses: `@cluesurf/@wordsurf/@alice/x`. A resource-keyed
// repository publishes as `@cluesurf/@wordsurf/language~tune`, the key and the slug joined
// by `~`, which no slug can contain, so the name stays one segment per space plus one.
//
// See note/project/mesh/model/workspace/shared-repositories-and-libraries.md.

export type Address = {
  // the space chain, root first, without the `@`
  spaces: Array<string>
  // the form slug a repository is keyed by; absent for a keyless repository
  resource?: string
  // absent when the address names a space
  repository?: string
  // a published version, `1.2.0`, when the repository segment carried `@version`
  version?: string
  // a record mark, when the address reaches into the repository
  mark?: string
  // whatever followed the repository (or the record) that this grammar does not read:
  // `branches/main/head`. Kept so a router can dispatch on it.
  rest: Array<string>
}

export type AddressFault = {
  fault: 'bad-address'
  path: string
  why: string
}

export type AddressAnswer =
  | { ok: true; value: Address }
  | ({ ok: false } & AddressFault)

// A DNS label, and a little stricter: lowercase, digits, SINGLE inner hyphens, at most
// 63. A doubled hyphen is a legal label but reads as a typo and is what punycode uses
// (`xn--`), so it is kept out of every slug.
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/

export const SLUG_MAX = 63

// Host, product, customer is the shape everything runs on; deeper is by permission; this
// is the ceiling nothing may pass.
export const DEPTH_MAX = 8

// The host's own words. A space segment can never equal one, because a space segment is
// `@`-prefixed; a repository slug can, because it sits after `repositories/`.
export const HOST_WORD = {
  repositories: 'repositories',
  resources: 'resources',
  records: 'records',
} as const

// A published version: three dot-separated numbers with an optional pre-release tail.
const VERSION = /^\d+\.\d+\.\d+(-[0-9a-z.-]+)?$/

// The joiner of a resource key and a slug in a package name. Not a slug character.
const KEY_JOIN = '~'

export function isSlug(slug: string): boolean {
  return SLUG.test(slug)
}

/** Why a slug is not one, or undefined when it is. */
export function slugFault(slug: string): string | undefined {
  if (slug.length === 0) {
    return 'empty'
  }
  if (slug.length > SLUG_MAX) {
    return `longer than ${SLUG_MAX}`
  }
  if (!SLUG.test(slug)) {
    return 'lowercase letters, digits and single inner hyphens only'
  }
  return undefined
}

const bad = (path: string, why: string): AddressAnswer => ({
  ok: false,
  fault: 'bad-address',
  path,
  why,
})

/**
 * Parse a host path.
 *
 * Reads the space chain, the optional resource key, the repository with its optional
 * version, and an optional record mark. Everything after that is returned in `rest`
 * untouched, so a router can mount branch and draft routes beneath a repository without
 * this module knowing them.
 */
export function parseAddress(path: string): AddressAnswer {
  const parts = path.split('/').filter(Boolean).map(decode)
  const spaces: Array<string> = []
  let at = 0

  while (at < parts.length && parts[at]!.startsWith('@')) {
    const slug = parts[at]!.slice(1)
    const why = slugFault(slug)

    if (why) {
      return bad(path, `space "${slug}": ${why}`)
    }

    spaces.push(slug)
    at += 1
  }

  if (spaces.length === 0) {
    return bad(path, 'a host path starts with a space, @slug')
  }

  if (spaces.length > DEPTH_MAX) {
    return bad(path, `deeper than ${DEPTH_MAX} spaces`)
  }

  const address: Address = { spaces, rest: [] }

  if (at === parts.length) {
    return { ok: true, value: address }
  }

  if (parts[at] === HOST_WORD.resources) {
    const resource = parts[at + 1]

    if (resource === undefined) {
      return bad(path, 'resources needs a form slug after it')
    }

    const why = slugFault(resource)

    if (why) {
      return bad(path, `resource "${resource}": ${why}`)
    }

    address.resource = resource
    at += 2

    if (parts[at] !== HOST_WORD.repositories) {
      return bad(path, 'a resource key is followed by repositories/<slug>')
    }
  }

  // Anything else after the chain belongs to whoever mounted the space: `members`,
  // `spaces/create!`, `rename!`. It is returned untouched for that router to read.
  if (parts[at] !== HOST_WORD.repositories) {
    address.rest = parts.slice(at)

    return { ok: true, value: address }
  }

  const segment = parts[at + 1]

  // `.../repositories` lists, and `.../repositories/create!` creates: both belong to the
  // control router, with the resource key already read
  if (segment === undefined || segment.endsWith('!')) {
    address.rest = parts.slice(at)

    return { ok: true, value: address }
  }

  const versionAt = segment.indexOf('@')
  const slug = versionAt === -1 ? segment : segment.slice(0, versionAt)
  const slugWhy = slugFault(slug)

  if (slugWhy) {
    return bad(path, `repository "${slug}": ${slugWhy}`)
  }

  address.repository = slug

  if (versionAt !== -1) {
    const version = segment.slice(versionAt + 1)

    if (!VERSION.test(version)) {
      return bad(path, `version "${version}" is not major.minor.patch`)
    }

    address.version = version
  }

  at += 2

  if (parts[at] === HOST_WORD.records) {
    const mark = parts[at + 1]

    if (mark === undefined) {
      return bad(path, 'records needs a mark after it')
    }

    address.mark = mark
    at += 2
  }

  address.rest = parts.slice(at)

  return { ok: true, value: address }
}

/** Print an address as a host path. The inverse of `parseAddress`. */
export function printAddress(address: Address): string {
  const parts = address.spaces.map(space => `@${space}`)

  if (address.resource !== undefined) {
    parts.push(HOST_WORD.resources, address.resource)
  }

  if (address.repository !== undefined) {
    parts.push(
      HOST_WORD.repositories,
      address.version === undefined
        ? address.repository
        : `${address.repository}@${address.version}`,
    )

    if (address.mark !== undefined) {
      parts.push(HOST_WORD.records, address.mark)
    }
  }

  parts.push(...address.rest)

  return `/${parts.join('/')}`
}

/** The space chain alone, as a path: `/@cluesurf/@wordsurf`. */
export function printSpacePath(spaces: Array<string>): string {
  return `/${spaces.map(space => `@${space}`).join('/')}`
}

/**
 * Parse a package name, the coordinate a deck's `link` line carries.
 *
 *   @cluesurf/x                        a root space's keyless repository
 *   @cluesurf/@wordsurf/@alice/x       a nested space's
 *   @cluesurf/@wordsurf/language~tune  a resource-keyed repository
 *   ...@1.2.0                          a version, on the last segment
 *
 * The two-layer `@scope/name` of the earlier design is the depth-one case of this, so an
 * existing name parses unchanged.
 */
export function parseName(name: string): AddressAnswer {
  const parts = name.split('/').filter(Boolean)
  const spaces: Array<string> = []
  let at = 0

  while (at < parts.length - 1 && parts[at]!.startsWith('@')) {
    const slug = parts[at]!.slice(1)
    const why = slugFault(slug)

    if (why) {
      return bad(name, `space "${slug}": ${why}`)
    }

    spaces.push(slug)
    at += 1
  }

  if (spaces.length === 0) {
    return bad(name, 'a package name starts with a space, @slug')
  }

  if (spaces.length > DEPTH_MAX) {
    return bad(name, `deeper than ${DEPTH_MAX} spaces`)
  }

  const last = parts[at]

  if (last === undefined || at !== parts.length - 1) {
    return bad(name, 'a package name ends with a repository slug')
  }

  if (last.startsWith('@')) {
    return bad(name, 'a package name ends with a repository slug, not a space')
  }

  const versionAt = last.indexOf('@')
  const keyed = versionAt === -1 ? last : last.slice(0, versionAt)
  const joinAt = keyed.indexOf(KEY_JOIN)
  const resource = joinAt === -1 ? undefined : keyed.slice(0, joinAt)
  const slug = joinAt === -1 ? keyed : keyed.slice(joinAt + 1)

  if (resource !== undefined) {
    const why = slugFault(resource)

    if (why) {
      return bad(name, `resource "${resource}": ${why}`)
    }
  }

  const slugWhy = slugFault(slug)

  if (slugWhy) {
    return bad(name, `repository "${slug}": ${slugWhy}`)
  }

  const address: Address = { spaces, repository: slug, rest: [] }

  if (resource !== undefined) {
    address.resource = resource
  }

  if (versionAt !== -1) {
    const version = last.slice(versionAt + 1)

    if (!VERSION.test(version)) {
      return bad(name, `version "${version}" is not major.minor.patch`)
    }

    address.version = version
  }

  return { ok: true, value: address }
}

/** Print a package name. The inverse of `parseName`. */
export function printName(address: Address): string {
  const parts = address.spaces.map(space => `@${space}`)
  const keyed =
    address.resource === undefined
      ? address.repository ?? ''
      : `${address.resource}${KEY_JOIN}${address.repository ?? ''}`

  parts.push(
    address.version === undefined ? keyed : `${keyed}@${address.version}`,
  )

  return parts.join('/')
}

/**
 * Resolve `@x` the way a site does: from a mount, a child named `x` first, then an
 * ancestor named `x`. The ancestor rule (no space's slug equals an ancestor's) is what
 * makes the two cases exclusive, so this needs no escape syntax.
 *
 * `mount` is the mount's chain, root first. `children` are the mount's child slugs.
 * Returns the resolved chain, or undefined when `x` is neither.
 */
export function resolveHandle(input: {
  mount: Array<string>
  children: Array<string>
  handle: string
}): Array<string> | undefined {
  if (input.children.includes(input.handle)) {
    return [...input.mount, input.handle]
  }

  const at = input.mount.lastIndexOf(input.handle)

  return at === -1 ? undefined : input.mount.slice(0, at + 1)
}

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}
