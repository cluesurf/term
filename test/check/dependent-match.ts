// Dependent pattern matching with per-branch index REFINEMENT. When a match on an indexed family has a result type that
// depends on the scrutinee's index, the dependent eliminator's motive must express the result through the DESTRUCTURED
// index, not as a constant. For `vecnat (succ n)` the only reachable constructor is `vcons count ..` with index
// `succ count`, and refining the result `vecnat n` to `vecnat count` under that branch is what types a SAFE vector tail
// (`vecnat (succ n) -> vecnat n`) and a safe head. This is genuine dependent pattern matching: the impossible `vnil`
// branch is omitted (ex-falso), and the result type refines per branch. Run: npx tsx test/check/dependent-match.ts

import { compile } from '@term/make/code/compile/compile'

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

const PRELUDE = `form nat
  case zero
  case succ
    link prior, like nat

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
`

// 1. SAFE TAIL: `vecnat (succ n) -> vecnat n`. The result `vecnat n` must refine to `vecnat count` under the `vcons`
// branch (whose index is `succ count`), and the impossible `vnil` is omitted. This only type-checks with per-branch
// index refinement in the dependent motive.
ok(
  'safe vector tail type-checks: vecnat (succ n) -> vecnat n',
  compiles(`${PRELUDE}
task vtail
  take n, like nat
  take v, like vecnat
    head
      make succ
        bind prior
          read n
  like vecnat
    head
      read n
  fork case, read v
    case vcons
      link count
      link item
      link rest
      send back
        read rest
`),
)

const VHEAD = `${PRELUDE}
task vhead
  take n, like nat
  take v, like vecnat
    head
      make succ
        bind prior
          read n
  like nat
  fork case, read v
    case vcons
      link count
      link item
      link rest
      send back
        read item
`

// 2. SAFE HEAD computes through the refined match: vhead (cons 1 nil) == 1.
ok(
  'safe vector head computes: vhead (cons 1 nil) == 1',
  compiles(`${VHEAD}
rule vhead-ok
  show hold
    call is-equal
      call vhead
        make zero
        make vcons
          bind count
            make zero
          bind item
            make succ
              bind prior
                make zero
          bind rest
            make vnil
      make succ
        bind prior
          make zero
  calm hold
`),
)

// 3. SOUNDNESS CONTROL: vhead (cons 1 nil) is 1, not 0. The refined match must compute the RIGHT value.
ok(
  'wrong head value is rejected (vhead (cons 1 nil) != 0)',
  !compiles(`${VHEAD}
rule vhead-wrong
  show hold
    call is-equal
      call vhead
        make zero
        make vcons
          bind count
            make zero
          bind item
            make succ
              bind prior
                make zero
          bind rest
            make vnil
      make zero
  calm hold
`),
)

console.log(`\ndependent-match: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
