// Does the streaming reader hold memory FLAT on a file far larger than the heap it is given?
//
// This is the property the whole design rests on, and it is the one a per-case test cannot give you: a reader that
// works on a 7 MB file and quietly accumulates is indistinguishable from one that does not, until somebody hands
// it a real corpus. The heap is capped small on purpose and the source is generated as a LINE ITERATOR rather than
// a string, so the file never exists in memory at all: what is measured is the reader, not the fixture.
//
// ASSERTED, NOT EYEBALLED. Resident heap at the end must be within a small multiple of resident heap after the
// first few groups. A reader that held every group would grow with the file and fail long before the end.
//
// Run: pnpm term:stream-memory   (it needs --expose-gc to measure RETAINED heap rather than whatever the collector
//                                 has not got to yet, which the alias supplies)

import { walkGroups } from '@term/make/code/parser/stream'

// how many top-level groups to stream. Each is six lines of about 80 bytes, so this is 24 million lines and
// roughly 340 MB of source that is NEVER MATERIALISED: the generator makes each line as the reader asks for it.
const GROUPS = 4_500_000

// the heap this is given, in MB, capped by the pnpm alias. The source above is more than ten times it, which is
// the bar tree-stream-0006 sets: a file far larger than the heap has to stream through it.
const HEAP = 32

// roughly how many bytes a generated group is, for the size the run reports
const GROUP_BYTES = 80

// retained heap at the end may be at most this multiple of retained heap early on. A reader that accumulated would
// be far past it; a flat one sits near 1.
const LIMIT = 3

const collect = (globalThis as { gc?: () => void }).gc

if (!collect) {
  console.log('run with --expose-gc (pnpm term:stream-memory does)')
  process.exit(1)
}

function heapMb(): number {
  collect!()
  collect!()

  return Math.round(process.memoryUsage().heapUsed / 1048576)
}

// A generated source, one line at a time. Nothing holds the file: the generator makes each line as the reader asks
// for it, which is exactly how a real byte or text source would behave.
function* generate(groups: number): Generator<string, void, undefined> {
  for (let i = 0; i < groups; i++) {
    yield `task probe-${i}`
    yield '  take n, like number'
    yield '  like number'
    yield '  send back'
    yield '    read n'
    yield ''
  }
}

let pass = 0
let fail = 0

function ok(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}${info ? `  ${info}` : ''}`)
  }
}

let seen = 0
let early = 0
let peak = 0

walkGroups({ file: 'big.tree', lines: generate(GROUPS) }, result => {
  if (result.kind !== 'group') {
    return
  }

  seen++

  // after enough groups to have warmed up, but far from the end
  if (seen === 1_000) {
    early = heapMb()
  }

  if (seen % 50_000 === 0) {
    peak = Math.max(peak, heapMb())
  }
})

const end = heapMb()
const ratio = early > 0 ? Math.max(end, peak) / early : Infinity

ok(`every group is read (${seen} of ${GROUPS})`, seen === GROUPS, `read ${seen}`)

ok(
  `heap is flat: ${early} MB early, ${Math.max(end, peak)} MB at the end, ratio ${ratio.toFixed(2)} (limit ${LIMIT})`,
  ratio <= LIMIT,
  'the reader is holding groups it has already yielded',
)

// the source is many times the heap it ran in, which is the point of the exercise
const sourceMb = Math.round((GROUPS * GROUP_BYTES) / 1048576)

ok(
  `the source is more than ten times the heap (~${sourceMb} MB streamed through ${HEAP} MB)`,
  sourceMb > HEAP * 10,
  `${sourceMb} MB is not more than ${HEAP * 10}`,
)

console.log(`\nstream-memory: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
