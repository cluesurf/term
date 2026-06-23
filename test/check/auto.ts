// `auto` / firstorder automation: discharge a goal by a depth-bounded BACKTRACKING search over the HINT DATABASE (every
// previously proven lemma in `lemmaRules`), applying each lemma as a single rewrite from the left side and checking
// convertibility (which also runs computation) to the right. The user need not name the lemma. Sound and ADDITIVE: every
// step is a proven equality or a reduction, so it can never close a false goal. Here `plus-zero` (`plus a 0 == a`,
// proven by induction) is applied automatically inside `succ (plus a 0)` to prove `succ (plus a 0) == succ a`, which
// `calm` alone cannot (it is not definitional for a symbolic `a`). Soundness control: a false goal is not closed.
// Run: npx tsx test/check/auto.ts

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

task plus
  take a, like nat
  take b, like nat
  like nat
  fork case, read a
    case zero
      send back
        read b
    case succ
      link prior
      send back
        make succ
          bind prior
            call plus
              read prior
              read b

rule plus-zero
  mark a, like nat
  show hold
    call is-equal
      call plus
        read a
        make zero
      read a
  fold a
`

// 1. auto applies the proven lemma `plus a 0 == a` (inside a `succ`) without being told which lemma.
ok(
  'auto applies a proven lemma: succ (plus a 0) == succ a',
  compiles(`${PRELUDE}
rule use-auto
  mark a, like nat
  show hold
    call is-equal
      make succ
        bind prior
          call plus
            read a
            make zero
      make succ
        bind prior
          read a
  auto
`),
)

// 2. SOUNDNESS CONTROL: `succ (plus a 0) == a` is FALSE (it is succ a). No lemma + computation closes it; must be
// rejected.
ok(
  'auto does not close a false goal (succ (plus a 0) == a)',
  !compiles(`${PRELUDE}
rule use-auto-wrong
  mark a, like nat
  show hold
    call is-equal
      make succ
        bind prior
          call plus
            read a
            make zero
      read a
  auto
`),
)

console.log(`\nauto: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
