// Where a Term package lives on an OCI registry, and the grammar every name, tag and digest has to fit.
//
// A registry is written `oci://<host>[:port]/<namespace>`, the way a scope maps to one in `name.ts`:
//
//   oci://ghcr.io/cluesurf/term          @term/bind   -> ghcr.io  cluesurf/term/bind
//   oci://localhost:5000/term            @term/bind   -> localhost:5000  term/bind
//
// Every identifier is checked against the OCI distribution spec's own grammar before it is put into a URL. A
// repository or tag that does not fit is refused with a message, never rewritten in silence, because a name that is
// quietly changed is a name somebody else can claim.

// The distribution spec's repository path: lowercase components joined by `/`, each separated internally by `.`,
// `_`, `__` or runs of `-`.
const REPOSITORY = /^[a-z0-9]+((\.|_|__|-+)[a-z0-9]+)*(\/[a-z0-9]+((\.|_|__|-+)[a-z0-9]+)*)*$/

// The spec's tag: at most 128 characters, a word character first.
const TAG = /^[a-zA-Z0-9_][a-zA-Z0-9._-]{0,127}$/

// Only sha256 digests, which is what every object id in Term is.
const DIGEST = /^sha256:[a-f0-9]{64}$/

// A registry host: a DNS name or `localhost`, an optional port. No userinfo, no path, no query.
const HOST = /^(localhost|[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+|\[[0-9a-f:]+\]|\d{1,3}(\.\d{1,3}){3})(:\d{1,5})?$/i

// A package name segment is one repository component already, once the `@` of a scope is dropped.
const SEGMENT = /^[a-z0-9]+((\.|_|__|-+)[a-z0-9]+)*$/

export const OCI_SCHEME = 'oci://'

/** A registry and the namespace a scope's packages live under. */
export type OciRegistryReference = {
  // `ghcr.io`, `localhost:5000`
  host: string
  // `cluesurf/term`, or empty for a registry whose packages sit at its top level
  namespace: string
}

/** One package's repository on a registry. */
export type OciRepository = OciRegistryReference & {
  // the full repository path: `cluesurf/term/bind`
  name: string
}

export function isOciRegistry(value: string | undefined): boolean {
  return value?.startsWith(OCI_SCHEME) ?? false
}

/** Parse `oci://host[:port]/namespace`. Throws on anything that is not exactly that shape. */
export function parseOciRegistry(value: string): OciRegistryReference {
  if (!value.startsWith(OCI_SCHEME)) {
    throw new Error(`not an OCI registry reference: ${value} (expected ${OCI_SCHEME}<host>/<namespace>)`)
  }

  const rest = value.slice(OCI_SCHEME.length).replace(/\/+$/, '')
  const slash = rest.indexOf('/')
  const host = slash === -1 ? rest : rest.slice(0, slash)
  const namespace = slash === -1 ? '' : rest.slice(slash + 1)

  if (!HOST.test(host)) {
    throw new Error(`OCI registry host is not a host: ${host}`)
  }

  if (namespace && !REPOSITORY.test(namespace)) {
    throw new Error(`OCI namespace does not fit the repository grammar: ${namespace}`)
  }

  return { host: host.toLowerCase(), namespace }
}

/**
 * The repository a package lives in. `@term/bind` under `cluesurf/term` is `cluesurf/term/bind`. The scope the
 * registry was chosen by is the namespace, so it is not repeated: a nested scope routed by its leading
 * space (`@cluesurf/@wordsurf/x` under `@cluesurf`) keeps its inner spaces as path components below the
 * namespace. `scope` is the scope-map key that chose the registry, and defaults to the leading space.
 */
export function repositoryOf(input: {
  package: string
  registry: OciRegistryReference
  scope?: string
}): OciRepository {
  const parts = input.package.split('/')
  const scopeParts = input.scope ? input.scope.split('/') : parts[0]?.startsWith('@') ? [parts[0]] : []

  if (scopeParts.some((part, at) => parts[at] !== part)) {
    throw new Error(`package ${input.package} is not in the scope ${input.scope}`)
  }

  // Below the scope: any inner spaces, then exactly one bare name. Dropping an inner space's `@` is only one to one
  // because a bare segment can never sit before another one, so `@a/@b/x` and a hypothetical `@a/b/x` cannot both
  // exist to claim the repository `a/b/x`.
  const rest = parts.slice(scopeParts.length)

  if (rest.length === 0 || rest.slice(0, -1).some(part => !part.startsWith('@')) || rest.at(-1)!.startsWith('@')) {
    throw new Error(`package ${input.package} is not <scope>/[<@space>/...]<name>, so it has no OCI repository`)
  }

  const below = rest.map(part => part.replace(/^@/, ''))

  if (below.length === 0 || below.some(part => !SEGMENT.test(part))) {
    throw new Error(
      `package ${input.package} cannot be an OCI repository: every segment must be lowercase letters, digits and . _ -`,
    )
  }

  const name = [input.registry.namespace, ...below].filter(Boolean).join('/')

  if (!REPOSITORY.test(name)) {
    throw new Error(`repository ${name} does not fit the OCI repository grammar`)
  }

  return { ...input.registry, name }
}

/**
 * The tag a version is published under. A tag may not hold `+`, so build metadata is written with `_` instead,
 * which is Helm's rule for the same problem. Anything else that does not fit is refused.
 */
export function tagOfVersion(version: string): string {
  const tag = version.replace(/\+/g, '_')

  if (!TAG.test(tag)) {
    throw new Error(`version ${version} cannot be an OCI tag`)
  }

  return tag
}

/** The version a tag carries, the inverse of `tagOfVersion`, or undefined for a tag that is not a version. */
export function versionOfTag(tag: string): string | undefined {
  // a version tag starts with a digit: `branch.main`, `sha256-…` (a referrers fallback tag) and `latest` are not
  if (!/^\d/.test(tag)) {
    return undefined
  }

  return tag.replace(/_/g, '+')
}

export function assertTag(tag: string): void {
  if (!TAG.test(tag)) {
    throw new Error(`not an OCI tag: ${tag}`)
  }
}

export function assertDigest(digest: string): void {
  if (!DIGEST.test(digest)) {
    throw new Error(`not a sha256 digest: ${digest}`)
  }
}

export function isDigest(value: string): boolean {
  return DIGEST.test(value)
}

/** `oci://ghcr.io/cluesurf/term/bind@sha256:…`: how a lockfile names one exact version. */
export function pinnedReference(input: { repository: OciRepository; digest: string }): string {
  assertDigest(input.digest)

  return `${OCI_SCHEME}${input.repository.host}/${input.repository.name}@${input.digest}`
}

/** Parse what `pinnedReference` wrote. */
export function parsePinnedReference(value: string): { repository: OciRepository; digest: string } {
  if (!value.startsWith(OCI_SCHEME)) {
    throw new Error(`not a pinned OCI reference: ${value}`)
  }

  const at = value.lastIndexOf('@')

  if (at === -1) {
    throw new Error(`OCI reference is not pinned to a digest: ${value}`)
  }

  const digest = value.slice(at + 1)
  assertDigest(digest)

  const rest = value.slice(OCI_SCHEME.length, at)
  const slash = rest.indexOf('/')

  if (slash === -1) {
    throw new Error(`pinned OCI reference names no repository: ${value}`)
  }

  const host = rest.slice(0, slash)
  const name = rest.slice(slash + 1)

  if (!HOST.test(host) || !REPOSITORY.test(name)) {
    throw new Error(`pinned OCI reference is malformed: ${value}`)
  }

  return { repository: { host: host.toLowerCase(), namespace: '', name }, digest }
}
