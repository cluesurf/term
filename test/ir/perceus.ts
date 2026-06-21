// Perceus / FBIP tests: precise dup/drop insertion from last-use, and in-place reuse. Run: npx tsx test/ir/perceus.ts

import type { Inst } from '@cluesurf/make/code/ir/perceus'
import {
  perceus,
  perceusControl,
  showInst,
} from '@cluesurf/make/code/ir/perceus'

let pass = 0
let fail = 0
function expect(
  name: string,
  got: Array<Inst>,
  want: Array<string>,
): void {
  const g = got.map(showInst)
  if (JSON.stringify(g) === JSON.stringify(want)) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(
      `FAIL  ${name}\n      got:  ${JSON.stringify(
        g,
      )}\n      want: ${JSON.stringify(want)}`,
    )
  }
}

const make = (
  ctor: string,
  ...args: Array<string>
): Inst['value' & keyof Inst] => ({ kind: 'make', ctor, args }) as never

function main(): void {
  // a value used exactly once is consumed at its last use: no dup
  expect(
    'used once: no dup',
    perceus(
      ['x'],
      [
        {
          op: 'let',
          name: 'a',
          value: { kind: 'make', ctor: 'box', args: ['x'] },
        },
        { op: 'return', name: 'a' },
      ],
    ),
    ['let a = make box(x)', 'return a'],
  )

  // a value used twice gets a dup at the earlier (non-last) use (q is kept live by combine, so no spurious drop)
  expect(
    'used twice: dup at first use',
    perceus(
      ['p'],
      [
        {
          op: 'let',
          name: 'q',
          value: { kind: 'call', fn: 'use', args: ['p'] },
        },
        {
          op: 'let',
          name: 'r',
          value: { kind: 'call', fn: 'combine', args: ['q', 'p'] },
        },
        { op: 'return', name: 'r' },
      ],
    ),
    ['dup p', 'let q = use(p)', 'let r = combine(q, p)', 'return r'],
  )

  // an unused binding is dropped right after it is created (different arity from the next make, so no reuse)
  expect(
    'dead binding: dropped',
    perceus(
      ['x', 'y', 'z'],
      [
        {
          op: 'let',
          name: 'a',
          value: { kind: 'make', ctor: 'box', args: ['x'] },
        },
        {
          op: 'let',
          name: 'b',
          value: { kind: 'make', ctor: 'pair', args: ['y', 'z'] },
        },
        { op: 'return', name: 'b' },
      ],
    ),
    [
      'let a = make box(x)',
      'drop a',
      'let b = make pair(y, z)',
      'return b',
    ],
  )

  // an unused parameter is dropped at entry
  expect(
    'unused param: dropped at entry',
    perceus(['used', 'unused'], [{ op: 'return', name: 'used' }]),
    ['drop unused', 'return used'],
  )

  // FBIP: freeing a record right before building one of the same arity reuses the cell (the classic map case)
  expect(
    'FBIP reuse: same-arity make reuses dropped cell',
    perceus(
      ['list', 'head'],
      [
        {
          op: 'let',
          name: 'pair',
          value: { kind: 'make', ctor: 'cons', args: ['list', 'head'] },
        },
        // `pair` is never used -> dropped; the next make of arity 2 reuses it
        {
          op: 'let',
          name: 'next',
          value: { kind: 'make', ctor: 'cons', args: ['list', 'head'] },
        },
        { op: 'return', name: 'next' },
      ],
    ),
    // pair is dead -> drop pair, then next (arity 2) reuses pair's cell. `list`/`head` used twice -> dup'd.
    [
      'dup list',
      'dup head',
      'let pair = make cons(list, head)',
      'let next = make cons(list, head) reuse pair',
      'return next',
    ],
  )

  void make
  // control flow: a value consumed in one branch must be dropped in the other (balanced ownership)
  expect(
    'if: balanced drop in the non-consuming branch',
    perceusControl(
      ['x'],
      [
        {
          op: 'if',
          cond: 'c',
          then: [{ op: 'return', name: 'x' }],
          else: [
            { op: 'let', name: 'z', value: { kind: 'lit' } },
            { op: 'return', name: 'z' },
          ],
        },
      ],
    ),
    ['if c { return x } else { drop x; let z = lit; return z }'],
  )

  // control flow: a value consumed on both branches needs no extra drop
  expect(
    'if: consumed on both branches, no extra drop',
    perceusControl(
      ['x'],
      [
        {
          op: 'if',
          cond: 'c',
          then: [{ op: 'return', name: 'x' }],
          else: [{ op: 'return', name: 'x' }],
        },
      ],
    ),
    ['if c { return x } else { return x }'],
  )

  console.log(`\nperceus: ${pass} pass, ${fail} fail`)
}

main()
