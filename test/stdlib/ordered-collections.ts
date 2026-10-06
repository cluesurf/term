// `list/bag`, `list/ordered-set` and `list/linked-list`, marked stable on 2026-10-05, held to one answer on every
// backend: what v1 promises of them. The bag counts each value in a hash (O(1) insert, remove, count-of), the ordered
// set is a hash's insertion-ordered keys (O(1) membership), and the linked list walks itself in loops, so a long one
// needs no deep stack. Each was list-backed or recursive before, and none had a test past TypeScript.
// Run: npx tsx test/stdlib/ordered-collections.ts   (COLLECTION_ONLY=typescript, rust, swift or kotlin runs one)

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectResolver } from '@term/call/code/make'
import { BACKENDS, runOn } from '../compile/shared/run-on'

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

const PROGRAM = `load @term/base/list/bag
  find bag

load @term/base/list/ordered-set
  find ordered-set

load @term/base/list/linked-list
  find linked-list
  find from-list

load @term/base/set
  find set

load @term/base/list
  find list
  find join

load @term/base/maybe
  find maybe

# a bag: three copies of 5 and one of 2, then one 5 taken out, and a value it never held taken out too
task bag-story
  like text
  save b, make(bag)
  insert(b, 5)
  insert(b, 2)
  insert(b, 5)
  insert(b, 5)
  save took, remove(b, 5)
  save missed, remove(b, 9)
  save shown, make list
  walk to-list(b)
    take one
    push(shown, <{one}>)
  back <{length(b)} {distinct(b)} {count-of(b, 5)} {count-of(b, 7)} {contains(b, 2)} {took} {missed} {join(shown, <,>)}>

# an ordered set: first-insertion order kept, a second insert of 3 changing nothing, a removal keeping the rest in order
task set-story
  like text
  save s, make(ordered-set)
  insert(s, 3)
  insert(s, 1)
  insert(s, 3)
  insert(s, 2)
  save gone, remove(s, 1)
  save shown, make list
  walk to-list(s)
    take one
    push(shown, <{one}>)
  back <{length(s)} {has(s, 3)} {has(s, 1)} {gone} {join(shown, <,>)}>

# a plain set, the same story: it keeps insertion order too (set.tree, decisions-2026-10.md, D13)
task plain-set-story
  like text
  save s
    make set
      bind items, make hash
  insert(s, 3)
  insert(s, 1)
  insert(s, 3)
  insert(s, 2)
  remove(s, 1)
  save shown, make list
  walk to-list(s)
    take one
    push(shown, <{one}>)
  back <{length(s)} {has(s, 3)} {has(s, 1)} {join(shown, <,>)}>

# a linked list: built from a list, reversed, measured, its head and tail read, and a long one measured in a loop
task chain-story
  like text
  save l, from-list(make(list, 1, 2, 3))
  save r, reverse(l)
  save shown, make list
  walk to-list(r)
    take one
    push(shown, <{one}>)
  save first, unwrap-or(head(l), 0)
  save rest, length(unwrap-or(tail(l), make(empty)))
  save long, make(empty)
  save i, 0
  walk test
    hook test, is-below(i, ${process.env.CHAIN_LENGTH ?? '200000'})
    hold
      save long, prepend(long, i)
      save i, add(i, 1)
  back <{length(l)} {join(shown, <,>)} {first} {rest} {is-empty(make(empty))} {length(long)}>

task run
  like text
  back <{bag-story()} | {set-story()} | {plain-set-story()} | {chain-story()}>
`

// bag: 3 copies left (5, 5, 2), 2 distinct, two 5s, no 7, a 2, a 5 taken, no 9 to take, and the copies grouped by
// first insertion. set: 3 and 2 left of 3, 1, 2, in that order. chain: 3 long, reversed, head 1, a tail of 2, an empty
// list empty, and 200,000 nodes measured
const EXPECTED = `3 2 2 0 true true false 5,5,2 | 2 true false true 3,2 | 2 true false 3,2 | 3 3,2,1 1 2 true ${process.env.CHAIN_LENGTH ?? '200000'}`

const dir = mkdtempSync(join(tmpdir(), 'term-ordered-'))
const only = process.env.COLLECTION_ONLY ?? ''

for (const backend of BACKENDS.filter(b => !only || b === only)) {
  const ran = runOn({ backend, program: PROGRAM, resolve: env => projectResolver(process.cwd(), env), dir, name: 'collections' })

  if (ran.form === 'skipped') {
    console.log(`skip  ${backend}: ${ran.reason}`)
    continue
  }

  ok(
    `${backend}: bag, ordered set and linked list answer alike`,
    ran.form === 'ran' && ran.output === EXPECTED,
    ran.form === 'ran' ? `got ${JSON.stringify(ran.output)}` : `${ran.stage}: ${ran.reason}`,
  )
}

console.log(`\nordered-collections: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
