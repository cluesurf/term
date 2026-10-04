// A whole run through the one module that touches the process (emit.tree), for test/item/unit.ts to watch from
// outside: it is spawned with a flag and an environment, and the test reads what reached stdout and stderr.
//
// Usage: npx tsx test/item/emit-child.ts [--log-json] [--plain] [--quiet]

import { beginRun, endRun, printData, report } from '@term/call/code/work/item/emit'
import { makeOpening, makeOptions } from '@term/call/code/work/item/run'
import { blankEvent, plainSubject } from '@term/call/code/work/item/event'
import { makeStandard } from '@term/call/code/work/item/standard'

const flags = process.argv.slice(2)
const standard = makeStandard()
const options = { ...makeOptions(), json: flags.includes('--log-json'), plain: flags.includes('--plain'), quiet: flags.includes('--quiet') }
const clock = Date.UTC(2026, 9, 3, 21, 42)

let runner = beginRun('make', makeOpening('make', '~/shape', clock, 'term 2.5.24'), options, standard)
runner = report(runner, { ...blankEvent(), glyph: 'done', verb: 'build', subject: plainSubject('typescript'), clock, duration: 410 })
runner = report(runner, {
  ...blankEvent(),
  glyph: 'failed',
  kind: 'problem',
  verb: 'check',
  subject: plainSubject('There is no task named multipy'),
  clock,
  place: { path: 'code/area.tree', line: 14, column: 12 },
})

if (flags.includes('--data')) {
  printData('the data the user asked for\n')
}

process.exitCode = endRun(runner, { ...blankEvent(), subject: plainSubject('Build failed'), clock, duration: 302 })
