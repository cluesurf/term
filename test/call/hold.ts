// `term hold`, the gate: a project holds when every file compiles, no claim is open, and every tier-0 obligation is
// proven or named in hold.json. Run: npx tsx test/call/hold.ts
//
// Each refusal sits beside the project that holds, so a gate that refused everything would fail here.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { holdProject } from '@term/call/code/hold'
import { findTreeFiles } from '@term/call/code/make'

let pass = 0
let fail = 0

function ok(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  ${info}`)
  }
}

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'term-hold-'))

  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(root, 'code'), { recursive: true })
    writeFileSync(join(root, 'code', name), text)
  }

  return root
}

function hold(root: string) {
  return holdProject(root, findTreeFiles(root, [], 'node'))
}

const GUARDED = `task first
  take items, like list, like number
  like number
  fork test
    hook test
      call is-above
        read items/length
        code 0
    hook hold
      send back, read items/0
  send back, code 0
`

// two statements, so it is not an accessor: an accessor's read is lifted to its callers, and with none it would owe
// nothing here
const UNGUARDED = `task first
  take items, like list, like number
  like number
  save head, read items/0
  send back, read head
`

const OPEN = `rule someday
  note open
  take x, like number
  like number
`

const roots: string[] = []

// 1. a project whose every obligation is proven holds
{
  const root = project({ 'first.tree': GUARDED })
  roots.push(root)
  const summary = hold(root)
  ok(
    'a proven project holds',
    summary.failed.length === 0 &&
      summary.open.length === 0 &&
      summary.fresh.length === 0 &&
      summary.total === 1 &&
      summary.proven === 1,
    JSON.stringify({ ...summary, ledger: undefined, kernel: undefined }),
  )
}

// 2. an open claim does not hold, though it compiles
{
  const root = project({ 'first.tree': GUARDED, 'someday.tree': OPEN })
  roots.push(root)
  const summary = hold(root)
  ok(
    'an open claim does not hold',
    summary.failed.length === 0 && summary.open.includes('someday'),
    JSON.stringify(summary.open),
  )
}

// 3. an unproven obligation outside the baseline does not hold, and one the baseline names does
{
  const root = project({ 'first.tree': UNGUARDED })
  roots.push(root)
  const before = hold(root)
  ok(
    'an unproven obligation not in the baseline does not hold',
    before.fresh.length === 1 && before.proven === 0,
    JSON.stringify(before.fresh.map(f => f.key)),
  )

  writeFileSync(
    join(root, 'hold.json'),
    JSON.stringify({ obligations: before.fresh.map(f => f.key) }),
  )

  const after = hold(root)
  ok(
    'the same obligation named in hold.json holds',
    after.fresh.length === 0 && after.baselined === 1,
    JSON.stringify({ fresh: after.fresh.map(f => f.key), baselined: after.baselined }),
  )

  // the key names the file, the task and the kind, never a line, so an edit above the task does not churn it
  ok(
    'a baseline key carries no line number',
    before.fresh.every(f => f.key === 'code/first.tree first index 0'),
    JSON.stringify(before.fresh.map(f => f.key)),
  )

  // proving it makes the baseline entry stale, which is reported so the baseline can shrink
  writeFileSync(join(root, 'code', 'first.tree'), GUARDED)
  const proven = hold(root)
  ok(
    'a baselined obligation that is now proven is reported as gone',
    proven.gone.length === 1 && proven.fresh.length === 0,
    JSON.stringify(proven.gone),
  )
}

// 4. a file that does not compile (here, a contract that is false) does not hold
{
  const root = project({
    'same.tree': `task same
  take n, like natural-number
  like number
  must
    call is-above
      read back
      read n
  send back, read n
`,
  })
  roots.push(root)
  const summary = hold(root)
  ok(
    'a false contract does not hold',
    summary.failed.length === 1,
    JSON.stringify(summary.failed),
  )
}

// a `mark roam` task that reaches no native code is counted once, as roaming. It was counted impure as well (guides:
// proofs/contracts, 2026-10-05)
{
  const root = project({
    'spin.tree': `task spin
  mark roam
  take n, like number
  like number
  save total, read n
  walk test
    hook test
      true
    hook hold
      save total
        call add
          read total
          code 1
  send back, read total
`,
  })
  roots.push(root)
  const summary = hold(root)
  ok(
    'a `mark roam` task is counted as roaming and not as impure',
    summary.ledger.roaming.length === 1 && summary.ledger.native.length === 0,
    JSON.stringify(summary.ledger),
  )
}

for (const root of roots) {
  rmSync(root, { recursive: true, force: true })
}

console.log(`\nhold: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
