// `term test` TURNS ITS SESSION ONCE A ROUND (decision 097 of term/self-host/change/001-finish-self-host, item
// term-self-host-001-0495). term test builds every test file through the run's one build graph (decision 094 rule 1),
// each file an entry request with its rewritten text. The run turns the session itself once for the round and marks
// the graph turned, so no file's request walks the project or turns the session again: a round of three test files
// takes one turn. The same files then answer as the run reports them, and a second run in the process counts anew.
// Run: npx tsx test/call/test-turns.ts

import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

// a draft's emitted module may stand in for the port before it lands (TEST_COMMAND_MODULE, an absolute path)
const { callTest, readLastTestTurns } = (await import(
  process.env.TEST_COMMAND_MODULE ?? '@term/call/host/port/code/work/testing/test-command'
)) as {
  callTest: (input: Record<string, unknown>) => Promise<void>
  readLastTestTurns: () => { rounds: number; turns: number }
}

const root = realpathSync(mkdtempSync(join(tmpdir(), 'test-turns-')))
process.env.TERM_CACHE_HOME = join(root, '.store')
mkdirSync(join(root, 'code'), { recursive: true })
mkdirSync(join(root, 'test'), { recursive: true })
writeFileSync(join(root, 'deck.tree'), `deck @probe/turns\n  mark <0.0.1>\n`)
writeFileSync(join(root, 'code', 'base.tree'), `task double\n  take n, like number\n  like number\n  send back, multiply(n, 2)\n`)

for (const [name, n] of [['one', 1], ['two', 2], ['three', 3]] as const) {
  writeFileSync(
    join(root, 'test', `${name}.tree`),
    `load ../code/base\n  find double\n\ntest doubles-${name}\n  want hold, is-equal(double(${n}), ${n * 2})\n`,
  )
}

const was = process.exitCode
await callTest({ root, filter: undefined, merged: false, case: undefined, env: undefined, ride: false, update: false })
const first = readLastTestTurns()
ok('the run passed', (process.exitCode ?? 0) === 0, `exit ${process.exitCode}`)
ok('one round', first.rounds === 1, JSON.stringify(first))
ok('one turn of the session for the round of three files', first.turns === 1, JSON.stringify(first))

// a second run in the same process: its own graph, its own count
await callTest({ root, filter: undefined, merged: false, case: undefined, env: undefined, ride: false, update: false })
const second = readLastTestTurns()
ok('a second run counts its own round and turn', second.rounds === 1 && second.turns === 1, JSON.stringify(second))
ok('and passes', (process.exitCode ?? 0) === 0, `exit ${process.exitCode}`)
process.exitCode = was

console.log(`\ntest-turns: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
