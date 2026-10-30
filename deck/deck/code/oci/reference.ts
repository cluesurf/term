// A FACE (term-cli-in-term-0115, INTEGRATE @term/deck): deck/deck/code/oci/reference.ts's exports, with
// their shapes, answered by deck/deck/code/oci/oci-address.tree.
// The logic is Term; this file only converts shapes for TypeScript callers.
// The original is kept byte for byte at deck/term/deck/term/tmp/retired/make/deck-oci-reference.
import * as port from '@term/deck/code/oci/oci-address'

export type OciRegistryReference = { host: string; namespace: string }
export type OciRepository = OciRegistryReference & { name: string }

export const OCI_SCHEME = port.ociScheme()
export const isOciRegistry = (value: string | undefined): boolean =>
  port.isOciRegistry(value)
export const parseOciRegistry = (value: string): OciRegistryReference =>
  port.parseOciRegistry(value) as OciRegistryReference
export const repositoryOf = (input: {
  package: string
  registry: OciRegistryReference
  scope?: string
}): OciRepository =>
  port.repositoryOf(
    input.package,
    input.registry,
    input.scope,
  ) as OciRepository
export const tagOfVersion = (version: string): string =>
  port.tagOfVersion(version)
export const versionOfTag = (tag: string): string | undefined =>
  port.versionOfTag(tag) as string | undefined
export const assertTag = (tag: string): void => port.assertTag(tag)
export const assertDigest = (digest: string): void =>
  port.assertDigest(digest)
export const isDigest = (value: string): boolean => port.isDigest(value)
export const pinnedReference = (input: {
  repository: OciRepository
  digest: string
}): string => port.pinnedReference(input.repository, input.digest)
export const parsePinnedReference = (
  value: string,
): { repository: OciRepository; digest: string } =>
  port.parsePinnedReference(value) as {
    repository: OciRepository
    digest: string
  }
