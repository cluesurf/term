// Containers / polynomial functors -- the general theory of strictly-positive types. A CONTAINER is a pair of SHAPES
// `S` and POSITIONS `P : S -> type` (a type-returning function, one position-type per shape). Its EXTENSION (the
// polynomial functor it denotes) is the dependent pair `[S < P] X = (s : S) * (P s -> X)`: a shape together with an
// X at each of its positions. Here `shape` is `leaf | node`, `P leaf = one` (one position), `P node = two` (two
// positions), and the extension `cext` over `X = nat` is the datatype `mk : (s : shape) -> (P s -> nat) -> cext`. It
// type-checks and COMPUTES (projecting the shape of a built node), drawing on the type-returning position function, the
// Sigma-type/dependent record, and type-level application of `P`. The W-type of a container (its least fixed point) is
// the function-field W-type already covered (`wtype-function.ts`); the relation to indexed families is `ornament.ts`.
// Run: npx tsx test/check/container.ts

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

const PRELUDE = `form nat
  case zero
  case succ
    link prior, like nat

form shape
  case leaf
  case node

form one
  case only

form two
  case pos0
  case pos1

task pos
  take s, like shape
  like type
  fork case, read s
    case leaf
      send back
        read one
    case node
      send back
        read two

form cext
  case mk
    link s, like shape
    link f
      like task
        take p
          like pos
            head
              read s
        like nat

task shape-of
  take c, like cext
  like shape
  fork case, read c
    case mk
      link s
      link f
      send back
        read s

task make-node
  like cext
  send back
    make mk
      bind s
        make node
      bind f
        task g
          take p
            like two
          like nat
          send back
            make zero
`

// 1. the polynomial-functor extension (S * (P s -> X)) type-checks and COMPUTES: the shape of a built node is `node`.
ok(
  'container extension computes: shape-of (mk node f) == node',
  compiles(`${PRELUDE}
rule shape-ok
  show hold
    call is-equal
      call shape-of
        call make-node
      make node
  calm hold
`),
)

// 2. SOUNDNESS CONTROL: that container's shape is `node`, not `leaf`.
ok(
  'wrong shape is rejected (shape-of (mk node f) != leaf)',
  !compiles(`${PRELUDE}
rule shape-wrong
  show hold
    call is-equal
      call shape-of
        call make-node
      make leaf
  calm hold
`),
)

// 3. SOUNDNESS CONTROL: the shape field is ENFORCED -- `mk`'s first field must be a `shape`, so a `nat` is rejected.
ok(
  'the shape field is enforced (a nat shape is rejected)',
  !compiles(`${PRELUDE}
task bad-shape
  like cext
  send back
    make mk
      bind s
        make zero
      bind f
        task g
          take p
            like one
          like nat
          send back
            make zero
`),
)

console.log(`\ncontainer: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
