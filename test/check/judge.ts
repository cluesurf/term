// Tests for the dependent type judgment: universe-polymorphic hierarchy, quantities (linearity), the identity
// type, and observational function extensionality (funext that COMPUTES, derivable as the identity).
// Run: npx tsx test/check/judge.ts

import type { Level, Term } from '@term/make/code/check/judge'
import {
  bind,
  check,
  checks,
  contextWithSignature,
  defineConstant,
  emptyContext,
  eqLevel,
  evaluate,
  freshMeta,
  infer,
  instantiateLevel,
  litLevel,
  resetDefinitions,
  resetMetas,
  varLevel,
  TypeError as CoreTypeError,
} from '@term/make/code/check/judge'
import type { Mult } from '@term/make/code/check/judge'

const v = (index: number): Term => ({ tag: 'var', index })
const kconst = (name: string): Term => ({ tag: 'const', name })
const ann = (term: Term, type: Term): Term => ({
  tag: 'ann',
  term,
  type,
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

const fst = (p: Term): Term => ({ tag: 'fst', pair: p })
const snd = (p: Term): Term => ({ tag: 'snd', pair: p })
const self = (body: Term): Term => ({ tag: 'self', body })
const ty = (n: number): Term => ({ tag: 'type', level: litLevel(n) })
const tyVar = (name: string): Term => ({
  tag: 'type',
  level: varLevel(name),
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

const typeValue = (n: number) => ({
  v: 'type' as const,
  level: litLevel(n),
})

let pass = 0
let fail = 0

function ok(name: string, run: () => void): void {
  try {
    run()
    pass++
    console.log(`ok    ${name}`)
  } catch (error) {
    fail++
    console.log(
      `FAIL  ${name}\n      ${
        error instanceof Error
          ? error.message.replace(/\n/g, '\n      ')
          : String(error)
      }`,
    )
  }
}

function rejects(name: string, run: () => void): void {
  try {
    run()
    fail++
    console.log(
      `FAIL  ${name}  (expected a type error, but it checked)`,
    )
  } catch (error) {
    if (error instanceof CoreTypeError) {
      pass++
      console.log(`ok    ${name}  (${error.message.split('\n')[0]})`)
    } else {
      fail++
      console.log(`FAIL  ${name}  (wrong error: ${String(error)})`)
    }
  }
}

function main(): void {
  // ---- universe hierarchy ----
  ok('Type 0 : Type 1', () => {
    const t = infer(emptyContext, ty(0)).type

    if (!(t.v === 'type' && eqLevel(t.level, litLevel(1))))
      {throw new CoreTypeError('expected Type 1')}
  })
  ok(
    'Type 0 checks against Type 1',
    () => void check(emptyContext, ty(0), typeValue(1)),
  )
  ok(
    'cumulativity: Type 0 against Type 2',
    () => void check(emptyContext, ty(0), typeValue(2)),
  )
  rejects(
    'Type 1 not against Type 0',
    () => void check(emptyContext, ty(1), typeValue(0)),
  )

  // ---- universe POLYMORPHISM: an identity polymorphic over a level variable u ----
  const idTypePoly = pi(0, tyVar('u'), pi(1, v(0), v(1)))
  const idTerm = lam(lam(v(0)))
  ok(
    'level-polymorphic identity checks abstractly',
    () => void checks(idTerm, idTypePoly),
  )
  ok('instantiate u := 0 and it still checks', () => {
    const idType0 = instantiateLevel(idTypePoly, 'u', litLevel(0))

    if (!checks(idTerm, idType0))
      {throw new CoreTypeError('instantiated identity did not check')}
  })
  ok('instantiate u := 5 and it still checks', () => {
    const idType5 = instantiateLevel(idTypePoly, 'u', litLevel(5))

    if (!checks(idTerm, idType5))
      {throw new CoreTypeError('instantiated identity did not check')}
  })

  // ---- quantities / linearity ----
  ok(
    'linear used once',
    () => void checks(lam(v(0)), pi(1, ty(0), ty(0))),
  )
  rejects(
    'linear used zero times',
    () => void checks(lam(ty(0)), pi(1, ty(0), ty(1))),
  )
  rejects(
    'erased argument used',
    () => void checks(lam(v(0)), pi(0, ty(0), ty(0))),
  )
  ok(
    'many used zero times',
    () => void checks(lam(ty(0)), pi('many', ty(0), ty(1))),
  )

  // ---- identity type ----
  ok('refl of a type', () => {
    if (!checks(refl(ty(1), ty(0)), id(ty(1), ty(0), ty(0))))
      {throw new CoreTypeError('refl did not check')}
  })
  rejects(
    'refl with unequal sides',
    () =>
      void check(emptyContext, refl(ty(2), ty(0)), {
        v: 'id',
        type: typeValue(2),
        left: typeValue(0),
        right: typeValue(1),
      }),
  )

  // J on refl
  ok('J on refl type-checks', () => {
    const motive = lam(lam(id(ty(1), ty(0), v(1))))
    const base = refl(ty(1), ty(0))
    const proof = refl(ty(1), ty(0))
    const jTerm: Term = {
      tag: 'j',
      proof,
      motive,
      base,
      level: litLevel(2),
    }

    void check(emptyContext, jTerm, {
      v: 'id',
      type: typeValue(1),
      left: typeValue(0),
      right: typeValue(0),
    })
  })

  // ---- observational funext: DERIVABLE (the identity function), because Id at a function type computes ----
  ok('funext is the identity (computes, not postulated)', () => {
    // funext : (0 A:Type0)(0 B:(1 A)->Type0)(0 f:(1 A)->B)(0 g:(1 A)->B)
    //          (1 _:(1 x:A)->Id (B x)(f x)(g x)) -> Id ((1 A)->B) f g
    const funextType: Term = pi(
      0,
      ty(0),
      pi(
        0,
        pi(1, v(0), ty(0)),
        pi(
          0,
          pi(1, v(1), app(v(1), v(0))),
          pi(
            0,
            pi(1, v(2), app(v(2), v(0))),
            pi(
              1,
              pi(
                1,
                v(3),
                id(app(v(3), v(0)), app(v(2), v(0)), app(v(1), v(0))),
              ),
              id(pi(1, v(4), app(v(4), v(0))), v(2), v(1)),
            ),
          ),
        ),
      ),
    )

    // the proof is just: lambda A. lambda B. lambda f. lambda g. lambda h. h
    const funextTerm = lam(lam(lam(lam(lam(v(0))))))

    if (!checks(funextTerm, funextType))
      {throw new CoreTypeError('funext-as-identity did not check')}
  })

  // ---- metavariables: unification solves a type argument from a value argument ----
  // identity : (0 A : Type0) -> (1 x : A) -> A, applied to a fresh meta and a value of type Nat. The meta must be
  // solved to Nat for the application to check at Nat.
  const idType: Term = pi(0, ty(0), pi(1, v(0), v(1)))
  const signature = [
    { name: 'Nat', type: ty(0) },
    { name: 'Bool', type: ty(0) },
    { name: 'value', type: kconst('Nat') },
    { name: 'identity', type: idType },
  ]

  ok(
    'metavariable solved by unification (polymorphic identity at a concrete type)',
    () => {
      resetMetas()

      const context = contextWithSignature(signature)
      const meta = freshMeta(typeValue(0))
      const term = app(app(kconst('identity'), meta), kconst('value'))
      void check(context, term, evaluate([], kconst('Nat'))) // checks only if the meta unified to Nat
    },
  )
  rejects(
    'metavariable solving rejects an inconsistent result type',
    () => {
      resetMetas()

      const context = contextWithSignature(signature)
      const meta = freshMeta(typeValue(0))
      const term = app(app(kconst('identity'), meta), kconst('value'))
      void check(context, term, evaluate([], kconst('Bool'))) // meta solves to Nat, so Bool must be rejected
    },
  )
  rejects('occurs check blocks a cyclic solution', () => {
    resetMetas()

    const context = contextWithSignature(signature)
    const a = freshMeta(typeValue(0)) // ?a : Type0
    const x = freshMeta(evaluate([], a)) // ?x : ?a
    // checking ?x against (?a -> Nat) tries to solve ?a := (?a -> Nat); the occurs check must refuse
    const cyclic: Term = pi(1, a, kconst('Nat'))
    void check(context, x, evaluate([], cyclic))
  })

  // ---- linear regions: mutation tied to the `1` multiplicity (a region is used exactly once, no aliasing) ----
  const regionSig = [{ name: 'Region', type: ty(0) }]
  ok('a linear region is consumed exactly once', () => {
    const context = contextWithSignature(regionSig)
    // \ r. r  :  (1 r : Region) -> Region  -- uses the region exactly once
    check(
      context,
      lam(v(0)),
      evaluate([], pi(1, kconst('Region'), kconst('Region'))),
    )
  })
  rejects('aliasing a linear region is rejected (used twice)', () => {
    const context = contextWithSignature(regionSig)
    // \ r. (r, r)  :  (1 r : Region) -> Region * Region  -- uses the region twice, violating linearity
    check(
      context,
      lam(pair(v(0), v(0))),
      evaluate(
        [],
        pi(
          1,
          kconst('Region'),
          sigma('many', kconst('Region'), kconst('Region')),
        ),
      ),
    )
  })
  rejects(
    'dropping a linear region is rejected (used zero times)',
    () => {
      const context = contextWithSignature([
        ...regionSig,
        { name: 'unit', type: ty(0) },
        { name: 'nothing', type: kconst('unit') },
      ])

      // \ r. nothing  :  (1 r : Region) -> unit  -- never uses the region, violating linearity
      check(
        context,
        lam(kconst('nothing')),
        evaluate([], pi(1, kconst('Region'), kconst('unit'))),
      )
    },
  )

  // ---- Miller pattern unification: a metavariable applied to distinct bound variables ----
  const millerSig = [
    { name: 'Nat', type: ty(0) },
    { name: 'value', type: kconst('Nat') },
  ]

  const NatToNat = pi('many', kconst('Nat'), kconst('Nat'))
  ok(
    'Miller pattern: ?m x = x solves ?m to the identity, then computes',
    () => {
      resetMetas()

      const context = bind(
        contextWithSignature(millerSig),
        'many',
        evaluate([], kconst('Nat')),
      ) // x : Nat at level 0

      const m = freshMeta(evaluate([], NatToNat))
      // checking refl against Id Nat (?m x) x forces (?m x) == x, solving ?m := \x. x
      const goal = id(kconst('Nat'), app(m, v(0)), v(0))
      check(
        context,
        refl(kconst('Nat'), v(0)),
        evaluate(context.env, goal),
      )

      // the solution must compute: (?m value) reduces to value
      const computed = id(
        kconst('Nat'),
        app(m, kconst('value')),
        kconst('value'),
      )

      check(
        context,
        refl(kconst('Nat'), kconst('value')),
        evaluate(context.env, computed),
      )
    },
  )
  rejects(
    'a non-pattern spine (argument is not a distinct variable) does not solve',
    () => {
      resetMetas()

      const context = contextWithSignature(millerSig)
      const m = freshMeta(evaluate([], NatToNat))
      // ?m value -- the argument is a constant, not a bound variable, so this is not a Miller pattern
      const goal = id(
        kconst('Nat'),
        app(m, kconst('value')),
        kconst('value'),
      )

      check(
        context,
        refl(kconst('Nat'), kconst('value')),
        evaluate([], goal),
      )
    },
  )

  // ---- transparent definitions (delta reduction) ----
  const deltaSig = [
    { name: 'Nat', type: ty(0) },
    {
      name: 'identityFn',
      type: pi('many', kconst('Nat'), kconst('Nat')),
    },
    { name: 'value', type: kconst('Nat') },
  ]

  ok(
    'a transparent definition unfolds during conversion (delta)',
    () => {
      resetMetas()
      resetDefinitions()

      const context = contextWithSignature(deltaSig)
      defineConstant('identityFn', evaluate([], lam(v(0)))) // identityFn := \ x. x

      // refl proves Id Nat (identityFn value) value only if identityFn delta-unfolds to the identity
      const goal = id(
        kconst('Nat'),
        app(kconst('identityFn'), kconst('value')),
        kconst('value'),
      )

      check(
        context,
        refl(kconst('Nat'), kconst('value')),
        evaluate([], goal),
      )
    },
  )
  rejects('an opaque constant does not unfold', () => {
    resetMetas()
    resetDefinitions()

    const context = contextWithSignature(deltaSig) // identityFn is left undefined: a postulate
    const goal = id(
      kconst('Nat'),
      app(kconst('identityFn'), kconst('value')),
      kconst('value'),
    )

    check(
      context,
      refl(kconst('Nat'), kconst('value')),
      evaluate([], goal),
    )
  })
  rejects(
    'fuel-bounded delta terminates on a recursive / self-referential definition',
    () => {
      resetMetas()
      resetDefinitions()

      const context = contextWithSignature([
        { name: 'Nat', type: ty(0) },
        { name: 'loopy', type: kconst('Nat') },
        { name: 'other', type: kconst('Nat') },
      ])

      defineConstant('loopy', evaluate([], kconst('loopy'))) // loopy := loopy (degenerate recursion)

      // converting loopy with other would unfold forever; fuel makes it terminate (and correctly fail) rather than hang
      const goal = id(kconst('Nat'), kconst('loopy'), kconst('other'))
      check(
        context,
        refl(kconst('Nat'), kconst('loopy')),
        evaluate([], goal),
      )
    },
  )

  // ---- dependent pairs (sigma) ----
  const data = [
    { name: 'Nat', type: ty(0) },
    { name: 'Bool', type: ty(0) },
    { name: 'value', type: kconst('Nat') },
  ]

  const NatPair = sigma('many', kconst('Nat'), kconst('Nat')) // (Nat) * Nat
  ok('a pair checks against its sigma type', () => {
    const context = contextWithSignature(data)
    check(
      context,
      pair(kconst('value'), kconst('value')),
      evaluate([], NatPair),
    )
  })
  ok('projections fst/snd type-check', () => {
    const context = contextWithSignature(data)
    const annotated = ann(
      pair(kconst('value'), kconst('value')),
      NatPair,
    )

    check(context, fst(annotated), evaluate([], kconst('Nat')))
    check(context, snd(annotated), evaluate([], kconst('Nat')))
  })
  rejects('a pair with a wrong component is rejected', () => {
    const context = contextWithSignature([
      ...data,
      { name: 'flag', type: kconst('Bool') },
    ])

    check(
      context,
      pair(kconst('value'), kconst('flag')),
      evaluate([], NatPair),
    ) // second must be Nat
  })

  // ---- observational equality beyond Pi: Id at a product is a product of Ids (pair extensionality computes) ----
  ok(
    'pair extensionality computes (Id at a product reduces to a product of Ids)',
    () => {
      const context = contextWithSignature(data)
      const point = pair(kconst('value'), kconst('value'))
      const identity = id(NatPair, point, point) // Id ((Nat)*Nat) p p  ==>  (Id Nat ..) * (Id Nat ..)
      const proof = pair(
        refl(kconst('Nat'), kconst('value')),
        refl(kconst('Nat'), kconst('value')),
      )

      check(context, proof, evaluate([], identity)) // a pair of refls inhabits it, because Id computed structurally
    },
  )

  // dependent-sigma observational equality: Id at a dependent pair computes through transport
  ok(
    'dependent pair extensionality computes (Id at a dependent sigma, via transport)',
    () => {
      const signature = [
        { name: 'Nat', type: ty(0) },
        { name: 'Vec', type: pi('many', kconst('Nat'), ty(0)) }, // a type family Vec : Nat -> Type0
        { name: 'n', type: kconst('Nat') },
        { name: 'vn', type: app(kconst('Vec'), kconst('n')) },
      ]

      const context = contextWithSignature(signature)
      const dependent = sigma(
        'many',
        kconst('Nat'),
        app(kconst('Vec'), v(0)),
      ) // Sigma (x : Nat) Vec x

      const point = pair(kconst('n'), kconst('vn'))
      const identity = id(dependent, point, point)
      // a pair of refls inhabits it: the second's type Id (Vec n) (transport refl vn) vn reduces to Id (Vec n) vn vn
      const proof = pair(
        refl(kconst('Nat'), kconst('n')),
        refl(app(kconst('Vec'), kconst('n')), kconst('vn')),
      )

      check(context, proof, evaluate([], identity))
    },
  )

  // ---- self types (the inductive foundation) ----
  ok(
    'self introduction: a value checks against a non-dependent self type',
    () => {
      const context = contextWithSignature(data)
      check(context, kconst('value'), evaluate([], self(kconst('Nat')))) // value : Self x. Nat  iff  value : Nat
    },
  )
  ok(
    'self elimination: a self-typed variable is usable at the unfolded type',
    () => {
      const context = bind(
        contextWithSignature(data),
        'many',
        evaluate([], self(kconst('Nat'))),
      )

      check(context, v(0), evaluate(context.env, kconst('Nat'))) // s : Self x. Nat  used at  Nat
    },
  )
  rejects('self introduction rejects a mismatched body', () => {
    const context = contextWithSignature(data)
    check(context, kconst('value'), evaluate([], self(kconst('Bool')))) // value : Nat is not Self x. Bool
  })

  // an inductive type with its dependent eliminator is expressible as a self type: this is the encoding the
  // surface enum compiles to. Bool = Self x. (P : Bool -> Type0) -> P true -> P false -> P x, where the recursive
  // reference `Bool` is the type itself (a transparent definition, so the self-variable is usable where Bool is).
  ok('an inductive (Bool) is derivable as a self-type encoding', () => {
    resetMetas()
    resetDefinitions()

    const context = contextWithSignature([
      { name: 'Bool', type: ty(0) },
      { name: 'true', type: kconst('Bool') },
      { name: 'false', type: kconst('Bool') },
    ])

    const boolEncoding = self(
      pi(
        'many',
        pi('many', kconst('Bool'), ty(0)), // P : Bool -> Type0
        pi(
          'many',
          app(v(0), kconst('true')), // P true
          pi(
            'many',
            app(v(1), kconst('false')), // P false
            app(v(2), v(3)),
          ),
        ),
      ), // P x
    )

    defineConstant('Bool', evaluate([], boolEncoding)) // Bool := the self-encoding (recursive reference)

    // the encoding is a well-formed type (its dependent eliminator is exactly application of a Bool)
    const inferred = infer(context, boolEncoding)

    if (inferred.type.v !== 'type')
      {throw new CoreTypeError('the Bool self-encoding is not a type')}
  })

  console.log(`\njudge: ${pass} pass, ${fail} fail`)
}

main()
