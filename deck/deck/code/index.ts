export {
  install,
  hostScopeRegistries,
  addDependency,
  removeDependency,
  verifyInstall,
} from './install'
export {
  loadManifest,
  parseManifest,
  writeManifest,
  writeCodeHold,
  validateManifest,
} from './manifest'
export {
  loadLockfile,
  parseLockfile,
  writeLockfile,
  saveLockfile,
} from './lock'
export { resolve, buildLockfile } from './resolve'
export {
  linkPackages,
  cleanLinks,
  devLink,
  devUnlink,
  registerGlobalLink,
  unregisterGlobalLink,
  listGlobalLinks,
  consumeGlobalLink,
} from './link'
export { hashFile, hashBuffer, hashText, verifyHash } from './hash'
export {
  parseCode,
  parseCodeHold,
  showCode,
  compareCode,
  codeMatch,
  pickBestCode,
  bumpCode,
} from './code'
export {
  fetchPackageMeta,
  fetchTarball,
  getVersionList,
  getVersionMeta,
  makeDefaultFetchConfig,
} from './fetch'
export {
  initStore,
  hasFile,
  storeFile,
  pruneStore,
  getStoreRoot,
  getTreeDir,
} from './store'
export {
  findWorkspaces,
  findProjectRoot,
  topologicalSort,
} from './workspace'
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
} from './name'
export { auditDependencies } from './audit'
export type { Advisory, AuditResult } from './audit'

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

// The object-graph publish path, built on @term/base. This is the real one; the
// tarball path below it is legacy and goes once this has published for real.
export {
  buildRelease,
  reachableFromCommit,
  RELEASE_BRANCH,
} from './object/release'
export type { Release } from './object/release'
export { buildVersion, readVersionFiles } from './object/version'
export type { BuiltVersion } from './object/version'
export {
  datasetOfFiles,
  filesOfDataset,
  fileRecord,
  fileOfRecord,
  markOfPath,
} from './object/dataset'
export type { PackageFile } from './object/dataset'
export { restoreFiles, restoreVersion, safeJoin } from './object/restore'
export { publishPackage } from './object/publish'
export { installPackage } from './object/install'
export { localObjectStore } from './object/store'
export type { ObjectStore } from './object/store'
export { directRegistry } from './object/registry'
export { memoryRefStore } from './object/refs'
export { httpRegistry } from './object/http'
export { serveRegistry } from './object/serve'
export { generateKeypair, signId, verifyId } from './object/sign'
export type { Keypair } from './object/sign'
export { objectKey, toneOfId, tonePath } from './object/tone'

// The OCI registry path: the default for `@term` (note/term/registry/18-oci-registry-default.md).
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
export type { OciRegistryReference, OciRepository } from './oci/reference'
export { credentialsFor, parseChallenge } from './oci/auth'
export type { OciCredentials } from './oci/auth'
export { httpTransport, OciError, sha256Digest } from './oci/transport'
export type { OciTransport, Descriptor, FetchedManifest } from './oci/transport'
export { layoutTransport, layoutObjectStore, initLayout } from './oci/layout'
export {
  ARTIFACT_TYPE,
  buildArtifact,
  parseDeckManifest,
  parseDeckConfig,
  verifyDeckConfig,
  deckStatement,
} from './oci/artifact'
export type { BuiltArtifact, DeckConfig, FilesLayer } from './oci/artifact'
export { trustedKeys, ensurePublisher, rotateKeys, KEYS_TAG } from './oci/keys'
export type { KeySet, TrustedKeys } from './oci/keys'
export { publishToOci, buildOciArtifact, attachSignature, tagOfTarget } from './oci/publish'
export type { OciPublishResult } from './oci/publish'
export { listOciVersions, readOciVersion, installOciVersion } from './oci/install'
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
export { parseRoleFile, matchRole, matchRoleRule, globMatch } from './role'
export type { RoleConfig, RoleRule } from './form'
