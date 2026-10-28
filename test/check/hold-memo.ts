// Per-definition holds (note/project/term/incremental-best-in-class.md, step 12). A module edited in one task is checked
// again whole, and its other tasks' proof walks are answered from the memo (check/holds.ts `holdKey`): only a task
// whose walk refused nothing is kept, and its answer is the counts it added. Here a module of tasks that owe tier-0
// obligations (list reads, a division) is compiled, one task is edited, and the build is compiled again with the memo
// and then without it. The two must agree exactly: every diagnostic, every obligation counted and proven.
// Run: npx tsx test/check/hold-memo.ts

import { compile } from '@term/make/code/compile/compile'
import { checkHolds, clearHoldMemo, holdsReplayed } from '@term/make/code/check/holds'
import type { Tally } from '@term/make/code/check/holds'
import type { Program } from '@term/make/code/compile/node'

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

// THE KEY IS NODE-JSON'S TEXT (decision 034 section 1, item 0319): a `need false` field absent and the same field at its
// default are one node, so the walk of a task that differs only so is answered from the memo. Here every task that
// carries no `async` is handed `async: false`, and every member read no `nick` the empty text, as a pass that writes
// the defaults would, and the program's holds are checked again: every walk kept the first time replays, and the
// answer is the same
const program = (first.ok ? first.program : []) as Program
const withDefaults = structuredClone(program)
let written = 0
const writeDefaults = (value: unknown): void => {
  if (Array.isArray(value)) {
    value.forEach(writeDefaults)
    return
  }

  if (value && typeof value === 'object') {
    const node = value as Record<string, unknown>

    if (node.form === 'function' && Array.isArray(node.body) && !('async' in node)) {
      node.async = false
      written++
    }

    if (node.form === 'member' && !('nick' in node)) {
      node.nick = ''
      written++
    }

    Object.values(node).forEach(writeDefaults)
  }
}
writeDefaults(withDefaults)
ok('the copy writes a default the program left out', written > 0, `${written} written`)

const holdsOf = (of: Program): string => {
  const tally: Tally = { total: 0, proven: 0, failed: [] }
  const said = checkHolds(of, 'm.tree', { tally }).map(d => `${d.name} ${d.span.start.line}:${d.span.start.column} ${d.message}`)

  return JSON.stringify({ said: said.sort(), total: tally.total, proven: tally.proven, kinds: tally.kinds })
}

clearHoldMemo()
const plain = holdsOf(program)
const replayedBeforeSame = holdsReplayed.tasks
holdsOf(program)
const replayedSame = holdsReplayed.tasks - replayedBeforeSame
ok('the program checked twice replays its kept walks', replayedSame >= 2, `${replayedSame} replayed`)
const replayedBeforeDefaults = holdsReplayed.tasks
const defaulted = holdsOf(withDefaults)
const replayedDefaults = holdsReplayed.tasks - replayedBeforeDefaults
ok('a task differing only absent against default replays from the memo', replayedDefaults === replayedSame, `${replayedDefaults} replayed, ${replayedSame} as written`)
ok('and answers as the program as written', plain === defaulted, `${plain}\n      ${defaulted}`)

clearHoldMemo()
ok('which is what the provers give afresh', holdsOf(withDefaults) === defaulted)

console.log(`\nhold-memo: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
