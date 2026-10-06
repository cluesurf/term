// A program booted from units carries what its run reaches (note/term/compiler/runtime-shaking.md). The bundle's entry
// exports the entry file's own names, what it imports, and every task a command calls, which a hook table names only
// in its routes: zone's commands are other files' tasks, and narrowing to the entry's own names alone left `zone call`
// answering `task "call" is not exported by the program` (2026-10-05). And nothing else: a command that trims one text
// carries `trim`, not the text module's other tasks.
// Run: npx tsx test/call/boot-shake.ts

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { callBoot } from '@term/call/code/boot'

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

const root = realpathSync(mkdtempSync(join(tmpdir(), 'boot-shake-')))
mkdirSync(join(root, 'code'), { recursive: true })
writeFileSync(join(root, 'deck.tree'), `deck @probe/shake\n  mark <0.0.2>\n  link @term/base, mark <0.0.x>\n`)

// fresh text, so no earlier run's units answer for these (unit keys are the same in every clone)
const fresh = `# run ${root.split('-').pop()} at ${Date.now()}\n`

// the command's task lives in another file, and trims a text
writeFileSync(
  join(root, 'code', 'work.tree'),
  `${fresh}load @term/base/text\n  find trim\n\ntask answer\n  take who, like text\n  like number\n  save said, trim(who)\n  fork test\n    hook test, is-equal(said, <you>)\n    hook hold\n      back 3\n  back 4\n`,
)
writeFileSync(join(root, 'code', 'base.tree'), `${fresh}load ./work\n  find answer\n\n# Answer by the trimmed name\nhook say\n  take who\n  task answer\n`)

const out = join(root, 'out')

await callBoot({ root, entry: join(root, 'code', 'base.tree'), out })

const run = spawnSync('node', [join(out, 'run.mjs'), 'say', '--who', ' you '], { encoding: 'utf8' })
ok('a command whose task is another file\'s runs it', run.status === 3, `${run.status} ${run.stdout}${run.stderr}`)

const app = readFileSync(join(out, 'app.mjs'), 'utf8')
ok('the bundle carries the text task it calls', /function trim\(/.test(app))
ok('and none it does not', !/function (padLeft|replaceAll|toUpperCase|contains)\(/.test(app), app.slice(0, 400))
ok('and of the text runtime, trim alone', /__termText_trim/.test(app) && !/__termText_(pad|replaceAll|compare)\b/.test(app))

console.log(`\n${pass} pass, ${fail} fail`)
process.exit(fail ? 1 : 0)
