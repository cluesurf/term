// ONE TABLE OF WHAT A NATIVE LIST AND MAP ANSWER (compile/lowered-members.ts, note/term/plan/backends-complete.md
// step 5). A member call on a list or a hash is a member every emitter lowers, else the Term form's method of that
// name, else refused on Rust, Swift and Kotlin before emit (check/lowered.ts), where it is the host's own on
// TypeScript.
//
// Before 2026-10-05 the checker's own list said `reverse`, `find`, `sort`, `forEach`, `entries`, `keys`, `values` and a
// map's `clear` and `entries` were answered natively, and no native emitter lowered them: `walk list, call
// items/reverse` failed in rustc, swiftc and kotlinc, and reversed `items` IN PLACE on TypeScript, where the Term
// method copies. A map's `clear` and `entries` were the host's own, unlike their Term definitions.
// Run: npx tsx test/compile/lowered-members.ts   (LOWERED_ONLY=typescript, rust, swift or kotlin runs one)

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectResolver } from '@term/call/code/make'
import { compile } from '@term/make/code/compile/compile'
import { BACKENDS, runOn } from './shared/run-on'

let pass = 0
let fail = 0

function ok(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  ${info.slice(0, 1500)}`)
  }
}

// a walk over the list `reverse` answers, which must leave `items` as it was; a map's `entries` and `clear`, which
// are Term methods; and a map's `size` read after the clear
const PROGRAM = `load @term/base/list
  find list

load @term/base/hash
  find hash

task run
  like text
  save items
    make list
      code 3
      code 1
      code 2
  save order
    make list
  walk list, call items/reverse
    hook next
      take site, name item
      call order/push
        read item
  save counts
    make hash
      save a, code 1
      save b, code 2
  save pairs, call counts/entries
  save before, read pairs/length
  call counts/clear
  send back, text <{order/0}{order/1}{order/2} {items/0} {before} {counts/size}>
`

const EXPECTED = '213 3 2 0'

const dir = mkdtempSync(join(tmpdir(), 'term-lowered-'))
const only = process.env.LOWERED_ONLY ?? ''

for (const backend of BACKENDS.filter(b => !only || b === only)) {
  const ran = runOn({ backend, program: PROGRAM, resolve: env => projectResolver(process.cwd(), env), dir, name: 'lowered' })

  if (ran.form === 'skipped') {
    console.log(`skip  ${backend}: ${ran.reason}`)
    continue
  }

  ok(
    `${backend}: a walk over items/reverse copies, a map's entries and clear are its Term methods`,
    ran.form === 'ran' && ran.output === EXPECTED,
    ran.form === 'ran' ? `got ${JSON.stringify(ran.output)}` : `${ran.stage}: ${ran.reason}`,
  )
}

// the refusals, which need only the checker
const diagnostics = (text: string, env: string): string[] => {
  const built = compile({ file: join(dir, `refused-${env}.tree`), text }, { resolve: projectResolver(process.cwd(), env as never), env: env as never })

  return built.ok ? [] : built.diagnostics.map(d => `${d.message} ${d.hint ?? ''}`)
}

const SORTED = `task run\n  like number\n  save items\n    make list\n      code 3\n      code 1\n  call items/sort\n  send back, read items/0\n`
const EACH = `task run\n  like number\n  save counts\n    make hash\n      save a, code 1\n  save total, code 0\n  call counts/for-each\n    task\n      take value, like number\n      save total, add(read(total), read(value))\n  send back, read total\n`

for (const env of ['rust', 'swift', 'kotlin'].filter(one => !only || one === only)) {
  const sorted = diagnostics(SORTED, env)
  ok(`${env}: a list's host-only method is refused, naming it, the backend and what a list answers`, sorted.some(m => m.includes('`sort` is not a method of a list on ' + env) && m.includes('index-of')), sorted.join(' | '))

  const each = diagnostics(EACH, env)
  ok(`${env}: a map's host-only method is refused the same way`, each.some(m => m.includes('`for-each` is not a method of a hash on ' + env)), each.join(' | '))
}

if (!only || only === 'typescript') {
  const sorted = diagnostics(SORTED, 'node')
  ok('typescript: the host method is the host\'s own, and builds', sorted.length === 0, sorted.join(' | '))
}

console.log(`\nlowered-members: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
