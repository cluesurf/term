// The resume token.
//
// Base keeps no per-consumer state, so this string is the whole interface between a server
// that has forgotten you and an applier that knows where it got to. Everything it fails to
// carry becomes a silent wrong answer somewhere, and nothing can be added to it later
// without breaking tokens people already hold.
//
// The case that matters most is `wrong-repository`. A commit hash from another repository is
// a perfectly VALID hash here, so without that field a misrouted token resolves to unrelated
// history rather than failing, and a customer is served somebody else's data.

import { describe, it, expect } from 'vitest'
import { encodeResume, decodeResume } from '@term/base/code/project/resume'
import type { Resume } from '@term/base/code/project/resume'
import { FORMAT_VERSION, READABLE_FORMATS } from '@term/base/code/canon/format'

const REPOSITORY = '0195f0e6-0000-7bd3-9f2e-00000000000a'
const OTHER = '0195f0e6-0000-7bd3-9f2e-00000000000b'
const COMMIT = 'sha256:aaaabbbbccccdddd'
const MAPPING = 'sha256:1111222233334444'

const CURSOR: Resume = {
  repository: REPOSITORY,
  commit: COMMIT,
  canonical: FORMAT_VERSION,
  mapping: MAPPING,
}

function check(token: string, over: Partial<Parameters<typeof decodeResume>[0]> = {}) {
  return decodeResume({
    token,
    repository: REPOSITORY,
    readable: READABLE_FORMATS,
    ...over,
  })
}

describe('the resume token', () => {
  it('round trips', () => {
    const verdict = check(encodeResume(CURSOR))

    expect(verdict).toEqual({ ok: true, resume: CURSOR })
  })

  it('round trips without a mapping, for a consumer that has no schema', () => {
    // a search index or a file dump projects into nothing with a shape, so it has no
    // mapping version to carry and must not be forced to invent one
    const cursor: Resume = {
      repository: REPOSITORY,
      commit: COMMIT,
      canonical: FORMAT_VERSION,
    }

    expect(check(encodeResume(cursor))).toEqual({ ok: true, resume: cursor })
  })

  it('refuses a token from another repository', () => {
    // THE case this field exists for. That hash is valid here, so without the check it
    // would resolve to unrelated history rather than fail.
    const verdict = check(encodeResume({ ...CURSOR, repository: OTHER }))

    expect(verdict.ok).toBe(false)

    if (!verdict.ok) {
      expect(verdict.problem).toBe('wrong-repository')
      expect(verdict.detail).toContain(OTHER)
    }
  })

  it('refuses a canonical form it cannot read', () => {
    const verdict = check(encodeResume({ ...CURSOR, canonical: 'base/99' }))

    expect(verdict.ok).toBe(false)

    if (!verdict.ok) {
      expect(verdict.problem).toBe('unreadable-canonical-form')
    }
  })

  it('refuses a token written through a stale mapping', () => {
    // resuming from it would leave every row written since missing whatever the new
    // mapping adds, permanently and invisibly
    const verdict = check(encodeResume(CURSOR), { mapping: 'sha256:9999' })

    expect(verdict.ok).toBe(false)

    if (!verdict.ok) {
      expect(verdict.problem).toBe('stale-mapping')
      expect(verdict.detail).toContain(MAPPING)
    }
  })

  it('accepts a token whose mapping matches', () => {
    expect(check(encodeResume(CURSOR), { mapping: MAPPING }).ok).toBe(true)
  })

  it('does not demand a mapping from a consumer that never had one', () => {
    const cursor: Resume = {
      repository: REPOSITORY,
      commit: COMMIT,
      canonical: FORMAT_VERSION,
    }

    expect(check(encodeResume(cursor), { mapping: MAPPING }).ok).toBe(true)
  })

  it('refuses a token from a newer applier rather than guessing at it', () => {
    const verdict = check(
      encodeResume(CURSOR).replace('resume/1', 'resume/2'),
    )

    expect(verdict.ok).toBe(false)

    if (!verdict.ok) {
      expect(verdict.problem).toBe('unknown-token-version')
    }
  })

  it('refuses something that is not a token at all', () => {
    expect(check('sha256:aaaa').ok).toBe(false)
    expect(check('').ok).toBe(false)
    expect(check('resume/1 a b').ok).toBe(false)
  })

  it('names a different problem for each failure, so an applier knows what to do', () => {
    // "your token is invalid" leaves an applier with nothing to do. Each of these implies a
    // different action: re-register, upgrade, rebuild, bootstrap.
    const problems = [
      check(encodeResume({ ...CURSOR, repository: OTHER })),
      check(encodeResume({ ...CURSOR, canonical: 'base/99' })),
      check(encodeResume(CURSOR), { mapping: 'sha256:9999' }),
      check('nonsense'),
    ].map(verdict => (verdict.ok ? 'ok' : verdict.problem))

    expect(new Set(problems).size).toBe(4)
  })

  it('carries no base64 and no raw digest of its own', () => {
    // it stays readable in a log line, and it never invents a second addressing scheme
    // beside the one base already uses
    const token = encodeResume(CURSOR)

    expect(token).toContain('sha256:')
    expect(token).toContain(REPOSITORY)
    expect(token.startsWith('resume/1 ')).toBe(true)
  })
})
