// Per-definition holds (note/term/plan/incremental-best-in-class.md, step 12). A module edited in one task is checked
// again whole, and its other tasks' proof walks are answered from the memo (check/holds.ts `holdKey`): only a task
// whose walk refused nothing is kept, and its answer is the counts it added. Here a module of tasks that owe tier-0
// obligations (list reads, a division) is compiled, one task is edited, and the build is compiled again with the memo
// and then without it. The two must agree exactly: every diagnostic, every obligation counted and proven.
// Run: npx tsx test/check/hold-memo.ts

import { compile } from '@term/make/code/compile/compile'
import { clearHoldMemo, holdsReplayed } from '@term/make/code/check/holds'

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

// tasks that each owe obligations, one with a read the provers cannot prove, so the module has a failure too
const task = (name: string, body: string): string => `task ${name}\n  take xs, like list, like number\n  like number\n${body}\n`
const reads = (at: number): string =>
  `  save total, code ${at}\n  walk size\n    bind base, code 0\n    bind head\n      read xs/length\n    hook next\n      take site, name i\n      save total\n        call add\n          read total\n          read xs/{i}\n  send back, read total`
// a read at an index the task is handed, which may be past the end
const unproven = `task third\n  take xs, like list, like number\n  take n, like number\n  like number\n  save one, read xs/{n}\n  send back, read one\n`
const halve = (k: number): string => `  send back\n    call divide\n      code ${k}\n      code 2`

const moduleText = (k: number): string =>
  [task('sum-all', reads(0)), unproven, task('half', halve(k)), task('sum-again', reads(1))].join('\n')

const build = (text: string) => compile({ file: 'm.tree', text }, { resolve: () => undefined })

const answer = (result: ReturnType<typeof build>): string =>
  JSON.stringify({
    ok: result.ok,
    said: (result.ok ? result.warnings : result.diagnostics).map(d => `${d.name} ${d.span.start.line}:${d.span.start.column} ${d.message}`).sort(),
    owed: result.ok ? result.obligations : undefined,
  })

clearHoldMemo()
const first = build(moduleText(8))
ok('the module builds', first.ok, first.ok ? '' : first.diagnostics.map(d => d.message).join(' | '))
ok('and owes obligations, one of them unproven', first.ok && (first.obligations?.total ?? 0) > 0 && (first.obligations?.proven ?? 0) < (first.obligations?.total ?? 0), JSON.stringify(first.ok ? first.obligations : null))

const replayedBefore = holdsReplayed.tasks
const kept = build(moduleText(10))
const replayed = holdsReplayed.tasks - replayedBefore
ok('an edit to one task replays the walks of the tasks it did not touch', replayed >= 2, `${replayed} replayed`)

clearHoldMemo()
const fresh = build(moduleText(10))
ok('and the build is the build the provers give afresh', answer(kept) === answer(fresh), `${answer(kept)}\n      ${answer(fresh)}`)

console.log(`\nhold-memo: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
