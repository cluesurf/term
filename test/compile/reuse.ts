// Record reuse (compile/place.ts, `recordReuse`), held both ways: the sites where a task may build its result in the
// object it is given, and for every rule a program where it must NOT, because a wrong one changes a value another name
// still holds. The answers themselves are held on all four toolchains by test/compile/meaning-native/reuse.tree.
// Run: npx tsx test/compile/reuse.ts

import { compile } from '@term/make/code/compile/compile'
import { stdlibResolver } from '@term/make/code/resolve'
import { withNativeEnv } from '@term/make/code/compile/native'
import { recordReuse } from '@term/make/code/compile/place'
import { emitTypeScript } from '@term/make/code/compile/typescript'

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

// the tasks that reuse, and the TypeScript, of a program built from the base and `use`
function reuse(use: string, extra = ''): { tasks: string[]; ts: string } {
  const text = `load @term/base/list
  find list
  find push

form dot
  link x, like number
  link v, like number

form step
  link dot, like dot
  link hit, like boolean

# a dot moved once: a new dot from the old one's fields
task move
  take d, like dot
  like dot
  send back
    make dot
      bind x
        call add
          read d/x
          read d/v
      bind v, read d/v

# the same, and whether it passed 10
task stride
  take d, like dot
  like step
  host x
    call add
      read d/x
      read d/v
  send back
    make step
      bind dot
        make dot
          bind x, read x
          bind v, read d/v
      bind hit
        call is-above
          read x
          code 10
${extra}
task use
  like number
  save dots
    make list
  call push
    bind list, read dots
    bind item
      make dot
        bind x, code 1
        bind v, code 4
${use}
  send back, read dots/0/x
`
  const built = compile({ file: 'main.tree', text }, { resolve: withNativeEnv('node', stdlibResolver()!), env: 'node', entryPoints: ['use'] })

  if (!built.ok) {
    throw new Error(built.diagnostics.map(d => d.message).join(' | '))
  }

  return { tasks: [...recordReuse(built.program).tasks.keys()], ts: built.typescript }
}

// 1. the slot written with the task's result in the same statement
const direct = reuse(`  save dots/0
    call move
      read dots/0`)
ok('a slot written with the result of a call given that slot reuses', direct.tasks.join() === 'move', direct.tasks.join())
ok('TypeScript assigns the fields on the object and answers it', /moveReuse\(/.test(direct.ts) && /d\.x = __reuse/.test(direct.ts), direct.ts.slice(direct.ts.indexOf('function moveReuse')))

// 2. through a carrier, written back at once, the carrier read after only for its other field
const carried = reuse(`  host s
    call stride
      read dots/0
  save dots/0, read s/dot
  fork test
    hook test
      read s/hit
    hook hold
      save dots/0
        call move
          read dots/0`)
ok('a carrier written back at once reuses, and the flag is answered alone', carried.tasks.includes('stride') && /function strideReuse\(d: Dot\): boolean/.test(carried.ts), carried.tasks.join())

// 3. a local read from the slot, alive across the call: the old value must stay
const kept = reuse(`  save before, read dots/0
  save dots/0
    call move
      read dots/0
  save dots/0
    make dot
      bind x
        call add
          read dots/0/x
          read before/x
      bind v, code 0`)
ok('a local holding the slot\'s object refuses reuse of its form', kept.tasks.length === 0, kept.tasks.join())

// 4. a walk over the list: its item is a second name for each object
const walked = reuse(`  walk list, read dots
    hook next
      take site, name d
      save dots/0
        call move
          read dots/0`)
ok('a walk over a list of the form refuses reuse', walked.tasks.length === 0, walked.tasks.join())

// 5. the result written to ANOTHER slot: the old object stays where it was
const other = reuse(`  call push
    bind list, read dots
    bind item
      make dot
        bind x, code 2
        bind v, code 0
  save dots/1
    call move
      read dots/0`)
ok('a result written to another slot is not a reuse site', other.tasks.length === 0, other.tasks.join())

// 6. a task that passes its record on, rather than only reading its fields
const passes = reuse(
  `  save dots/0
    call relay
      read dots/0`,
  `task relay
  take d, like dot
  like dot
  send back
    call move
      read d
`,
)
ok('a task that passes its record on does not reuse it', !passes.tasks.includes('relay'), passes.tasks.join())

// 7. the carrier read after for the record it carries: that would be the reused object again
const reread = reuse(`  host s
    call stride
      read dots/0
  save dots/0, read s/dot
  save dots/0
    make dot
      bind x, read s/dot/x
      bind v, code 0`)
ok('a carrier read again for its record is not a reuse site', reread.tasks.length === 0, reread.tasks.join())

console.log(`\nreuse: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
