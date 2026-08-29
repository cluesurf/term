// Reading across repositories.
//
// One repository per form means a language and its expressions have INDEPENDENT watermarks,
// and word.surf reads across forms on most pages. So a read can see a child whose parent has
// not arrived, nothing in the database will catch it (foreign keys crossing the base and
// projection boundary are dropped by construction), and the only defence is that the caller
// knows it can happen.
//
// These lock in the two things a caller needs: a demand that spans repositories, and a
// refusal that NAMES which repository could not answer. A refusal that just says "stale"
// makes the caller guess which half to wait for.

import { describe, it, expect } from 'vitest'
import { admitAcross, commitSetOf } from '@term/base/code/project/across'
import type { Participant } from '@term/base/code/project/across'

const NOW = 1_000_000
const LANG = 'languages'
const EXPR = 'expressions'

function fresh(repository: string, commit: string, hasCommit?: boolean): Participant {
  return {
    repository,
    state: { serving: commit, appliedAt: NOW - 1_000 },
    ...(hasCommit === undefined ? {} : { hasCommit }),
  }
}

describe('a read spanning repositories', () => {
  it('serves when every participant is healthy', () => {
    const verdict = admitAcross({
      participants: [fresh(LANG, 'sha256:a'), fresh(EXPR, 'sha256:b')],
      now: NOW,
    })

    expect(verdict).toEqual({
      ok: true,
      serving: { [LANG]: 'sha256:a', [EXPR]: 'sha256:b' },
    })
  })

  it('reports the commit each repository was served at, not one commit for the read', () => {
    // Two repositories can never be compared by commit hash, so there is no single commit
    // that describes a cross-repository read. Pretending otherwise is the mistake.
    const verdict = admitAcross({
      participants: [fresh(LANG, 'sha256:a'), fresh(EXPR, 'sha256:b')],
      now: NOW,
    })

    expect(verdict.ok && Object.keys(verdict.serving)).toEqual([LANG, EXPR])
  })

  it('refuses when one participant has never applied anything, and NAMES it', () => {
    const verdict = admitAcross({
      participants: [
        fresh(LANG, 'sha256:a'),
        { repository: EXPR, state: { serving: undefined } },
      ],
      now: NOW,
    })

    expect(verdict.ok).toBe(false)

    if (!verdict.ok) {
      expect(verdict.repository).toBe(EXPR)
      expect(verdict.reason).toBe('never-applied')
      // a caller that learns only "stale" has to guess which half to wait for
      expect(verdict.detail).toContain(EXPR)
    }
  })

  it('refuses when one participant is outside the age bound', () => {
    const verdict = admitAcross({
      participants: [
        fresh(LANG, 'sha256:a'),
        { repository: EXPR, state: { serving: 'sha256:b', appliedAt: NOW - 90_000 } },
      ],
      bound: { maxAgeMs: 60_000 },
      now: NOW,
    })

    expect(verdict.ok).toBe(false)

    if (!verdict.ok) {
      expect(verdict.repository).toBe(EXPR)
      expect(verdict.reason).toBe('too-old')
    }
  })

  it('honours a per-repository commit demand', () => {
    const verdict = admitAcross({
      participants: [
        fresh(LANG, 'sha256:a', true),
        fresh(EXPR, 'sha256:b', true),
      ],
      demand: { [LANG]: 'sha256:a1', [EXPR]: 'sha256:b1' },
      now: NOW,
    })

    expect(verdict.ok).toBe(true)
  })

  it('refuses when one repository has not applied the commit demanded of IT', () => {
    // read-your-writes across a mutation that touched both: one landed, one has not
    const verdict = admitAcross({
      participants: [
        fresh(LANG, 'sha256:a', true),
        fresh(EXPR, 'sha256:b', false),
      ],
      demand: { [LANG]: 'sha256:a1', [EXPR]: 'sha256:b1' },
      now: NOW,
    })

    expect(verdict.ok).toBe(false)

    if (!verdict.ok) {
      expect(verdict.repository).toBe(EXPR)
      expect(verdict.reason).toBe('behind-demand')
    }
  })

  it('demands nothing of a repository the caller did not name', () => {
    // a mutation that touched one repository must not make a read of two impossible
    const verdict = admitAcross({
      participants: [fresh(LANG, 'sha256:a', true), fresh(EXPR, 'sha256:b')],
      demand: { [LANG]: 'sha256:a1' },
      now: NOW,
    })

    expect(verdict.ok).toBe(true)
  })

  it('checks health BEFORE the demand, so an outage does not read as a race', () => {
    const verdict = admitAcross({
      participants: [
        { repository: LANG, state: { serving: undefined }, hasCommit: false },
      ],
      demand: { [LANG]: 'sha256:a1' },
      now: NOW,
    })

    // "never applied" rather than "has not applied your commit", which would read as a
    // moment's lag when it is actually a projection that has never run
    expect(verdict.ok).toBe(false)

    if (!verdict.ok) {
      expect(verdict.reason).toBe('never-applied')
    }
  })
})

describe('building a commit set from a mutation', () => {
  it('carries only the repositories that produced a commit', () => {
    expect(
      commitSetOf([
        { repository: LANG, commit: 'sha256:a' },
        { repository: EXPR, commit: undefined },
      ]),
    ).toEqual({ [LANG]: 'sha256:a' })
  })

  it('is empty when nothing committed, rather than a set with holes in it', () => {
    expect(commitSetOf([{ repository: LANG, commit: undefined }])).toEqual({})
  })
})
