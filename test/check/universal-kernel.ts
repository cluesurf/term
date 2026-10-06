// UNIVERSAL HYPOTHESES IN THE KERNEL, over any type (math-foundations-0004): `have h / mark u, like a / L == R` is
// instantiated at the goal's own terms of type `a` (check/elaborate.ts universalInstances), the instances decided by the
// truth table's pruned search (`truthTable`) and by congruence closure (check/judge.ts `congruent`). Each acceptance
// sits beside a refusal of the same shape with one thing changed, and the soundness cases come first: an instance at a
// term of another type, two unrelated hypotheses, and a universal used past the terms the goal names.
// Run: npx tsx test/check/universal-kernel.ts

import { compile } from '@term/make/code/compile/compile'

let pass = 0
let fail = 0

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

task implies
  take a, like flag
  take b, like flag
  like flag
  sift a
    case yes
      back b
    case no
      back make yes

form relation
  head a
  like task
    take x, like a
    take y, like a
    like flag
`

// `want` is 'ok', or a diagnostic name, optionally with a phrase its message must hold
function expect(name: string, source: string, want: string, phrase?: string): void {
  const result = compile({ file: 'u.tree', text: source }, { leanOf: () => true })
  const said = result.ok ? [] : result.diagnostics
  const good =
    want === 'ok'
      ? result.ok
      : !result.ok && said.some(d => d.name === want && (!phrase || d.message.includes(phrase)))

  if (good) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  (ok=${result.ok}, ${said.map(d => `${d.name}: ${d.message}`).join(' | ')})`)
  }
}

expect(
  'an instance is never taken at a term of another type',
  `${FLAG}
rule other-type
  head a
  head b
  seat r, like relation a
  seat p, like relation b
  seat x, like a
  seat y, like b
  have p-is-reflexive
    seat u, like b
    is-equal p(u, u), make yes
  show hold, is-equal r(x, x), make yes
`,
  'invalid-proof',
)

expect(
  'two unrelated hypotheses do not join their ends',
  `
rule unrelated
  head a
  seat f
    like task
      take x, like a
      like a
  seat x, like a
  seat y, like a
  seat z, like a
  seat w, like a
  have first, is-equal f(x), y
  have second, is-equal f(z), w
  show hold, is-equal y, w
`,
  'unproven',
)

expect(
  'a universal is used only at the terms the goal names, and says so',
  `${FLAG}
rule symmetry-alone
  head a
  seat r, like relation a
  seat x, like a
  seat y, like a
  seat z, like a
  have symmetric
    seat u, like a
    seat v, like a
    is-equal r(u, v), r(v, u)
  have first, is-equal r(x, y), make yes
  have second, is-equal r(y, z), make yes
  show hold, is-equal r(x, z), make yes
`,
  'invalid-proof',
  'does not follow from its hypotheses at the terms it names: they all hold where r(x, z) is no, r(x, y) is yes, r(y, z) is yes,',
)

expect(
  'symmetry at two named elements',
  `${FLAG}
rule symmetric-twice
  head a
  seat r, like relation a
  seat x, like a
  seat y, like a
  have symmetric
    seat u, like a
    seat v, like a
    is-equal r(u, v), r(v, u)
  have related, is-equal r(x, y), make yes
  show hold, is-equal r(y, x), make yes
`,
  'ok',
)

expect(
  'transitivity chains two steps',
  `${FLAG}
rule transitive-chain
  head a
  seat r, like relation a
  seat x, like a
  seat y, like a
  seat z, like a
  have transitive
    seat u, like a
    seat v, like a
    seat w, like a
    is-equal implies(both(r(u, v), r(v, w)), r(u, w)), make yes
  have first, is-equal r(x, y), make yes
  have second, is-equal r(y, z), make yes
  show hold, is-equal r(x, z), make yes
`,
  'ok',
)

expect(
  'sixteen atoms, decided by the pruned search: overlapping classes agree',
  `${FLAG}
rule overlapping
  head a
  seat r, like relation a
  seat x, like a
  seat y, like a
  seat z, like a
  seat w, like a
  have symmetric
    seat u, like a
    seat v, like a
    is-equal r(u, v), r(v, u)
  have transitive
    seat u, like a
    seat v, like a
    seat t, like a
    is-equal implies(both(r(u, v), r(v, t)), r(u, t)), make yes
  have z-with-x, is-equal r(x, z), make yes
  have z-with-y, is-equal r(y, z), make yes
  show hold, is-equal r(x, w), r(y, w)
`,
  'ok',
)

expect(
  'and without symmetry they need not',
  `${FLAG}
rule overlapping-without-symmetry
  head a
  seat r, like relation a
  seat x, like a
  seat y, like a
  seat z, like a
  seat w, like a
  have transitive
    seat u, like a
    seat v, like a
    seat t, like a
    is-equal implies(both(r(u, v), r(v, t)), r(u, t)), make yes
  have z-with-x, is-equal r(x, z), make yes
  have z-with-y, is-equal r(y, z), make yes
  show hold, is-equal r(x, w), r(y, w)
`,
  'invalid-proof',
)

const FUNCTIONS = `  seat f
    like task
      take x, like a
      like b
  seat g
    like task
      take y, like b
      like a
`

expect(
  'a left inverse makes a function injective, by congruence',
  `
rule injective
  head a
  head b
${FUNCTIONS}  seat x, like a
  seat y, like a
  have g-undoes-f
    seat u, like a
    is-equal g(f(u)), u
  have same-image, is-equal f(x), f(y)
  show hold, is-equal x, y
`,
  'ok',
)

expect(
  'and a section does not',
  `
rule not-injective
  head a
  head b
${FUNCTIONS}  seat x, like a
  seat y, like a
  have f-undoes-g
    seat v, like b
    is-equal f(g(v)), v
  have same-image, is-equal f(x), f(y)
  show hold, is-equal x, y
`,
  'unproven',
)

expect(
  'a section makes it surjective, through the witness',
  `
rule surjective
  head a
  head b
${FUNCTIONS}  seat z, like b
  have f-undoes-g
    seat v, like b
    is-equal f(g(v)), v
  find x, g(z)
  show hold, is-equal f(x), z
`,
  'ok',
)

expect(
  'and a left inverse does not',
  `
rule not-surjective
  head a
  head b
${FUNCTIONS}  seat z, like b
  have g-undoes-f
    seat u, like a
    is-equal g(f(u)), u
  find x, g(z)
  show hold, is-equal f(x), z
`,
  'unproven',
)

expect(
  'a universal over numbers stays the hold checker’s, and still proves',
  `
rule numbers
  seat x
    like task
      take t, like integer
      like integer
  seat n, like integer
  have non-decreasing
    seat t, like integer
    is-maximum x(t), x(add(t, 1))
  show hold, is-maximum x(n), x(add(n, 2))
`,
  'ok',
)

console.log(`universal-kernel: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
