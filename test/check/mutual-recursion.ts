// Mutual structural recursion: two functions that call each other (a rose-tree `count-rose` <-> `count-forest`) are now
// verified terminating -- and made transparent so their laws reduce -- when there is a FIXED argument position that
// strictly descends (structurally) on every call in the cycle. Sound: that position's structural size is a well-founded
// measure decreasing on every step. The soundness control is essential: a NON-descending mutual recursion (a ping-pong
// that passes its argument unchanged, i.e. never terminates) must NOT be made transparent, so a law over it does not
// discharge. Run: npx tsx test/check/mutual-recursion.ts

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

// a rose tree (node with a child forest) + a mutually-recursive node count
const ROSE = `form nat
  case zero
  case succ
    link prior, like nat

form forest
  case empty
  case grow
    link top, like rose
    link rest, like forest

form rose
  case node
    link label, like nat
    link kids, like forest

task count-rose
  take r, like rose
  like nat
  fork case, read r
    case node
      link label
      link kids
      send back
        make succ
          bind prior
            call count-forest
              read kids

task count-forest
  take f, like forest
  like nat
  fork case, read f
    case empty
      send back
        make zero
    case grow
      link top
      link rest
      send back
        call count-rose
          read top
`

// 1. the mutually-recursive count reduces: a single leaf node has count one.
ok(
  'mutual structural recursion reduces',
  compiles(`${ROSE}
rule count-leaf
  show hold
    call is-equal
      call count-rose
        make node
          bind label
            make zero
          bind kids
            make empty
      make succ
        bind prior
          make zero
  calm hold
`),
)

// 2. SOUNDNESS CONTROL: a non-descending mutual recursion (ping passes its argument to pong unchanged, and back) never
// terminates, so it must NOT be transparent -- `ping x == x` must NOT discharge (ping stays an opaque neutral).
ok(
  'non-descending mutual recursion is not made transparent',
  !compiles(`form nat
  case zero
  case succ
    link prior, like nat

task ping
  take n, like nat
  like nat
  send back
    call pong
      read n

task pong
  take n, like nat
  like nat
  send back
    call ping
      read n

rule ping-identity
  mark x, like nat
  show hold
    call is-equal
      call ping
        read x
      read x
  calm hold
`),
)

console.log(`\nmutual recursion: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
