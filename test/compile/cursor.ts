// The text cursor fact (compile/backend.ts, `textCursors`), held both ways: the texts it must give a cursor, so a
// loop's reads step from the last one, and for every rule a text it must NOT, because a cursor kept across a change
// to its text reads the wrong code point.
// Run: npx tsx test/compile/cursor.ts

import { compile } from '@term/make/code/compile/compile'
import { textCursors } from '@term/make/code/compile/backend'
import { asciiTexts } from '@term/make/code/ir/facts/text'
import { stdlibResolver } from '@term/make/code/resolve'
import { withNativeEnv } from '@term/make/code/compile/native'
import type { Program, Statement } from '@term/make/code/compile/node'

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

const head = `load @term/base/text
  find char-at
  find char-code-at
  find char-count

`

// the names task `task` reads through a cursor, with `use` calling it with a text that is not ASCII
function cursors(body: string, task = 'scan'): string[] {
  const text = `${head}${body}

task use
  like number
  send back
    call scan
      text <aé€>
`
  const built = compile({ file: 'main.tree', text }, { resolve: withNativeEnv('node', stdlibResolver()!), env: 'node' })

  if (!built.ok) {
    throw new Error(built.diagnostics.map(d => d.message).join(' | '))
  }

  const program = built.program as Program
  const fn = program.find((n): n is Extract<Statement, { form: 'function' }> => n.form === 'function' && n.name === task)!

  return textCursors(fn, asciiTexts(program)).names
}

// a counted loop over `s`, its body `read`
const loop = (read: string): string => `  host n
    call char-count
      read s
  save total, code 0
  walk size
    bind base, code 0
    bind head, read n
    hook next
      take site, name i
${read}
  send back, read total`

const sum = `      save total
        call add
          read total
          call char-code-at
            read s
            read i`

// 1. a parameter read in a loop: a cursor
const param = cursors(`task scan
  take s, like text
  like number
${loop(sum)}`)
ok('a parameter read by position in a loop takes a cursor', param.join() === 's', param.join())

// 2. a parameter written in the task: none, the text changes under the cursor
const written = cursors(`task scan
  take s, like text
  like number
  save s, text <{s}x>
${loop(sum)}`)
ok('a text written in the task takes none', written.length === 0, written.join())

// 3. read only outside a loop: none, nothing to step from
const once = cursors(`task scan
  take s, like text
  like number
  send back
    call char-code-at
      read s
      code 1`)
ok('a text read once, outside a loop, takes none', once.length === 0, once.join())

// 4. a local declared inside the loop: none, a new text every turn
const inner = cursors(`task scan
  take s, like text
  like number
  host n
    call char-count
      read s
  save total, code 0
  walk size
    bind base, code 0
    bind head, read n
    hook next
      take site, name i
      host t, text <{s}x>
      save total
        call add
          read total
          call char-code-at
            read t
            read i
  send back, read total`)
ok('a local declared inside the loop takes none', inner.length === 0, inner.join())

// 5. a local at the top of the task, never written: a cursor
const local = cursors(`task scan
  take r, like text
  like number
  host s, text <{r}y>
${loop(sum)}`)
ok('a local at the top of the task, never written, takes a cursor', local.join() === 's', local.join())

// 6. an ASCII text: none, every read is a direct index already
const ascii = (() => {
  const text = `${head}task scan
  take s, like text
  like number
${loop(sum)}

task use
  like number
  send back
    call scan
      text <abc>
`
  const built = compile({ file: 'main.tree', text }, { resolve: withNativeEnv('node', stdlibResolver()!), env: 'node' })

  if (!built.ok) throw new Error(built.diagnostics.map(d => d.message).join(' | '))

  const program = built.program as Program
  const fn = program.find((n): n is Extract<Statement, { form: 'function' }> => n.form === 'function' && n.name === 'scan')!

  return textCursors(fn, asciiTexts(program)).names
})()
ok('an ASCII text takes none', ascii.length === 0, ascii.join())

console.log(`\ncursor: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
