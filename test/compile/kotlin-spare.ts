// Kotlin's node reuse (kotlin.ts, `kotlinReuse`, `localSpares`): a task that both keeps a node and builds one keeps it
// in a spare of its own, and the rest go through the program's spare. Only the program's spare has the node's links
// cleared first, since it outlives the task and would keep a dead chain alive; a task's own spare is rebuilt in the
// task or dropped with it. The meaning fixtures hold the answers on Kotlin (`slot`, `kept`, `payload`, `raise-spare`).
// Run: npx tsx test/compile/kotlin-spare.ts

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { stdlibResolver } from '@term/make/code/resolve'
import { withNativeEnv } from '@term/make/code/compile/native'
import { emitKotlin } from '@term/make/code/compile/kotlin'

let pass = 0
let fail = 0

function ok(name: string, holds: boolean, detail = ''): void {
  if (holds) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}${detail ? `\n        ${detail}` : ''}`)
  }
}

const TERM = join(import.meta.dirname, '../..')
const kotlin = (file: string, entry: string): string => {
  const built = compile(
    { file, text: readFileSync(join(TERM, file), 'utf8') },
    { resolve: withNativeEnv('kotlin', stdlibResolver()!), env: 'kotlin', entryPoints: [entry] },
  )

  if (!built.ok) {
    throw new Error(`${file}: ${built.diagnostics[0]?.message}`)
  }

  return emitKotlin(built.program)
}
const task = (text: string, name: string): string => {
  const start = text.indexOf(`fun ${name}(`)

  return start < 0 ? '' : text.slice(start, text.indexOf('\n}\n', start))
}

// 1. Towers' move keeps the popped node in its own spare and builds the pushed one in it, with no clear between
const towers = kotlin('bench/towers/term.tree', 'towers')
const moveTop = task(towers, 'moveTop')
ok('towers: the move keeps the node in its own spare', /__spareStackDisk = top\d+/.test(moveTop), moveTop.slice(0, 400))
ok('towers: and does not clear its links first', !/\.below = StackEmpty/.test(moveTop), moveTop.split('\n').filter(l => /below/.test(l)).join(' | '))
ok('towers: the push builds in the spare', /val __h\d+ = __spareStackDisk/.test(moveTop))

// 2. a task that keeps a node it does not build goes through the program's spare, its links cleared first
const slot = kotlin('test/compile/meaning-native/slot.tree', 'compute')
const keeps = slot.split('\n').map((l, i, all) => ({ line: l, before: all[i - 1] ?? '' })).filter(({ line }) => /termSpareStackDisk = \w+$/.test(line.trim()))
ok('slot: some task keeps a node for the program\'s spare', keeps.length > 0, slot.split('\n').filter(l => /termSpare/.test(l)).join(' | '))
ok(
  'slot: each one clears the node\'s links first',
  keeps.length > 0 && keeps.every(({ before }) => /\.below = StackEmpty$/.test(before.trim())),
  keeps.map(({ before, line }) => `${before.trim()} / ${line.trim()}`).join(' | '),
)

console.log(`\nkotlin-spare: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
