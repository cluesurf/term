// A VALUE IS COPIED AT THE STORE, DECIDED AT COMPILE TIME (decision 115 of
// note/project/term/self-host/change/001-finish-self-host, item term-self-host-001-0888). A form not marked shared, a union
// included, is a value on every backend (D1): a write through one name never reaches another, and no value can hold
// itself. Each program is built and RUN on TypeScript, Rust, Swift and Kotlin, and every backend must print the same text.
//
// Held, each a leg of tmp/self-host/0887/four.ts or of the decision:
// - `save t/left, t` in a `case node` arm makes t a node whose left is the old t (depth 2): before, TypeScript overflowed
//   the stack (t held itself) and Rust, Swift and Kotlin did not build (the arm's local was written, or a val).
// - a record stored in a `make` and written after keeps the holder's copy (1): before, TypeScript and Kotlin answered 5.
// - `save r/u, make(node, bind(r, r))`, a record holding a union that holds the record, ends (1).
// - a union parameter written in an arm (node.tree `with-type`'s shape) leaves the caller's value as it was.
// - the plain record legs that already held: an aliasing let and a written parameter.
// Run: npx tsx test/compile/value-store-native.ts   (from deck/term/deck/term; SLOT_ONLY=typescript|rust|swift|kotlin,
// SLOT_CASE=<name>)
// A TypeScript test, not a `term test`: it builds with each native toolchain.

import { projectResolver } from '@term/call/code/make'
import { tempDir } from '../temp'
import { BACKENDS, runOn } from './shared/run-on'
import type { Backend } from './shared/run-on'

const FORMS = `form tree
  case leaf
  case node
    link left, like tree

task depth
  take t, like tree
  like number
  sift t
    case leaf
      back 0
    case node
      back add(depth(left), 1)

form pair
  link x, like number
  link y, like number

form holder
  link p, like pair
`

// `gap` names a backend a case cannot pass on yet, and why: never the store this file holds
const CASES: { name: string; expected: string; body: string; gap?: Partial<Record<Backend, string>> }[] = [
  {
    // the arm writes the matched subject, and the stored value is the subject as it was
    name: 'arm-write-self',
    expected: '2',
    body: `task run
  like text
  save t, make(node, bind(left, make leaf))
  sift t
    case node
      save t/left, t
    case leaf
      back <leaf>
  back <{depth(t)}>
`,
  },
  {
    // the arm writes the subject with a value that does not hold it
    name: 'arm-write-other',
    expected: '1 2',
    body: `task run
  like text
  save t, make(node, bind(left, make leaf))
  save before, depth(t)
  sift t
    case node
      save t/left, make(node, bind(left, make leaf))
    case leaf
      back <leaf>
  back <{before} {depth(t)}>
`,
  },
  {
    // a record stored in a make, then written: the holder keeps the value as stored
    name: 'stored-then-written',
    expected: '1 5',
    body: `task run
  like text
  save a, make(pair, bind(x, 1), bind(y, 1))
  save h, make(holder, bind(p, a))
  save a/x, 5
  back <{h/p/x} {a/x}>
`,
  },
  {
    // a record stored into a field, then written
    name: 'field-stored-then-written',
    expected: '1 7',
    body: `task run
  like text
  save a, make(pair, bind(x, 1), bind(y, 1))
  save h, make(holder, bind(p, make(pair, bind(x, 0), bind(y, 0))))
  save h/p, a
  save a/x, 7
  back <{h/p/x} {a/x}>
`,
  },
  {
    // a record holding a union that holds the record: the store holds the root, so the root is rebuilt
    name: 'root-in-make',
    expected: '1',
    // rustc E0072 before any store: a record and a union that hold each other are not boxed (the recursive fields
    // reach only a form that holds itself), item 0888's log.md entry
    gap: { rust: 'a record and a union holding each other are not boxed on Rust (E0072), apart from the store' },
    body: `form room
  link u, like door
  link n, like number

form door
  case shut
  case open
    link r, like room

task count-rooms
  take r, like room
  like number
  save at, r/u
  sift at
    case shut
      back 1
    case open
      back add(count-rooms(r), 1)

task run
  like text
  save r, make(room, bind(u, make shut), bind(n, 1))
  save r/u, make(open, bind(r, r))
  save inner, r/u
  sift inner
    case open
      back <{count-rooms(r)}>
    case shut
      back <shut>
`,
  },
  {
    // a union parameter written in an arm, as node.tree with-type writes its expression: the caller's value stays
    name: 'union-param-written',
    expected: '1 9',
    body: `form shape
  case dot
    link size, like number
  case box
    link size, like number

task grow
  take s, like shape
  like shape
  sift s
    case dot
      save s/size, 9
    case box
      save s/size, 8
  back s

task size-of
  take s, like shape
  like number
  sift s
    case dot
      back size
    case box
      back size

task run
  like text
  save a, make(dot, bind(size, 1))
  save b, grow(a)
  back <{size-of(a)} {size-of(b)}>
`,
  },
  {
    // the legs that held before: an aliasing let and a written parameter
    name: 'alias-and-param',
    expected: '1 1',
    body: `task bump
  take p, like pair
  like number
  save p/x, 9
  back p/x

task run
  like text
  save a, make(pair, bind(x, 1), bind(y, 1))
  save b, a
  save b/x, 2
  save n, bump(a)
  back <{a/x} {a/x}>
`,
  },
]

const dir = tempDir('value-store-')
const only = process.env.SLOT_ONLY ?? ''
const caseOnly = process.env.SLOT_CASE ?? ''
let pass = 0
let fail = 0
let skipped = 0

for (const one of CASES.filter(c => !caseOnly || c.name === caseOnly)) {
  for (const backend of BACKENDS.filter(b => !only || b === only)) {
    const gap = one.gap?.[backend]

    if (gap) {
      skipped++
      console.log(`gap   ${one.name} ${backend}: ${gap}`)
      continue
    }

    const ran = runOn({
      backend,
      program: `${FORMS}\n${one.body}`,
      resolve: env => projectResolver(process.cwd(), env),
      dir,
      name: `v-${one.name}`,
    })

    if (ran.form === 'skipped') {
      skipped++
      console.log(`skip  ${one.name} ${backend}: ${ran.reason}`)
    } else if (ran.form === 'ran' && ran.output === one.expected) {
      pass++
      console.log(`ok    ${one.name} ${backend}`)
    } else {
      fail++
      console.log(
        `FAIL  ${one.name} ${backend}: ${ran.form === 'ran' ? `got ${JSON.stringify(ran.output)}` : `${ran.stage}: ${ran.reason.slice(0, 400)}`}`,
      )
    }
  }
}

console.log(`value-store-native: ${pass} pass, ${fail} fail, ${skipped} skipped`)

if (fail > 0) {
  process.exit(1)
}
