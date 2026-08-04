import { canonicalString } from '@term/base/code/canon/json'
import type { ChunkStore } from '@term/base/code/store/chunk-store'
import { signCommit, verifyCommit } from '@term/base/code/access/sign'

// A commit records more than a message: the record-tree root it names, its parents,
// authorship, the reason and sources behind the change, and the validation result.
// A commit is a content-addressed object, so its hash names both a state and how it
// was reached.
//
// See note/library/base/04-commit-and-patch.md.

export type Validation = {
  schema: 'passed' | 'failed'
  errors: number
  warnings: number
}

export type Commit = {
  // the record-tree root hash naming the full state
  root: string
  // parent commit hashes: none for the first, one normally, two for a merge
  parents: Array<string>
  author: string
  // wall time in milliseconds, passed in explicitly so history is deterministic
  time: number
  message: string
  reason?: string
  sources?: Array<string>
  validation: Validation
  // the chunk hash of the field-level change set this commit introduced, so a reader
  // knows exactly what changed without re-diffing two full states
  changes?: string
  // the signer's public key (PEM) and the ed25519 signature over the commit payload,
  // so authorship cannot be forged and any tampering is evident
  signer?: string
  signature?: string
}

// The canonical form of a commit, excluding the signature, which is what gets signed.
// The signer key is included so a signature cannot be re-attributed to another key.
function toCanon(commit: Commit): { [key: string]: unknown } {
  const out: { [key: string]: unknown } = {
    root: commit.root,
    parents: commit.parents,
    author: commit.author,
    time: commit.time,
    message: commit.message,
    validation: [
      commit.validation.schema,
      commit.validation.errors,
      commit.validation.warnings,
    ],
  }
  if (commit.reason !== undefined) {
    out.reason = commit.reason
  }
  if (commit.sources !== undefined) {
    out.sources = commit.sources
  }
  if (commit.changes !== undefined) {
    out.changes = commit.changes
  }
  if (commit.signer !== undefined) {
    out.signer = commit.signer
  }
  return out
}

// The exact bytes a signature covers: the canonical commit without the signature.
export function commitPayload(commit: Commit): string {
  return canonicalString(toCanon(commit) as never)
}

// Sign a commit with an ed25519 private key, returning a copy carrying the signer's
// public key and signature.
export function signCommitObject(
  commit: Commit,
  keypair: { publicKey: string; privateKey: string },
): Commit {
  const signed: Commit = { ...commit, signer: keypair.publicKey }
  signed.signature = signCommit(commitPayload(signed), keypair.privateKey)
  return signed
}

// Verify a commit's signature against its embedded signer key. False if unsigned or
// tampered.
export function verifyCommitObject(commit: Commit): boolean {
  if (commit.signer === undefined || commit.signature === undefined) {
    return false
  }
  return verifyCommit(commitPayload(commit), commit.signature, commit.signer)
}

export function writeCommit(commit: Commit, store: ChunkStore): string {
  const full = toCanon(commit) as { [key: string]: unknown }
  if (commit.signature !== undefined) {
    full.signature = commit.signature
  }
  return store.put(canonicalString(full as never))
}

export function readCommit(hash: string, store: ChunkStore): Commit {
  const bytes = store.get(hash)
  if (bytes === undefined) {
    throw new Error(`missing commit ${hash}`)
  }
  return parseCommit(bytes)
}

// Parse a commit from its stored bytes. Split out so an async store can fetch the bytes
// itself and reuse the same decoding.
export function parseCommit(bytes: string): Commit {
  const raw = JSON.parse(bytes) as {
    root: string
    parents: Array<string>
    author: string
    time: number
    message: string
    reason?: string
    sources?: Array<string>
    validation: [string, number, number]
    changes?: string
    signer?: string
    signature?: string
  }
  const commit: Commit = {
    root: raw.root,
    parents: raw.parents,
    author: raw.author,
    time: raw.time,
    message: raw.message,
    validation: {
      schema: raw.validation[0] as 'passed' | 'failed',
      errors: raw.validation[1],
      warnings: raw.validation[2],
    },
  }
  if (raw.reason !== undefined) {
    commit.reason = raw.reason
  }
  if (raw.sources !== undefined) {
    commit.sources = raw.sources
  }
  if (raw.changes !== undefined) {
    commit.changes = raw.changes
  }
  if (raw.signer !== undefined) {
    commit.signer = raw.signer
  }
  if (raw.signature !== undefined) {
    commit.signature = raw.signature
  }
  return commit
}
