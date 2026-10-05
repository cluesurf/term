// `term boot` on units (note/term/plan/incremental-best-in-class.md, step 9). A program is built one unit at a time,
// and a rebuild in the same process (the dev loop) reads every unit an edit did not reach from memory. Here a
// command-line program of two modules is booted into an `--out` folder and run, a module it loads is edited, and it is
// booted again in the same process: the rebuild builds the edited unit and what reads it and no other, and runs the
// edited program. Then the same program is booted whole, and the two answer alike.
// Run: npx tsx test/call/boot-units.ts

import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { callBoot, lastBootUnits } from '@term/call/code/boot'

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

const root = realpathSync(mkdtempSync(join(tmpdir(), 'boot-units-')))
mkdirSync(join(root, 'code'), { recursive: true })
writeFileSync(join(root, 'deck.tree'), `deck @probe/boot\n  mark <0.0.1>\n`)

// a line no earlier run wrote: unit keys are the same in every clone (step 13), so the same text would be read from
// the store a previous run of this test filled, and nothing would be built
const fresh = `# run ${root.split('-').pop()} at ${Date.now()}\n`
const helper = join(root, 'code', 'helper.tree')
const helperText = (answer: number): string =>
  `${fresh}load @term/base/text\n  find trim\n\ntask answer\n  take who, like text\n  like number\n  save said, trim(who)\n  back ${answer}\n`

writeFileSync(helper, helperText(3))
writeFileSync(
  join(root, 'code', 'base.tree'),
  `${fresh}load ./helper\n  find answer\n\n# Answer with the helper's number\nhook say\n  take who\n  task answer\n`,
)

const out = join(root, 'out')

// the bundle run as a person runs it, its exit code being what the task answered
const run = (): number | null => spawnSync('node', [join(out, 'run.mjs'), 'say', '--who', 'you'], { encoding: 'utf8' }).status

await callBoot({ root, entry: join(root, 'code', 'base.tree'), out })
ok('the program boots through units', lastBootUnits.built > 0, `${lastBootUnits.built} built`)
ok('and runs, answering the helper\'s number', run() === 3, String(run()))

const first = { ...lastBootUnits }
writeFileSync(helper, helperText(5))

await callBoot({ root, entry: join(root, 'code', 'base.tree'), out })
ok('a rebuild after an edit to the helper builds its unit and the one reading it, no other', lastBootUnits.built > 0 && lastBootUnits.built <= 2, `${lastBootUnits.built} built`)
ok('and reads every other unit', lastBootUnits.reused >= first.built + first.reused - 2, `${lastBootUnits.reused} read`)
ok('and runs the edited program', run() === 5, String(run()))

process.env.TERM_BOOT_MERGED = '1'
await callBoot({ root, entry: join(root, 'code', 'base.tree'), out })
delete process.env.TERM_BOOT_MERGED
ok('the same program booted whole answers alike', run() === 5, String(run()))

console.log(`\nboot-units: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
