// `term test` on CONTROLS: a file under a package's `test/case/` states laws false on purpose, and passes only when
// the build refuses it, for proof reasons, exactly as many times as its header says (`Expected: N`). Each project
// here holds one control, run as a person runs it. Every way a control can stop testing anything is held: a count that
// is wrong, a false law the build accepts, a refusal for another reason (a typo), and no count at all.
// Run: npx tsx test/call/test-case.ts

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

// a project whose only file is one control, built and tested
function control(text: string): { code: number | null; out: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'test-case-')))
  mkdirSync(join(root, 'code'), { recursive: true })
  mkdirSync(join(root, 'test', 'case'), { recursive: true })
  writeFileSync(join(root, 'deck.tree'), `deck @probe/case\n  mark <0.0.1>\n`)
  writeFileSync(join(root, 'test', 'case', 'square-control.tree'), text)

  const ran = spawnSync('node', [line, 'test', '--color', 'never'], { cwd: root, encoding: 'utf8', timeout: 600_000 })

  return { code: ran.status, out: `${ran.stdout}${ran.stderr}` }
}

// false at a = 1: a >= 1 does not give a * a >= 2 a
const FALSE_LAW = `rule square-at-least-double
  seat a, like integer
  have a-is-at-least-one, is-minimum a, 1
  show hold, is-minimum multiply(a, a), multiply(2, a)
`

const held = control(`# false on purpose. Expected: 1.\n\n${FALSE_LAW}`)
ok('a control refused as its header says passes', held.code === 0 && held.out.includes('1 of 1 refused') && held.out.includes('1 control refused as expected'), held.out)

const short = control(`# false on purpose. Expected: 2.\n\n${FALSE_LAW}`)
ok('one refused fewer times than its header says fails, and says both counts', short.code === 1 && short.out.includes('1 refused where its header expects 2'), short.out)

const accepted = control(`# false on purpose, except it is not. Expected: 1.

rule square-at-least-double
  seat a, like integer
  have a-is-at-least-two, is-minimum a, 2
  show hold, is-minimum multiply(a, a), multiply(2, a)
`)
ok('a control whose law the build PROVES fails: a false law would have been accepted', accepted.code === 1 && accepted.out.includes('0 of 1 refused'), accepted.out)

const typo = control(`# false on purpose. Expected: 1.

rule square-at-least-double
  seat a, like integer
  show hold, is-minimum multipy(a, a), multiply(2, a)
`)
ok('a control refused for another reason is broken, not passed', typo.code === 1 && typo.out.includes('refused for another reason'), typo.out)

const uncounted = control(`# false on purpose.\n\n${FALSE_LAW}`)
ok('a control with no count is broken', uncounted.code === 1 && uncounted.out.includes('a control states no count'), uncounted.out)

console.log(`\ntest-case: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
