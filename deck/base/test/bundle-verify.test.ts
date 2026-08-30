// Verifying a deposited bundle against a citation, offline.
//
// A citation names a commit. A copy of the bundle turns up somewhere: an archive, a mirror,
// a colleague's disk. This is what answers whether that copy IS the release, from the bytes
// alone, and it is what lets a deposit be a fallback without becoming a fork.
//
// `applyBundle` already re-hashes on the way in, so the interesting cases are the ones it
// CANNOT catch:
//
//   a bundle that is entirely un-tampered and TRUNCATED, which applies without complaint
//   until somebody reads the part that is not there
//
//   a bundle that is complete and simply does not contain the commit that was cited
//
// And one thing it must not do: write. Checking a stranger's file should not mean letting it
// into your store first.
//
// See note/library/base/design/citeable-releases.md.

import { describe, it, expect } from 'vitest'
import { Repository } from '@term/base/code/repo/repo'
import { MemoryChunkStore } from '@term/base/code/store/chunk-store'
import { MemoryRefStore } from '@term/base/code/store/ref-store'
import {
  createBundle,
  decodeBundle,
  encodeBundle,
  verifyBundle,
  type Bundle,
} from '@term/base/code/transport/bundle'
import type { Dataset } from '@term/base/code/diff/change'
import type { RecordNode } from '@term/base/code/base/type'

const BRANCH = 'main'
const META = { author: 'test', time: 1_700_000_000_000, message: 'release' }

function markOf(n: number): string {
  const hex = n.toString(16).padStart(12, '0')

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(0, 3)}-8${hex.slice(3, 6)}-${hex.slice(0, 12)}`
}

function recordOf(n: number): RecordNode {
  return {
    mark: markOf(n),
    type: 'word',
    fields: new Map([['text', { kind: 'text', value: `word-${n}` }]]),
  }
}

/** A repository with `size` records committed, and the bundle over it. */
function released(size: number): { commit: string; bundle: Bundle } {
  const chunks = new MemoryChunkStore()
  const refs = new MemoryRefStore()
  const repo = new Repository(chunks, refs)
  const dataset: Dataset = new Map()

  for (let n = 0; n < size; n++) {
    dataset.set(markOf(n), recordOf(n))
  }

  const written = repo.commit(BRANCH, META, dataset)

  if (!written.ok) {
    throw new Error('the fixture could not commit')
  }

  return {
    commit: written.commit,
    bundle: createBundle(chunks, { [`branch/${BRANCH}`]: written.commit }),
  }
}

describe('verifying a deposited bundle', () => {
  it('accepts a whole bundle for the commit it names', () => {
    const { commit, bundle } = released(60)
    const verdict = verifyBundle({ bundle, commit })

    expect(verdict.ok).toBe(true)
    expect(verdict.missing).toEqual([])
    expect(verdict.corrupt).toEqual([])
    expect(verdict.checked).toBeGreaterThan(60)
  })

  it('survives a round trip through the encoded form', () => {
    // A deposit is a file. If the property only held for the in-memory value it would say
    // nothing about the thing actually archived.
    const { commit, bundle } = released(40)

    expect(
      verifyBundle({ bundle: decodeBundle(encodeBundle(bundle)), commit }).ok,
    ).toBe(true)
  })

  it('REFUSES a truncated bundle, which applyBundle cannot catch', () => {
    // The case that matters most. Every remaining chunk is genuine and hashes correctly, so
    // nothing is tampered: the copy is simply incomplete, and an incomplete copy reads fine
    // until somebody opens the part that is not there.
    const { commit, bundle } = released(60)
    const chunks = { ...bundle.chunks }
    const dropped = Object.keys(chunks).find(hash => hash !== commit)!

    delete chunks[dropped]

    const verdict = verifyBundle({ bundle: { ...bundle, chunks }, commit })

    expect(verdict.ok).toBe(false)
    expect(verdict.missing.length).toBeGreaterThan(0)
  })

  it('refuses a bundle that does not carry the cited commit at all', () => {
    const { bundle } = released(20)
    const other = released(20)

    // a complete bundle, for a different release
    const verdict = verifyBundle({ bundle, commit: `${other.commit}x` })

    expect(verdict.ok).toBe(false)
    expect(verdict.missing).toHaveLength(1)
  })

  it('refuses a bundle whose bytes were altered under their own hash', () => {
    const { commit, bundle } = released(30)
    const chunks = { ...bundle.chunks }
    const target = Object.keys(chunks).find(hash => hash !== commit)!

    chunks[target] = 'tampered'

    const verdict = verifyBundle({ bundle: { ...bundle, chunks }, commit })

    expect(verdict.ok).toBe(false)
    expect(verdict.corrupt).toContain(target)
  })

  it('reports unreachable chunks without failing on them', () => {
    // Harmless: content addressing means nothing can reference them by accident, and a
    // bundle carrying several refs legitimately holds chunks one commit does not touch.
    // Reported anyway, because a deposit that is mostly unreachable is worth a look.
    const { commit, bundle } = released(20)
    const chunks = { ...bundle.chunks, 'sha256:notreferenced': 'spare' }

    const verdict = verifyBundle({ bundle: { ...bundle, chunks }, commit })

    expect(verdict.ok).toBe(true)
    expect(verdict.extra).toEqual(['sha256:notreferenced'])
  })

  it('does not write anything, even into a store it was handed nothing of', () => {
    // A verifier that can write is one that can be made to store what it is checking.
    // Nobody should have to accept a copy to find out whether to accept it.
    const { commit, bundle } = released(25)
    const before = { ...bundle.chunks }

    verifyBundle({ bundle, commit })

    expect(bundle.chunks).toEqual(before)
  })

  it('is honest about an empty bundle', () => {
    const verdict = verifyBundle({
      bundle: { refs: {}, chunks: {} },
      commit: 'sha256:whatever',
    })

    expect(verdict.ok).toBe(false)
    expect(verdict.checked).toBe(0)
  })
})
