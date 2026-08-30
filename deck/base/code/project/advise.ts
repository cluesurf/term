// What a remote projection tells us about itself, and why none of it is load bearing.
//
// In modes C and D the applier runs on somebody else's infrastructure, so their projection's
// state is invisible to us. A status page cannot say "your projection is three commits
// behind" without them telling us. So they tell us.
//
// THAT REPORT IS TELEMETRY. If it is lost, delayed, duplicated, or never sent, NOTHING IS
// WRONG WITH THEIR DATA. They simply look unknown on a dashboard. The applier's own durable
// state remains the only answer to "where did you get to", and the resume token they hand
// back on their next request remains the only input to the feed.
//
// Keeping that separation explicit is the entire point of this file, because the pressure to
// break it is real and reasonable-sounding. Somebody will want the status page to be
// accurate, and the shortest path to that is for the server to remember the last report and
// serve the feed from it. That single step would:
//
//   put O(consumers) of mutable state back on the server, which rots when a consumer
//   disappears and is the part of every feed system that needs its own repair tooling
//
//   make a LOST REPORT into data loss, since a consumer whose report went missing would be
//   fed from a cursor behind where it actually is, or ahead of it
//
//   turn the advisory report into the delivery handshake that §1 of the protocol exists to
//   avoid
//
// So the separation is enforced by TYPE rather than by this comment. An `Advisory` carries no
// field a feed request accepts, and `resumeFrom` does not exist. A caller that wants to
// resume needs the applier's token, and there is no way to get one from here.
//
// See note/library/base/design/projection-sync-protocol.md §1a.

/**
 * What a remote projector volunteers about itself.
 *
 * Deliberately NOT a resume token, and deliberately not convertible into one. The fields are
 * chosen so a status page can be drawn and nothing else can be done.
 */
export type Advisory = {
  repository: string
  // the commit the remote projection says it has applied through. A DISPLAY value: nothing
  // reads it to compute a feed, and it is not checked against anything
  watermark: string
  // when the remote applier applied it, by ITS clock
  appliedAt: number
  // when it told us, by OURS. Both, because they answer different questions: a report that
  // arrived late and a projection that fell behind look identical with only one of them
  reportedAt: number
}

/**
 * How a remote projection looks on a status page.
 *
 * `unknown` is a first-class outcome rather than an error or a zero. A consumer that has
 * never reported, or whose reports stopped, is UNKNOWN, and saying so is the honest answer.
 * Rendering it as "0 behind" would invent good news, and rendering it as an outage would
 * invent bad news, and both are claims we cannot support.
 */
export type Standing =
  | { known: false; reason: 'never-reported' | 'reports-stopped' }
  | { known: true; watermark: string; behindMs: number; reportAgeMs: number }

// How long a silent consumer stays "current" before it becomes "unknown". Generous, because
// a missed report is ordinary and the cost of being wrong here is a misleading dashboard
// rather than anything touching data.
const SILENCE_MS = 15 * 60 * 1000

/**
 * Read a report for display.
 *
 * Reports nothing about correctness and cannot be used to decide anything. A caller that
 * wants to know whether a projection is safe to READ uses the lag contract against that
 * projection, which is local to it.
 */
export function standingOf(input: {
  advisory: Advisory | undefined
  now: number
  silenceMs?: number
}): Standing {
  const silence = input.silenceMs ?? SILENCE_MS

  if (!input.advisory) {
    return { known: false, reason: 'never-reported' }
  }

  const reportAgeMs = input.now - input.advisory.reportedAt

  if (reportAgeMs > silence) {
    // The consumer may be perfectly current and simply not talking to us. That is why this
    // says reports stopped rather than "behind": we know about the reports, not the data.
    return { known: false, reason: 'reports-stopped' }
  }

  return {
    known: true,
    watermark: input.advisory.watermark,
    behindMs: Math.max(0, input.advisory.reportedAt - input.advisory.appliedAt),
    reportAgeMs,
  }
}

/**
 * Keep the most recent report per repository, in memory.
 *
 * IN MEMORY ON PURPOSE. Persisting it would make it look like state worth trusting, and the
 * next reader would reasonably wonder why the feed does not consult it. Losing every report
 * on a restart costs one silence window of "unknown" on a dashboard and costs nothing else,
 * which is exactly the weight this data should carry.
 *
 * A later report always wins. Reports can arrive out of order, and comparing watermarks to
 * decide would mean ordering commits from a repository we are not reading, which is the kind
 * of reasoning that turns telemetry into a cursor.
 */
export class AdvisoryBoard {
  private readonly held = new Map<string, Advisory>()

  record(advisory: Advisory): void {
    const held = this.held.get(advisory.repository)

    if (held && held.reportedAt > advisory.reportedAt) {
      return
    }

    this.held.set(advisory.repository, advisory)
  }

  standing(repository: string, now: number): Standing {
    return standingOf({ advisory: this.held.get(repository), now })
  }

  /** Every repository that has ever reported. For drawing a board, nothing else. */
  reported(): string[] {
    return [...this.held.keys()].sort()
  }

  forget(repository: string): void {
    this.held.delete(repository)
  }
}
