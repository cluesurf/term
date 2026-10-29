// The arm-shadow scan (task/arm-shadows.ts) must count an arm's read of a field that hides a local, even when the same
// line also reads the subject's field of that name. call-hierarchy.tree's outgoingCalls compared statement/name with
// name (always true), and the scan passed it: the member `name` before `, name` was taken for a `name` head, so the
// read after it was skipped (term-compiler-0042, cli-in-term traps.md).
// Run from deck/term/deck/term: npx tsx test/check/arm-shadow-reads.ts

import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readsIn, scan } from '../../task/arm-shadows'

let pass = 0
let fail = 0

function ok(name: string, holds: boolean, detail = ''): void {
  if (holds) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}${detail ? `\n        ${detail}` : ''}`)
  }
}

function reads(line: string, name: string): boolean {
  return readsIn([line], 1, 1, name).length > 0
}

// the read rule, line by line
ok(
  'a bare read beside a member read of the same field counts',
  reads('      back is-equal(one/name, name)', 'name'),
)
ok(
  'a bare read as a later argument counts',
  reads('      back f(x, name)', 'name'),
)
ok(
  'a member read alone is no read',
  !reads('      back is-equal(one/name, 1)', 'name'),
)
ok(
  'a binder after its head is no read',
  !reads('    link name, like text', 'name') &&
    !reads('      save x, name span', 'span'),
)
ok(
  'a type after like is no read',
  !reads('      take x, like span', 'span'),
)
ok(
  'a call of a task bearing the name is no read',
  !reads('      back span(1)', 'span'),
)

// the whole scan over the item's fixture: same-name-read's arm reads the hidden name, same-name's never does
const fixture = `form statement
  case call
    link name, like text
    link span, like number
  case other

task same-name
  take one, like statement
  take name, like text
  like boolean

  sift one
    case call
      back is-equal(span, 1)
    case other
      back false
  back false

task same-name-read
  take one, like statement
  take name, like text
  like boolean

  sift one
    case call
      back is-equal(one/name, name)
    case other
      back false
  back false
`
const folder = realpathSync(
  mkdtempSync(join(tmpdir(), 'arm-shadow-reads-')),
)
const file = join(folder, 'fixture.tree')

writeFileSync(file, fixture)

const found = scan(file)

ok('the fixture compiles', !found.failed, found.out.join(' | '))
ok(
  'one arm reads its hidden name',
  found.count.reads === 1,
  found.out.join(' | '),
)
ok(
  "the read arm is same-name-read's (its sift at line 24, read at 26)",
  found.out.some(line =>
    /line 24: "case call" binds "name" as "name".*READS it at line 26/.test(
      line,
    ),
  ),
  found.out.join(' | '),
)
ok(
  "same-name's arm is counted, never read",
  found.count.quiet === 1,
  found.out.join(' | '),
)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
