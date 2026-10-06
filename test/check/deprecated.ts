// `mark deprecated` WARNS WHERE ANOTHER FILE USES THE NAME (check/deprecated.tree). A task: a call. A form, since
// 2026-10-05 (note/term/plan/decisions-2026-10.md, D13, `ordered-set` toward `set`): a `make` of it, and a task's input
// or result typed by it. The file that defines the name may use it with no word. Two modules: `old.tree` defines a
// deprecated task and form and uses both itself, and the entry uses each from outside.
// Run: sh tmp/run-term-ts.sh test/check/deprecated.ts

import { compile } from '@term/make/code/compile/compile'
import { stdlibResolver } from '@term/make/code/resolve'
import type { Resolver } from '@term/make/code/compile/load'

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

const OLD = `form old-box
  mark deprecated
  link value, like number

task old-way
  take x, like number
  like number
  mark deprecated
  back x

# its own file uses both, with no word
task inside
  like number
  save b, make old-box, bind value, 1
  back old-way(b/value)
`

const ENTRY = `load ./old
  find old-box
  find old-way

task boxed
  take box, like old-box
  like number
  back box/value

task outside
  like number
  save b, make old-box, bind value, 2
  back old-way(boxed(b))
`

const stdlib = stdlibResolver()!
const resolve: Resolver = (path, from, how) => (path === './old' ? { file: '/probe/code/old.tree', text: OLD } : stdlib(path, from, how))

const built = compile({ file: '/probe/code/main.tree', text: ENTRY }, { resolve, env: 'node' })
const warned = built.ok ? (built.warnings ?? []).filter(w => /is marked deprecated/.test(w.message)) : []
const said = built.ok ? warned.map(w => `${w.file}:${w.span.start.line + 1} ${w.message}`).join(' | ') : built.diagnostics.map(d => d.message).join(' | ')
const at = (line: number, name: string): boolean => warned.some(w => w.span.start.line + 1 === line && w.message.includes(`"${name}"`))

ok('the program builds', built.ok, said)
ok('a call of a deprecated task from another file warns', at(13, 'old-way'), said)
ok('a make of a deprecated form from another file warns', at(12, 'old-box'), said)
ok('a task taking a deprecated form from another file warns', warned.some(w => w.message.includes('"old-box"') && w.span.start.line + 1 === 5), said)
ok('the defining file uses its own with no word', !warned.some(w => (w.file ?? '').endsWith('old.tree')), said)

const BOTH = `form plain-box
  link value, like number

task use
  like number
  save b, make plain-box, bind value, 3
  back b/value
`
const plain = compile({ file: '/probe/code/plain.tree', text: BOTH }, { resolve, env: 'node' })
ok('a form not marked is no warning', plain.ok && !(plain.warnings ?? []).some(w => /deprecated/.test(w.message)), plain.ok ? '' : plain.diagnostics.map(d => d.message).join(' | '))

console.log(`\ndeprecated: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
