// SAMPLED TESTS (decisions-2026-10.md, D11): a `test` whose body begins with `take` lines is a property, run on a
// hundred sampled values of the inputs' types from a seed the phrase fixes, and a failure is shrunk to the smallest
// input that still fails and reported with the `want` line that did not hold and that input. A project of six tests,
// run as a person runs it: two that hold, three that fail and must each name their line and their shrunk input, and
// one whose input type no sample is drawn for. Run twice, to be the same twice, and on each native backend this machine
// has the toolchain for, where the same tests must fail at the same inputs.
// Run: npx tsx test/call/test-sampled.ts

import { spawnSync } from 'node:child_process'
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

const line = join(process.cwd(), 'host', 'line.js')
const root = realpathSync(mkdtempSync(join(tmpdir(), 'test-sampled-')))
mkdirSync(join(root, 'test'), { recursive: true })
writeFileSync(join(root, 'deck.tree'), `deck @probe/sampled\n  mark <0.0.1>\n`)
writeFileSync(
  join(root, 'test', 'math.tree'),
  [
    'test <adding nothing changes a number>',
    '  take n, like number',
    '  want hold, is-equal add(n, 0), n',
    '',
    'test <adding is the same either way>',
    '  take a, like number',
    '  take b, like number',
    '  want hold, is-equal add(a, b), add(b, a)',
    '',
    'test <every number is below ten>',
    '  take n, like number',
    '  want hold, is-below n, 10',
    '',
    'test <every flag is on>',
    '  take b, like boolean',
    '  want hold, b',
    '',
    'test <every list is short>',
    '  take xs, like list, like number',
    '  want hold, is-below xs/length, 3',
    '',
    'test <a fraction is sampled>',
    '  take f, like float',
    '  want hold, is-equal f, f',
    '',
  ].join('\n'),
)

const run = (...args: string[]): { code: number | null; out: string } => {
  const ran = spawnSync('node', [line, 'test', ...args, '--color', 'never'], { cwd: root, encoding: 'utf8', timeout: 900_000 })

  // the report wraps a long reason onto an indented line; read as one line
  return { code: ran.status, out: `${ran.stdout}${ran.stderr}`.replace(/\n {4}(?=\S)/g, ' ') }
}

const checkRun = (on: string, ran: { code: number | null; out: string }): void => {
  const where = on === 'node' ? '' : ` on ${on}`

  ok(`${on}: two of six hold`, ran.out.includes('6 tests · 2 passed · 4 failed') && ran.code === 1, ran.out)
  // the greedy shrink walks a whole number down one at a time, so the smallest failing one is ten exactly
  ok(`${on}: a number shrinks to the smallest that fails`, ran.out.includes(`line 12 did not hold${where}: want hold, is-below n, 10, at n 10`), ran.out)
  ok(`${on}: a flag shrinks to off`, ran.out.includes(`line 16 did not hold${where}: want hold, b, at b false`), ran.out)
  // a list shrinks by dropping items, never below the three that fail
  ok(`${on}: a list shrinks to three items`, new RegExp(`line 20 did not hold${where}: want hold, is-below xs/length, 3, at xs \\[-?\\d+, -?\\d+, -?\\d+\\]`).test(ran.out), ran.out)
  ok(`${on}: an input no sample is drawn for is named`, ran.out.includes('"f" is float'), ran.out)
}

// the line and the input each failing property named, without the times around it
const reasons = (out: string): string => out.split('\n').filter(text => /^\s+why line \d+ did not hold/.test(text)).join('\n')

const first = run()
checkRun('node', first)

const again = run()
ok('node: a second run fails at the same inputs', reasons(again.out) !== '' && reasons(again.out) === reasons(first.out), again.out)

const have = (tool: string): boolean => spawnSync('which', [tool], { stdio: 'ignore' }).status === 0

for (const [env, tools] of [['rust', ['rustc']], ['swift', ['swiftc']], ['kotlin', ['kotlinc', 'java']]] as const) {
  if (!tools.every(have)) {
    console.log(`skip  ${env}: ${tools.join(' and ')} not here`)
    continue
  }

  const native = run('--env', env)
  checkRun(env, native)
  // the seed is the phrase's, and the generator is Term on every backend, so each fails at node's inputs
  ok(`${env}: the same inputs as node`, reasons(native.out).replace(new RegExp(` on ${env}`, 'g'), '') === reasons(first.out), native.out)
}

console.log(`\ntest-sampled: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
