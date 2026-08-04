// Higher-order functions + a parametricity-flavored free theorem. A function-typed PARAMETER (`take f, like task / ...`,
// a map/fold/filter callback) is now applied in the kernel: the `call` elaborator, when its callee is a LOCAL binding
// rather than a global function, applies that binding's de Bruijn variable directly (a local shadows a global, carries
// no erased witnesses). So a higher-order call REDUCES, and -- the payoff -- the REPRESENTATION-INDEPENDENCE law that
// mapping a structure preserves its length, `length (map f s) == length s`, is PROVABLE by induction over the
// polymorphic container for an ARBITRARY element function `f`. This is the consequence a free theorem asserts, here
// established constructively. Soundness controls: a higher-order call computes the RIGHT value (a wrong one is
// rejected), and a false shape law is rejected. Run: npx tsx test/check/higher-order.ts

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

const NAT = `form nat
  case zero
  case succ
    link prior, like nat

task bump
  take x, like nat
  like nat
  send back
    make succ
      bind prior
        read x
`

// the function-typed parameter `f` is declared in the non-comma (indented) form, where its `take`/`like` children nest
// under the `like task` group the kernel reads.
const CONTAINER = `${NAT}
form stack
  head a
  case empty
  case push
    link top, like a
    link rest, like stack
      head a

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

task map
  take f
    like task
      take x, like nat
      like nat
  take s, like stack
    head nat
  like stack
    head nat
  fork case, read s
    case empty
      send back
        make empty
    case push
      link top
      link rest
      send back
        make push
          bind top
            call f
              read top
          bind rest
            call map
              read f
              read rest
`

// 1. a higher-order call REDUCES: apply a callback `f` twice to a value.
ok(
  'higher-order call reduces (apply a callback twice)',
  compiles(`${NAT}
task apply-twice
  take f
    like task
      take x, like nat
      like nat
  take n, like nat
  like nat
  send back
    call f
      call f
        read n

rule twice-bump
  show hold
    call is-equal
      call apply-twice
        read bump
        make zero
      make succ
        bind prior
          make succ
            bind prior
              make zero
  calm hold
`),
)

// 2. SOUNDNESS CONTROL: the higher-order call computes the RIGHT value -- `apply-twice bump zero` is `succ (succ zero)`,
// NOT `succ zero`. The wrong value must be rejected (the callback is genuinely applied, not dropped).
ok(
  'higher-order call computes the exact value (wrong value rejected)',
  !compiles(`${NAT}
task apply-twice
  take f
    like task
      take x, like nat
      like nat
  take n, like nat
  like nat
  send back
    call f
      call f
        read n

rule twice-bump-wrong
  show hold
    call is-equal
      call apply-twice
        read bump
        make zero
      make succ
        bind prior
          make zero
  calm hold
`),
)

// 3. THE FREE THEOREM: mapping preserves length -- `length (map f s) == length s` -- for an ARBITRARY function `f`,
// proven by induction (`fold s`) over the polymorphic container, using the induction hypothesis on the tail.
ok(
  'free theorem: length (map f s) == length s, proven by induction',
  compiles(`${CONTAINER}
rule map-preserves-length
  mark f
    like task
      take x, like nat
      like nat
  mark s, like stack
    head nat
  show hold
    call is-equal
      call length
        call map
          read f
          read s
      call length
        read s
  fold s
`),
)

// 4. SOUNDNESS CONTROL: a FALSE shape law over the higher-order map is rejected -- `length (map f s)` is NOT identically
// `zero` (it equals `length s`, which is not always zero).
ok(
  'false shape law over higher-order map is rejected',
  !compiles(`${CONTAINER}
rule map-collapses-wrong
  mark f
    like task
      take x, like nat
      like nat
  mark s, like stack
    head nat
  show hold
    call is-equal
      call length
        call map
          read f
          read s
      make zero
  fold s
`),
)

console.log(`\nhigher-order: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
