// A construction of a case two forms share fits the form whose case it builds, a `need false` field left out
// included. Until 2026-10-05 a case fitted only when every one of its fields was given, so `make variable / bind name /
// bind span` fitted neither node.tree's expression case (with three `need false` fields beside those two) nor the
// type's (`id`), stayed open, and the TypeScript emitter built the type's case, `{ kind: "variable" }`, where an
// expression was meant: no refusal, and a wrong record. check/infer.ts, `caseRequired`. Run: npx tsx test/check/case-fit.ts

import { compile } from '@term/make/code/compile/compile'

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

// two forms each with a case `variable`: the first tagged on `kind` with one field, the second with two given fields
// and a `need false` one
const forms = `form kind-of
  mark tag, name kind
  case variable
    link id, like number
  case other

form value
  case variable
    link name, like text
    link at, like number
    link note
      like text
      need false
  case constant
    link amount, like number
`

{
  const text = `${forms}
task named
  take name, like text
  like value
  send back
    make variable
      bind name, read name
      bind at, code 3
`
  const built = compile({ file: 'case-fit.tree', text })
  ok('a construction leaving out a need false field builds', built.ok, built.ok ? '' : built.diagnostics.map(d => d.message).join(' | '))

  if (built.ok) {
    const at = built.typescript.indexOf('function named')
    const body = built.typescript.slice(at, at + 300)
    ok('it builds the case of the form whose fields it gives', /form: "variable", name: name, at: 3/.test(body), body)
    ok('and never the other form\'s case', !/kind: "variable"/.test(body), body)
  }
}

{
  // the other form's case, by its own field, still builds that one
  const text = `${forms}
task numbered
  like kind-of
  send back
    make variable
      bind id, code 7
`
  const built = compile({ file: 'case-fit.tree', text })
  const at = built.ok ? built.typescript.indexOf('function numbered') : 0
  const body = built.ok ? built.typescript.slice(at, at + 200) : ''
  ok('a construction giving the other case\'s field builds that case', built.ok && /kind: "variable", id: 7/.test(body), built.ok ? body : built.diagnostics.map(d => d.message).join(' | '))
}

console.log(`\ncase-fit: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
