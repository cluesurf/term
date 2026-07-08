/**
 * The HTTP registry client: a `Registry` implementation that talks to a
 * registry server over HTTP. This is the wire transport over the proven
 * registry logic (see ./registry). The client publish/install code
 * (./publish, ./install) does not change; it just receives this Registry
 * instead of the in-process `directRegistry`.
 *
 * Endpoints (see note/term/registry/12):
 *   POST /publish/negotiate   { package, ids }  -> { missing }
 *   PUT  /object/:id          <bytes>           -> { ok }
 *   GET  /object/:id                            -> <bytes>
 *   HEAD /object/:id                            -> 200 | 404
 *   POST /publish/commit      { ... }           -> { ok, ref }
 *   GET  /resolve?package&ref                   -> { commit }
 *   GET  /manifest?package&ref                  -> <manifest>
 */

import { Registry, Ref, PublishTarget } from './registry'
import { Manifest } from './graph'

function refQuery(ref: Ref): string {
  if (ref.kind === 'version') {
    return `version=${encodeURIComponent(ref.version)}`
  }

  if (ref.kind === 'branch') {
    return `branch=${encodeURIComponent(ref.branch)}`
  }

  return `commit=${encodeURIComponent(ref.commit)}`
}

async function readError(response: Response): Promise<string> {
  try {
    const body = await response.text()

    return body ? ` — ${body.slice(0, 500)}` : ''
  } catch {
    return ''
  }
}

/** A Registry backed by an HTTP registry server. `token` authenticates publishes. */
export function httpRegistry(input: {
  baseUrl: string
  token?: string
}): Registry {
  const base = input.baseUrl.replace(/\/$/, '')
  const authHeaders: Record<string, string> = input.token
    ? { authorization: `Bearer ${input.token}` }
    : {}

  const objectUrl = (id: string): string =>
    `${base}/package-objects/${encodeURIComponent(id)}`

  // a package is `@scope/name`; its slash is a path separator, so it is not
  // percent-encoded (the scope + name are already URL-safe)
  const packageUrl = (pkg: string, sub: string): string =>
    `${base}/packages/${pkg}/${sub}`

  return {
    async findMissing(ids: string[]): Promise<string[]> {
      const response = await fetch(`${base}/packages/verify!`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids }),
      })

      if (!response.ok) {
        throw new Error(
          `negotiate failed: ${response.status}${await readError(response)}`,
        )
      }

      return ((await response.json()) as { missing: string[] }).missing
    },

    async putObject(obj: { id: string; bytes: Buffer }): Promise<void> {
      // Send as a Blob. A Uint8Array / Buffer body fails on Node 24 undici with
      // `slice on a detached ArrayBuffer` (the readFile Buffer's pooled
      // ArrayBuffer is detached mid-request); a Blob copies the bytes and
      // transfers cleanly.
      // POST the object bytes to the mutate action; the object's id rides a
      // header (the server verifies the bytes hash to it under some kind).
      const response = await fetch(`${base}/package-objects/mutate!`, {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'x-object-id': obj.id,
          ...authHeaders,
        },
        body: new Blob([obj.bytes]),
      })

      if (!response.ok) {
        throw new Error(
          `put object ${obj.id} failed: ${response.status}${await readError(response)}`,
        )
      }
    },

    async putPack(pack: { id: string; bytes: Buffer }): Promise<void> {
      // A pack POSTs its compressed bytes; the server unpacks + stores each
      // contained object. The pack id rides a header so the server can verify
      // the bytes and dedup. Blob body for the same Node 24 undici reason as
      // putObject above.
      const response = await fetch(`${base}/packages/bundle!`, {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'x-pack-id': pack.id,
          ...authHeaders,
        },
        body: new Blob([pack.bytes]),
      })

      if (!response.ok) {
        throw new Error(
          `put pack ${pack.id} failed: ${response.status}${await readError(response)}`,
        )
      }
    },

    async getObject(id: string): Promise<Buffer> {
      const response = await fetch(objectUrl(id))

      if (!response.ok) {
        throw new Error(
          `get object ${id} failed: ${response.status}${await readError(response)}`,
        )
      }

      return Buffer.from(await response.arrayBuffer())
    },

    async hasObject(id: string): Promise<boolean> {
      const response = await fetch(objectUrl(id), { method: 'HEAD' })

      return response.ok
    },

    async resolve(args: { package: string; ref: Ref }): Promise<string> {
      const url = `${packageUrl(args.package, 'commit')}?${refQuery(args.ref)}`
      const response = await fetch(url)

      if (!response.ok) {
        throw new Error(
          `resolve failed: ${response.status}${await readError(response)}`,
        )
      }

      return ((await response.json()) as { commit: string }).commit
    },

    async publishCommit(args: {
      package: string
      target: PublishTarget
      commit: string
      sig: string
      key: string
    }): Promise<{ ok: true; ref: string }> {
      const response = await fetch(`${base}/packages/commit!`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders },
        body: JSON.stringify(args),
      })

      if (!response.ok) {
        throw new Error(
          `commit failed: ${response.status}${await readError(response)}`,
        )
      }

      return (await response.json()) as { ok: true; ref: string }
    },

    async manifest(args: { package: string; ref: Ref }): Promise<Manifest> {
      const url = `${packageUrl(args.package, 'manifest')}?${refQuery(args.ref)}`
      const response = await fetch(url)

      if (!response.ok) {
        throw new Error(
          `manifest failed: ${response.status}${await readError(response)}`,
        )
      }

      return (await response.json()) as Manifest
    },
  }
}
