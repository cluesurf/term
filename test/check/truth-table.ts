// The kernel's truth table (check/elaborate.ts `truthTable`, math-foundations-0017): a value of a form whose cases hold
// nothing (`flag`) that the kernel cannot compute is still one of those cases, so an induction case built from such
// values is decided by trying each. It is what proves soundness of a proof system with one `fold`.
//
// Each acceptance sits beside a refusal, and the soundness-critical rule is held directly: a choice is set aside only
// when a hypothesis computes to two DIFFERENT cases, never when it merely stays undecided.
// Run: npx tsx test/check/truth-table.ts

import { compile } from '@term/make/code/compile/compile'

let pass = 0
let fail = 0

// `want` is 'ok', or a text one of the refusals must contain
function expect(name: string, source: string, want: string): void {
  const result = compile({ file: 't.tree', text: source }, { leanOf: () => true })
  const messages = result.ok ? [] : result.diagnostics.map(d => `${d.name}: ${d.message}`)
  const good = want === 'ok' ? result.ok : !result.ok && messages.some(m => m.includes(want))

  if (good) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  (ok=${result.ok}, wanted ${want})\n      ${messages.join('\n      ')}`)
  }
}

const LOGIC = `form flag
  case yes
  case no

task implies
  take a, like flag
  take b, like flag

  like flag

  sift a
    case yes
      back b
    case no
      back make yes

task both
  take a, like flag
  take b, like flag

  like flag

  sift a
    case yes
      back b
    case no
      back make no

form natural
  case zero
  case succ
    link prior, like natural

task plus
  take a, like natural
  take b, like natural

  like natural

  sift a
    case zero
      back b
    case succ
      link prior
      back make succ, bind prior, plus(prior, b)

form formula
  case atom
    slot index, like natural
  case arrow
    slot left, like formula
    slot right, like formula

form assignment
  like task
    take n, like natural
    like flag

task value
  take v, like assignment
  take p, like formula

  like flag

  sift p
    case atom
      back v(index)
    case arrow
      back implies(value(v, left), value(v, right))
`

// a two-rule system: one axiom scheme and modus ponens, indexed by the formula each derivation proves
function system(axiom: string, rule: string): string {
  return `${LOGIC}
form proof
  head p, like formula
  case axiom
    link a, like formula
    link b, like formula
    head
      ${axiom}
  case ponens
    link a, like formula
    link b, like formula
    link minor, like proof
      head
        read ${rule === 'forward' ? 'a' : 'b'}
    link major, like proof
      head
        make arrow(a, b)
    head
      read ${rule === 'forward' ? 'b' : 'a'}

rule provable-is-true
  seat v, like assignment
  seat p, like formula
  seat d, like proof
    head
      read p
  show hold, is-equal value(v, p), make yes
  fold d
`
}

const WEAKENING = `make arrow
        a
        make arrow(b, a)`

const FROM_NOTHING = `make arrow(a, b)`

expect('a sound system is proven sound by one fold', system(WEAKENING, 'forward'), 'ok')

expect(
  'an unsound axiom is refused, naming the case and the values that break it',
  system(FROM_NOTHING, 'forward'),
  'FALSE in the case `axiom`, where value(v, a) is yes, value(v, b) is no',
)

expect(
  'modus ponens backwards is refused in its own case, its hypotheses holding',
  system(WEAKENING, 'backward'),
  'FALSE in the case `ponens`, where value(v, a) is no, value(v, b) is yes, with every hypothesis of the case holding',
)

// THE RULE THAT KEEPS IT SOUND. `plus(n, n) == n` stays undecided for a variable n: it must not set any choice aside,
// so the choice x(n) = no stands and the goal is false there
expect(
  'a hypothesis left undecided never sets a choice aside',
  `${LOGIC}
rule undecided-hypothesis
  seat x
    like task
      take n, like natural
      like flag
  seat n, like natural
  seat b, like flag
  have doubled, is-equal plus(n, n), n
  show hold, is-equal both(b, x(n)), b
  fold b
`,
  'the induction did not establish the equality',
)

// and one shown false does: under x(n) = no the hypothesis is `no == yes`, two different cases
expect(
  'a hypothesis shown false sets its choice aside',
  `${LOGIC}
rule decided-hypothesis
  seat x
    like task
      take n, like natural
      like flag
  seat n, like natural
  seat b, like flag
  have true-at-n, is-equal x(n), make yes
  show hold, is-equal both(b, x(n)), b
  fold b
`,
  'ok',
)

// with no step at all, a goal over truth values decides itself, as a ring identity does
expect(
  'a law of flags needs no step',
  `${LOGIC}
rule both-commutes
  seat a, like flag
  seat b, like flag
  show hold, is-equal both(a, b), both(b, a)
`,
  'ok',
)

expect(
  'and a law over values the kernel cannot compute needs none either',
  `${LOGIC}
rule arrow-of-an-arrow
  seat v, like assignment
  seat p, like formula
  seat q, like formula
  show hold
    is-equal
      value(v, make arrow(p, make arrow(q, p)))
      make yes
`,
  'ok',
)

expect(
  'a false law with no step is refused with the values that break it',
  `${LOGIC}
rule both-is-implies
  seat a, like flag
  seat b, like flag
  show hold, is-equal both(a, b), implies(a, b)
`,
  'this rule is FALSE where a is no',
)

// sets as truth-valued tasks over any type: a generic alias (`set a`), a rule with a type parameter, operations that
// return sets. A membership `has(s, x)` computes to `s(x)`, the same atom, so the counterexample names only real values
const SETS = `${LOGIC}
task either
  take a, like flag
  take b, like flag

  like flag

  sift a
    case yes
      back make yes
    case no
      back b

form set
  head a
  like task
    take x, like a
    like flag

task has
  head a
  take s, like set a
  take x, like a

  like flag

  back s(x)

task union
  head a
  take s, like set a
  take t, like set a

  like set a

  back
    task
      take x, like a
      like flag
      back either(s(x), t(x))
`

expect(
  'a set law over every type decides itself (union associates)',
  `${SETS}
rule union-associates
  head a
  seat s, like set a
  seat t, like set a
  seat r, like set a
  seat x, like a
  show hold, is-equal has(union(union(s, t), r), x), has(union(s, union(t, r)), x)
`,
  'ok',
)

expect(
  'a false set law names the memberships that break it, and only those',
  `${SETS}
rule union-is-the-left
  head a
  seat s, like set a
  seat t, like set a
  seat x, like a
  show hold, is-equal has(union(s, t), x), has(s, x)
`,
  'this rule is FALSE where s(x) is no, t(x) is yes',
)

expect(
  'a false law with nothing to choose is refused as false, with what its sides compute to',
  `${SETS}
task empty
  head a

  like set a

  back
    task
      take x, like a
      like flag
      back make no

rule empty-has-everything
  head a
  seat x, like a
  show hold, is-equal has(empty(), x), make yes
`,
  'this rule is FALSE: its two sides compute to no and yes',
)

// ONE FALSE LAW DOES NOT HIDE ANOTHER'S REFUSAL: the kernel refuses the first, and the provers' verdict on the second,
// which the kernel neither proved nor refused, is reported beside it (compile/compile.ts)
{
  const result = compile(
    {
      file: 't.tree',
      text: `${LOGIC}
rule both-is-implies
  seat a, like flag
  seat b, like flag
  show hold, is-equal both(a, b), implies(a, b)

rule plus-commutes-unproven
  seat m, like natural
  seat n, like natural
  show hold, is-equal plus(m, n), plus(n, m)
`,
    },
    { leanOf: () => true },
  )
  const names = result.ok ? [] : result.diagnostics.map(d => d.name)
  // the second law is refused by the provers, as not proven: unchecked or unproven, as long as it is SAID
  const good = !result.ok && names.includes('invalid-proof') && names.some(n => n === 'unchecked-hold' || n === 'unproven')

  if (good) {
    pass++
    console.log('ok    one false law does not hide an unproven law beside it')
  } else {
    fail++
    console.log(`FAIL  one false law does not hide an unproven law beside it  (${names.join(', ')})`)
  }
}

console.log(`\ntruth-table: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
