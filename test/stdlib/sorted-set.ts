// The sorted set, over the sorted map's B-tree (deck/base/code/sorted-set.tree, 2026-10-05), on every backend: 180,000
// seeded adds and removes over 30,000 values against a JavaScript Set kept sorted, then its ends and its order. Sized
// for the tree's degree, 64: about 20,000 values are held at the end, three levels of nodes, where 500 was one leaf.
// Run: npx tsx test/stdlib/sorted-set.ts   (SORTED_ONLY=typescript, rust, swift or kotlin runs one)

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

const OPERATIONS = 180000
const VALUES = 30000

const PROGRAM = `load @term/base/sorted-set
  find sorted-set
  find make-sorted-set

load @term/base/ordering
  find ordering
  find from-numbers

load @term/base/list
  find list
  find join

load @term/base/maybe
  find maybe
  find unwrap-or

task run
  like text
  save s, make-sorted-set(from-numbers)
  save state, 777
  save i, 0
  save removed, 0
  walk test
    hook test, is-below(i, ${OPERATIONS})
    hold
      save state, modulo(multiply(state, 48271), 2147483647)
      save value, modulo(state, ${VALUES})
      save state, modulo(multiply(state, 48271), 2147483647)
      fork test, is-below(modulo(state, 3), 2)
        hold
          insert(s, value)
        miss
          fork test, remove(s, value)
            hold
              save removed, add(removed, 1)
      save i, add(i, 1)
  save shown, make list
  walk to-list(s)
    take one
    push(shown, <{one}>)
  back <{length(s)}|{removed}|{has(s, 3)}|{unwrap-or(least(s), -1)}|{unwrap-or(greatest(s), -1)}|{join(shown, <,>)}>
`

function reference(): string {
  const set = new Set<number>()
  let state = 777
  let removed = 0

  for (let i = 0; i < OPERATIONS; i++) {
    state = (state * 48271) % 2147483647
    const value = state % VALUES
    state = (state * 48271) % 2147483647

    if (state % 3 < 2) {
      set.add(value)
    } else if (set.delete(value)) {
      removed++
    }
  }

  const sorted = [...set].sort((a, b) => a - b)

  return `${set.size}|${removed}|${set.has(3)}|${sorted[0] ?? -1}|${sorted.at(-1) ?? -1}|${sorted.join(',')}`
}

const EXPECTED = reference()
const dir = mkdtempSync(join(tmpdir(), 'term-sorted-set-'))
const only = process.env.SORTED_ONLY ?? ''

for (const backend of BACKENDS.filter(b => !only || b === only)) {
  const ran = runOn({ backend, program: PROGRAM, resolve: env => projectResolver(process.cwd(), env), dir, name: 'sorted-set' })

  if (ran.form === 'skipped') {
    console.log(`skip  ${backend}: ${ran.reason}`)
    continue
  }

  ok(
    `${backend}: 3,000 adds and removes answer what a sorted Set does`,
    ran.form === 'ran' && ran.output === EXPECTED,
    ran.form === 'ran' ? `got ${ran.output.slice(0, 160)}... want ${EXPECTED.slice(0, 160)}...` : `${ran.stage}: ${ran.reason}`,
  )
}

console.log(`\nsorted-set: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
