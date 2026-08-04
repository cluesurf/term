import { randomBytes } from 'node:crypto'
import type { Value } from '@term/base/code/base/type'

// Off-history two-tier storage. The content-addressed history is immutable: once a
// value is committed it can never be truly erased, only redacted or crypto-shredded.
// That is wrong for content the law can compel you to delete outright (personal data
// under a right-to-erasure request, licensed text pulled on a takedown). Such content
// lives in a mutable side store, and the history holds only a reference to it. Deleting
// the side entry removes the content for good while leaving every commit hash intact;
// the reference simply resolves to nothing.
//
// See note/library/base/design/deletion-and-legal-removal.md and
// note/library/base/design/repository-content-modes.md.

const PREFIX = 'offhistory:'

export interface OffHistoryStore {
  // store content under a fresh, time-independent id and return the id
  put(content: string): string
  // read content, or undefined if never stored or since deleted
  get(id: string): string | undefined
  has(id: string): boolean
  // permanently remove the content; the reference in history now dangles
  delete(id: string): void
}

export class MemoryOffHistoryStore implements OffHistoryStore {
  private data = new Map<string, string>()

  put(content: string): string {
    const id = randomBytes(16).toString('hex')
    this.data.set(id, content)
    return id
  }

  get(id: string): string | undefined {
    return this.data.get(id)
  }

  has(id: string): boolean {
    return this.data.has(id)
  }

  delete(id: string): void {
    this.data.delete(id)
  }
}

// A blob value that points at off-history content rather than a content hash. It is
// stored in history like any other reference, but its target is deletable.
export function offHistoryRef(id: string): Value {
  return { kind: 'blob', hash: `${PREFIX}${id}` }
}

export function isOffHistoryRef(value: Value): boolean {
  return value.kind === 'blob' && value.hash.startsWith(PREFIX)
}

export function offHistoryId(value: Value): string | undefined {
  return value.kind === 'blob' && value.hash.startsWith(PREFIX)
    ? value.hash.slice(PREFIX.length)
    : undefined
}

// Store content off-history and get back the reference value to put in a record.
export function putOffHistory(store: OffHistoryStore, content: string): Value {
  return offHistoryRef(store.put(content))
}

// Resolve an off-history reference to its content, or undefined if it is not such a
// reference or the content has been deleted.
export function resolveOffHistory(
  store: OffHistoryStore,
  value: Value,
): string | undefined {
  const id = offHistoryId(value)
  return id === undefined ? undefined : store.get(id)
}
