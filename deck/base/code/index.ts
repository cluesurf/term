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
} from '@term/base/code/base/type'
export * from '@term/base/code/base/make'
export { mintMark, isMark, normalizeMark } from '@term/base/code/base/mark'
export { valueEqual, recordEqual } from '@term/base/code/base/equal'

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
} from '@term/base/code/canon/canonicalize'
export { decodeRecord, decodeRecordBytes, decodeValue, decodeValueBytes } from '@term/base/code/canon/decode'
export { hashRecord, hashValue, hashBytes, hashCanonicalBytes, HASH_FUNCTION } from '@term/base/code/canon/hash'
export { markToBytes, bytesToMark, bytesToToneMark, bytesToHexMark, toToneMark, toHexMark, TONE_ALPHABET } from '@term/base/code/canon/mark'
export { CANONICAL_FORM_VERSION, TAG_REF, TAG_BLOB, TAG_DECIMAL } from '@term/base/code/canon/cbor'

// Diff, patch, merge
export type { Change, Dataset } from '@term/base/code/diff/change'
export { emptyDataset, datasetOf } from '@term/base/code/diff/change'
export { diffDataset, diffRecord } from '@term/base/code/diff/diff'
export { diffValues } from '@term/base/code/diff/value-diff'
export type { ValueDiff } from '@term/base/code/diff/value-diff'
export { diffSemantic, summarizeSemantic } from '@term/base/code/diff/semantic'
export type { SemanticChange } from '@term/base/code/diff/semantic'
export { applyChanges } from '@term/base/code/patch/patch'
export { mergeDataset } from '@term/base/code/merge/merge'
export type { Conflict, MergeResult, MergeOptions } from '@term/base/code/merge/merge'
export { MergeSession } from '@term/base/code/merge/session'
export type { Resolution } from '@term/base/code/merge/session'
export { applyFieldPolicy, policyResolver } from '@term/base/code/merge/policy'
export type { MergePolicy, FieldPolicyResolver } from '@term/base/code/merge/policy'
export type { Hlc } from '@term/base/code/merge/clock'
export { compareHlc, localTick, receiveTick, tieBreak } from '@term/base/code/merge/clock'

// Forms, constraints, validation
export type {
  Form,
  Property,
  Constraint,
  Like,
  Severity,
  RoleBase,
} from '@term/base/code/form/form'
export { form, property, hold, want, roleBase } from '@term/base/code/form/form'
export type { Diagnostic } from '@term/base/code/form/validate'
export { validateRecord, validateDataset, errors } from '@term/base/code/form/validate'
export { validateReferences } from '@term/base/code/form/references'
export type { ReferenceOptions } from '@term/base/code/form/references'
export { autoMark } from '@term/base/code/form/automark'

// The store (prolly tree, chunks, refs)
export type { ChunkStore, PrunableChunkStore } from '@term/base/code/store/chunk-store'
export { MemoryChunkStore, isPrunable } from '@term/base/code/store/chunk-store'
export type { RefStore } from '@term/base/code/store/ref-store'
export { MemoryRefStore } from '@term/base/code/store/ref-store'
export { writeDataset, readDataset, readRecord, diffRoots } from '@term/base/code/store/tree'
export { catchUp } from '@term/base/code/store/mirror'
export type { CatchUp } from '@term/base/code/store/mirror'

// Async storage backends (R2 object storage for chunks, CockroachDB for refs)
export type { ObjectStore, ObjectHead } from '@term/base/code/store/object-store'
export { MemoryObjectStore } from '@term/base/code/store/object-store'
export type { AsyncChunkStore } from '@term/base/code/store/r2-chunk-store'
export { R2ChunkStore, chunkKey } from '@term/base/code/store/r2-chunk-store'
export type {
  SqlClient,
  AsyncRefStore,
  RefColumns,
  SqlRefOptions,
} from '@term/base/code/store/sql-ref-store'
export {
  SqlRefStore,
  CockroachRefStore,
  PostgresRefStore,
  MemorySqlClient,
  DEFAULT_REF_COLUMNS,
  DEFAULT_REF_TABLE,
  REF_TABLE_DDL,
} from '@term/base/code/store/sql-ref-store'

// Commits and the repository
export type { Commit, Validation } from '@term/base/code/commit/commit'
export {
  writeCommit,
  readCommit,
  commitPayload,
  signCommitObject,
  verifyCommitObject,
} from '@term/base/code/commit/commit'
export {
  encodeChanges,
  decodeChanges,
  writeChanges,
  readChanges,
} from '@term/base/code/commit/changeset'
export { Repository } from '@term/base/code/repo/repo'
export { MemoryRefLog } from '@term/base/code/reflog/reflog'
export type { RefLog, RefLogEntry } from '@term/base/code/reflog/reflog'
export type {
  CommitMeta,
  CommitResult,
  MergeResultOut,
  RepoOptions,
} from '@term/base/code/repo/repo'

// Projections and the change feed
export type { Projection } from '@term/base/code/project/projection'
export { MemoryProjection } from '@term/base/code/project/projection'
export {
  ChangeFeed,
  commitChanges,
  projectFromEmpty,
  advance,
  sync,
} from '@term/base/code/project/feed'

// The .tree syntax
export { formatTree } from '@term/base/code/tree/format'
export { parseTree } from '@term/base/code/tree/parse'

// Text diff and three-way merge (finer than line-level git diff)
export {
  diffText,
  diffTokens,
  tokenize,
  detokenize,
  changeHunks,
} from '@term/base/code/text/diff'
export type { Granularity, Hunk, Edit, ChangeHunk } from '@term/base/code/text/diff'
export { merge3Text, merge3Tokens } from '@term/base/code/text/merge'
export type { TextMerge, MergeRegion } from '@term/base/code/text/merge'

// File-level diff policy: opt generated/derived files out of text diffing
export type { FileConfig, FileRule } from '@term/base/code/form/form'
export { globMatcher, matchesGlob } from '@term/base/code/file/glob'
export { FilePolicy, filePolicy, diffFile, mergeFile } from '@term/base/code/file/policy'

// Sync: async replica (chunk transfer) and realtime (op delta)
export { collectChunkHashes } from '@term/base/code/store/tree'
export {
  missingChunks,
  packMissing,
  applyChunks,
  pull,
} from '@term/base/code/sync/chunk-sync'
export type { ChunkMessage } from '@term/base/code/sync/chunk-sync'
export { OpLog, applyOps } from '@term/base/code/sync/op-sync'
export type { Op } from '@term/base/code/sync/op-sync'
export { shallowChunks, packShallow, sparseRecords, ofTypes } from '@term/base/code/sync/partial'

// Offline transfer (bundle) and packing
export {
  createBundle,
  encodeBundle,
  decodeBundle,
  applyBundle,
} from '@term/base/code/transport/bundle'
export type { Bundle, ApplyBundleReport } from '@term/base/code/transport/bundle'
export { packChunks, unpack, readFromPack } from '@term/base/code/store/pack'
export type { Pack } from '@term/base/code/store/pack'

// Remote editing: browser-server and cloud-local push/pull over an injected transport
export { MemoryRemoteRepo } from '@term/base/code/transport/session'
export type { RemoteRepo, PushResult, PullResult } from '@term/base/code/transport/session'

// Access control and signed authorship
export { AccessPolicy, authorizeCommit } from '@term/base/code/access/policy'
export type { Action, Resource } from '@term/base/code/access/policy'
export { generateKeypair, signCommit, verifyCommit } from '@term/base/code/access/sign'
export type { Keypair } from '@term/base/code/access/sign'

// Deletion: redaction and crypto-shredding
export { makeTombstone, isRedacted, redactInDataset } from '@term/base/code/redact/redact'
export {
  KeyStore,
  shredEncrypt,
  shredDecrypt,
} from '@term/base/code/redact/shred'
export type { Shredded } from '@term/base/code/redact/shred'
export {
  RedactionVault,
  redactReversibly,
  unredact,
} from '@term/base/code/redact/reversible'

// Garbage collection and hard erasure from history
export { reachableChunks, sweep, sweepObjectStore } from '@term/base/code/gc/gc'
export type { GcReport } from '@term/base/code/gc/gc'
export { reachableChunksAsync, collectGarbageAsync } from '@term/base/code/gc/gc-async'
export { removeMatching, redactMatching, ConcurrentErasureError } from '@term/base/code/erase/erase'
export type { Eraser, EraseReport } from '@term/base/code/erase/erase'
export { RevocationList, enforceRevocation } from '@term/base/code/erase/revocation'
export type { RevocationReport } from '@term/base/code/erase/revocation'

// Off-history two-tier storage for regulated, deletable content
export {
  MemoryOffHistoryStore,
  offHistoryRef,
  isOffHistoryRef,
  offHistoryId,
  putOffHistory,
  resolveOffHistory,
} from '@term/base/code/offhistory/store'
export type { OffHistoryStore } from '@term/base/code/offhistory/store'
export {
  sealedProperties,
  partitionSensitive,
  resolveSensitive,
} from '@term/base/code/offhistory/sensitive'

// Schema migration (upcasting, migrations as commits)
export { upcastRecord, upcastDataset, upcastAll } from '@term/base/code/migrate/migrate'
export type { MigrationOp, Migration } from '@term/base/code/migrate/migrate'

// Identity lifecycle: merge-as-redirect, split, referential actions
export {
  referrers,
  isRedirect,
  redirectTarget,
  resolveMark,
  mergeRecords,
  splitRecord,
  removeWithAction,
} from '@term/base/code/identity/lifecycle'
export type { RefAction, RemoveResult } from '@term/base/code/identity/lifecycle'

// Move-aware hierarchy: first-class moves, move-aware diff, cycle-safe tree CRDT
export {
  parentOf,
  moveRecord,
  childrenOf,
  diffMoves,
  applyMoves,
  mergeTree,
  recoverOrphans,
} from '@term/base/code/identity/tree'
export type { MoveChange, TreeMove } from '@term/base/code/identity/tree'
export { orderKeyBetween, orderKeyAfter, orderKeyBefore } from '@term/base/code/base/order'

// Ephemeral presence and soft leases (separate from durable state)
export { PresenceChannel, LeaseRegistry } from '@term/base/code/live/presence'
export type { PresenceState, Lease } from '@term/base/code/live/presence'

// Query language and declared indexes
export { Query, query, QueryableProjection } from '@term/base/code/query/query'
export type { Predicate, Comparator, Order } from '@term/base/code/query/query'
export { OrderedIndex } from '@term/base/code/query/ordered-index'
export { compareValues } from '@term/base/code/query/compare'

// Maintained reverse-reference index for identity operations at scale
export { ReferenceIndex } from '@term/base/code/lookup/reference-index'

// History operations: field-level blame, record history, bisect, mark index
export { blame, recordHistory, bisect, buildMarkIndex, markHistory } from '@term/base/code/history/history'
export type { FieldBlame, HistoryEntry } from '@term/base/code/history/history'
export { MarkIndex, marksTouched } from '@term/base/code/lookup/mark-index'

// Integrity verification (fsck)
export { fsck } from '@term/base/code/verify/fsck'
export type { FsckReport } from '@term/base/code/verify/fsck'
