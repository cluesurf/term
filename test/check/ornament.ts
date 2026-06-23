// Ornaments: the relation between an INDEXED family and its UNINDEXED version. The canonical ornament is the
// length-indexed vector `vecnat n` over the plain list `stack nat`: the vector is the list "ornamented" with a length
// index. The forgetful map `forget : vecnat n -> stack nat` drops the index; the ORNAMENT LAW is that the dropped index
// is recoverable as a property of the unindexed image -- `length (forget v) == n`. Here we verify that recovery law on
// concrete vectors (length 1 and length 2): the index the family was carrying is exactly the length of the forgetful
// list, so the indexed family really is the unindexed one decorated with a recomputable measure. Soundness control: a
// wrong recovered index is rejected. Run: npx tsx test/check/ornament.ts

import { compile } from '@cluesurf/make/code/compile/compile'

let pass = 0
let fail = 0

function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  ${detail}`)
  }
}

function compiles(source: string): boolean {
  return compile({ file: 'p.tree', text: source }).ok
}

// nat, the plain list `stack a`, and the length-indexed `vecnat n`; the forgetful map `forget` and the `length` measure.
const PRELUDE = `form nat
  case zero
  case succ
    link prior, like nat

form stack
  head a
  case empty
  case push
    link top, like a
    link rest, like stack
      head a

form vecnat
  head n, like nat
  case vnil
    head
      make zero
  case vcons
    link count, like nat
    link item, like nat
    link rest, like vecnat
      head
        read count
    head
      make succ
        bind prior
          read count

task length
  take s, like stack
    head nat
  like nat
  fork case, read s
    case empty
      send back
        make zero
    case push
      link top
      link rest
      send back
        make succ
          bind prior
            call length
              read rest

task forget
  take n, like nat
  take v, like vecnat
    head
      read n
  like stack
    head nat
  fork case, read v
    case vnil
      send back
        make empty
    case vcons
      link count
      link item
      link rest
      send back
        make push
          bind top
            read item
          bind rest
            call forget
              read count
              read rest
`

// 1. Recovery on a length-1 vector: length (forget [0]) == 1. The forgetful map throws the index away, the length
// measure recomputes it, and they agree -- the ornament round-trips.
ok(
  'ornament recovers the index: length (forget v1) == 1',
  compiles(`${PRELUDE}
rule recover-one
  show hold
    call is-equal
      call length
        call forget
          make succ
            bind prior
              make zero
          make vcons
            bind count
              make zero
            bind item
              make zero
            bind rest
              make vnil
      make succ
        bind prior
          make zero
  calm hold
`),
)

// 2. Recovery on a length-2 vector: length (forget [0,0]) == 2.
ok(
  'ornament recovers the index: length (forget v2) == 2',
  compiles(`${PRELUDE}
rule recover-two
  show hold
    call is-equal
      call length
        call forget
          make succ
            bind prior
              make succ
                bind prior
                  make zero
          make vcons
            bind count
              make succ
                bind prior
                  make zero
            bind item
              make zero
            bind rest
              make vcons
                bind count
                  make zero
                bind item
                  make zero
                bind rest
                  make vnil
      make succ
        bind prior
          make succ
            bind prior
              make zero
  calm hold
`),
)

// 3. SOUNDNESS CONTROL: length (forget v1) is 1, not 2. A wrong recovered index must be rejected.
ok(
  'wrong recovered index is rejected (length (forget v1) != 2)',
  !compiles(`${PRELUDE}
rule recover-wrong
  show hold
    call is-equal
      call length
        call forget
          make succ
            bind prior
              make zero
          make vcons
            bind count
              make zero
            bind item
              make zero
            bind rest
              make vnil
      make succ
        bind prior
          make succ
            bind prior
              make zero
  calm hold
`),
)

// 4. The GENERAL ornament law, for EVERY n and every vector of that length: length (forget v) == n. This is proven by
// DEPENDENT INDUCTION over the indexed family -- `fold v` refines the length index per constructor (vnil -> the index is
// zero; vcons count .. -> the index is succ count) in both the case goal and the induction hypothesis, so the recursive
// case closes from the hypothesis at `count`. This is the real ornament theorem: the index is recoverable on all data.
ok(
  'general ornament law by dependent induction: forall v, length (forget v) == n',
  compiles(`${PRELUDE}
rule recover-all
  mark n, like nat
  mark v, like vecnat
    head
      read n
  show hold
    call is-equal
      call length
        call forget
          read n
          read v
      read n
  fold v
`),
)

// 5. SOUNDNESS CONTROL for the general law: length (forget v) is n, not succ n. The dependent induction must NOT close a
// false universal -- the vnil case would need 0 == succ 0.
ok(
  'wrong general ornament law is rejected (length (forget v) != succ n)',
  !compiles(`${PRELUDE}
rule recover-all-wrong
  mark n, like nat
  mark v, like vecnat
    head
      read n
  show hold
    call is-equal
      call length
        call forget
          read n
          read v
      make succ
        bind prior
          read n
  fold v
`),
)

console.log(`\nornament: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
