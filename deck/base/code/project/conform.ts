// The applier conformance suite.
//
// base's own tests prove THIS implementation agrees with itself. They prove nothing about
// somebody's Redis applier, or their Go service, or the thing they wrote over a weekend
// against a REST feed. And the applier is not ours to constrain, so what we owe a third
// party is not a library but a way to find out whether theirs is correct.
//
// Run this against your applier before you trust it with data.
//
// The two obligations people get wrong are C2 and C3, and both fail SILENTLY:
//
//   C2  writing the cursor before the records. A crash between them skips a span
//       permanently, and nothing anywhere reports it
//   C3  a write that is not idempotent by mark. At-least-once delivery then duplicates or
//       corrupts on every retry, and retries are ordinary rather than exceptional
//
// Neither shows up in a happy-path test, which is exactly why a suite is worth more here
// than documentation.
//
// WHAT THIS SUITE CANNOT CHECK is stated as plainly as what it can. See `uncheckable` below.
//
// See note/library/base/design/projection-sync-protocol.md §1b.

import type { Change } from '@term/base/code/diff/change'
import type { RecordNode, Value } from '@term/base/code/base/type'
import type { Sink } from '@term/base/code/project/once'
import { applyOnce } from '@term/base/code/project/once'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'

const TOKEN_ONE = 'resume/1 r sha256:one base/1 -'
const TOKEN_TWO = 'resume/1 r sha256:two base/1 -'

function text(value: string): Value {
  return { kind: 'text', value }
}

function word(mark: string, value: string): RecordNode {
  return { mark, type: 'word', fields: new Map([['text', text(value)]]) }
}

function add(mark: string, value: string): Change {
  return { type: 'record.add', mark, value: word(mark, value) }
}

/**
 * What a candidate applier must supply to be tested.
 *
 * A factory rather than an instance, because several checks need a FRESH target: an
 * idempotence check that inherited state from an ordering check would pass or fail for the
 * wrong reason.
 */
export type Candidate = {
  name: string
  /** A new, empty target. */
  make(): Promise<Sink> | Sink
  /**
   * Apply a span. A candidate that uses `applyOnce` can leave this out and get the
   * reference behaviour; one with its own applier supplies it, which is the point.
   */
  apply?(input: { sink: Sink; changes: Change[]; token: string }): Promise<void>
}

export type Check = {
  rule: 'C2' | 'C3' | 'C4'
  what: string
  ok: boolean
  detail?: string
}

export type Report = {
  candidate: string
  checks: Check[]
  ok: boolean
}

/** Obligations this suite deliberately does not claim to verify. */
export const uncheckable: Array<{ rule: string; why: string }> = [
  {
    rule: 'C1, treat the token as opaque',
    why: 'An applier that parses the token behaves identically until the token gains a field, which is precisely when the damage happens and precisely what cannot be simulated here. Reviewed, not tested.',
  },
  {
    rule: 'C5, declare dependencies and pin',
    why: 'What an applier depends on is a claim about its own consumers, which this suite cannot know. The mechanism is tested in base; whether a candidate declares honestly is not checkable from outside.',
  },
  {
    rule: 'C6, never write back',
    why: 'Absence of a behaviour. A candidate that writes to base on a schedule, or only on conflict, would pass any finite observation here.',
  },
]

async function run(
  candidate: Candidate,
  changes: Change[],
  token: string,
  sink: Sink,
): Promise<void> {
  if (candidate.apply) {
    await candidate.apply({ sink, changes, token })

    return
  }

  await applyOnce({ sink, changes, token })
}

/**
 * C3: applying the same span twice must equal applying it once.
 *
 * A projection is a STATE projection, not an event log. Upsert by mark, never append. This
 * is what makes at-least-once delivery safe, and an applier that appends passes every
 * first-delivery test and corrupts on the first retry.
 */
async function checkIdempotent(candidate: Candidate): Promise<Check> {
  const sink = await candidate.make()
  const changes = [add(A, 'one'), add(B, 'two')]

  await run(candidate, changes, TOKEN_ONE, sink)
  const first = await sink.cursor()

  await run(candidate, changes, TOKEN_ONE, sink)

  const value = await readBack(sink, A)

  return {
    rule: 'C3',
    what: 'applying a span twice equals applying it once',
    ok: value === 'one' && first === (await sink.cursor()),
    ...(value === 'one'
      ? {}
      : { detail: `record ${A} read back as ${String(value)} after a second apply` }),
  }
}

/**
 * C2: every record write lands before the cursor moves.
 *
 * Probed by failing a write partway and asking where the cursor is. If it moved, the
 * candidate has already told us a span is done whose records are not there, and a resume
 * from it never revisits them.
 */
async function checkOrdering(candidate: Candidate): Promise<Check> {
  const sink = await candidate.make()
  const before = await sink.cursor()
  const failing = failAfter(sink, 1)

  try {
    await run(candidate, [add(A, 'one'), add(B, 'two')], TOKEN_TWO, failing)
  } catch {
    // expected: the point is where the cursor ended up, not that it threw
  }

  const after = await sink.cursor()

  return {
    rule: 'C2',
    what: 'a failed span leaves the cursor where it was',
    ok: after === before,
    ...(after === before
      ? {}
      : {
          detail: `cursor moved to ${String(after)} while records were still unwritten, so a resume would skip them`,
        }),
  }
}

/**
 * C4: a field the applier does not map is dropped, not fatal.
 *
 * A form gaining a field must not break an older applier. Dropping an unmapped field is
 * correct rather than lossy, because base remains the place nothing is lost.
 */
async function checkUnknownFields(candidate: Candidate): Promise<Check> {
  const sink = await candidate.make()
  const record: RecordNode = {
    mark: A,
    type: 'word',
    fields: new Map([
      ['text', text('one')],
      ['a-field-this-applier-has-never-heard-of', text('surprise')],
    ]),
  }

  try {
    await run(candidate, [{ type: 'record.add', mark: A, value: record }], TOKEN_ONE, sink)
  } catch (error) {
    return {
      rule: 'C4',
      what: 'an unknown field is ignored rather than fatal',
      ok: false,
      detail: `threw on an unmapped field: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  const value = await readBack(sink, A)

  return {
    rule: 'C4',
    what: 'an unknown field is ignored rather than fatal',
    ok: value === 'one',
    ...(value === 'one'
      ? {}
      : { detail: `the known field did not survive alongside the unknown one` }),
  }
}

/** Read one record's `text` back, for candidates whose sink exposes nothing else. */
async function readBack(sink: Sink, mark: string): Promise<string | undefined> {
  const held = (sink as Sink & { held?: Map<string, RecordNode> }).held

  if (!held) {
    return undefined
  }

  const value = held.get(mark)?.fields.get('text')

  return value?.kind === 'text' ? value.value : undefined
}

/** Wrap a sink so its Nth write throws, without the candidate knowing. */
function failAfter(sink: Sink, writes: number): Sink {
  let seen = 0

  const tick = (): void => {
    seen += 1

    if (seen > writes) {
      throw new Error('the applier process died')
    }
  }

  return {
    async put(input) {
      tick()

      return sink.put(input)
    },
    async drop(mark) {
      tick()

      return sink.drop(mark)
    },
    cursor: () => sink.cursor(),
    async advance(token) {
      tick()

      return sink.advance(token)
    },
  }
}

/**
 * Run every mechanical check against a candidate applier.
 *
 * Returns a report rather than throwing, so a caller can print all the failures at once. An
 * applier with two problems should learn about two problems.
 */
export async function conform(candidate: Candidate): Promise<Report> {
  const checks = [
    await checkOrdering(candidate),
    await checkIdempotent(candidate),
    await checkUnknownFields(candidate),
  ]

  return {
    candidate: candidate.name,
    checks,
    ok: checks.every(check => check.ok),
  }
}

/** The report as lines, for a command line. */
export function describeReport(report: Report): string {
  const out = [`${report.candidate}: ${report.ok ? 'conforms' : 'DOES NOT CONFORM'}`]

  for (const check of report.checks) {
    out.push(`  ${check.ok ? 'ok  ' : 'FAIL'} ${check.rule} ${check.what}`)

    if (check.detail) {
      out.push(`       ${check.detail}`)
    }
  }

  if (!report.ok) {
    out.push('')
    out.push('  These fail silently in production. C2 skips a span permanently on a crash,')
    out.push('  and C3 corrupts on the first retry, and retries are ordinary.')
  }

  return out.join('\n')
}
