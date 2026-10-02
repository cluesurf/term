// A number where text is declared is refused (native-dom-0022). The checker once accepted a `like task / like text`
// getter whose body sent back a `read-signal` of a number signal, because `read-signal` returned `like any`;
// TypeScript ran it and swiftc was the first to refuse. `read-signal` is generic now, and every shape below must be
// refused at build time, on every backend, before any native compiler sees it.
// Run: npx tsx test/check/declared-text.ts

import { compile } from '@term/make/code/compile/compile'
import { projectResolver } from '@term/call/code/make'

let pass = 0
let fail = 0

function ok(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  ${info}`)
  }
}

const REACTIVE = `load @term/site/code/view/reactive
  find make-signal
  find read-signal
  find signal
`

const GETTER = `task show-it
  take getter
    like task
      like text
  like text
  send back, call getter
`

const cases: Record<string, string> = {
  'a number sent back': `task f\n  like text\n  send back, code 3\n`,
  'through a local': `task f\n  like text\n  save n, code 3\n  send back, read n\n`,
  'from a number task': `task three\n  like number\n  send back, code 3\n\ntask f\n  like text\n  send back, call three\n`,
  'from a closure declared text': `task f\n  like text\n  save get\n    task inner\n      like text\n      send back, code 3\n  send back, call get\n`,
  'through a generic identity': `task same\n  head t\n  take x, like t\n  like t\n  send back, read x\n\ntask f\n  like text\n  send back\n    call same\n      code 3\n`,
  'a read-signal of a number signal': `${REACTIVE}
task f
  like text
  save s
    call make-signal
      bind value, code 3
  send back
    call read-signal
      bind self, read s
`,
  'a text getter closure over a number signal': `${REACTIVE}
task f
  like text
  save s
    call make-signal
      bind value, code 3
  save get
    task inner
      like text
      send back
        call read-signal
          bind self, read s
  send back, call get
`,
  'a closure declared text passed as a text getter': `${GETTER}
task f
  like text
  send back
    call show-it
      task inner
        like text
        send back, code 3
`,
  'an undeclared closure passed as a text getter': `${GETTER}
task f
  like text
  send back
    call show-it
      task inner
        send back, code 3
`,
}

for (const env of ['node', 'swift', 'kotlin'] as const) {
  for (const [name, text] of Object.entries(cases)) {
    const result = compile({ file: '/tmp/declared-text.tree', text }, { resolve: projectResolver(process.cwd(), env), env })
    ok(`${env}: ${name} is refused`, !result.ok, result.ok ? 'it compiled' : '')
  }
}

// the control: the same getter with text in it compiles, so the refusals above are about the number
const control = compile(
  { file: '/tmp/declared-text.tree', text: `${GETTER}\ntask f\n  like text\n  send back\n    call show-it\n      task inner\n        like text\n        send back, text <three>\n` },
  { resolve: projectResolver(process.cwd(), 'node'), env: 'node' },
)
ok('the control, text in the getter, compiles', control.ok, control.ok ? '' : control.diagnostics.map(d => d.message).join(' | '))

console.log(`\ndeclared-text: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
