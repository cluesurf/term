// Two kernel gaps compile/node.tree found (2026-10-05), each held here by a program that failed before:
//   1. A form named `type`. The kernel reads `like type` as its universe (the type of types), so every task answering
//      the form failed as `kernel: type mismatch`. check/elaborate.ts `kindsApart` now renames such a form on the
//      kernel's own copy, as it renames a form that shares a task's or a parameter's name.
//   2. A construction that leaves a `need false` field out. The surface checker allows it; the kernel's constructor
//      takes every field, so `make unknown` beside `link free / need false` was "expected form, found (many x0 :
//      Boolean) -> form". The kernel now declines such a construction, as it declines an unresolved name.
// Run: npx tsx test/check/form-named-type.ts

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

const build = (text: string) =>
  compile({ file: 'kernel.tree', text }, { resolve: withNativeEnv('node', stdlibResolver()!), library: true, leanOf: () => true } as never)

const named = build(`form type
  mark tag, name kind
  case number
  case named
    link name, like text

task number-type
  like type

  back make number
`)

ok('a task answering a form named type builds', named.ok, named.ok ? '' : named.diagnostics.map(d => d.message.split('\n').join(' ')).join(' | '))

const optional = build(`form shape
  case open
    link free
      like boolean
      need false
  case closed

task open-shape
  like shape

  back make open
`)

ok('a construction leaving a need false field out builds', optional.ok, optional.ok ? '' : optional.diagnostics.map(d => d.message.split('\n').join(' ')).join(' | '))

if (optional.ok) {
  ok('and the field is left out of what it builds', /\{ form: "open" \}/.test(optional.typescript), optional.typescript.split('\n').filter(l => /open/.test(l)).join(' | '))
}

console.log(`\nform-named-type: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
