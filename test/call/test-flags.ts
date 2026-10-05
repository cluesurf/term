// `term test --case` and `term test --env` (note/term/guides/tests/running.md, backends.md). A project of one task and
// three tests, one of which does not hold, run as a person runs it: whole, one test by its phrase, a phrase no test
// holds, and on each native backend this machine has the toolchain for, where the same test must fail on the same line.
// Run: npx tsx test/call/test-flags.ts

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
const root = realpathSync(mkdtempSync(join(tmpdir(), 'test-flags-')))
mkdirSync(join(root, 'code'), { recursive: true })
mkdirSync(join(root, 'test'), { recursive: true })
writeFileSync(join(root, 'deck.tree'), `deck @probe/flags\n  mark <0.0.1>\n`)
writeFileSync(join(root, 'code', 'math.tree'), `task double\n  take n, like number\n  like number\n  send back\n    call multiply\n      read n\n      code 2\n`)
writeFileSync(
  join(root, 'test', 'math.tree'),
  `load ../code/math\n  find double\n\ntest <double of two is four>\n  want hold, is-equal double(2), 4\n\ntest <double of zero is zero>\n  want hold, is-equal double(0), 0\n\ntest <double of one is three>\n  want hold, is-equal double(1), 3\n`,
)

const run = (...args: string[]): { code: number | null; out: string } => {
  const ran = spawnSync('node', [line, 'test', ...args, '--color', 'never'], { cwd: root, encoding: 'utf8', timeout: 600_000 })

  return { code: ran.status, out: `${ran.stdout}${ran.stderr}` }
}

const whole = run()
ok('whole: two of three hold', whole.out.includes('3 tests · 2 passed · 1 failed') && whole.code === 1, whole.out)

const one = run('--case', 'zero')
ok('--case runs the one test whose phrase holds it', one.out.includes('1 test · 1 passed') && one.code === 0, one.out)

const named = run('--case', 'DOUBLE OF ONE')
ok('in any case, and the one it names fails', named.out.includes('1 test · 0 passed · 1 failed') && named.code === 1, named.out)

const none = run('--case', 'nothing-like-this')
ok('a phrase no test holds is no pass', none.out.includes('No test matched') && none.code !== 0, none.out)

const strange = run('--env', 'cobol')
ok('a backend term test does not run on is refused', strange.out.includes('not on cobol') && strange.code !== 0, strange.out)

const have = (tool: string): boolean => spawnSync('which', [tool], { stdio: 'ignore' }).status === 0

for (const [env, tools] of [['rust', ['cargo']], ['swift', ['swiftc']], ['kotlin', ['kotlinc', 'java']]] as const) {
  if (!tools.every(have)) {
    console.log(`skip  ${env}: ${tools.join(' and ')} not here`)
    continue
  }

  const native = run('--env', env)
  ok(`on ${env}: two of three hold`, native.out.includes('3 tests · 2 passed · 1 failed') && native.code === 1, native.out)
  ok(`on ${env}: the failing test names its line`, native.out.includes(`line 11 did not hold on ${env}`), native.out)

  const chosen = run('--env', env, '--case', 'four')
  ok(`on ${env}: --case runs the one test`, chosen.out.includes('1 test · 1 passed') && chosen.code === 0, chosen.out)
}

console.log(`\ntest-flags: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
