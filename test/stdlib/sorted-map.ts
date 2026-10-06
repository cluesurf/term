// The sorted map is a B-tree written in Term (deck/base/code/sorted-map.tree, 2026-10-05), held to a reference on
// every backend: 180,000 seeded puts and drops over 30,000 keys, enough to split, borrow and merge nodes at three
// depths, answered with the length, every key in order, a lookup of each of the first hundred keys, and the least and
// greatest. The same draws are replayed here on a JavaScript Map, which is the reference. Then the order of texts:
// code point order, which puts an astral character after every one below it, where UTF-16 order would not.
// Run: npx tsx test/stdlib/sorted-map.ts   (SORTED_ONLY=typescript, rust, swift or kotlin runs one)

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

// sized for the tree's degree, 64 (sorted-map.tree): two thirds of the keys are held at the end, about 20,000, which
// two levels of at most 127 keys to a node cannot hold, so the churn splits, borrows and merges at three depths. At
// 1,000 keys, the size before the degree was measured, the tree was two levels and its middle was never exercised
const OPERATIONS = 180000
const KEYS = 30000

const PROGRAM = `load @term/base/sorted-map
  find sorted-map
  find make-sorted-map

load @term/base/ordering
  find ordering
  find from-numbers
  find from-texts

load @term/base/list
  find list
  find join

load @term/base/maybe
  find maybe
  find unwrap-or

task churn
  like text
  save m, make-sorted-map(from-numbers)
  save state, 12345
  save i, 0
  walk test
    hook test, is-below(i, ${OPERATIONS})
    hold
      save state, modulo(multiply(state, 48271), 2147483647)
      save key, modulo(state, ${KEYS})
      save state, modulo(multiply(state, 48271), 2147483647)
      fork test, is-below(modulo(state, 3), 2)
        hold
          put(m, key, multiply(key, 7))
        miss
          drop(m, key)
      save i, add(i, 1)
  save shown, make list
  walk keys(m)
    take one
    push(shown, <{one}>)
  save found, make list
  save j, 0
  walk test
    hook test, is-below(j, 100)
    hold
      push(found, <{unwrap-or(lookup(m, j), -1)}>)
      save j, add(j, 1)
  back <{length(m)}|{join(shown, <,>)}|{join(found, <,>)}|{unwrap-or(least(m), -1)}|{unwrap-or(greatest(m), -1)}>

task words
  like text
  save m, make-sorted-map(from-texts)
  put(m, <pear>, 3)
  put(m, <𝄞>, 9)
  put(m, <～>, 4)
  put(m, <apple>, 1)
  drop(m, <pear>)
  back join(keys(m), <,>)

task run
  like text
  back <{churn()}#{words()}>
`

// the same draws on a JavaScript Map: the reference answer
function reference(): string {
  const map = new Map<number, number>()
  let state = 12345

  for (let i = 0; i < OPERATIONS; i++) {
    state = (state * 48271) % 2147483647
    const key = state % KEYS
    state = (state * 48271) % 2147483647

    if (state % 3 < 2) {
      map.set(key, key * 7)
    } else {
      map.delete(key)
    }
  }

  const keys = [...map.keys()].sort((a, b) => a - b)
  const found = Array.from({ length: 100 }, (_, j) => map.get(j) ?? -1)

  return `${map.size}|${keys.join(',')}|${found.join(',')}|${keys[0] ?? -1}|${keys.at(-1) ?? -1}#apple,～,𝄞`
}

const EXPECTED = reference()
const dir = mkdtempSync(join(tmpdir(), 'term-sorted-'))
const only = process.env.SORTED_ONLY ?? ''

for (const backend of BACKENDS.filter(b => !only || b === only)) {
  const ran = runOn({ backend, program: PROGRAM, resolve: env => projectResolver(process.cwd(), env), dir, name: 'sorted' })

  if (ran.form === 'skipped') {
    console.log(`skip  ${backend}: ${ran.reason}`)
    continue
  }

  ok(
    `${backend}: 6,000 puts and drops answer what a Map does, and texts order by code point`,
    ran.form === 'ran' && ran.output === EXPECTED,
    ran.form === 'ran' ? `got ${ran.output.slice(0, 200)}... want ${EXPECTED.slice(0, 200)}...` : `${ran.stage}: ${ran.reason}`,
  )
}

console.log(`\nsorted-map: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
