// `cite <rule>`: a theorem uses a rule proven above it (check/holds.ts `citedFacts`). The cited rule's hypotheses are
// proved at the citing goal, then its conclusion is a fact there. The instance is chosen by NAME: the cited rule's marks
// are the citing rule's names of the same spelling, and a `find` names any other value.
// Run: npx tsx test/check/cite.ts
//
// Each refusal is built so that skipping the check it holds would prove a FALSE statement, and every refusal sits
// beside a citation that must still be proven, so the suite cannot pass by refusing everything.

import { compile } from '@term/make/code/compile/compile'
import { provenRules } from '@term/make/code/check/holds'

let pass = 0
let fail = 0

// `want` is 'ok', or a text the refusal's message must contain
function expect(name: string, source: string, want: string): void {
  const result = compile({ file: 'c.tree', text: source })
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

// x(0) = 0 and x(t + 1) = x(t) + 2 for every t: then x(n) = 2 n for every count n. It needs induction
const RECURRENCE = `  mark x
    like task
      take t, like integer
      like integer
  mark n, like integer
  have starts-at-zero
    call is-equal
      call x
        code 0
      code 0
  have steps-by-two
    mark t, like integer
    call is-equal
      call x
        call add
          read t
          code 1
      call add
        call x
          read t
        code 2
`

const COUNT = `  have n-is-a-count
    call is-minimum
      read n
      code 0
`

const DOUBLES = `
rule doubles
${RECURRENCE}${COUNT}  show hold
    call is-equal
      call x
        read n
      call multiply
        code 2
        read n
  fold n
`

const AT_LEAST_N = `  show hold
    call is-minimum
      call x
        read n
      read n
`

expect('the cited rule is proven by induction', DOUBLES, 'ok')

expect(
  'citing it closes a goal that needs the induction: x(n) >= n',
  `${DOUBLES}
rule at-least-n
${RECURRENCE}${COUNT}${AT_LEAST_N}  cite doubles
`,
  'ok',
)

expect(
  'control: without the citation the same goal is not proven',
  `${DOUBLES}
rule at-least-n
${RECURRENCE}${COUNT}${AT_LEAST_N}`,
  'unproven',
)

// a cited rule's hypotheses must be PROVED where it is cited. a >= 2 gives a * a >= 2 a, which is false at a = 1, so a
// citation that skipped the hypothesis would prove a false statement from a >= 1
const SQUARE = `
rule square-bound
  mark a, like integer
  have a-is-at-least-two
    call is-minimum
      read a
      code 2
  show hold
    call is-minimum
      call multiply
        read a
        read a
      call multiply
        code 2
        read a
`

const SQUARE_GOAL = `  show hold
    call is-minimum
      call multiply
        read a
        read a
      call multiply
        code 2
        read a
  cite square-bound
`

expect(
  'a hypothesis that does not hold here refuses the citation (a >= 1 does not give a * a >= 2 a)',
  `${SQUARE}
rule false-square
  mark a, like integer
  have a-is-at-least-one
    call is-minimum
      read a
      code 1
${SQUARE_GOAL}`,
  'cite square-bound: its hypothesis 1 does not follow',
)

expect(
  'control: where the hypothesis holds the citation is accepted (a >= 3)',
  `${SQUARE}
rule true-square
  mark a, like integer
  have a-is-at-least-three
    call is-minimum
      read a
      code 3
${SQUARE_GOAL}`,
  'ok',
)

expect(
  'a rule proven BELOW cannot be cited, so no rule can rest on itself',
  `
rule true-square
  mark a, like integer
  have a-is-at-least-three
    call is-minimum
      read a
      code 3
${SQUARE_GOAL}${SQUARE}`,
  'cite square-bound: it is not a rule proven above',
)

expect(
  'a rule that FAILED cannot be cited',
  `
rule square-bound
  mark a, like integer
  show hold
    call is-minimum
      call multiply
        read a
        read a
      call multiply
        code 2
        read a

rule uses-it
  mark a, like integer
${SQUARE_GOAL}`,
  'cite square-bound: it is not a rule proven above',
)

expect(
  "the cited rule's marks are read by name: a rule without an `a` cannot cite it",
  `${SQUARE}
rule other-name
  mark b, like integer
  have b-is-at-least-three
    call is-minimum
      read b
      code 3
  show hold
    call is-minimum
      read b
      code 3
  cite square-bound
`,
  'its mark a names nothing in this rule',
)

expect(
  'a find names the instance: p = a + 1 with a >= 1, so p >= 2 and p * p >= 2 p',
  `${SQUARE.replaceAll('read a', 'read p').replace('mark a,', 'mark p,')}
rule shifted
  mark a, like integer
  have a-is-at-least-one
    call is-minimum
      read a
      code 1
  find p
    call add
      read a
      code 1
  show hold
    call is-minimum
      call multiply
        read p
        read p
      call multiply
        code 2
        read p
  cite square-bound
`,
  'ok',
)

// a theorem with universal hypotheses is decided over an ordered field, and may not rest on integer reasoning. `a > 0`
// gives `a >= 1` only over the integers (a = 1/2 is a rational counterexample), so that rule is `integer`
const TIGHTEN = `
rule positive-is-one
  mark a, like integer
  have a-is-positive
    call is-above
      read a
      code 0
  show hold
    call is-minimum
      read a
      code 1
`

const FIELD_RULE = (cited: string, goal: string): string => `
rule field-rule
  mark a, like integer
  mark x
    like task
      take t, like integer
      like integer
  have flat
    mark t, like integer
    call is-equal
      call x
        read t
      code 0
  have a-is-at-least-three
    call is-minimum
      read a
      code 3
${goal}  cite ${cited}
`

expect(
  'a rule decided over a field cannot cite one proven only with integer reasoning',
  `${TIGHTEN}${FIELD_RULE(
    'positive-is-one',
    `  show hold
    call is-minimum
      read a
      code 1
`,
  )}`,
  'it was proven with integer reasoning',
)

expect(
  'control: it may cite a rule the field-only provers also prove (a >= 2 gives a * a >= 2 a over any field)',
  `${SQUARE}${FIELD_RULE(
    'square-bound',
    SQUARE_GOAL.replace('  cite square-bound\n', ''),
  )}`,
  'ok',
)

// a disjunction is field-valid by the case split: u v < 0 and w w > 0 give u w < 0 or v w < 0, since their product is
// u v w w < 0. Classified `integer` it would be refused here
const PASCH = `
rule pasch
  mark u, like integer
  mark v, like integer
  mark w, like integer
  have crosses
    call is-below
      call multiply
        read u
        read v
      code 0
  have off-the-line
    call is-above
      call multiply
        read w
        read w
      code 0
  show hold
    meet or
      call is-below
        call multiply
          read u
          read w
        code 0
      call is-below
        call multiply
          read v
          read w
        code 0
`

{
  const result = compile({ file: 'c.tree', text: PASCH })
  const how = provenRules().get('pasch')

  if (result.ok && how === 'field') {
    pass++
    console.log('ok    a disjunction proven by a case split is measured field-valid')
  } else {
    fail++
    console.log(`FAIL  a disjunction proven by a case split is measured field-valid  (ok=${result.ok}, measured ${how})`)
  }
}

expect(
  'a disjunction proven by a case split is field-valid, and a rule with universal hypotheses proves a disjunction too',
  `${PASCH}
rule field-pasch
  mark u, like integer
  mark v, like integer
  mark w, like integer
  mark x
    like task
      take t, like integer
      like integer
  have flat
    mark t, like integer
    call is-equal
      call x
        read t
      code 0
  have crosses
    call is-below
      call multiply
        read u
        read v
      code 0
  have off-the-line
    call is-above
      call multiply
        read w
        read w
      code 0
  show hold
    meet or
      call is-below
        call multiply
          read u
          read w
        code 0
      call is-below
        call multiply
          read v
          read w
        code 0
  cite pasch
`,
  'ok',
)

expect(
  'and a FALSE disjunction is still refused there: a >= 3 does not give a < 0 or a > 5 (a = 4)',
  FIELD_RULE(
    'square-bound',
    `  show hold
    meet or
      call is-below
        read a
        code 0
      call is-above
        read a
        code 5
`,
  ).replace('  cite square-bound\n', '') + SQUARE,
  'unproven',
)

// a cited rule's universal hypothesis must be one the citing rule states, word for word
expect(
  'a universal hypothesis the citing rule lacks refuses the citation',
  `${DOUBLES}
rule at-least-n
${RECURRENCE.replace('code 2\n', 'code 3\n')}${COUNT}${AT_LEAST_N}  cite doubles
`,
  'its universal hypothesis steps-by-two is not one of this rule',
)

// a cite of a name that is no rule, under a goal that is not an equality: the kernel pass reads steps only under an
// equality, so here nothing else would refuse it, and a step that did nothing would read as a proof that used it
expect(
  'a cite of a name that is no rule is refused, under an inequality too',
  `
rule shifted
  mark a, like integer
  have a-is-at-least-two
    call is-minimum
      read a
      code 2
  show hold
    call is-minimum
      call add
        read a
        code 1
      code 3
  cite no-such-rule
`,
  'cite no-such-rule: there is no rule of that name in this build',
)

// ACROSS FILES: the cited rule is in another file, loaded with `find`. The merged build's tree-shaking pruned a rule
// that was only cited (no call reaches a rule), so the citation found nothing and was skipped in silence until
// 2026-10-05 (check/cite-roots.ts). Here the citing rule knows a >= 1, so the cited a >= 2 must be refused by name
{
  const citing = (least: number): string => `load ./square
  find square-bound

rule uses-the-square
  mark a, like integer
  have a-is-at-least
    call is-minimum
      read a
      code ${least}
${SQUARE_GOAL}`
  const square = { file: '/memory/code/square.tree', text: SQUARE }
  const resolve = (path: string) => (path === './square' ? square : undefined)
  const build = (least: number) =>
    compile({ file: '/memory/code/base.tree', text: citing(least) }, { resolve })

  const refused = build(1)
  const messages = refused.ok ? [] : refused.diagnostics.map(d => d.message)

  if (!refused.ok && messages.some(m => m.includes('cite square-bound: its hypothesis 1 does not follow'))) {
    pass++
    console.log('ok    a rule in another file is cited: its hypothesis is checked here (a >= 1 is refused)')
  } else {
    fail++
    console.log(`FAIL  a rule in another file is cited  (ok=${refused.ok})\n      ${messages.join('\n      ')}`)
  }

  const held = build(3)

  if (held.ok) {
    pass++
    console.log('ok    control: and where it holds the citation is accepted (a >= 3)')
  } else {
    fail++
    console.log(`FAIL  control: a >= 3 across files\n      ${held.diagnostics.map(d => d.message).join('\n      ')}`)
  }
}

console.log(`\ncite: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
