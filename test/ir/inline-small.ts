// The small-task inliner in ir/simplify.ts (`smallBody`): a task whose body is one `send back <expr>` is replaced by
// its value at a call whose arguments are all pure. Held both ways: where it must inline, and every reason it must not.
// Run: npx tsx test/ir/inline-small.ts

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

// the emitted TypeScript of a program, with `use` the only root, so a helper whose calls are all inlined is dropped
function emit(text: string): string {
  const built = compile({ file: 'main.tree', text }, { entryPoints: ['use'] })

  if (!built.ok) {
    throw new Error(built.diagnostics.map(d => d.message).join(' | '))
  }

  return built.typescript
}

const helper = `task twice
  take x, like number
  like number
  send back
    call multiply
      read x
      code 2
`

// 1. pure arguments: inlined, and the helper is dropped once nothing calls it
const inlined = emit(`${helper}
task use
  take n, like number
  like number
  send back
    call twice
      read n
`)
ok('a call with a pure argument is replaced by the value', !/twice\(/.test(inlined) && /n \* 2/.test(inlined), inlined)

// 2. an impure argument (a call) keeps the call, so the argument is evaluated once and in order
const impure = emit(`${helper}
task bump
  take n, like number
  like number
  send back
    call add
      read n
      code 1

task use
  take n, like number
  like number
  send back
    call twice
      call bump
        read n
`)
ok('a call whose argument is itself a call is NOT inlined', /twice\(/.test(impure), impure)

// 3. capture: the helper reads a module constant `limit`, and the caller binds its own `limit`
const captured = emit(`host limit, code 10

task capped
  take x, like number
  like number
  send back
    call add
      read x
      read limit

task use
  take n, like number
  like number
  save limit
    call add
      read n
      code 3
  send back
    call add
      call capped
        read n
      read limit
`)
// the caller's own `limit` is live (it is read after the call), so inlining `x + limit` here would read the caller's
ok('a body name the caller binds itself is NOT inlined into it', /capped\(/.test(captured), captured)

// 4. an `unknown` result is boxed at the boundary on Rust, so it is never inlined
const boxed = emit(`task wrap
  take x, like number
  like unknown
  send back, read x

task use
  take n, like number
  like unknown
  send back
    call wrap
      read n
`)
ok('a task answering `unknown` is NOT inlined', /wrap\(/.test(boxed), boxed)

// 5. an async task is awaited by its caller, so it is never inlined
const awaited = emit(`task later
  take x, like number
  like number
  note async
  send back, read x

task use
  take n, like number
  like number
  note async
  send back
    call later
      read n
      wait true
`)
ok('an async task is NOT inlined', /later\(/.test(awaited), awaited)

console.log(`\ninline-small: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
