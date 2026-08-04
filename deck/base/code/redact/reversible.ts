import type { RecordNode } from '@/base/type'
import type { Mark } from '@/base/type'
import type { Dataset } from '@/diff/change'
import { makeTombstone } from '@/redact/redact'
import {
  KeyStore,
  shredEncrypt,
  shredDecrypt,
  type Shredded,
} from '@/redact/shred'
import { canonicalizeRecord } from '@/canon/canonicalize'
import { decodeRecord } from '@/canon/decode'

// Reversible redaction. A plain redaction is immediate and permanent. Some policies
// want a window in which an author can undo a mistaken redaction, then a point of no
// return. This gives both: the original is stashed encrypted in a vault, so the
// redaction can be reversed while the key lives, and finalizing the ticket shreds the
// key, making the redaction permanent (the original is then unrecoverable, exactly like
// crypto-shredding). Whether the window is time-based or manual is left to the caller.
//
// See note/library/base/design/deletion-and-legal-removal.md.

// Holds the encrypted originals behind redactions. The key store is what makes a
// redaction reversible: while the key lives the original can be restored; shred it and
// the redaction is permanent.
export class RedactionVault {
  private entries = new Map<string, { shredded: Shredded; mark: Mark }>()

  constructor(private keys: KeyStore = new KeyStore()) {}

  // Stash a record's original content, returning a ticket (the encryption key id).
  stash(mark: Mark, node: RecordNode): string {
    const shredded = shredEncrypt(canonicalizeRecord(node), this.keys)
    this.entries.set(shredded.keyId, { shredded, mark })
    return shredded.keyId
  }

  // Restore the original, or undefined if the ticket is unknown or already finalized.
  restore(ticket: string): RecordNode | undefined {
    const entry = this.entries.get(ticket)
    if (entry === undefined) {
      return undefined
    }
    const bytes = shredDecrypt(entry.shredded, this.keys)
    return bytes === undefined ? undefined : decodeRecord(bytes)
  }

  // Make the redaction permanent by shredding the key. The original becomes
  // unrecoverable while its ciphertext and structure stay intact.
  finalize(ticket: string): void {
    this.keys.shred(ticket)
  }

  // Whether the ticket can still be reversed.
  reversible(ticket: string): boolean {
    return this.restore(ticket) !== undefined
  }
}

// Redact a record to a tombstone while stashing its original in the vault, so it can be
// reversed until finalized. Returns the new dataset and the reversal ticket.
export function redactReversibly(
  dataset: Dataset,
  mark: Mark,
  opts: { reason: string; by: string; time: number },
  vault: RedactionVault,
): { dataset: Dataset; ticket: string | undefined } {
  const node = dataset.get(mark)
  if (node === undefined) {
    return { dataset, ticket: undefined }
  }
  const ticket = vault.stash(mark, node)
  const out: Dataset = new Map(dataset)
  out.set(mark, makeTombstone(node, opts))
  return { dataset: out, ticket }
}

// Reverse a reversible redaction, restoring the original record. A no-op if the ticket
// was finalized (the original is gone for good).
export function unredact(
  dataset: Dataset,
  ticket: string,
  vault: RedactionVault,
): Dataset {
  const original = vault.restore(ticket)
  if (original === undefined || original.mark === undefined) {
    return dataset
  }
  const out: Dataset = new Map(dataset)
  out.set(original.mark, original)
  return out
}
