// `term boot` (the port, work/boot/boot-running.tree) BUILDS THROUGH ONE BUILD GRAPH PER PROCESS (decision 094 rule 1,
// decision 097, item term-self-host-001-0495). A command-line program of two modules is booted into an `--out` folder
// and run, a module it loads is edited, and it is booted again in the same process: the rebuild builds the edited unit
// and what reads it and no other (the graph's memo, not the store), and runs the edited program. A second boot with
// nothing edited builds nothing. test/call/boot-units.ts holds the same of call/code/boot.ts.
// Run: npx tsx test/call/boot-graph.ts

import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
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

// a draft's emitted module may stand in for the port before it lands (BOOT_RUNNING_MODULE, an absolute path)
const { callBoot, readLastBootUnits } = (await import(
  process.env.BOOT_RUNNING_MODULE ?? '@term/call/host/port/code/work/boot/boot-running'
)) as {
  callBoot: (input: Record<string, unknown>) => Promise<void>
  readLastBootUnits: () => { built: number; reused: number }
}

const root = realpathSync(mkdtempSync(join(tmpdir(), 'boot-graph-')))
process.env.TERM_CACHE_HOME = join(root, '.store')
mkdirSync(join(root, 'code'), { recursive: true })
writeFileSync(join(root, 'deck.tree'), `deck @probe/boot\n  mark <0.0.1>\n`)

const helper = join(root, 'code', 'helper.tree')
const helperText = (answer: number): string =>
  `load @term/base/text\n  find trim\n\ntask answer\n  take who, like text\n  like number\n  save said, trim(who)\n  back ${answer}\n`

writeFileSync(helper, helperText(3))
writeFileSync(
  join(root, 'code', 'base.tree'),
  `load ./helper\n  find answer\n\n# Answer with the helper's number\nhook say\n  take who\n  task answer\n`,
)

const out = join(root, 'out')
const run = (): number | null =>
  spawnSync('node', [join(out, 'run.mjs'), 'say', '--who', 'you'], { encoding: 'utf8' }).status

await callBoot({ root, entry: join(root, 'code', 'base.tree'), out })
const first = { ...readLastBootUnits() }
ok('the program boots through units', first.built > 0, `${first.built} built`)
ok("and runs, answering the helper's number", run() === 3, String(run()))

await callBoot({ root, entry: join(root, 'code', 'base.tree'), out })
const again = { ...readLastBootUnits() }
ok('a second boot with nothing edited builds nothing', again.built === 0, JSON.stringify(again))

writeFileSync(helper, helperText(5))
await callBoot({ root, entry: join(root, 'code', 'base.tree'), out })
const edited = { ...readLastBootUnits() }
ok(
  'a rebuild after an edit to the helper builds its unit and the one reading it, no other',
  edited.built > 0 && edited.built <= 2,
  JSON.stringify(edited),
)
ok('and reads every other unit', edited.reused >= first.built + first.reused - 2, JSON.stringify(edited))
ok('and runs the edited program', run() === 5, String(run()))

process.env.TERM_BOOT_MERGED = '1'
await callBoot({ root, entry: join(root, 'code', 'base.tree'), out })
delete process.env.TERM_BOOT_MERGED
ok('the same program booted whole answers alike', run() === 5, String(run()))

console.log(`\nboot-graph: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
