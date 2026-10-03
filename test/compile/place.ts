// The in-place record write (compile/place.ts), held both ways: the writes it must make in place, and for every rule a
// program it must NOT, because a wrong one changes a value somebody else still holds. The answers themselves are held
// on all four toolchains by test/compile/meaning-native/place.tree.
// Run: npx tsx test/compile/place.ts

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { stdlibResolver } from '@term/make/code/resolve'
import { withNativeEnv } from '@term/make/code/compile/native'
import { gatedTasks, listFacts } from '@term/make/code/compile/backend'
import { placeWrites, privateForms } from '@term/make/code/compile/place'
import { emitTypeScript } from '@term/make/code/compile/typescript'
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

const stdlib = stdlibResolver()!

function facts(text: string): { forms: Set<string>; writes: string[]; program: Program } {
  const built = compile({ file: 'main.tree', text }, { resolve: withNativeEnv('node', stdlib), env: 'node' })

  if (!built.ok) {
    throw new Error(built.diagnostics.map(d => d.message).join(' | '))
  }

  const program = built.program
  const masks = new Set(program.flatMap(n => (n.form === 'mask' ? n.methods : [])))
  const { lend, fresh } = listFacts(program, gatedTasks(program, masks))
  const forms = privateForms(program, lend, fresh)
  const writes = [...placeWrites(program, forms).values()].map(w => `${w.local}:${w.fields.map(f => f.name).join(',')}`)

  return { forms, writes, program }
}

const TERM = join(import.meta.dirname, '..', '..')

// 1. the meaning fixture: the pair loop in place, the three hazards not
const fixture = facts(readFileSync(join(TERM, 'test/compile/meaning-native/place.tree'), 'utf8'))
ok('point is slot-private, pin is not', fixture.forms.has('point') && !fixture.forms.has('pin'), [...fixture.forms].join(' '))
ok('only the pair loop is written in place, both of its writes', JSON.stringify(fixture.writes) === JSON.stringify(['p:a', 'q:b']), fixture.writes.join(' | '))

// 2. n-body: the four writes, and the TypeScript it drives
const nbody = facts(readFileSync(join(TERM, 'mark/kernels/n-body/term.tree'), 'utf8'))
ok('n-body writes all four in place', nbody.writes.length === 4, nbody.writes.join(' | '))
const ts = emitTypeScript(nbody.program)
ok('TypeScript assigns the changed fields and allocates nothing', /bi\.vx = bi\.vx - dx \* mj/.test(ts) && !/__termPut\(bodies/.test(ts))

const base = `load @term/base/list
  find list
  find push
  find get

form spot
  link a, like number

task spots
  like list, like spot
  save out
    make list
  call push
    read out
    make spot
      bind a, code 1
  call push
    read out
    make spot
      bind a, code 2
  send back, read out

task bump
  take xs, like list, like spot
  save s
    call get
      read xs
      code 0
  save xs/0
    make spot
      bind a
        call add
          read s/a
          code 1
`

// 3-7. what must NOT be private, each beside the same program without the hazard
ok('the plain program is private and written in place', facts(`${base}
task compute
  like number
  save xs
    call spots
  call bump
    read xs
  save s
    call get
      read xs
      code 0
  send back, read s/a
`).writes.length === 1)

// a second name for the list is the same list (lists are references on all four backends today; D1's list values
// arrive with self-hosting-0026), so a write through it is a write to the same slot. A COPY is the hazard: it holds
// the same objects in a second list
ok(
  'a list copied by slice is NOT private (the copy shares its elements)',
  !facts(`${base}
task compute
  like number
  save xs
    call spots
  save ys
    call xs/slice
      code 0
  call bump
    read xs
  save s
    call get
      read ys
      code 0
  send back, read s/a
`).forms.has('spot'),
)

ok(
  'an element passed whole to a task is NOT private',
  !facts(`${base}
task keep
  take s, like spot
  like number
  send back, read s/a

task compute
  like number
  save xs
    call spots
  call bump
    read xs
  send back
    call keep
      call get
        read xs
        code 1
`).forms.has('spot'),
)

ok(
  'one slot copied into another is NOT private (two slots, one object)',
  !facts(`${base}
task compute
  like number
  save xs
    call spots
  save xs/1
    call get
      read xs
      code 0
  call bump
    read xs
  send back, code 0
`).forms.has('spot'),
)

ok(
  'a list handed to a generic task other than get and push is NOT private',
  !facts(`${base}
load @term/base/list
  find first

task compute
  like number
  save xs
    call spots
  call bump
    read xs
  call first
    read xs
  send back, code 0
`).forms.has('spot'),
)

// 8. private, but a write whose local is read again for the changed field stays a make (`bump`'s, from the shared
// program, is the one write in place)
ok(
  'a changed field read after the write keeps the write a make',
  facts(`${base}
task again
  take xs, like list, like spot
  like number
  save s
    call get
      read xs
      code 0
  save xs/0
    make spot
      bind a
        call add
          read s/a
          code 1
  send back, read s/a

task compute
  like number
  save xs
    call spots
  send back
    call again
      read xs
`).writes.length === 1,
)

console.log(`\nplace: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
