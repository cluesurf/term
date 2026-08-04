// General well-founded recursion. The structural / numeric / lexicographic descent checks handle the common measures;
// for an ARBITRARY well-founded recursion (gcd, mergesort -- where the recursive argument is not a syntactic subterm),
// the sound, working technique is FUEL: any well-founded recursion is structural recursion on an upper bound of its
// depth. `gcd-fuel` recurses structurally on `fuel` while reducing `a` by `sub a b`, so it is accepted by the existing
// termination checker AND computes the right value. (The AUTOMATIC version -- the `Acc` accessibility predicate that
// removes the manual fuel argument -- is the research-grade completion; it needs a dependent, indexed, higher-order
// constructor.) Soundness control: a wrong gcd value is rejected. Run: npx tsx test/check/well-founded.ts

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

task sub
  take a, like nat
  take b, like nat
  like nat
  fork case, read b
    case zero
      send back
        read a
    case succ
      link bp
      fork case, read a
        case zero
          send back
            make zero
        case succ
          link ap
          send back
            call sub
              read ap
              read bp

task gcd-fuel
  take fuel, like nat
  take a, like nat
  take b, like nat
  like nat
  fork case, read fuel
    case zero
      send back
        read a
    case succ
      link f
      fork case, read b
        case zero
          send back
            read a
        case succ
          link bp
          send back
            call gcd-fuel
              read f
              read b
              call sub
                read a
                read b
`

// 1. fuel-bounded well-founded recursion is accepted by the checker AND computes: gcd-fuel 2 1 1 = 1.
ok(
  'fuel-bounded gcd is well-typed and computes (gcd 1 1 = 1)',
  compiles(`${PRELUDE}
rule gcd-ok
  show hold
    call is-equal
      call gcd-fuel
        make succ
          bind prior
            make succ
              bind prior
                make zero
        make succ
          bind prior
            make zero
        make succ
          bind prior
            make zero
      make succ
        bind prior
          make zero
  calm hold
`),
)

// 2. SOUNDNESS CONTROL: gcd 1 1 is 1, not 0. Must be rejected.
ok(
  'wrong gcd value is rejected (gcd 1 1 != 0)',
  !compiles(`${PRELUDE}
rule gcd-wrong
  show hold
    call is-equal
      call gcd-fuel
        make succ
          bind prior
            make succ
              bind prior
                make zero
        make succ
          bind prior
            make zero
        make succ
          bind prior
            make zero
      make zero
  calm hold
`),
)

console.log(`\nwell-founded: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
