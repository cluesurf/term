// Downloading a repository as an archive.
//
// Transport-free like the rest: this yields ENTRIES, and the host writes them into a zip,
// a tar, or straight to a socket. Yielding rather than returning is deliberate, because a
// large repository must never be assembled in memory before the first byte ships.
//
// See note/library/base/design/export-and-dump.md.

import type { Repository } from '@term/base/code/repo/repo'
import type { RecordNode } from '@term/base/code/base/type'
import { formatTree } from '@term/base/code/tree/format'

export type Entry = {
  path: string
  bytes: Buffer
}

export type Manifest = {
  // what this archive is OF. A zip carries no proof of its own completeness, so the
  // commit travels with it and a recipient can re-verify after extraction.
  commit: string
  repository: string
  entries: number
  // every record's mark and content address, so a recipient can check each file rather
  // than trusting the archive as a whole
  records: Array<{ mark: string; path: string }>
}

/** A record's file name inside the archive. */
function pathFor(record: RecordNode, mark: string): string {
  // grouped by form so an extracted archive is browsable, named by mark so it is stable
  // across exports even when a label changes
  return `${record.type}/${mark}.tree`
}

/**
 * The working tree at a commit, entry by entry.
 *
 * This is the readable dump: `.tree` files a person can open without any of our software.
 * It is a checkout, not the object graph, so history and branches do NOT come with it.
 * Someone migrating off the platform wants `bundle` below instead.
 */
export function* exportTree(input: {
  repo: Repository
  commit: string
  repository?: string
}): Generator<Entry> {
  const dataset = input.repo.checkout(input.commit)

  // sorted by mark so two exports of one commit are byte-identical. An archive that
  // differs run to run cannot be cached by content address or compared by hash.
  for (const mark of [...dataset.keys()].sort()) {
    const record = dataset.get(mark)!

    yield {
      path: pathFor(record, mark),
      bytes: Buffer.from(formatTree(record), 'utf8'),
    }
  }
}

/** The manifest for an export, listing what a recipient should find. */
export function manifestOf(input: {
  repo: Repository
  commit: string
  repository: string
}): Manifest {
  const dataset = input.repo.checkout(input.commit)
  const records = [...dataset.keys()]
    .sort()
    .map(mark => ({ mark, path: pathFor(dataset.get(mark)!, mark) }))

  return {
    commit: input.commit,
    repository: input.repository,
    entries: records.length,
    records,
  }
}

/**
 * A full export: the manifest, then every record.
 *
 * The manifest comes FIRST so a streaming recipient knows what to expect before the
 * payload arrives, and can tell a truncated download from a small repository.
 */
export function* exportArchive(input: {
  repo: Repository
  commit: string
  repository: string
}): Generator<Entry> {
  yield {
    path: 'manifest.json',
    bytes: Buffer.from(
      JSON.stringify(manifestOf(input), null, 2),
      'utf8',
    ),
  }

  yield* exportTree(input)
}

/**
 * The cache key for an archive.
 *
 * An archive of a commit is deterministic, so it is content-addressed by the commit it
 * exports. That is what makes caching one safe: there is no invalidation, because the key
 * IS the content. A cached archive can never be stale, only absent.
 */
export function archiveKey(input: {
  repository: string
  commit: string
  kind: 'tree' | 'archive'
}): string {
  return `export/${input.kind}/${input.repository}/${input.commit}.zip`
}

/**
 * Whether an archive is worth storing rather than streaming.
 *
 * Published versions and branch heads are downloaded repeatedly and deserve a stored
 * copy. An arbitrary historical commit is usually a one-off, and storing every one of
 * those fills the bucket with archives nobody asks for twice.
 */
export function worthCaching(input: {
  commit: string
  heads: Array<string>
  versions: Array<string>
}): boolean {
  return (
    input.heads.includes(input.commit) || input.versions.includes(input.commit)
  )
}
