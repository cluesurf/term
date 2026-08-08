import type { Change, Comments } from '@term/base/code/diff/change'
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

// An optional value is wrapped in a 0-or-1 element array: [] means absent
// (distinct from a value of null / empty), [v] means present. Used for the
// field.set before-value and the label header change.
function encodeOptionalText(text: string | undefined): Array<Canon> {
  return text === undefined ? [] : [text]
}

function decodeOptionalText(wrap: Array<Canon>): string | undefined {
  return wrap.length === 0 ? undefined : (wrap[0] as string)
}

// Comments encode as an object (key -> lines) when present, or an empty array
// when absent, so undefined round-trips distinctly from an empty map.
function encodeComments(comments: Comments | undefined): Canon {
  if (comments === undefined) {
    return []
  }
  const out: { [key: string]: Canon } = {}
  for (const [key, lines] of comments) {
    out[key] = [...lines]
  }
  return out
}

function decodeComments(canon: Canon): Comments | undefined {
  if (Array.isArray(canon)) {
    return undefined
  }
  const obj = canon as { [key: string]: Canon }
  const out: Comments = new Map()
  for (const key of Object.keys(obj)) {
    out.set(key, (obj[key] as Array<Canon>).map(l => l as string))
  }
  return out
}

// Each change is encoded as a tagged array so the serialization is compact and
// deterministic (canonical JSON), reusing the value and record canonicalizers.
// Exported so the live-draft segment codec encodes operation changes identically.
export function encodeChange(change: Change): Array<Canon> {
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
    case 'record.relabel':
      return [
        'rl',
        change.mark,
        encodeOptionalText(change.before),
        encodeOptionalText(change.after),
      ]
    case 'record.retype':
      return ['rt', change.mark, change.before, change.after]
    case 'record.recomment':
      return [
        'rc',
        change.mark,
        encodeComments(change.before),
        encodeComments(change.after),
      ]
  }
}

export function decodeChange(enc: Array<Canon>): Change {
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
    case 'rl':
      return {
        type: 'record.relabel',
        mark,
        before: decodeOptionalText(enc[2] as Array<Canon>),
        after: decodeOptionalText(enc[3] as Array<Canon>),
      }
    case 'rt':
      return {
        type: 'record.retype',
        mark,
        before: enc[2] as string,
        after: enc[3] as string,
      }
    case 'rc':
      return {
        type: 'record.recomment',
        mark,
        before: decodeComments(enc[2]!),
        after: decodeComments(enc[3]!),
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
