// Mode D: a projection into a store with no transactions.
//
// The interesting test here is not that the correct ordering works. It is that the WRONG
// ordering loses data, demonstrated rather than asserted, because "rows before cursor" reads
// like a style preference until you watch the other order drop a record permanently.
//
// A customer projecting into Redis or a search index has no transaction to hold rows and
// cursor together, so what they get instead is at-least-once delivery over idempotent writes,
// with the cursor trailing the data. That is a real but weaker guarantee, and these lock in
// exactly how much weaker.

import { describe, it, expect } from 'vitest'
import { applyOnce, foldChanges, type Sink } from '@term/base/code/project/once'
import type { Change } from '@term/base/code/diff/change'
import type { RecordNode } from '@term/base/code/base/type'
import { text } from '@term/base/code/base/make'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'

function word(mark: string, value: string): RecordNode {
  return { mark, type: 'word', fields: new Map([['text', text(value)]]) }
}

function add(mark: string, value: string): Change {
  return { type: 'record.add', mark, value: word(mark, value) }
}

/**
 * A key-value target with NO transactions, which is the whole point.
 *
 * `die` makes the next write throw, so a crash can be placed exactly between the record
 * writes and the cursor.
 */
class MemorySink implements Sink {
  readonly held = new Map<string, RecordNode>()
  token: string | undefined
  die = 0
  writes = 0

  private tick(): void {
    this.writes += 1

    if (this.die && this.writes >= this.die) {
      throw new Error('the applier process died')
    }
  }

  async put(input: { mark: string; record: RecordNode }): Promise<void> {
    this.tick()
    this.held.set(input.mark, input.record)
  }

  async drop(mark: string): Promise<void> {
    this.tick()
    this.held.delete(mark)
  }

  async cursor(): Promise<string | undefined> {
    return this.token
  }

  async advance(token: string): Promise<void> {
    this.tick()
    this.token = token
  }
}

function valueOf(sink: MemorySink, mark: string): string | undefined {
  const held = sink.held.get(mark)?.fields.get('text')

  return held?.kind === 'text' ? held.value : undefined
}

describe('folding a span before writing it', () => {
  it('writes a mark once however many times the span touched it', () => {
    const folded = foldChanges([
      add(A, 'one'),
      { type: 'field.set', mark: A, field: 'text', before: text('one'), after: text('two') },
      { type: 'field.set', mark: A, field: 'text', before: text('two'), after: text('three') },
    ])

    expect(folded.put.size).toBe(1)

    const held = folded.put.get(A)?.fields.get('text')

    expect(held?.kind === 'text' && held.value).toBe('three')
  })

  it('lets a later removal win over an earlier add', () => {
    const folded = foldChanges([add(A, 'one'), { type: 'record.remove', mark: A, before: word(A, 'one') }])

    expect(folded.put.size).toBe(0)
    expect(folded.drop.has(A)).toBe(true)
  })

  it('lets a later add win over an earlier removal', () => {
    const folded = foldChanges([
      { type: 'record.remove', mark: A, before: word(A, 'one') },
      add(A, 'again'),
    ])

    expect(folded.drop.has(A)).toBe(false)
    expect(folded.put.has(A)).toBe(true)
  })
})

describe('applying at least once', () => {
  it('writes every record, then the cursor', async () => {
    const sink = new MemorySink()

    const done = await applyOnce({
      changes: [add(A, 'one'), add(B, 'two')],
      token: 'resume/1 x',
      sink,
    })

    expect(done.put).toBe(2)
    expect(sink.token).toBe('resume/1 x')
    expect(valueOf(sink, A)).toBe('one')
  })

  it('is harmless to apply twice, which is what makes at-least-once safe', async () => {
    const sink = new MemorySink()
    const span = { changes: [add(A, 'one'), add(B, 'two')], token: 'resume/1 x', sink }

    await applyOnce(span)
    await applyOnce(span)

    expect(sink.held.size).toBe(2)
    expect(valueOf(sink, A)).toBe('one')
  })

  it('leaves the cursor WHERE IT WAS when a write fails, so the span is re-applied', async () => {
    const sink = new MemorySink()
    sink.token = 'resume/1 before'
    sink.die = 2

    await expect(
      applyOnce({ changes: [add(A, 'one'), add(B, 'two')], token: 'resume/1 after', sink }),
    ).rejects.toThrow(/died/)

    // partially applied, which mode D accepts and mode A does not
    expect(sink.held.size).toBe(1)
    // but the cursor did NOT move, so nothing is lost
    expect(sink.token).toBe('resume/1 before')
  })

  it('converges after a crash, once the retry succeeds', async () => {
    const sink = new MemorySink()
    sink.die = 2

    await expect(
      applyOnce({ changes: [add(A, 'one'), add(B, 'two')], token: 'resume/1 after', sink }),
    ).rejects.toThrow(/died/)

    sink.die = 0

    await applyOnce({ changes: [add(A, 'one'), add(B, 'two')], token: 'resume/1 after', sink })

    expect(sink.held.size).toBe(2)
    expect(sink.token).toBe('resume/1 after')
  })
})

describe('why the cursor goes last', () => {
  it('DEMONSTRATES that cursor-first loses a record permanently', async () => {
    // The rule is not a style preference. This is what the other order does.
    //
    // A careful person writes progress first, because that feels like the diligent move.
    // Here it means the cursor names a span whose records never landed, so the next attempt
    // starts AFTER them and they are gone with no error anywhere.
    const sink = new MemorySink()

    const cursorFirst = async (): Promise<void> => {
      await sink.advance('resume/1 after')
      await sink.put({ mark: A, record: word(A, 'one') })
      await sink.put({ mark: B, record: word(B, 'two') })
    }

    sink.die = 2 // dies after the cursor write, before the records

    await expect(cursorFirst()).rejects.toThrow(/died/)

    // the cursor says this span is done
    expect(sink.token).toBe('resume/1 after')
    // and not one of its records is there. A resume from this cursor never revisits them.
    expect(sink.held.size).toBe(0)
  })

  it('and that rows-first loses nothing in the same crash', async () => {
    const sink = new MemorySink()
    sink.die = 2

    await expect(
      applyOnce({ changes: [add(A, 'one'), add(B, 'two')], token: 'resume/1 after', sink }),
    ).rejects.toThrow(/died/)

    // the cursor still points before the span, so a resume replays it in full
    expect(sink.token).toBeUndefined()
  })
})
