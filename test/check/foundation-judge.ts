// Foundation battery on the DECIDED kernel (judge.ts), the real 12-type-systems stack:
// predicative cumulative universe-polymorphic hierarchy, quantities 0/1/many, Id/refl/J with observational
// funext that computes, dependent pairs, and self types. This checks the foundation on the sound kernel that
// Seed actually uses, not the superseded Type-in-Type kernel.ts. Run: npx tsx test/check/foundation-judge.ts

import type { Mult, Term } from '@term/make/code/check/judge'
import {
  check,
  checks,
  contextWithSignature,
  emptyContext,
  evaluate,
  instantiateLevel,
  litLevel,
  eqLevel,
  bind,
} from '@term/make/code/check/judge'

// ---- term builders (the judge.ts idiom) ----
const v = (index: number): Term => ({ tag: 'var', index })
const kconst = (name: string): Term => ({ tag: 'const', name })
const ty = (n: number): Term => ({ tag: 'type', level: litLevel(n) })
const tyVar = (name: string): Term => ({
  tag: 'type',
  level: { constant: 0, vars: new Map([[name, 0]]) },
})

const pi = (mult: Mult, domain: Term, codomain: Term): Term => ({
  tag: 'pi',
  mult,
  domain,
  codomain,
})

const lam = (body: Term): Term => ({ tag: 'lam', body })
const app = (fun: Term, arg: Term): Term => ({ tag: 'app', fun, arg })
const id = (type: Term, left: Term, right: Term): Term => ({
  tag: 'id',
  type,
  left,
  right,
})

const refl = (type: Term, value: Term): Term => ({
  tag: 'refl',
  type,
  value,
})

const sigma = (mult: Mult, domain: Term, codomain: Term): Term => ({
  tag: 'sigma',
  mult,
  domain,
  codomain,
})

const pair = (first: Term, second: Term): Term => ({
  tag: 'pair',
  first,
  second,
})

const self = (body: Term): Term => ({ tag: 'self', body })

let pass = 0
let fail = 0

function ok(name: string, run: () => boolean): void {
  let result = false

  try {
    result = run()
  } catch (error) {
    console.log(
      `FAIL  ${name}\n  ${error instanceof Error ? error.message : String(error)}`,
    )
    fail++

    return
  }

  if (result) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}`)
  }
}

function rejects(name: string, run: () => void): void {
  try {
    run()
  } catch {
    pass++
    console.log(`ok    ${name} (correctly rejected)`)

    return
  }

  fail++
  console.log(`FAIL  ${name} (should have been rejected)`)
}

// universe-polymorphic identity: (0 u : level) (0 A : Type u) (1 x : A) -> A
const idTypePoly = pi(0, tyVar('u'), pi(1, v(0), v(1)))
const idTerm = lam(lam(v(0)))

// ===== universe polymorphism: one definition checks at every level =====
ok('identity checks at universe level 0', () =>
  checks(idTerm, instantiateLevel(idTypePoly, 'u', litLevel(0))),
)
ok(
  'identity checks at universe level 5 (cumulative, polymorphic)',
  () => checks(idTerm, instantiateLevel(idTypePoly, 'u', litLevel(5))),
)
ok('Type 0 has type Type 1', () => checks(ty(0), ty(1)))
rejects('Type : Type is rejected (Type 0 is not in Type 0)', () => {
  void checks(ty(0), ty(0))
})

// ===== quantities (QTT): linear use is enforced =====
const regionSig = [
  { name: 'R', type: ty(0) },
  { name: 'unit', type: ty(0) },
  { name: 'nothing', type: kconst('unit') },
]

ok('a linear value is used exactly once', () => {
  check(
    contextWithSignature(regionSig),
    lam(v(0)),
    evaluate([], pi(1, kconst('R'), kconst('R'))),
  )

  return true
})
rejects('using a linear value twice is rejected', () => {
  check(
    contextWithSignature(regionSig),
    lam(pair(v(0), v(0))),
    evaluate(
      [],
      pi(1, kconst('R'), sigma('many', kconst('R'), kconst('R'))),
    ),
  )
})
rejects('dropping a linear value is rejected', () => {
  check(
    contextWithSignature(regionSig),
    lam(kconst('nothing')),
    evaluate([], pi(1, kconst('R'), kconst('unit'))),
  )
})

// ===== identity type and reflexivity =====
ok('refl proves a reflexive equality', () =>
  checks(refl(ty(1), ty(0)), id(ty(1), ty(0), ty(0))),
)

// ===== observational function extensionality (derivable, the identity) =====
// funext : (0 A : Type0) (0 B : Type0) (0 f g : A -> B)
//          (1 _ : (1 x : A) -> Id B (f x) (g x)) -> Id (A -> B) f g
const arrow = pi(1, v(/*A*/ 3), v(/*B*/ 3))
const funextType = pi(
  0,
  ty(0), // A
  pi(
    0,
    ty(0), // B
    pi(
      0,
      pi(1, v(1), v(1)), // f : A -> B
      pi(
        0,
        pi(1, v(2), v(2)), // g : A -> B
        pi(
          1,
          pi(1, v(3), id(v(3), app(v(2), v(0)), app(v(1), v(0)))), // pointwise
          id(pi(1, v(4), v(4)), v(2), v(1)), // Id (A->B) f g
        ),
      ),
    ),
  ),
)

void arrow

const funextTerm = lam(lam(lam(lam(lam(v(0))))))
ok('function extensionality is derivable (Id at Pi computes)', () =>
  checks(funextTerm, funextType),
)

// ===== dependent pairs (Sigma) =====
ok('a dependent pair checks against its sigma type', () => {
  const context = contextWithSignature([
    { name: 'Nat', type: ty(0) },
    { name: 'value', type: kconst('Nat') },
  ])

  check(
    context,
    pair(kconst('value'), kconst('value')),
    evaluate([], sigma('many', kconst('Nat'), kconst('Nat'))),
  )

  return true
})

// ===== self types (the inductive foundation) =====
ok('a self type is a well-formed type', () => {
  const context = contextWithSignature([{ name: 'Nat', type: ty(0) }])
  // Self x. Nat  :  Type0   (a trivial self type, formation only)
  check(context, self(kconst('Nat')), evaluate([], ty(0)))

  return true
})

// ===== discharged proofs: real theorems of the foundations, as judge.ts proof terms =====
const jay = (
  proof: Term,
  motive: Term,
  base: Term,
  level: number,
): Term => ({ tag: 'j', proof, motive, base, level: litLevel(level) })

// symmetry of equality: given p : Id A x y, prove Id A y x, by J.
// motive C = \ y'. \ p'. Id A y' x ;  base : Id A x x = refl ;  J p C base : Id A y x.
ok('equality is symmetric (Id A x y -> Id A y x), proved by J', () => {
  const context = contextWithSignature([
    { name: 'A', type: ty(0) },
    { name: 'x', type: kconst('A') },
    { name: 'y', type: kconst('A') },
    { name: 'p', type: id(kconst('A'), kconst('x'), kconst('y')) },
  ])

  const motive = lam(lam(id(kconst('A'), v(1), kconst('x'))))
  const base = refl(kconst('A'), kconst('x'))
  const proofTerm = jay(kconst('p'), motive, base, 0)
  check(
    context,
    proofTerm,
    evaluate([], id(kconst('A'), kconst('y'), kconst('x'))),
  )

  return true
})

// transport (substitution): given P : A -> Type, p : Id A x y, and P x, produce P y, by J.
// motive C = \ y'. \ p'. P y' ;  base : P x ;  J p C base : P y.
ok('transport along equality (P x -> P y), proved by J', () => {
  const context = contextWithSignature([
    { name: 'A', type: ty(0) },
    { name: 'P', type: pi('many', kconst('A'), ty(0)) },
    { name: 'x', type: kconst('A') },
    { name: 'y', type: kconst('A') },
    { name: 'p', type: id(kconst('A'), kconst('x'), kconst('y')) },
    { name: 'px', type: app(kconst('P'), kconst('x')) },
  ])

  const motive = lam(lam(app(kconst('P'), v(1))))
  const base = kconst('px')
  const proofTerm = jay(kconst('p'), motive, base, 0)
  check(context, proofTerm, evaluate([], app(kconst('P'), kconst('y'))))

  return true
})

// transitivity: given p : Id A x y and q : Id A y z, prove Id A x z, by J on q.
// motive C = \ z'. \ q'. Id A x z' ;  base : Id A x y = p ;  J q C base : Id A x z.
ok(
  'equality is transitive (Id A x y -> Id A y z -> Id A x z), proved by J',
  () => {
    const context = contextWithSignature([
      { name: 'A', type: ty(0) },
      { name: 'x', type: kconst('A') },
      { name: 'y', type: kconst('A') },
      { name: 'z', type: kconst('A') },
      { name: 'p', type: id(kconst('A'), kconst('x'), kconst('y')) },
      { name: 'q', type: id(kconst('A'), kconst('y'), kconst('z')) },
    ])

    const motive = lam(lam(id(kconst('A'), kconst('x'), v(1))))
    const base = kconst('p')
    const proofTerm = jay(kconst('q'), motive, base, 0)
    check(
      context,
      proofTerm,
      evaluate([], id(kconst('A'), kconst('x'), kconst('z'))),
    )

    return true
  },
)

// congruence: given f : A -> B and p : Id A x y, prove Id B (f x) (f y), by J on p.
// motive C = \ y'. \ p'. Id B (f x) (f y') ;  base : Id B (f x) (f x) = refl ;  J p C base : Id B (f x) (f y).
ok('equality is a congruence (f respects =), proved by J', () => {
  const context = contextWithSignature([
    { name: 'A', type: ty(0) },
    { name: 'B', type: ty(0) },
    { name: 'f', type: pi('many', kconst('A'), kconst('B')) },
    { name: 'x', type: kconst('A') },
    { name: 'y', type: kconst('A') },
    { name: 'p', type: id(kconst('A'), kconst('x'), kconst('y')) },
  ])

  const motive = lam(
    lam(
      id(
        kconst('B'),
        app(kconst('f'), kconst('x')),
        app(kconst('f'), v(1)),
      ),
    ),
  )

  const base = refl(kconst('B'), app(kconst('f'), kconst('x')))
  const proofTerm = jay(kconst('p'), motive, base, 0)
  check(
    context,
    proofTerm,
    evaluate(
      [],
      id(
        kconst('B'),
        app(kconst('f'), kconst('x')),
        app(kconst('f'), kconst('y')),
      ),
    ),
  )

  return true
})

// ===== a Peano signature: successor respects equality (an arithmetic theorem) =====
// given succ : Nat -> Nat and p : Id Nat m n, prove Id Nat (succ m) (succ n), by J.
ok(
  'successor respects equality (Id Nat m n -> Id Nat (succ m) (succ n))',
  () => {
    const context = contextWithSignature([
      { name: 'Nat', type: ty(0) },
      { name: 'succ', type: pi('many', kconst('Nat'), kconst('Nat')) },
      { name: 'm', type: kconst('Nat') },
      { name: 'n', type: kconst('Nat') },
      { name: 'p', type: id(kconst('Nat'), kconst('m'), kconst('n')) },
    ])

    const motive = lam(
      lam(
        id(
          kconst('Nat'),
          app(kconst('succ'), kconst('m')),
          app(kconst('succ'), v(1)),
        ),
      ),
    )

    const base = refl(kconst('Nat'), app(kconst('succ'), kconst('m')))
    const proofTerm = jay(kconst('p'), motive, base, 0)
    check(
      context,
      proofTerm,
      evaluate(
        [],
        id(
          kconst('Nat'),
          app(kconst('succ'), kconst('m')),
          app(kconst('succ'), kconst('n')),
        ),
      ),
    )

    return true
  },
)

// ===== proof erasure (the QTT core): a multiplicity-0 proof may go unused, a linear value must be used once =====
ok(
  'an erased (0) proof can be dropped while a linear (1) value is used once',
  () => {
    const context = contextWithSignature([
      { name: 'P', type: ty(0) },
      { name: 'A', type: ty(0) },
    ])

    // \ (0 p : P). \ (1 x : A). x   :   (0 _ : P) -> (1 x : A) -> A
    check(
      context,
      lam(lam(v(0))),
      evaluate([], pi(0, kconst('P'), pi(1, kconst('A'), kconst('A')))),
    )

    return true
  },
)

function main(): void {
  console.log(
    `\nfoundation (decided kernel judge.ts): ${pass} pass, ${fail} fail`,
  )
  void eqLevel
  void bind
  void emptyContext
}

main()
