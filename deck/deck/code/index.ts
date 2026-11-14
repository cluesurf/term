export {
  install,
  hostScopeRegistries,
  addDependency,
  removeDependency,
  verifyInstall,
} from './package/install'
export {
  loadManifest,
  parseManifest,
  writeManifest,
  writeCodeHold,
  validateManifest,
  manifestSpellings,
  rewriteManifestSpellings,
  isDefaultCodeRoot,
} from './package/manifest'
export type { ManifestSpelling } from './package/manifest'
export {
  loadLockfile,
  parseLockfile,
  writeLockfile,
  saveLockfile,
} from './package/lock'
export { resolve, buildLockfile } from './package/resolve'
export {
  linkPackages,
  cleanLinks,
  devLink,
  devUnlink,
  registerGlobalLink,
  unregisterGlobalLink,
  listGlobalLinks,
  consumeGlobalLink,
} from './package/link'
export {
  hashFile,
  hashBuffer,
  hashText,
  verifyHash,
} from './package/hash'
export {
  parseCode,
  parseCodeHold,
  showCode,
  compareCode,
  codeMatch,
  pickBestCode,
  bumpCode,
  bumpPrerelease,
} from './code'
export {
  fetchPackageMeta,
  fetchTarball,
  getVersionList,
  getVersionMeta,
  makeDefaultFetchConfig,
} from './package/fetch'
export {
  initStore,
  hasFile,
  storeFile,
  pruneStore,
  getStoreRoot,
  getBaseDir,
  getTreeDir,
} from './package/store'
export {
  findWorkspaces,
  findProjectRoot,
  topologicalSort,
} from './package/workspace'
export {
  toRegistryName,
  toTreeName,
  parseScope,
  rootScope,
  resolveRegistry,
  normalizeRegistry,
  scopeName,
  DEFAULT_OCI_HOST,
  TERM_REGISTRY,
  DEFAULT_SCOPE_REGISTRIES,
} from './package/name'
export { auditDependencies } from './package/audit'
export type { Advisory, AuditResult } from './package/audit'

export type {
  Code,
  CodeHold,
  MarkBand,
  MarkWild,
  MarkTest,
  DeckManifest,
  DeckLink,
  DeckMind,
  DeckBase,
  DeckHostGroup,
  ResolvedDeck,
  ResolutionMap,
  LockEntry,
  Lockfile,
  StoreConfig,
  FetchConfig,
  RegistryPackageMeta,
  InstallConfig,
} from './form'

// The signing keys of the OCI path (decision 129 section 4: of the object store only
// id-signing stays).
export { generateKeypair, signId, verifyId } from './object/sign'
export type { Keypair } from './object/sign'

// The OCI registry path: the default for `@term` (note/project/term/registry/18-oci-registry-default.md).
export {
  OCI_SCHEME,
  isOciRegistry,
  parseOciRegistry,
  repositoryOf,
  tagOfVersion,
  versionOfTag,
  pinnedReference,
  parsePinnedReference,
} from './oci/reference'
export type {
  OciRegistryReference,
  OciRepository,
} from './oci/reference'
export { credentialsFor, parseChallenge } from './oci/auth'
export type { OciCredentials } from './oci/auth'
export { httpTransport, OciError, sha256Digest } from './oci/transport'
export type {
  OciTransport,
  Descriptor,
  FetchedManifest,
} from './oci/transport'
export {
  layoutTransport,
  layoutObjectStore,
  initLayout,
} from './oci/layout'
export {
  ARTIFACT_TYPE,
  buildArtifact,
  parseDeckManifest,
  parseDeckConfig,
  verifyDeckConfig,
  deckStatement,
} from './oci/artifact'
export type {
  BuiltArtifact,
  DeckConfig,
  FilesLayer,
} from './oci/artifact'
export {
  trustedKeys,
  ensurePublisher,
  rotateKeys,
  KEYS_TAG,
} from './oci/keys'
export type { KeySet, TrustedKeys } from './oci/keys'
export {
  publishToOci,
  buildOciArtifact,
  attachSignature,
  tagOfTarget,
} from './oci/publish'
export type { OciPublishResult } from './oci/publish'
export {
  listOciVersions,
  readOciVersion,
  installOciVersion,
} from './oci/install'
export type { OciVersion } from './oci/install'
export {
  ociRouteOf,
  transportFor,
  storeDir,
  storeTransport,
  localStore,
  trustDir,
} from './oci/client'
export type { OciRoute } from './oci/client'
export {
  RELEASE_ARTIFACT_TYPE,
  RELEASE_LAYER_MEDIA_TYPE,
  RELEASE_PLATFORMS,
  currentPlatform,
  publishRelease,
  readRelease,
  readReleaseIndex,
  releaseRoute,
  releaseStatement,
  verifyReleaseConfig,
} from './oci/release'
export type { ReleaseConfig, ReleaseEntry } from './oci/release'
export {
  TOOLCHAIN,
  newestMatching,
  pinNeed,
  pinSatisfies,
  releasedVersions,
  showPin,
} from './oci/need'
export type { DeckNeed, LockNeed } from './form'
export { readTree, valueOf } from './package/read'
export type { Form } from './package/read'
export { pingIndex, publishStatement } from './oci/index-ping'
export type { IndexPing } from './oci/index-ping'
export {
  parseRoleFile,
  matchRole,
  matchRoleRule,
  globMatch,
} from './package/role'
export type { RoleConfig, RoleRule } from './form'
