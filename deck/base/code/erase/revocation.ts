import { canonicalString } from '@/canon/json'
import type { PrunableChunkStore } from '@/store/chunk-store'

// Distributed erasure. A local erasure reclaims content in the store it runs against,
// but a fork or replica that has the old chunks would otherwise keep serving them, and
// a hostile peer could push them back. A revocation list closes that: the set of chunk
// hashes that must never be stored or served again. It is a grow-only set (a CRDT
// join-semilattice, so merging two replicas' lists is just union), it propagates
// alongside sync, and every peer honours it on catch-up by refusing revoked chunks and
// deleting any it already holds. Because content is addressed by hash, revoking a hash
// bans exactly that content forever, which is the point for illegal or personal data.
//
// See note/library/base/design/deletion-and-legal-removal.md and
// note/library/base/design/sync-and-transport.md.

export class RevocationList {
  private revoked: Set<string>

  constructor(hashes: Iterable<string> = []) {
    this.revoked = new Set(hashes)
  }

  revoke(hashes: Iterable<string>): void {
    for (const h of hashes) {
      this.revoked.add(h)
    }
  }

  has(hash: string): boolean {
    return this.revoked.has(hash)
  }

  size(): number {
    return this.revoked.size
  }

  hashes(): Array<string> {
    return [...this.revoked].sort()
  }

  // Union with another list (grow-only merge). Order-independent and idempotent.
  merge(other: RevocationList): void {
    for (const h of other.revoked) {
      this.revoked.add(h)
    }
  }

  // Deterministic serialization for propagation and storage.
  encode(): string {
    return canonicalString(this.hashes())
  }

  static decode(bytes: string): RevocationList {
    return new RevocationList(JSON.parse(bytes) as Array<string>)
  }
}

export type RevocationReport = {
  removed: number
  removedHashes: Array<string>
}

// Honour a revocation list against a store: delete every revoked chunk it holds. A
// replica runs this on catch-up so an erasure that happened elsewhere takes effect
// locally.
export function enforceRevocation(
  store: PrunableChunkStore,
  revocation: RevocationList,
): RevocationReport {
  const removedHashes: Array<string> = []
  for (const hash of store.keys()) {
    if (revocation.has(hash)) {
      store.delete(hash)
      removedHashes.push(hash)
    }
  }
  return { removed: removedHashes.length, removedHashes }
}
