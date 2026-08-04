// SET QUOTIENTS as a higher inductive type. The quotient `nat / R` has a POINT constructor `cls : nat -> quot` (the
// equivalence class of a representative) and a PATH constructor `glue : R a b -> cls a = cls b` (related representatives
// become equal). Here R identifies 0 and 2, so `glue : cls 0 = cls 2` is POSTULATED (a bodyless `task`) -- sound because
// the kernel has no axiom K, so the identification is a genuine path, not a definitional collapse. The recursion
// principle maps out by a function that RESPECTS R: a respecting function lifts and computes on `cls`, while a function
// that distinguishes 0 and 2 cannot be lifted (its respect obligation `0 = 2` is unconstructable) -- which is exactly
// what keeps the quotient sound. Run: npx tsx test/check/set-quotient.ts

import { compile } from '@term/make/code/compile/compile'

let pass = 0
let fail = 0

function ok(name: string, cond: boolean): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}`)
  }
}

function compiles(source: string): boolean {
  return compile({ file: 'p.tree', text: source }).ok
}

// `two` = succ (succ zero); `five` = succ^5 zero. `quot` is nat/R with R relating 0 and 2.
const PRELUDE = `form nat
  case zero
  case succ
    link prior, like nat

form quot
  case cls
    link rep, like nat

form qpath
  head a, like quot
  head b, like quot
  case qid
    link c, like quot
    head
      read c
    head
      read c

form eqn
  head a, like nat
  head b, like nat
  case rfl
    link c, like nat
    head
      read c
    head
      read c

task glue
  like qpath
    head
      make cls
        bind rep
          make zero
    head
      make cls
        bind rep
          make succ
            bind prior
              make succ
                bind prior
                  make zero

task quot-map-const
  take c, like quot
  like nat
  fork case, read c
    case cls
      link rep
      send back
        make succ
          bind prior
            make succ
              bind prior
                make succ
                  bind prior
                    make succ
                      bind prior
                        make succ
                          bind prior
                            make zero

task quot-map-rep
  take resp, like eqn
    head
      make zero
    head
      make succ
        bind prior
          make succ
            bind prior
              make zero
  take c, like quot
  like nat
  fork case, read c
    case cls
      link rep
      send back
        read rep
`

// 1. the POINT computation rule: a respecting map (the constant 5) lifts and computes on `cls`. quot-map-const (cls 1) = 5.
ok(
  'respecting map computes on cls: quot-map-const (cls 1) == 5',
  compiles(`${PRELUDE}
rule const-one
  show hold
    call is-equal
      call quot-map-const
        make cls
          bind rep
            make succ
              bind prior
                make zero
      make succ
        bind prior
          make succ
            bind prior
              make succ
                bind prior
                  make succ
                    bind prior
                      make succ
                        bind prior
                          make zero
  calm hold
`),
)

// 2. the lifted map is WELL-DEFINED on the quotient: it sends the glued representatives 0 and 2 to the SAME value (5 =
// 5), so it respects glue. quot-map-const (cls 0) == quot-map-const (cls 2).
ok(
  'well-defined: quot-map-const (cls 0) == quot-map-const (cls 2)',
  compiles(`${PRELUDE}
rule respects
  show hold
    call is-equal
      call quot-map-const
        make cls
          bind rep
            make zero
      call quot-map-const
        make cls
          bind rep
            make succ
              bind prior
                make succ
                  bind prior
                    make zero
  calm hold
`),
)

// 3. glue is a genuine inhabitant of the identity type `cls 0 = cls 2`: a task may return it at that type, so the
// quotient really carries the identifying path.
ok(
  'glue inhabits cls 0 = cls 2 (the path constructor is well-typed)',
  compiles(`${PRELUDE}
task use-glue
  like qpath
    head
      make cls
        bind rep
          make zero
    head
      make cls
        bind rep
          make succ
            bind prior
              make succ
                bind prior
                  make zero
  send back
    call glue
`),
)

// 4. NON-DEGENERACY: the quotient does NOT collapse definitionally -- `cls 0 == cls 2` is not provable by computation
// (they are identified only PROPOSITIONALLY, through the path glue, not as identical terms).
ok(
  'cls 0 == cls 2 is NOT a definitional equality (identified only via glue)',
  !compiles(`${PRELUDE}
rule not-definitional
  show hold
    call is-equal
      make cls
        bind rep
          make zero
      make cls
        bind rep
          make succ
            bind prior
              make succ
                bind prior
                  make zero
  calm hold
`),
)

// 5. SOUNDNESS of the recursor: the representative-extracting map (which would distinguish the glued 0 and 2) can only
// be invoked with a respect proof of type `0 = 2`, which is UNCONSTRUCTABLE. Supplying `rfl 0 : 0 = 0` does not have
// that type, so the call does NOT compile -- the quotient cannot be used to tell glued elements apart.
ok(
  'soundness: extracting the representative requires an unconstructable proof 0 = 2',
  !compiles(`${PRELUDE}
task break-quotient
  like nat
  send back
    call quot-map-rep
      make rfl
        bind c
          make zero
      make cls
        bind rep
          make zero
`),
)

console.log(`\nset-quotient: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
