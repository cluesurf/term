import { describe, it, expect } from 'vitest'
import type { RecordNode } from '@term/base/code/base/type'
import { record, text, integer, list, set, item } from '@term/base/code/base/make'
import { canonicalizeRecord } from '@term/base/code/canon/canonicalize'
import { formatTree } from '@term/base/code/tree/format'
import { parseTree } from '@term/base/code/tree/parse'

const M1 = '11111111-1111-4111-8111-111111111111'

// Every string must survive parse(format(x)) === x, including the ones that used
// to re-parse as a different type or get their content stripped. These are the
// exact corruption cases that mattered for word.surf guide bodies.
function roundTrips(node: RecordNode): void {
  const printed = formatTree(node)
  const back = parseTree(printed)
  expect(canonicalizeRecord(back)).toBe(canonicalizeRecord(node))
}

describe('tree round-trip of adversarial text', () => {
  it('a text value beginning with a reserved @tag stays text', () => {
    for (const s of ['@integer 5', '@list', '@record foo', '@null', '@ref x', '@map', '@text already']) {
      roundTrips(record({ type: 'word', mark: M1, fields: { body: text(s) } }))
    }
  })

  it('a text value of exactly "|" stays text', () => {
    roundTrips(record({ type: 'word', mark: M1, fields: { body: text('|') } }))
  })

  it('a multi-line body keeps # heading lines and blank lines', () => {
    const body = 'intro paragraph\n\n# Heading\n\nbody paragraph\n## Sub'
    roundTrips(record({ type: 'guide', mark: M1, fields: { body: text(body) } }))
  })

  it('a multi-line body keeps interior indentation (code blocks)', () => {
    const body = 'func()\n    return 1\n    if x:\n        y'
    roundTrips(record({ type: 'guide', mark: M1, fields: { body: text(body) } }))
  })

  it('a collection item scalar keeps embedded " ^", ": ", and "|"', () => {
    roundTrips(
      record({
        type: 'word',
        mark: M1,
        fields: {
          notes: list([
            item(text('look ^up')),
            item(text('ratio: 3')),
            item(text('|')),
            item(text('@integer 9')),
          ]),
        },
      }),
    )
  })

  it('a marked item with ordinary text still round-trips with its mark', () => {
    roundTrips(
      record({
        type: 'word',
        mark: M1,
        fields: {
          members: set([item(text('plain'), M1)]),
        },
      }),
    )
  })
})

describe('tree parser robustness', () => {
  it('rejects pathologically deep input instead of crashing', () => {
    // 5000 levels of nested @record via indentation
    const lines = ['root']
    for (let i = 1; i <= 5000; i++) {
      lines.push('  '.repeat(i) + 'child @record node')
    }
    expect(() => parseTree(lines.join('\n'))).toThrow(/too deep/)
  })
})
