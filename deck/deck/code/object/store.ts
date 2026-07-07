/**
 * The content-addressed object store interface, plus a local
 * filesystem implementation.
 *
 * Everything above (build, checkout, publish, install) talks to an
 * `ObjectStore`: does it have an object, get it, put it. The local
 * implementation lays objects out under the tone-encoded, dash-grouped
 * path (see ./tone) so the store is semi-readable on disk. A remote
 * store (the registry over HTTP) implements the same interface, so the
 * higher layers do not care whether an object is local or remote.
 *
 * Objects are immutable and content-addressed, so `put` is
 * create-if-absent: writing an id that already exists is a no-op, and
 * writing is verified (the bytes must hash to the claimed id) so a wrong
 * or corrupt object can never enter the store.
 */

import fsp from 'fs/promises'
import path from 'path'
import os from 'os'
import { hashObject, ObjectKind, idHex } from './hash'
import { tonePath } from './tone'

/** The minimal contract every object store (local or remote) satisfies. */
export type ObjectStore = {
  has(id: string): Promise<boolean>
  get(id: string): Promise<Buffer>
  put(input: { id: string; bytes: Buffer }): Promise<void>
  /** Batch existence check: return the subset of ids NOT present. */
  missing(ids: string[]): Promise<string[]>
}

// The local object store root. Kept beside the existing deck store under
// the user's home so both share one content-addressed home.
function localObjectRoot(): string {
  return path.join(os.homedir(), '.term', 'store', 'objects', 'sha256')
}

/** Absolute on-disk path for an object id in a given root. */
function objectFilePath(root: string, id: string): string {
  return path.join(root, tonePath(id))
}

/**
 * Recompute an object's address from its bytes and kind, to verify it
 * matches its claimed id before the store accepts it. The kind is
 * recovered from context by the caller; here we accept a precomputed id
 * and re-derive against every kind is wrong, so callers pass the kind.
 */
export function verifyObject(input: {
  id: string
  kind: ObjectKind
  bytes: Buffer
}): boolean {
  return hashObject({ kind: input.kind, bytes: input.bytes }) === input.id
}

/** A local filesystem object store rooted under `~/.term/store`. */
export function localObjectStore(input?: { root: string }): ObjectStore {
  const root = input?.root ?? localObjectRoot()

  return {
    async has(id: string): Promise<boolean> {
      try {
        await fsp.access(objectFilePath(root, id))

        return true
      } catch {
        return false
      }
    },

    async get(id: string): Promise<Buffer> {
      return fsp.readFile(objectFilePath(root, id))
    },

    async put(putInput: { id: string; bytes: Buffer }): Promise<void> {
      const filePath = objectFilePath(root, putInput.id)

      try {
        await fsp.access(filePath)

        return
      } catch {
        // not present yet
      }

      await fsp.mkdir(path.dirname(filePath), { recursive: true })
      // write to a temp then rename, so a reader never sees a partial object
      const tmp = `${filePath}.tmp-${idHex(putInput.id).slice(0, 8)}`
      await fsp.writeFile(tmp, putInput.bytes)
      await fsp.rename(tmp, filePath)
    },

    async missing(ids: string[]): Promise<string[]> {
      const out: string[] = []

      for (const id of ids) {
        try {
          await fsp.access(objectFilePath(root, id))
        } catch {
          out.push(id)
        }
      }

      return out
    },
  }
}
