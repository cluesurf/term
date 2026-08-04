import type { Change } from '@term/base/code/diff/change'
import type { Canon } from '@term/base/code/canon/json'
import {
  toCanonValue,
  toCanonRecord,
  canonicalString,
} from '@term/base/code/canon/json'
import { fromCanonValue, fromCanonRecord } from '@term/base/code/canon/json'
import type { ChunkStore } from '@term/base/code/store/chunk-store'

// A commit's field-level change set, stored as its own content-addressed chunk and
// referenced from the commit. Recording exactly what changed makes a commit auditable
// on its own and lets a projection advance by reading the change set directly, instead
// of re-diffing two full checkouts. See note/library/base/04-commit-and-patch.md.

// Each change is encoded as a tagged array so the serialization is compact and
// deterministic (canonical JSON), reusing the value and record canonicalizers.
function encodeChange(change: Change): Array<Canon> {
  switch (change.type) {
    case 'record.add':
      return ['+', change.mark, toCanonRecord(change.value)]
    case 'record.remove':
      return ['-', change.mark, toCanonRecord(change.before)]
    case 'field.set':
      // the before-value is wrapped in a 0-or-1 element array: [] means the field did
      // not exist before (a first set), distinct from a before-value of null
      return [
        's',
        change.mark,
        change.field,
        change.before === undefined ? [] : [toCanonValue(change.before)],
        toCanonValue(change.after),
      ]
    case 'field.remove':
      return ['x', change.mark, change.field, toCanonValue(change.before)]
  }
}

function decodeChange(enc: Array<Canon>): Change {
  const tag = enc[0] as string
  const mark = enc[1] as string
  switch (tag) {
    case '+':
      return { type: 'record.add', mark, value: fromCanonRecord(enc[2] as { [k: string]: Canon }) }
    case '-':
      return { type: 'record.remove', mark, before: fromCanonRecord(enc[2] as { [k: string]: Canon }) }
    case 's': {
      const beforeWrap = enc[3] as Array<Canon>
      return {
        type: 'field.set',
        mark,
        field: enc[2] as string,
        before: beforeWrap.length === 0 ? undefined : fromCanonValue(beforeWrap[0]!),
        after: fromCanonValue(enc[4] as Canon),
      }
    }
    case 'x':
      return {
        type: 'field.remove',
        mark,
        field: enc[2] as string,
        before: fromCanonValue(enc[3] as Canon),
      }
    default:
      throw new Error(`unknown change tag ${tag}`)
  }
}

export function encodeChanges(changes: Array<Change>): string {
  return canonicalString(changes.map(encodeChange) as never)
}

export function decodeChanges(bytes: string): Array<Change> {
  const arr = JSON.parse(bytes) as Array<Array<Canon>>
  return arr.map(decodeChange)
}

// Store a change set and return its chunk hash.
export function writeChanges(changes: Array<Change>, store: ChunkStore): string {
  return store.put(encodeChanges(changes))
}

// Read a change set back by hash, or undefined if the commit did not record one.
export function readChanges(hash: string, store: ChunkStore): Array<Change> | undefined {
  const bytes = store.get(hash)
  return bytes === undefined ? undefined : decodeChanges(bytes)
}
