// What a proof in one file may use from another, and the instantiating `cite`. Four things, each held by an acceptance
// beside a refusal, so the suite cannot pass by refusing everything:
//
//   1. `cite <rule>` closes a goal that is an INSTANCE of an equation the kernel proved: one rewrite by it, at some
//      values of its marks, makes the two sides the same (check/elaborate.ts `instanceOf`, judge.ts `normalTerm`). A
//      goal that is not an instance, or is false, is refused.
//   2. a case's fields may be `slot`s, filled by position: `make conjunction(p, q)` (check/extend.ts `fillVariant`).
//   3. a form that aliases a task type is called as the task, in the checker and the kernel (`seat v, like assignment`).
//   4. separately compiled, a rule may run a task and cite a rule of a THEORY in another file (a file that states rules),
//      because the theory's stubs carry those bodies (compile/stub.ts `stubBody`). A file with no rules carries none.
//
// Run: npx tsx test/check/cite-instance.ts

import { compile } from '@term/make/code/compile/compile'
import { compileSeparate } from '@term/make/code/compile/separate'
import { CompileCache } from '@term/make/code/compile/cache'
import type { Resolver } from '@term/make/code/compile/load'

let pass = 0
let fail = 0

const LEAN = { leanOf: () => true }

function report(name: string, good: boolean, detail: string): void {
  if (good) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}\n      ${detail}`)
  }
}

// `want` is 'ok', or a text one of the refusals must contain
function expect(name: string, source: string, want: string): void {
  const result = compile({ file: 'c.tree', text: source }, LEAN)
  const messages = result.ok ? [] : result.diagnostics.map(d => `${d.name}: ${d.message}`)
  const good = want === 'ok' ? result.ok : !result.ok && messages.some(m => m.includes(want))

  report(name, good, `ok=${result.ok}, wanted ${want}: ${messages.join(' | ')}`)
}

const FLAG = `form flag
  case yes
  case no

task both
  take a, like flag
  take b, like flag

  like flag

  sift a
    case yes
      back b
    case no
      back make no

task flip
  take a, like flag

  like flag

  sift a
    case yes
      back make no
    case no
      back make yes

rule both-commutes
  seat a, like flag
  seat b, like flag
  show hold, is-equal both(a, b), both(b, a)
  fold a, b

rule flip-twice
  seat a, like flag
  show hold, is-equal flip(flip(a)), a
  fold a
`

const PAIR = `
form pair
  case two
    slot left, like flag
    slot right, like flag

task conjoin
  take p, like pair

  like flag

  sift p
    case two
      back both(left, right)

form assignment
  like task
    take n, like integer
    like flag
`

// 1. the instantiating cite

expect(
  'an instance at constructed values is proven',
  `${FLAG}${PAIR}
rule conjoin-swapped
  seat x, like flag
  seat y, like flag
  show hold, is-equal conjoin(make two(x, y)), conjoin(make two(y, x))
  cite both-commutes
`,
  'ok',
)

expect(
  'an instance at a call whose value is not known is proven',
  `${FLAG}${PAIR}
rule both-of-a-call
  seat x, like pair
  seat y, like flag
  show hold, is-equal both(conjoin(x), y), both(y, conjoin(x))
  cite both-commutes
`,
  'ok',
)

expect(
  'an instance deep inside a side is proven (flip twice, under both)',
  `${FLAG}${PAIR}
rule flip-twice-inside
  seat x, like pair
  seat y, like flag
  show hold, is-equal both(flip(flip(conjoin(x))), y), both(conjoin(x), y)
  cite flip-twice
`,
  'ok',
)

expect(
  'a TRUE goal that is not an instance of the cited rule is refused',
  `${FLAG}
rule both-is-idempotent
  seat a, like flag
  show hold, is-equal both(a, a), a
  cite both-commutes
`,
  'not an instance of it',
)

expect(
  'a FALSE goal citing a rule is refused',
  `${FLAG}
rule flip-is-identity
  seat a, like flag
  show hold, is-equal flip(a), a
  cite flip-twice
`,
  'not an instance of it',
)

expect(
  'one rewrite only: a goal needing the rule twice is refused',
  `${FLAG}
rule four-flips
  seat a, like flag
  seat b, like flag
  show hold, is-equal both(flip(flip(a)), flip(flip(b))), both(a, b)
  cite flip-twice
`,
  'not an instance of it',
)

// 2. slots in a case

expect(
  'a case with slots is built by position, and its rule computes',
  `${FLAG}${PAIR}
rule conjoin-of-yes
  seat x, like flag
  show hold
    is-equal
      conjoin
        make two
          make yes
          x
      x
`,
  'ok',
)

expect(
  'a case with slots refuses one value too many',
  `${FLAG}${PAIR}
host on, make yes
host bad, make two(on, on, on)
`,
  'has 2 slots',
)

expect(
  'a slot given by position and by name is refused',
  `${FLAG}${PAIR}
host bad
  make two(make yes)
    bind left, make no
`,
  'given twice',
)

expect(
  'a case with link fields still refuses values by position',
  `form box
  case full
    link left, like integer
    link right, like integer

host bad, make full(1, 2)
`,
  'takes its fields by name',
)

// 3. a task alias called as the task

expect(
  'a mark typed by a task alias is called, and the kernel proves an instance at its values',
  `${FLAG}${PAIR}
rule both-of-an-assignment
  seat v, like assignment
  seat y, like integer
  seat z, like integer
  show hold, is-equal both(v(y), v(z)), both(v(z), v(y))
  cite both-commutes
`,
  'ok',
)

expect(
  'and a goal about it that is no instance is refused',
  `${FLAG}${PAIR}
rule both-of-an-assignment-wrongly
  seat v, like assignment
  seat y, like integer
  seat z, like integer
  show hold, is-equal both(v(y), v(z)), both(v(y), v(y))
  cite both-commutes
`,
  'not an instance of it',
)

// 4. separate compilation: a theory in one file, rules about it in another

const USE = `load ./theory
  find flag
  find both
  find flip
  find both-commutes
  find flip-twice

rule computes-across-files
  seat a, like flag
  show hold
    is-equal
      both
        make yes
        a
      a

rule cites-across-files
  seat a, like flag
  seat b, like flag
  show hold, is-equal both(flip(flip(a)), b), both(a, b)
  cite flip-twice
`

const USE_FALSE = `load ./theory
  find flag
  find both
  find flip
  find flip-twice

rule false-across-files
  seat a, like flag
  show hold, is-equal flip(a), a
  cite flip-twice
`

function separately(entry: string, theory: string): { ok: boolean; messages: string[] } {
  const resolve: Resolver = path => (path === './theory' ? { file: 'theory.tree', text: theory } : undefined)
  const result = compileSeparate(
    { file: 'entry.tree', text: entry },
    { resolve, cache: new CompileCache(), modules: file => `./${file.replace(/\W/g, '_')}.mjs`, ...LEAN },
  )

  return { ok: result.ok, messages: result.ok ? [] : result.diagnostics.map(d => `${d.name}: ${d.message}`) }
}

const across = separately(USE, FLAG)

report('separately, a rule runs a task and cites a rule of a theory in another file', across.ok, across.messages.join(' | '))

const acrossFalse = separately(USE_FALSE, FLAG)

report(
  'separately, a false rule citing across files is still refused',
  !acrossFalse.ok && acrossFalse.messages.some(m => m.includes('not an instance of it')),
  `ok=${acrossFalse.ok}: ${acrossFalse.messages.join(' | ')}`,
)

// the same theory with its rules removed is a plain file: its bodies stay home, so a rule elsewhere cannot run them
const PLAIN = FLAG.slice(0, FLAG.indexOf('rule both-commutes'))
const plain = separately(
  `load ./theory
  find flag
  find both

rule computes-across-files
  seat a, like flag
  show hold
    is-equal
      both
        make yes
        a
      a
`,
  PLAIN,
)

report(
  'a file with no rules carries no bodies to its dependents',
  !plain.ok && plain.messages.every(m => m.startsWith('unchecked-hold') || m.startsWith('unproven')),
  `ok=${plain.ok}: ${plain.messages.join(' | ')}`,
)

console.log(`\ncite-instance: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
