// `link` chaining: a value expression with `link <fn>` children pipes its value into fn as the first argument, so a
// nested call-after-call flattens into a top-down chain. `call f, x / link g` lowers to g(f(x)). These tests lock in
// that the chain (1) lowers identically to the hand-nested form, (2) discharges proofs the nested form discharges,
// (3) is genuinely computed (a false single-link claim is rejected), and (4) leaves a constructor named `link` alone.
// Run: npx tsx test/compile/link-chain.ts

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

// a bit type and its flip, the shared prelude for the chain tests
const PRELUDE = `form bit
  case off
  case on

task flip
  take b, like bit
  like bit
  fork case, read b
    case off
      send back
        make on
    case on
      send back
        make off
`

// a hold/rule with a working proof emits no unchecked-hold warning and compiles
function proves(source: string): boolean {
  const result = compile({ file: 'p.tree', text: source })
  if (!result.ok) {
    return false
  }
  return (result.warnings ?? []).every(d => d.name !== 'unchecked-hold')
}

// the compiled TypeScript body of the lone task in a source, for comparing two lowerings
function loweringOf(source: string): string | undefined {
  const result = compile({ file: 'p.tree', text: source })
  return result.ok ? result.typescript : undefined
}

// 1. EQUIVALENCE: the chained task lowers to exactly the same TypeScript as the hand-nested task.
const CHAINED_TASK = `${PRELUDE}
task apply-twice
  take b, like bit
  like bit
  send back
    call flip, read b
      link flip
`
const NESTED_TASK = `${PRELUDE}
task apply-twice
  take b, like bit
  like bit
  send back
    call flip
      call flip
        read b
`
const chainedTs = loweringOf(CHAINED_TASK)
const nestedTs = loweringOf(NESTED_TASK)
ok(
  'chain lowers identically to nested',
  chainedTs !== undefined && chainedTs === nestedTs,
  `chained vs nested differ`,
)

// 2. A THREE-DEEP chain lowers identically to its nest: flip(flip(flip(b))).
const CHAINED_THRICE = `${PRELUDE}
task apply-thrice
  take b, like bit
  like bit
  send back
    call flip, read b
      link flip
      link flip
`
const NESTED_THRICE = `${PRELUDE}
task apply-thrice
  take b, like bit
  like bit
  send back
    call flip
      call flip
        call flip
          read b
`
ok(
  'three-deep chain lowers identically to nested',
  loweringOf(CHAINED_THRICE) !== undefined &&
    loweringOf(CHAINED_THRICE) === loweringOf(NESTED_THRICE),
)

// 3. PROOF: the chained involution discharges (flip (flip b) = b).
const CHAINED_PROOF = `${PRELUDE}
rule flip-involution
  mark b, like bit
  show hold
    call is-equal
      call flip, read b
        link flip
      read b
  fold b
`
ok('chained involution proof discharges', proves(CHAINED_PROOF))

// 4. A base with no inline argument still chains: read b / link flip / link flip = flip(flip(b)).
const CHAINED_FROM_READ = `${PRELUDE}
rule flip-twice-from-read
  mark b, like bit
  show hold
    call is-equal
      read b
        link flip
        link flip
      read b
  fold b
`
ok('chain onto a bare read discharges', proves(CHAINED_FROM_READ))

// 5. GENUINELY COMPUTED: a single link is NOT the identity, so this false claim must NOT prove.
const FALSE_SINGLE_LINK = `${PRELUDE}
rule one-flip-is-identity
  mark b, like bit
  show hold
    call is-equal
      read b
        link flip
      read b
  fold b
`
ok('single-link false claim is rejected', !proves(FALSE_SINGLE_LINK))

// 6. REGRESSION: a constructor literally named `link` (`make link ...`) coexists with chaining, the head argument of
// `make` is never mistaken for a chain pipe.
const LINK_CONSTRUCTOR = `form chain
  case stop
  case link
    link head, like bit
    link rest, like chain

task first
  take c, like chain
  like bit
  fork case, read c
    case stop
      send back
        make off
    case link
      link head
      link rest
      send back
        read head

task one
  like chain
  send back
    make link
      bind head
        make on
      bind rest
        make stop
`
ok(
  'constructor named link coexists with chaining',
  loweringOf(LINK_CONSTRUCTOR) !== undefined,
)

console.log(`\nlink chaining: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
