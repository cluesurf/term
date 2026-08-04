// @cluesurf/base.tree: the base protocol library.
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
} from '@/base/type'
export * from '@/base/make'
export { mintMark, isMark, normalizeMark } from '@/base/mark'
export { valueEqual, recordEqual } from '@/base/equal'

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
} from '@/canon/canonicalize'
export { decodeRecord, decodeRecordBytes, decodeValue, decodeValueBytes } from '@/canon/decode'
export { hashRecord, hashValue, hashBytes, hashCanonicalBytes, HASH_FUNCTION } from '@/canon/hash'
export { markToBytes, bytesToMark, bytesToToneMark, bytesToHexMark, toToneMark, toHexMark, TONE_ALPHABET } from '@/canon/mark'
export { CANONICAL_FORM_VERSION, TAG_REF, TAG_BLOB, TAG_DECIMAL } from '@/canon/cbor'

// Diff, patch, merge
export type { Change, Dataset } from '@/diff/change'
export { emptyDataset, datasetOf } from '@/diff/change'
export { diffDataset, diffRecord } from '@/diff/diff'
export { diffValues } from '@/diff/value-diff'
export type { ValueDiff } from '@/diff/value-diff'
export { diffSemantic, summarizeSemantic } from '@/diff/semantic'
export type { SemanticChange } from '@/diff/semantic'
export { applyChanges } from '@/patch/patch'
export { mergeDataset } from '@/merge/merge'
export type { Conflict, MergeResult, MergeOptions } from '@/merge/merge'
export { MergeSession } from '@/merge/session'
export type { Resolution } from '@/merge/session'
export { applyFieldPolicy, policyResolver } from '@/merge/policy'
export type { MergePolicy, FieldPolicyResolver } from '@/merge/policy'
export type { Hlc } from '@/merge/clock'
export { compareHlc, localTick, receiveTick, tieBreak } from '@/merge/clock'

// Forms, constraints, validation
export type {
  Form,
  Property,
  Constraint,
  Like,
  Severity,
  RoleBase,
} from '@/form/form'
export { form, property, hold, want, roleBase } from '@/form/form'
export type { Diagnostic } from '@/form/validate'
export { validateRecord, validateDataset, errors } from '@/form/validate'
export { validateReferences } from '@/form/references'
export type { ReferenceOptions } from '@/form/references'
export { autoMark } from '@/form/automark'

// The store (prolly tree, chunks, refs)
export type { ChunkStore, PrunableChunkStore } from '@/store/chunk-store'
export { MemoryChunkStore, isPrunable } from '@/store/chunk-store'
export type { RefStore } from '@/store/ref-store'
export { MemoryRefStore } from '@/store/ref-store'
export { writeDataset, readDataset, readRecord, diffRoots } from '@/store/tree'
export { catchUp } from '@/store/mirror'
export type { CatchUp } from '@/store/mirror'

// Async storage backends (R2 object storage for chunks, CockroachDB for refs)
export type { ObjectStore, ObjectHead } from '@/store/object-store'
export { MemoryObjectStore } from '@/store/object-store'
export type { AsyncChunkStore } from '@/store/r2-chunk-store'
export { R2ChunkStore, chunkKey } from '@/store/r2-chunk-store'
export type {
  SqlClient,
  AsyncRefStore,
  RefColumns,
  SqlRefOptions,
} from '@/store/sql-ref-store'
export {
  SqlRefStore,
  CockroachRefStore,
  PostgresRefStore,
  MemorySqlClient,
  DEFAULT_REF_COLUMNS,
  DEFAULT_REF_TABLE,
  REF_TABLE_DDL,
} from '@/store/sql-ref-store'

// Commits and the repository
export type { Commit, Validation } from '@/commit/commit'
export {
  writeCommit,
  readCommit,
  commitPayload,
  signCommitObject,
  verifyCommitObject,
} from '@/commit/commit'
export {
  encodeChanges,
  decodeChanges,
  writeChanges,
  readChanges,
} from '@/commit/changeset'
export { Repository } from '@/repo/repo'
export { MemoryRefLog } from '@/reflog/reflog'
export type { RefLog, RefLogEntry } from '@/reflog/reflog'
export type {
  CommitMeta,
  CommitResult,
  MergeResultOut,
  RepoOptions,
} from '@/repo/repo'

// Projections and the change feed
export type { Projection } from '@/project/projection'
export { MemoryProjection } from '@/project/projection'
export {
  ChangeFeed,
  commitChanges,
  projectFromEmpty,
  advance,
  sync,
} from '@/project/feed'

// The .tree syntax
export { formatTree } from '@/tree/format'
export { parseTree } from '@/tree/parse'

// Text diff and three-way merge (finer than line-level git diff)
export {
  diffText,
  diffTokens,
  tokenize,
  detokenize,
  changeHunks,
} from '@/text/diff'
export type { Granularity, Hunk, Edit, ChangeHunk } from '@/text/diff'
export { merge3Text, merge3Tokens } from '@/text/merge'
export type { TextMerge, MergeRegion } from '@/text/merge'

// File-level diff policy: opt generated/derived files out of text diffing
export type { FileConfig, FileRule } from '@/form/form'
export { globMatcher, matchesGlob } from '@/file/glob'
export { FilePolicy, filePolicy, diffFile, mergeFile } from '@/file/policy'

// Sync: async replica (chunk transfer) and realtime (op delta)
export { collectChunkHashes } from '@/store/tree'
export {
  missingChunks,
  packMissing,
  applyChunks,
  pull,
} from '@/sync/chunk-sync'
export type { ChunkMessage } from '@/sync/chunk-sync'
export { OpLog, applyOps } from '@/sync/op-sync'
export type { Op } from '@/sync/op-sync'
export { shallowChunks, packShallow, sparseRecords, ofTypes } from '@/sync/partial'

// Offline transfer (bundle) and packing
export {
  createBundle,
  encodeBundle,
  decodeBundle,
  applyBundle,
} from '@/transport/bundle'
export type { Bundle, ApplyBundleReport } from '@/transport/bundle'
export { packChunks, unpack, readFromPack } from '@/store/pack'
export type { Pack } from '@/store/pack'

// Remote editing: browser-server and cloud-local push/pull over an injected transport
export { MemoryRemoteRepo } from '@/transport/session'
export type { RemoteRepo, PushResult, PullResult } from '@/transport/session'

// Access control and signed authorship
export { AccessPolicy, authorizeCommit } from '@/access/policy'
export type { Action, Resource } from '@/access/policy'
export { generateKeypair, signCommit, verifyCommit } from '@/access/sign'
export type { Keypair } from '@/access/sign'

// Deletion: redaction and crypto-shredding
export { makeTombstone, isRedacted, redactInDataset } from '@/redact/redact'
export {
  KeyStore,
  shredEncrypt,
  shredDecrypt,
} from '@/redact/shred'
export type { Shredded } from '@/redact/shred'
export {
  RedactionVault,
  redactReversibly,
  unredact,
} from '@/redact/reversible'

// Garbage collection and hard erasure from history
export { reachableChunks, sweep, sweepObjectStore } from '@/gc/gc'
export type { GcReport } from '@/gc/gc'
export { reachableChunksAsync, collectGarbageAsync } from '@/gc/gc-async'
export { removeMatching, redactMatching, ConcurrentErasureError } from '@/erase/erase'
export type { Eraser, EraseReport } from '@/erase/erase'
export { RevocationList, enforceRevocation } from '@/erase/revocation'
export type { RevocationReport } from '@/erase/revocation'

// Off-history two-tier storage for regulated, deletable content
export {
  MemoryOffHistoryStore,
  offHistoryRef,
  isOffHistoryRef,
  offHistoryId,
  putOffHistory,
  resolveOffHistory,
} from '@/offhistory/store'
export type { OffHistoryStore } from '@/offhistory/store'
export {
  sealedProperties,
  partitionSensitive,
  resolveSensitive,
} from '@/offhistory/sensitive'

// Schema migration (upcasting, migrations as commits)
export { upcastRecord, upcastDataset, upcastAll } from '@/migrate/migrate'
export type { MigrationOp, Migration } from '@/migrate/migrate'

// Identity lifecycle: merge-as-redirect, split, referential actions
export {
  referrers,
  isRedirect,
  redirectTarget,
  resolveMark,
  mergeRecords,
  splitRecord,
  removeWithAction,
} from '@/identity/lifecycle'
export type { RefAction, RemoveResult } from '@/identity/lifecycle'

// Move-aware hierarchy: first-class moves, move-aware diff, cycle-safe tree CRDT
export {
  parentOf,
  moveRecord,
  childrenOf,
  diffMoves,
  applyMoves,
  mergeTree,
  recoverOrphans,
} from '@/identity/tree'
export type { MoveChange, TreeMove } from '@/identity/tree'
export { orderKeyBetween, orderKeyAfter, orderKeyBefore } from '@/base/order'

// Ephemeral presence and soft leases (separate from durable state)
export { PresenceChannel, LeaseRegistry } from '@/live/presence'
export type { PresenceState, Lease } from '@/live/presence'

// Query language and declared indexes
export { Query, query, QueryableProjection } from '@/query/query'
export type { Predicate, Comparator, Order } from '@/query/query'
export { OrderedIndex } from '@/query/ordered-index'
export { compareValues } from '@/query/compare'

// Maintained reverse-reference index for identity operations at scale
export { ReferenceIndex } from '@/lookup/reference-index'

// History operations: field-level blame, record history, bisect, mark index
export { blame, recordHistory, bisect, buildMarkIndex, markHistory } from '@/history/history'
export type { FieldBlame, HistoryEntry } from '@/history/history'
export { MarkIndex, marksTouched } from '@/lookup/mark-index'

// Integrity verification (fsck)
export { fsck } from '@/verify/fsck'
export type { FsckReport } from '@/verify/fsck'
