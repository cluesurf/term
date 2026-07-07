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
    `${base}/object/${encodeURIComponent(id)}`

  return {
    async findMissing(ids: string[]): Promise<string[]> {
      const response = await fetch(`${base}/publish/negotiate`, {
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
      const response = await fetch(objectUrl(obj.id), {
        method: 'PUT',
        headers: {
          'content-type': 'application/octet-stream',
          ...authHeaders,
        },
        body: new Uint8Array(obj.bytes),
      })

      if (!response.ok) {
        throw new Error(
          `put object ${obj.id} failed: ${response.status}${await readError(response)}`,
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
      const url = `${base}/resolve?package=${encodeURIComponent(args.package)}&${refQuery(args.ref)}`
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
      const response = await fetch(`${base}/publish/commit`, {
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
      const url = `${base}/manifest?package=${encodeURIComponent(args.package)}&${refQuery(args.ref)}`
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
