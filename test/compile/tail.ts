// The tasks that are loops (compile/backend.ts, `tailTasks`), held both ways: a task whose every self call is a tail
// call becomes a loop on TypeScript and `tailrec` on Kotlin, and for every rule a task that must NOT, because a wrong
// one drops work (a non-tail call's result) or continues the wrong loop. The answers themselves, and a recursion deep
// enough to overflow a JavaScript stack, are held on all four toolchains by test/compile/meaning-native/tail.tree.
// Run: npx tsx test/compile/tail.ts

import { compile } from '@term/make/code/compile/compile'
import { tailTasks } from '@term/make/code/compile/backend'
import { emitKotlin } from '@term/make/code/compile/kotlin'

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

function tails(text: string): { names: string[]; ts: string; kotlin: string } {
  const built = compile({ file: 'main.tree', text }, { optimize: false })

  if (!built.ok) {
    throw new Error(built.diagnostics.map(d => d.message).join(' | '))
  }

  return { names: [...tailTasks(built.program).keys()], ts: built.typescript, kotlin: emitKotlin(built.program) }
}

// 1. a countdown with an accumulator: every self call a tail call
const sum = tails(`task sum-down
  take n, like number
  take acc, like number
  like number
  fork test
    hook test
      call is-equal
        read n
        code 0
    hook hold
      send back, read acc
  send back
    call sum-down
      call subtract
        read n
        code 1
      call add
        read acc
        read n
`)
ok('a task whose every self call is a tail call is a loop', sum.names.join() === 'sum-down', sum.names.join())
ok('TypeScript writes it inside while (true), its tail call rebinding the parameters', /while \(true\)/.test(sum.ts) && /n = __tail/.test(sum.ts) && /continue/.test(sum.ts), sum.ts)
ok('Kotlin marks it tailrec', /tailrec fun sumDown/.test(sum.kotlin), sum.kotlin.split('\n').find(l => /fun sumDown/.test(l)) ?? '')

// 2. a self call whose result is added to: not a tail call
const size = tails(`task count-down
  take n, like number
  like number
  fork test
    hook test
      call is-equal
        read n
        code 0
    hook hold
      send back, code 0
  send back
    call add
      code 1
      call count-down
        call subtract
          read n
          code 1
`)
ok('a self call whose result is used is NOT a loop', size.names.length === 0, size.names.join())

// 3. a tail call inside a walk: a continue there would continue the walk
const walked = tails(`task find
  take n, like number
  like number
  walk size
    bind base, code 0
    bind head, read n
    hook next
      take site, name i
      fork test
        hook test
          call is-above
            read i
            code 3
        hook hold
          send back
            call find
              call subtract
                read n
                code 1
  send back, read n
`)
ok('a self call inside a walk is NOT a loop', walked.names.length === 0, walked.names.join())

// 4. the task taken as a value
const value = tails(`task again
  take n, like number
  like number
  host f, read again
  fork test
    hook test
      call is-equal
        read n
        code 0
    hook hold
      send back, code 0
  send back
    call again
      call subtract
        read n
        code 1
`)
ok('a task also taken as a value is NOT a loop', value.names.length === 0, value.names.join())

console.log(`\ntail: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
