// The applier conformance suite, tested against appliers that are deliberately wrong.
//
// A conformance suite that passes everything is worse than none, because it converts "we do
// not know whether this applier is correct" into "we checked". So the load-bearing tests
// here are not that a correct applier passes. They are that each BROKEN one fails, on the
// specific rule it breaks.
//
// The two breakages are the two a real applier ships with, and both are invisible in a
// happy-path test:
//
//   cursor first    a crash between the cursor and the records skips a span permanently
//   append, not upsert   at-least-once delivery then duplicates on the first retry

import { describe, it, expect } from 'vitest'
import { conform, describeReport, uncheckable } from '@term/base/code/project/conform'
import type { Candidate } from '@term/base/code/project/conform'
import type { Sink } from '@term/base/code/project/once'
import { foldChanges } from '@term/base/code/project/once'
import type { RecordNode } from '@term/base/code/base/type'

/** A key-value target with no transactions, which is what mode D assumes. */
class MemorySink implements Sink {
  readonly held = new Map<string, RecordNode>()
  token: string | undefined

  async put(input: { mark: string; record: RecordNode }): Promise<void> {
    this.held.set(input.mark, input.record)
  }

  async drop(mark: string): Promise<void> {
    this.held.delete(mark)
  }

  async cursor(): Promise<string | undefined> {
    return this.token
  }

  async advance(token: string): Promise<void> {
    this.token = token
  }
}

/** The reference applier: rows first, cursor last, upsert by mark. */
const CORRECT: Candidate = {
  name: 'reference applier',
  make: () => new MemorySink(),
}

/**
 * The mistake a careful person makes: record progress first.
 *
 * It reads as the diligent move and it is the only ordering that loses data.
 */
const CURSOR_FIRST: Candidate = {
  name: 'applier that writes the cursor first',
  make: () => new MemorySink(),
  async apply({ sink, changes, token }) {
    await sink.advance(token)

    const { put, drop } = foldChanges(changes)

    for (const [mark, record] of put) {
      await sink.put({ mark, record })
    }

    for (const mark of drop) {
      await sink.drop(mark)
    }
  },
}

/**
 * An applier that treats the feed as an event log rather than a state projection.
 *
 * Appending is the natural reading of "change feed", and it is wrong: applying the same span
 * twice must equal applying it once, or at-least-once delivery corrupts on every retry.
 */
const APPENDING: Candidate = {
  name: 'applier that appends instead of upserting',
  make: () => new MemorySink(),
  async apply({ sink, changes, token }) {
    const { put } = foldChanges(changes)
    let seen = 0

    for (const [mark, record] of put) {
      seen += 1
      // a fresh key per delivery, which is what "append" amounts to under a mark
      await sink.put({ mark: `${mark}#${seen}-${Math.random()}`, record })
    }

    await sink.advance(token)
  },
}

/** An applier that refuses a record carrying a field it does not know. */
const BRITTLE: Candidate = {
  name: 'applier that rejects unknown fields',
  make: () => new MemorySink(),
  async apply({ sink, changes, token }) {
    const { put } = foldChanges(changes)

    for (const [mark, record] of put) {
      for (const field of record.fields.keys()) {
        if (field !== 'text') {
          throw new Error(`unknown field ${field}`)
        }
      }

      await sink.put({ mark, record })
    }

    await sink.advance(token)
  },
}

function failing(report: Awaited<ReturnType<typeof conform>>): string[] {
  return report.checks.filter(check => !check.ok).map(check => check.rule)
}

describe('the conformance suite', () => {
  it('passes a correct applier on every rule', async () => {
    const report = await conform(CORRECT)

    expect(report.ok).toBe(true)
    expect(failing(report)).toEqual([])
  })

  it('CATCHES an applier that writes the cursor before the records', async () => {
    // the whole reason the suite exists. This applier looks fine until a crash, and then
    // silently loses a span forever
    const report = await conform(CURSOR_FIRST)

    expect(report.ok).toBe(false)
    expect(failing(report)).toContain('C2')

    const detail = report.checks.find(check => check.rule === 'C2')?.detail

    expect(detail).toContain('skip')
  })

  it('CATCHES an applier that appends instead of upserting by mark', async () => {
    const report = await conform(APPENDING)

    expect(report.ok).toBe(false)
    expect(failing(report)).toContain('C3')
  })

  it('CATCHES an applier that rejects a field it does not know', async () => {
    const report = await conform(BRITTLE)

    expect(report.ok).toBe(false)
    expect(failing(report)).toContain('C4')

    expect(report.checks.find(check => check.rule === 'C4')?.detail).toContain(
      'unmapped field',
    )
  })

  it('reports every failure at once, rather than stopping at the first', async () => {
    // an applier with two problems should learn about two problems
    const report = await conform(BRITTLE)

    expect(report.checks).toHaveLength(3)
  })

  it('renders a report a person can act on', async () => {
    const text = describeReport(await conform(CURSOR_FIRST))

    expect(text).toContain('DOES NOT CONFORM')
    expect(text).toContain('C2')
    // it says why these matter, because a failing rule with no consequence attached gets
    // read as pedantry and waived
    expect(text).toContain('silently')
  })

  it('renders a passing report without the warning', async () => {
    const text = describeReport(await conform(CORRECT))

    expect(text).toContain('conforms')
    expect(text).not.toContain('DOES NOT')
  })

  it('states what it cannot check, rather than implying full coverage', async () => {
    // a suite that quietly covers three of six obligations, while reading as though it
    // covers all six, is how "we ran the conformance suite" becomes a false claim
    expect(uncheckable.map(one => one.rule.split(',')[0])).toEqual(['C1', 'C5', 'C6'])

    for (const one of uncheckable) {
      expect(one.why.length).toBeGreaterThan(40)
    }
  })
})
