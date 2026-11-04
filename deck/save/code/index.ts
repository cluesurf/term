// @cluesurf/save: the base protocol library.
//
// Version control for structured knowledge data: a content-addressed, mergeable
// record store with semantic diff and merge, a form and constraint schema, and
// pluggable projections. This is the TypeScript reference implementation of the
// design in note/library/base/.

// The semantic model
export type {
  Mark,
  Value,
  Item,
  RecordNode,
  CollectionKind,
  ScalarKind,
} from '@cluesurf/save/base/type'
export * from '@cluesurf/save/base/make'
export { mintMark, isMark, normalizeMark } from '@cluesurf/save/base/mark'
export { valueEqual, recordEqual } from '@cluesurf/save/base/equal'

// Canonical serialization and hashing
export {
  canonicalizeRecord,
  canonicalizeValue,
  canonicalBytes,
  canonicalValueBytes,
  bytesToBase16,
  base16ToBytes,
  parseDecimal,
  formatDecimal,
  normalizeDecimal,
} from '@cluesurf/save/canon/canonicalize'
export { decodeRecord, decodeRecordBytes, decodeValue, decodeValueBytes } from '@cluesurf/save/canon/decode'
export { hashRecord, hashValue, hashBytes, hashCanonicalBytes, HASH_FUNCTION } from '@cluesurf/save/canon/hash'
export { markToBytes, bytesToMark, bytesToToneMark, bytesToHexMark, toToneMark, toHexMark, TONE_ALPHABET } from '@cluesurf/save/canon/mark'
export { CANONICAL_FORM_VERSION, TAG_REF, TAG_BLOB, TAG_DECIMAL } from '@cluesurf/save/canon/cbor'

// Diff, patch, merge
export type { Change, Dataset } from '@cluesurf/save/diff/change'
export { emptyDataset, datasetOf } from '@cluesurf/save/diff/change'
export { diffDataset, diffRecord } from '@cluesurf/save/diff/diff'
export { diffValues } from '@cluesurf/save/diff/value-diff'
export type { ValueDiff, CollectionMember } from '@cluesurf/save/diff/value-diff'
export { diffSemantic, summarizeSemantic } from '@cluesurf/save/diff/semantic'
export type { SemanticChange } from '@cluesurf/save/diff/semantic'
export { applyChanges } from '@cluesurf/save/patch/patch'
export { mergeDataset } from '@cluesurf/save/merge/merge'
export type { Conflict, MergeResult, MergeOptions } from '@cluesurf/save/merge/merge'
export { MergeSession } from '@cluesurf/save/merge/session'
export type { Resolution } from '@cluesurf/save/merge/session'
export { applyFieldPolicy, policyResolver } from '@cluesurf/save/merge/policy'
export type { MergePolicy, FieldPolicyResolver } from '@cluesurf/save/merge/policy'
export type { Hlc } from '@cluesurf/save/merge/clock'
export { compareHlc, localTick, receiveTick, tieBreak } from '@cluesurf/save/merge/clock'

// Forms, constraints, validation
export type {
  Form,
  Property,
  Constraint,
  Like,
  Severity,
  RoleBase,
} from '@cluesurf/save/form/form'
export { form, property, hold, want, roleBase, union, armOf, UNION_KEY } from '@cluesurf/save/form/form'
export type { Diagnostic } from '@cluesurf/save/form/validate'
export { validateRecord, validateDataset, errors } from '@cluesurf/save/form/validate'
export { validateReferences } from '@cluesurf/save/form/references'
export type { ReferenceOptions } from '@cluesurf/save/form/references'
export { autoMark } from '@cluesurf/save/form/automark'

// The store (prolly tree, chunks, refs)
export type { ChunkStore, PrunableChunkStore } from '@cluesurf/save/store/chunk-store'
export { MemoryChunkStore, isPrunable } from '@cluesurf/save/store/chunk-store'
export type { RefStore } from '@cluesurf/save/store/ref-store'
export { MemoryRefStore } from '@cluesurf/save/store/ref-store'
export { writeDataset, readDataset, readRecord, diffRoots } from '@cluesurf/save/store/tree'
export { catchUp } from '@cluesurf/save/store/mirror'
export type { CatchUp } from '@cluesurf/save/store/mirror'

// Async storage backends (R2 object storage for chunks, CockroachDB for refs)
export type { ObjectStore, ObjectHead } from '@cluesurf/save/store/object-store'
export { MemoryObjectStore } from '@cluesurf/save/store/object-store'
export type { AsyncChunkStore } from '@cluesurf/save/store/r2-chunk-store'
export { R2ChunkStore, chunkKey } from '@cluesurf/save/store/r2-chunk-store'
export type {
  SqlClient,
  AsyncRefStore,
  RefColumns,
  SqlRefOptions,
} from '@cluesurf/save/store/sql-ref-store'
export {
  SqlRefStore,
  CockroachRefStore,
  PostgresRefStore,
  MemorySqlClient,
  DEFAULT_REF_COLUMNS,
  DEFAULT_REF_TABLE,
  REF_TABLE_DDL,
} from '@cluesurf/save/store/sql-ref-store'

// Commits and the repository
export type { Commit, Validation } from '@cluesurf/save/commit/commit'
export {
  writeCommit,
  readCommit,
  commitPayload,
  signCommitObject,
  verifyCommitObject,
} from '@cluesurf/save/commit/commit'
export {
  encodeChanges,
  decodeChanges,
  writeChanges,
  readChanges,
} from '@cluesurf/save/commit/changeset'
export { Repository } from '@cluesurf/save/repo/repo'
export { MemoryRefLog } from '@cluesurf/save/reflog/reflog'
export type { RefLog, RefLogEntry } from '@cluesurf/save/reflog/reflog'
export type {
  CommitMeta,
  CommitResult,
  MergeResultOut,
  RepoOptions,
} from '@cluesurf/save/repo/repo'

// Projections and the change feed
export type { Projection } from '@cluesurf/save/project/projection'
export { MemoryProjection } from '@cluesurf/save/project/projection'
export {
  ChangeFeed,
  commitChanges,
  projectFromEmpty,
  advance,
  sync,
} from '@cluesurf/save/project/feed'

// The .tree syntax
export { formatTree } from '@cluesurf/save/tree/format'
export { parseTree } from '@cluesurf/save/tree/parse'

// Text diff and three-way merge (finer than line-level git diff)
export {
  diffText,
  diffTokens,
  tokenize,
  detokenize,
  changeHunks,
} from '@cluesurf/save/text/diff'
export type { Granularity, Hunk, Edit, ChangeHunk } from '@cluesurf/save/text/diff'
export { merge3Text, merge3Tokens } from '@cluesurf/save/text/merge'
export type { TextMerge, MergeRegion } from '@cluesurf/save/text/merge'

// File-level diff policy: opt generated/derived files out of text diffing
export type { FileConfig, FileRule } from '@cluesurf/save/form/form'
export { globMatcher, matchesGlob } from '@cluesurf/save/file/glob'
export { FilePolicy, filePolicy, diffFile, mergeFile } from '@cluesurf/save/file/policy'

// Sync: async replica (chunk transfer) and realtime (op delta)
export { collectChunkHashes } from '@cluesurf/save/store/tree'
export {
  missingChunks,
  packMissing,
  applyChunks,
  pull,
} from '@cluesurf/save/sync/chunk-sync'
export type { ChunkMessage } from '@cluesurf/save/sync/chunk-sync'
export { OpLog, applyOps } from '@cluesurf/save/sync/op-sync'
export type { Op } from '@cluesurf/save/sync/op-sync'
export { shallowChunks, packShallow, sparseRecords, ofTypes } from '@cluesurf/save/sync/partial'

// Offline transfer (bundle) and packing
export {
  createBundle,
  encodeBundle,
  decodeBundle,
  applyBundle,
  verifyBundle,
} from '@cluesurf/save/transport/bundle'
export type {
  Bundle,
  ApplyBundleReport,
  BundleVerdict,
} from '@cluesurf/save/transport/bundle'
export { packChunks, unpack, readFromPack } from '@cluesurf/save/store/pack'
export type { Pack } from '@cluesurf/save/store/pack'

// Remote editing: browser-server and cloud-local push/pull over an injected transport
export { MemoryRemoteRepo } from '@cluesurf/save/transport/session'
export type { RemoteRepo, PushResult, PullResult } from '@cluesurf/save/transport/session'

// Access control and signed authorship
export { AccessPolicy, authorizeCommit } from '@cluesurf/save/access/policy'
export type { Action, Resource } from '@cluesurf/save/access/policy'
export { generateKeypair, signCommit, verifyCommit } from '@cluesurf/save/access/sign'
export type { Keypair } from '@cluesurf/save/access/sign'

// Deletion: redaction and crypto-shredding
export { makeTombstone, isRedacted, redactInDataset } from '@cluesurf/save/redact/redact'
export {
  KeyStore,
  shredEncrypt,
  shredDecrypt,
} from '@cluesurf/save/redact/shred'
export type { Shredded } from '@cluesurf/save/redact/shred'
export {
  RedactionVault,
  redactReversibly,
  unredact,
} from '@cluesurf/save/redact/reversible'

// Garbage collection and hard erasure from history
export { reachableChunks, sweep, sweepObjectStore } from '@cluesurf/save/gc/gc'
export type { GcReport } from '@cluesurf/save/gc/gc'
export { reachableChunksAsync, collectGarbageAsync } from '@cluesurf/save/gc/gc-async'
export { removeMatching, redactMatching, ConcurrentErasureError } from '@cluesurf/save/erase/erase'
export type { Eraser, EraseReport } from '@cluesurf/save/erase/erase'
export { RevocationList, enforceRevocation } from '@cluesurf/save/erase/revocation'
export type { RevocationReport } from '@cluesurf/save/erase/revocation'

// Off-history two-tier storage for regulated, deletable content
export {
  MemoryOffHistoryStore,
  offHistoryRef,
  isOffHistoryRef,
  offHistoryId,
  putOffHistory,
  resolveOffHistory,
} from '@cluesurf/save/offhistory/store'
export type { OffHistoryStore } from '@cluesurf/save/offhistory/store'
export {
  sealedProperties,
  partitionSensitive,
  resolveSensitive,
} from '@cluesurf/save/offhistory/sensitive'

// Schema migration (upcasting, migrations as commits)
export { upcastRecord, upcastDataset, upcastAll } from '@cluesurf/save/migrate/migrate'
export type { MigrationOp, Migration } from '@cluesurf/save/migrate/migrate'

// Identity lifecycle: merge-as-redirect, split, referential actions
export {
  referrers,
  isRedirect,
  redirectTarget,
  resolveMark,
  mergeRecords,
  splitRecord,
  removeWithAction,
} from '@cluesurf/save/identity/lifecycle'
export type { RefAction, RemoveResult } from '@cluesurf/save/identity/lifecycle'

// Move-aware hierarchy: first-class moves, move-aware diff, cycle-safe tree CRDT
export {
  parentOf,
  moveRecord,
  childrenOf,
  diffMoves,
  applyMoves,
  mergeTree,
  recoverOrphans,
} from '@cluesurf/save/identity/tree'
export type { MoveChange, TreeMove } from '@cluesurf/save/identity/tree'
export { orderKeyBetween, orderKeyAfter, orderKeyBefore } from '@cluesurf/save/base/order'

// Ephemeral presence and soft leases (separate from durable state)
export { PresenceChannel, LeaseRegistry } from '@cluesurf/save/live/presence'
export type { PresenceState, Lease } from '@cluesurf/save/live/presence'

// Query language and declared indexes
export { Query, query, QueryableProjection } from '@cluesurf/save/query/query'
export type { Predicate, Comparator, Order } from '@cluesurf/save/query/query'
export { OrderedIndex } from '@cluesurf/save/query/ordered-index'
export { compareValues } from '@cluesurf/save/query/compare'

// Maintained reverse-reference index for identity operations at scale
export { ReferenceIndex } from '@cluesurf/save/lookup/reference-index'

// History operations: field-level blame, record history, bisect, mark index
export { blame, recordHistory, bisect, buildMarkIndex, markHistory } from '@cluesurf/save/history/history'
export type { FieldBlame, HistoryEntry } from '@cluesurf/save/history/history'
export { MarkIndex, marksTouched } from '@cluesurf/save/lookup/mark-index'

// Lifting ordinary data into records: the on-ramp
export {
  BadRow,
  parseDelimited,
  parseJsonRows,
  recordsFrom,
} from '@cluesurf/save/bridge/from-data'
export type { Lifted, MarkSource, Row } from '@cluesurf/save/bridge/from-data'

// JSON as base values, both ways, losing nothing
export { liftJson, lowerJson, readsAsMark, OBJECT, ID } from '@cluesurf/save/bridge/json'
export type { Json, LiftTake } from '@cluesurf/save/bridge/json'

// Working out a projection's schema from the records themselves
export {
  DEFAULT_MARK_COLUMN,
  MixedField,
  inferProjection,
} from '@cluesurf/save/project/infer'
export type { Inferred } from '@cluesurf/save/project/infer'

// Transparency checkpoints over the log
export {
  checkpointOf,
  checkpointSigned,
  consistent,
  inclusionProof,
  rootOf,
  verifyInclusion,
} from '@cluesurf/save/access/checkpoint'
export type { Checkpoint } from '@cluesurf/save/access/checkpoint'

// Which key belonged to which publisher, and when
export {
  canonicalDirectory,
  covers,
  endKey,
  keysAt,
  verifyAuthorship,
} from '@cluesurf/save/access/directory'
export type {
  Directory,
  KeyEntry,
  Refusal,
  Verdict,
} from '@cluesurf/save/access/directory'

// Integrity verification (fsck)
export { fsck } from '@cluesurf/save/verify/fsck'
export type { FsckReport } from '@cluesurf/save/verify/fsck'
