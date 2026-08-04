import { hashBytes } from '@/canon/hash'
import { parseCommit } from '@/commit/commit'
import { treeNodeRefs } from '@/store/tree'
import type { ChunkStore } from '@/store/chunk-store'

// Integrity verification, base's `fsck`. Because every object (commit, tree node, record
// chunk, change set) is content-addressed, integrity is one uniform check: a chunk is
// sound when it is present and its bytes still hash to its name. fsck walks the whole
// object graph from the retained roots, re-hashing every chunk, and reports anything
// missing (a dangling reference) or corrupt (bytes that no longer match their hash).
// This is what lets base claim git-like trust: the store can prove its own integrity.
//
// See note/library/base/design/storage-backend.md.

export type FsckReport = {
  ok: boolean
  // chunks checked
  checked: number
  // hashes referenced but absent from the store
  missing: Array<string>
  // hashes whose bytes no longer match (corruption or tampering)
  corrupt: Array<string>
}

type ChunkKind = 'commit' | 'node' | 'record'

// Verify the object graph reachable from the given commits.
export function fsck(chunks: ChunkStore, roots: Iterable<string>): FsckReport {
  const missing: Array<string> = []
  const corrupt: Array<string> = []
  const seen = new Set<string>()
  let checked = 0

  // work items carry the kind so we know how to walk their children
  const stack: Array<{ hash: string; kind: ChunkKind }> = []
  for (const root of roots) {
    stack.push({ hash: root, kind: 'commit' })
  }

  while (stack.length > 0) {
    const { hash, kind } = stack.pop()!
    if (seen.has(hash)) {
      continue
    }
    seen.add(hash)

    const bytes = chunks.get(hash)
    if (bytes === undefined) {
      missing.push(hash)
      continue
    }
    checked++
    if (hashBytes(bytes) !== hash) {
      corrupt.push(hash)
      continue // do not trust the children of a corrupt chunk
    }

    if (kind === 'commit') {
      const commit = parseCommit(bytes)
      stack.push({ hash: commit.root, kind: 'node' })
      if (commit.changes !== undefined) {
        // a change set is a content-addressed leaf: verified by the re-hash above
        stack.push({ hash: commit.changes, kind: 'record' })
      }
      for (const parent of commit.parents) {
        stack.push({ hash: parent, kind: 'commit' })
      }
    } else if (kind === 'node') {
      const { leaf, refs } = treeNodeRefs(bytes)
      for (const ref of refs) {
        stack.push({ hash: ref, kind: leaf ? 'record' : 'node' })
      }
    }
    // a 'record' chunk is a leaf: its integrity is the re-hash, nothing to descend
  }

  return { ok: missing.length === 0 && corrupt.length === 0, checked, missing, corrupt }
}
