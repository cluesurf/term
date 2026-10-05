// A program that declares `form type` gets that form wherever it writes `like type`, as a local `form text` gets
// its own `text`. The TypeScript emitter read `like type` as the universe of types and spelled it `any` even then, so
// a field typed by the form was `any`: `{ form: "unit"; span: Span; type?: any }` where compile/node.ts says
// `type?: Type`. Found porting compile/node.ts, whose surface types are a `form type` (2026-10-05). Without such a
// form, `like type` is still the universe and still `any`. Run: npx tsx test/compile/form-named-type.ts

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

const declared = `form type
  mark tag, name kind
  case number
  case named
    link name, like text
    link args
      like list, like type
      need false

form slot
  link held, like type
  link maybe-held
    like type
    need false
`

const built = compile({ file: 'own.tree', text: declared }, { resolve: withNativeEnv('node', stdlibResolver()!), library: true, leanOf: () => true } as never)

if (!built.ok) {
  ok('a program with its own form type builds', false, built.diagnostics.map(d => d.message).join(' | '))
} else {
  ok('a case field typed by it is the form', /args\?: Type\[\]/.test(built.typescript), built.typescript.split('\n').filter(l => /args/.test(l)).join(' | '))
  ok('a record field typed by it is the form', /held: Type\b/.test(built.typescript) && /maybeHeld\?: Type\b/.test(built.typescript), built.typescript.split('\n').filter(l => /held/i.test(l)).join(' | '))
  ok('and none is any', !/: any\b/.test(built.typescript))
}

const universe = `task identity
  take t, like type
  like type

  back t
`

const plain = compile({ file: 'universe.tree', text: universe }, { resolve: withNativeEnv('node', stdlibResolver()!), library: true, leanOf: () => true } as never)

if (!plain.ok) {
  ok('a program without one builds', false, plain.diagnostics.map(d => d.message).join(' | '))
} else {
  ok('without a form type, like type is still the universe, any', /identity\(t: any\): any/.test(plain.typescript), plain.typescript.split('\n').filter(l => /identity/.test(l)).join(' | '))
}

console.log(`\nform-named-type: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
