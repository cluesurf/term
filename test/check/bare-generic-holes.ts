// A generic task whose signature names a generic form bare (native-dom-0044, 0046): `like box` where `like box t` was
// meant. The bare form is seeded one hole that is not among the task's generics. Each call now resolves it for itself:
// linked by the body to a declared generic it takes that generic's fresh copy, still free (a module-level `host` is
// checked before every function body) it takes a variable of its own. Shared, the first call to bind it decided it for
// the whole program: a host making a box of text made every later box a box of text.
// Run: npx tsx test/check/bare-generic-holes.ts

import { compile } from '@term/make/code/compile/compile'

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

const BOX = `form box
  note shared
  head t
  link value, like t

# bare: \`like box\`, not \`like box t\`
task make-box
  head t
  take value, like t
  like box
  send back
    make box
      bind value, read value
`

const check = (name: string, text: string, want: boolean) => {
  const result = compile({ file: 'holes.tree', text })
  ok(name, result.ok === want, result.ok ? '' : result.diagnostics.map(d => d.message).join(' | '))
}

// the shape of native-dom-0044: a host makes it at text before any body is checked, a task at a number
check(
  'a host making a box of text does not make every box a box of text',
  `${BOX}
form held
  note shared
  link name, like box text

host kept
  make held
    bind name
      call make-box
        bind value, text <hi>

task count-box
  like box number
  send back
    call make-box
      bind value, code 3
`,
  true,
)

// two hosts at two types
check(
  'two hosts make boxes of two types',
  `${BOX}
form held
  note shared
  link name, like box text
  link size, like box number

host kept
  make held
    bind name
      call make-box
        bind value, text <hi>
    bind size
      call make-box
        bind value, code 3
`,
  true,
)

// the link the body makes still carries: called after its body is checked, the result follows the argument, so a
// mismatch is still refused
check(
  "the body's link from argument to result still holds: a box of text is not a box of number",
  `${BOX}
task wrong
  like box number
  send back
    call make-box
      bind value, text <hi>
`,
  false,
)

console.log(`\nbare-generic-holes: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
