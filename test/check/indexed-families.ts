// Value-indexed inductive families (length-typed vectors). A form declares a VALUE index with `head <n>, like <type>`,
// and each constructor states its output index with `head <expr>` (`vnil -> zero`, `vcons -> succ count`). The index
// rides in the TYPE, so `vecnat zero` and `vecnat (succ (succ zero))` are DISTINCT types, checked by ordinary
// conversion. The payoff is type safety from the index alone: a function whose parameter is a length-2 vector accepts a
// length-2 value and REJECTS the empty vector, with no runtime check. This exercises the full pipeline -- value
// arguments in types survive parsing, inference (seedType / zonk), and the kernel encoding (a relevant index binder on
// the type former + per-constructor index result types). The dependent eliminator (a motive that refines the index per
// branch) is the next step; construction and application are sound now. Run: npx tsx test/check/indexed-families.ts

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

// a length-indexed vector of naturals, and a function whose parameter is a length-TWO vector (so its type fixes the
// index to `succ (succ zero)`).
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

task expects-two
  take v, like vecnat
    head
      make succ
        bind prior
          make succ
            bind prior
              make zero
  like nat
  send back
    make zero
`

// a length-2 vector value: cons(1)(cons(0)(nil)), whose index computes to succ (succ zero).
const LENGTH_TWO = `make vcons
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
              make vnil`

// 1. the indexed family declares and the length-typed function compiles (value arguments in types are accepted).
ok('indexed family + length-typed parameter compile', compiles(PRELUDE))

// 2. a length-2 vector is ACCEPTED where a length-2 vector is expected (the index matches: succ (succ zero)).
ok(
  'length-2 vector accepted by a length-2 parameter',
  compiles(`${PRELUDE}
task use-good
  like nat
  send back
    call expects-two
      ${LENGTH_TWO}
`),
)

// 3. SOUNDNESS / the type-safety win: the EMPTY vector (index zero) is REJECTED where a length-2 vector is expected.
// This is enforced purely by the index in the type, with no runtime check.
ok(
  'empty vector rejected by a length-2 parameter (index zero != succ (succ zero))',
  !compiles(`${PRELUDE}
task use-bad
  like nat
  send back
    call expects-two
      make vnil
`),
)

// 4. SOUNDNESS: a length-ONE vector is also REJECTED (succ zero != succ (succ zero)).
ok(
  'length-1 vector rejected by a length-2 parameter',
  !compiles(`${PRELUDE}
task use-one
  like nat
  send back
    call expects-two
      make vcons
        bind count
          make zero
        bind item
          make zero
        bind rest
          make vnil
`),
)

// a length-tagging family + functions that PATTERN MATCH on an indexed value (the non-dependent eliminator: `fork
// case` reduces on `vecnat <index>`). The match peels the subject's full type spine -- type args AND index args -- and
// feeds them as the eliminator's leading witnesses, and a dependent field (`rest : vecnat count`) binds correctly in
// the branch.
const MATCH_PRELUDE = `form nat
  case zero
  case succ
    link prior, like nat

form bit
  case off
  case on

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

task tag-empty
  take v, like vecnat
    head
      make zero
  like bit
  fork case, read v
    case vnil
      send back
        make on
    case vcons
      link count
      link item
      link rest
      send back
        make off

task tag-one
  take v, like vecnat
    head
      make succ
        bind prior
          make zero
  like bit
  fork case, read v
    case vnil
      send back
        make on
    case vcons
      link count
      link item
      link rest
      send back
        make off
`

// a length-1 vector value, indented to sit directly under `call tag-one` (8 spaces for `make vcons`, deeper for its
// bindings) so it nests correctly when interpolated.
const ONE = `        make vcons
          bind count
            make zero
          bind item
            make zero
          bind rest
            make vnil`

// 5. `fork case` on an indexed value REDUCES through the empty (0-field) branch: tag-empty (vnil) = on.
ok(
  'fork case reduces on an indexed value (vnil branch)',
  compiles(`${MATCH_PRELUDE}
rule empty-on
  show hold
    call is-equal
      call tag-empty
        make vnil
      make on
  calm hold
`),
)

// 6. `fork case` reduces through the dependent-field (3-field, `rest : vecnat count`) branch: tag-one (cons ..) = off.
ok(
  'fork case reduces on an indexed value (dependent vcons branch)',
  compiles(`${MATCH_PRELUDE}
rule one-off
  show hold
    call is-equal
      call tag-one
${ONE}
      make off
  calm hold
`),
)

// 7. SOUNDNESS: the match reduces to the RIGHT branch -- tag-one (cons ..) is off, NOT on. Must be rejected.
ok(
  'match reduces to the correct branch (cons is not on)',
  !compiles(`${MATCH_PRELUDE}
rule one-not-on
  show hold
    call is-equal
      call tag-one
${ONE}
      make on
  calm hold
`),
)

// VALUE-GENERIC function parameter: `is-empty : (n : nat) -> vecnat n -> bit` abstracts over the index value, so one
// function works at any length. This is a dependent function parameter (the type of `v` mentions the earlier value
// param `n`). The match then reduces once the index is concrete at the call site.
const GENERIC_PRELUDE = `${MATCH_PRELUDE}
task is-empty
  take n, like nat
  take v, like vecnat
    head
      read n
  like bit
  fork case, read v
    case vnil
      send back
        make on
    case vcons
      link count
      link item
      link rest
      send back
        make off
`

// 8. value-generic matching reduces at a concrete call: is-empty zero (vnil) = on.
ok(
  'value-generic function over vecnat n: is-empty zero vnil = on',
  compiles(`${GENERIC_PRELUDE}
rule generic-empty
  show hold
    call is-equal
      call is-empty
        make zero
        make vnil
      make on
  calm hold
`),
)

// 9. and through the cons branch at a concrete length: is-empty (succ zero) (cons ..) = off.
ok(
  'value-generic function: is-empty (succ zero) (cons ..) = off',
  compiles(`${GENERIC_PRELUDE}
rule generic-cons
  show hold
    call is-equal
      call is-empty
        make succ
          bind prior
            make zero
${ONE}
      make off
  calm hold
`),
)

// INVERSION: a total `head : (n) -> vecnat (succ n) -> nat` that handles ONLY the `vcons` case. At a `succ`-headed
// index the `vnil` case is impossible, so it may be omitted -- the match auto-discharges it via a discriminator motive
// (impossible index -> Unit) built on the large eliminator. This is the convoy/inversion that makes a total head/tail
// expressible.
const HEAD = `${MATCH_PRELUDE}
task head
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

const HEAD_CALL = `call head
        make zero
        make vcons
          bind count
            make zero
          bind item
            make succ
              bind prior
                make zero
          bind rest
            make vnil`

// 10. total head: head of the length-1 vector [1] reduces to 1, with the empty case omitted.
ok(
  'inversion: total head (vnil omitted) reduces, head [1] = 1',
  compiles(`${HEAD}
rule head-one
  show hold
    call is-equal
      ${HEAD_CALL}
      make succ
        bind prior
          make zero
  calm hold
`),
)

// 11. SOUNDNESS: head [1] is 1, not 0 -- must be rejected.
ok(
  'inversion: head reduces to the right value (not zero)',
  !compiles(`${HEAD}
rule head-wrong
  show hold
    call is-equal
      ${HEAD_CALL}
      make zero
  calm hold
`),
)

// 12. SOUNDNESS: omitting a REACHABLE branch (only vnil, while the subject is succ-headed so vcons is reachable) is
// still non-exhaustive and must be rejected -- the relaxation only forgives IMPOSSIBLE omissions.
ok(
  'inversion does not forgive omitting a reachable branch',
  !compiles(`${MATCH_PRELUDE}
task bad-head
  take n, like nat
  take v, like vecnat
    head
      make succ
        bind prior
          read n
  like nat
  fork case, read v
    case vnil
      send back
        make zero
`),
)

console.log(`\nindexed families: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
