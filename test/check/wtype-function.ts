// Function-field W-types (general / infinitely-branching well-founded trees): a constructor may carry a FUNCTION-typed
// field, `sup : (nat -> wtree) -> wtree`, the W-type shape where a node has one child per element of an index type.
// `kernelTypeAt` now lowers a function type to an arrow chain, so the constructor's field is representable, the encoding
// is not skipped, and the type declares + reduces + eliminates (`fork case`). Soundness control: a false law is rejected.
// Run: npx tsx test/check/wtype-function.ts

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

form wtree
  case leaf
  case sup
    link kids, like task
      take index, like nat
      like wtree

task root-is-leaf
  take w, like wtree
  like nat
  fork case, read w
    case leaf
      send back
        make zero
    case sup
      link kids
      send back
        make succ
          bind prior
            make zero
`

// 1. the function-field W-type declares, and a function over it (eliminating both the leaf and the function-field `sup`
// case) reduces: root-is-leaf leaf = zero.
ok(
  'function-field W-type declares and reduces',
  compiles(`${PRELUDE}
rule leaf-depth
  show hold
    call is-equal
      call root-is-leaf
        make leaf
      make zero
  calm hold
`),
)

// 2. SOUNDNESS CONTROL: root-is-leaf leaf is not succ zero. Must be rejected.
ok(
  'false law over the W-type is rejected',
  !compiles(`${PRELUDE}
rule leaf-depth-wrong
  show hold
    call is-equal
      call root-is-leaf
        make leaf
      make succ
        bind prior
          make zero
  calm hold
`),
)

console.log(`\nfunction-field W-type: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
