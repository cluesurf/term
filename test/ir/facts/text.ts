// The ASCII text fact (ir/facts/text.ts), held both ways: the texts it must prove ASCII, so the backends read them by
// index, and for every rule a text it must NOT, because a wrong one reads a byte where a code point was asked for.
// Run: npx tsx test/ir/facts/text.ts

import { compile } from '@term/make/code/compile/compile'
import { asciiTexts } from '@term/make/code/ir/facts/text'
import type { Program } from '@term/make/code/compile/node'

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

// whether every read of the variable `name` inside task `task` is proven ASCII
function proven(text: string, task: string, name: string): boolean {
  const built = compile({ file: 'main.tree', text }, { optimize: false })

  if (!built.ok) {
    throw new Error(built.diagnostics.map(d => d.message).join(' | '))
  }

  const facts = asciiTexts(built.program)
  const fn = (built.program as Program).find(n => n.form === 'function' && n.name === task)
  const reads: object[] = []
  const walk = (value: unknown): void => {
    if (typeof value !== 'object' || value === null) {
      return
    }

    if (Array.isArray(value)) {
      value.forEach(walk)

      return
    }

    const node = value as { form?: string; name?: string }

    if (node.form === 'variable' && node.name === name) {
      reads.push(node)
    }

    for (const [key, child] of Object.entries(node)) {
      if (key !== 'type' && key !== 'span') {
        walk(child)
      }
    }
  }

  walk(fn)

  return reads.length > 0 && reads.every(r => facts.has(r))
}

const reader = `task first
  take s, like text
  like text
  send back
    call s/char-at
      code 0
`

ok('a local made from an ASCII literal IS ASCII', proven(`${reader}
task go
  like text
  save s, text <hello>
  send back
    call first
      read s
`, 'go', 's'))

ok('a local made from a literal with a character above 127 is NOT', !proven(`${reader}
task go
  like text
  save s, text <héllo>
  send back
    call first
      read s
`, 'go', 's'))

ok('a local later given a non-ASCII text is NOT', !proven(`${reader}
task go
  like text
  save s, text <hello>
  save s, text <wörld>
  send back
    call first
      read s
`, 'go', 's'))

ok('a template of an ASCII text and a number IS', proven(`${reader}
task go
  take n, like number
  like text
  save s, text <row {n}>
  save t, text <{s}!>
  send back
    call first
      read t
`, 'go', 't'))

ok('a parameter every caller passes ASCII IS', proven(`${reader}
task go
  like text
  send back
    call first
      text <abc>
`, 'first', 's'))

ok('a parameter one caller passes non-ASCII is NOT', !proven(`${reader}
task go
  like text
  save a
    call first
      text <abc>
  send back
    call first
      text <ñ>
`, 'first', 's'))

ok('a parameter of a task nothing calls is NOT (a caller the program cannot see)', !proven(reader, 'first', 's'))

console.log(`\ntext: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
