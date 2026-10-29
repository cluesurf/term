// A run with a long running step (code/output.ts `progress`), for test/item/unit.ts to watch from outside, as
// follow-child.ts is. The step is `port toolchain modules`, 0 to 6 of 6 modules, then its finished ✓ item, then the
// closing. Usage: npx tsx test/item/progress-child.ts [--tty] [--log-json] [--no-motion]
//
//   --tty        stderr reads as a terminal (process.stderr.isTTY), so the run draws a live region, and the parent
//                reads every byte of it through the pipe
//   otherwise    the clock is moved 4 seconds per update, so a 24-second step without a terminal is seen in a moment

import {
  closeRun,
  openRun,
  progress,
  report,
  setOutput,
} from '@term/call/code/output'

const tty = process.argv.includes('--tty')

if (tty) {
  Object.defineProperty(process.stderr, 'isTTY', { value: true })
}

let clock = Date.parse('2026-10-22T12:00:00Z')

if (!tty) {
  Date.now = () => clock
}

setOutput(
  {
    log: process.argv.includes('--log-json') ? 'json' : undefined,
    motion: !process.argv.includes('--no-motion'),
  },
  '2.8.0',
)
openRun({ verb: 'release', root: process.cwd() })

const pause = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms))

for (let done = 0; done <= 6; done++) {
  progress({
    verb: 'port',
    subject: 'toolchain modules',
    done,
    total: 6,
    noun: 'modules',
    one: 'module',
  })

  if (tty) {
    // past the redraw limit, so each update draws a frame
    await pause(120)
  } else {
    clock += 4000
  }
}

report({
  glyph: 'done',
  verb: 'port',
  subject: 'toolchain modules',
  counts: [{ amount: 0, noun: 'built', one: '', total: -1 }],
})
closeRun({ verdict: 'Built, nothing published' })
