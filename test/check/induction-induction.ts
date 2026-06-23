// Induction-induction: two TYPES defined SIMULTANEOUSLY, the second INDEXED by the first. `ctx` is a type of contexts
// and `ty : ctx -> type` is a type of types-in-context (indexed by `ctx`). They are mutually defined: `ctx`'s `extend`
// constructor takes a `ty` of the context being extended (`a : ty g`), and `ty`'s `base` constructor takes the context
// it lives in (`base : (gg : ctx) -> ty gg`, the standard presentation where the index is a constructor argument). A
// function `length : ctx -> nat` computes through it: `length (extend empty (base empty)) == 1`. The dependency is
// type-safe -- `extend`'s `a` field must be a `ty`, not (say) a `nat`. With induction-recursion, this completes
// "define a type and a function/type on it simultaneously". Run: npx tsx test/check/induction-induction.ts

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

// `ctx` (contexts) and `ty` (types in context, indexed by ctx), defined together: ctx.extend mentions ty, ty.base
// mentions ctx.
const PRELUDE = `form nat
  case zero
  case succ
    link prior, like nat

form ctx
  case empty
  case extend
    link g, like ctx
    link a
      like ty
        head
          read g

form ty
  head g, like ctx
  case base
    link gg, like ctx
    head
      read gg

task length
  take c, like ctx
  like nat
  fork case, read c
    case empty
      send back
        make zero
    case extend
      link g
      link a
      send back
        make succ
          bind prior
            call length
              read g
`

// 1. the mutual definition COMPUTES: length (extend empty (base empty)) == 1.
ok(
  'induction-induction computes: length (extend empty (base empty)) == 1',
  compiles(`${PRELUDE}
rule length-ok
  show hold
    call is-equal
      call length
        make extend
          bind g
            make empty
          bind a
            make base
              bind gg
                make empty
      make succ
        bind prior
          make zero
  calm hold
`),
)

// 2. SOUNDNESS CONTROL: that context has length 1, not 2.
ok(
  'wrong length is rejected (length (extend empty (base empty)) != 2)',
  !compiles(`${PRELUDE}
rule length-wrong
  show hold
    call is-equal
      call length
        make extend
          bind g
            make empty
          bind a
            make base
              bind gg
                make empty
      make succ
        bind prior
          make succ
            bind prior
              make zero
  calm hold
`),
)

// 3. SOUNDNESS CONTROL: the index-DEPENDENCY is type-safe -- `extend`'s `a` field must be a `ty`, so a `nat` is rejected.
ok(
  'the ty-typed field is enforced (extend with a nat field is rejected)',
  !compiles(`${PRELUDE}
task bad-extend
  like ctx
  send back
    make extend
      bind g
        make empty
      bind a
        make zero
`),
)

console.log(`\ninduction-induction: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
