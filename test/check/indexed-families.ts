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

console.log(`\nindexed families: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
