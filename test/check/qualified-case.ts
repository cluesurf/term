// A case two forms share, named with its owner: `make expression/integer` beside another form's `integer`. Before
// 2026-10-04 the qualified spelling worked only where the case name was unique, so the one place it carries
// information did not work: the checker typed the construction leniently, and the kernel verified it against
// whichever owner it held, the wrong form when the intended one is a form it does not encode (the engine test port).
// Also: a form named like another form's case is renamed `<name>__form`, and its qualified constructions are written by
// the author's name. Run: npx tsx test/check/qualified-case.ts

import { compile } from '@term/make/code/compile/compile'
import { stdlibResolver } from '@term/make/code/resolve'
import { withNativeEnv } from '@term/make/code/compile/native'

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

// `literal` and `outcome` share `integer` with one field of different types; `expression` is also the name of a case
// of `statement`, so the form is renamed `expression__form`
const forms = `form literal
  case integer
    link value, like number
  case word
    link value, like text

form outcome
  case integer
    link value, like text
  case nothing

form expression
  case integer
    link value, like literal
  case name
    link text, like text

form statement
  case expression
    link body, like expression
  case stop
`

function build(body: string): { ok: boolean; messages: string; typescript: string } {
  const result = compile({ file: 'qualified.tree', text: `${forms}\n${body}` }, { resolve: withNativeEnv('node', stdlibResolver()!) })

  return {
    ok: result.ok,
    messages: result.ok ? '' : result.diagnostics.map(d => `${d.name}: ${d.message}`).join(' | '),
    typescript: result.ok ? result.typescript : '',
  }
}

const literal = build(`task one
  like literal
  send back
    make literal/integer
      bind value, code 1
`)
ok('a qualified construction of a shared case builds', literal.ok, literal.messages)

const outcome = build(`task one
  like outcome
  send back
    make outcome/integer
      bind value, text <seven>
`)
ok('the other owner of the same case builds with its own field type', outcome.ok, outcome.messages)

const renamed = build(`task one
  like expression
  send back
    make expression/integer
      bind value
        make literal/integer
          bind value, code 4
`)
ok('a form renamed for a case of its name is qualified by the written name', renamed.ok, renamed.messages)

const wrong = build(`task one
  like outcome
  send back
    make outcome/integer
      bind value, code 7
`)
ok('the named owner is the one checked: a field of the other owner is refused', !wrong.ok, wrong.messages || 'it built')

const unknown = build(`task one
  like outcome
  send back
    make nowhere/integer
      bind value, code 7
`)
ok('an owner that names no form is refused', !unknown.ok && /names no form/.test(unknown.messages), unknown.messages || 'it built')

console.log(`\nqualified-case: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
