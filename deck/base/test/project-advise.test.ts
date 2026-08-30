// The advisory watermark report.
//
// The tests that matter here are not that a report renders. They are that losing one costs
// NOTHING but a dashboard, and that a report cannot be mistaken for a cursor. The pressure to
// break that separation is real and reasonable-sounding: somebody wants the status page to be
// accurate, and the shortest path is for the server to serve the feed from the last report.
// That step turns telemetry into the delivery handshake the protocol exists to avoid, and
// makes a lost report into data loss.
//
// So `unknown` is asserted as a first-class outcome, and a report is asserted to be unusable
// as a resume token.

import { describe, it, expect } from 'vitest'
import {
  AdvisoryBoard,
  standingOf,
  type Advisory,
} from '@term/base/code/project/advise'
import { decodeResume } from '@term/base/code/project/resume'
import { READABLE_FORMATS } from '@term/base/code/canon/format'

const REPOSITORY = '0195f0e6-0000-7bd3-9f2e-00000000000a'
const NOW = 1_000_000_000

function report(over: Partial<Advisory> = {}): Advisory {
  return {
    repository: REPOSITORY,
    watermark: 'sha256:aaaa',
    appliedAt: NOW - 2_000,
    reportedAt: NOW - 1_000,
    ...over,
  }
}

describe('reading a remote projection for display', () => {
  it('reports a recent watermark with how stale it was when sent', () => {
    const standing = standingOf({ advisory: report(), now: NOW })

    expect(standing).toEqual({
      known: true,
      watermark: 'sha256:aaaa',
      behindMs: 1_000,
      reportAgeMs: 1_000,
    })
  })

  it('keeps the two ages apart, because they answer different questions', () => {
    // a report that arrived late and a projection that fell behind look identical with only
    // one of them
    const standing = standingOf({
      advisory: report({ appliedAt: NOW - 60_000, reportedAt: NOW - 1_000 }),
      now: NOW,
    })

    expect(standing.known && standing.behindMs).toBe(59_000)
    expect(standing.known && standing.reportAgeMs).toBe(1_000)
  })

  it('says UNKNOWN when nothing has ever been reported', () => {
    // not an error, and not zero. Rendering it as "0 behind" would invent good news
    const standing = standingOf({ advisory: undefined, now: NOW })

    expect(standing).toEqual({ known: false, reason: 'never-reported' })
  })

  it('says reports STOPPED rather than "behind" when a consumer goes quiet', () => {
    // the consumer may be perfectly current and simply not talking to us. We know about the
    // reports, not the data, and the wording has to keep that straight
    const standing = standingOf({
      advisory: report({ reportedAt: NOW - 60 * 60 * 1000 }),
      now: NOW,
    })

    expect(standing).toEqual({ known: false, reason: 'reports-stopped' })
  })

  it('never reports a negative lag, whatever the remote clock says', () => {
    // the remote applies by its clock and reports by ours, so they can disagree. A negative
    // number on a dashboard reads as a bug in us
    const standing = standingOf({
      advisory: report({ appliedAt: NOW + 5_000, reportedAt: NOW - 1_000 }),
      now: NOW,
    })

    expect(standing.known && standing.behindMs).toBe(0)
  })
})

describe('the board', () => {
  it('keeps the latest report per repository', () => {
    const board = new AdvisoryBoard()

    board.record(report({ watermark: 'sha256:old', reportedAt: NOW - 5_000 }))
    board.record(report({ watermark: 'sha256:new', reportedAt: NOW - 1_000 }))

    const standing = board.standing(REPOSITORY, NOW)

    expect(standing.known && standing.watermark).toBe('sha256:new')
  })

  it('ignores a report that arrives out of order', () => {
    // ordering by REPORT TIME rather than by watermark. Comparing watermarks would mean
    // ordering commits from a repository we are not reading, which is the kind of reasoning
    // that turns telemetry into a cursor
    const board = new AdvisoryBoard()

    board.record(report({ watermark: 'sha256:new', reportedAt: NOW - 1_000 }))
    board.record(report({ watermark: 'sha256:old', reportedAt: NOW - 5_000 }))

    const standing = board.standing(REPOSITORY, NOW)

    expect(standing.known && standing.watermark).toBe('sha256:new')
  })

  it('reports UNKNOWN for a repository it has never heard from', () => {
    const board = new AdvisoryBoard()

    expect(board.standing('nobody', NOW)).toEqual({
      known: false,
      reason: 'never-reported',
    })
  })

  it('loses everything on a restart, which costs a dashboard and nothing else', () => {
    // in memory ON PURPOSE. Persisting it would make it look like state worth trusting, and
    // the next reader would reasonably wonder why the feed does not consult it
    const board = new AdvisoryBoard()
    board.record(report())

    expect(board.reported()).toEqual([REPOSITORY])

    const afterRestart = new AdvisoryBoard()

    expect(afterRestart.reported()).toEqual([])
    expect(afterRestart.standing(REPOSITORY, NOW).known).toBe(false)
  })
})

describe('a report is not a cursor', () => {
  it('carries no field a feed request accepts', () => {
    // the separation is enforced by shape rather than by a comment. There is no `token`, and
    // no way to build one from what a report carries
    const keys = Object.keys(report()).sort()

    expect(keys).toEqual(['appliedAt', 'reportedAt', 'repository', 'watermark'])
    expect(keys).not.toContain('token')
  })

  it('cannot be handed to the feed as a resume token', () => {
    // the watermark is a bare commit hash, which decodeResume refuses. Somebody reaching for
    // the shortcut gets a refusal rather than a plausible-looking resume from stale telemetry
    const verdict = decodeResume({
      token: report().watermark,
      repository: REPOSITORY,
      readable: READABLE_FORMATS,
    })

    expect(verdict.ok).toBe(false)

    if (!verdict.ok) {
      expect(verdict.problem).toBe('malformed')
    }
  })
})
