// Tests for the dependent type judgment: the universe hierarchy, quantities (linearity), and the identity type.
// Run: npx tsx test/check/judge.ts

import type { Term } from '@/code/check/judge'
import { check, checks, emptyContext, infer, TypeError as CoreTypeError } from '@/code/check/judge'
import type { Mult } from '@/code/check/judge'

// term builders
const v = (index: number): Term => ({ tag: 'var', index })
const ty = (level: number): Term => ({ tag: 'type', level })
const pi = (mult: Mult, domain: Term, codomain: Term): Term => ({ tag: 'pi', mult, domain, codomain })
const lam = (body: Term): Term => ({ tag: 'lam', body })
const app = (fun: Term, arg: Term): Term => ({ tag: 'app', fun, arg })
const id = (type: Term, left: Term, right: Term): Term => ({ tag: 'id', type, left, right })
const refl = (type: Term, value: Term): Term => ({ tag: 'refl', type, value })

let pass = 0
let fail = 0

function ok(name: string, run: () => void): void {
  try {
    run()
    pass++
    console.log(`ok    ${name}`)
  } catch (error) {
    fail++
    console.log(`FAIL  ${name}\n      ${error instanceof Error ? error.message.replace(/\n/g, '\n      ') : String(error)}`)
  }
}

function rejects(name: string, run: () => void): void {
  try {
    run()
    fail++
    console.log(`FAIL  ${name}  (expected a type error, but it checked)`)
  } catch (error) {
    if (error instanceof CoreTypeError) {
      pass++
      console.log(`ok    ${name}  (${error.message.split('\n')[0]})`)
    } else {
      fail++
      console.log(`FAIL  ${name}  (threw the wrong error: ${String(error)})`)
    }
  }
}

function main(): void {
  // ---- universe hierarchy ----
  ok('Type 0 : Type 1', () => {
    const inferred = infer(emptyContext, ty(0))
    if (!(inferred.type.v === 'type' && inferred.type.level === 1)) throw new CoreTypeError('expected Type 1')
  })
  ok('Type 0 checks against Type 1', () => void check(emptyContext, ty(0), { v: 'type', level: 1 }))
  ok('cumulativity: Type 0 checks against Type 2', () => void check(emptyContext, ty(0), { v: 'type', level: 2 }))
  rejects('Type 1 does not check against Type 0', () => void check(emptyContext, ty(1), { v: 'type', level: 0 }))

  // ---- functions and the universe-polymorphic identity ----
  // id : (0 Type 0) -> (1 #0) -> #1   ;  \ \ #0
  const idType = pi(0, ty(0), pi(1, v(0), v(1)))
  const idTerm = lam(lam(v(0)))
  ok('polymorphic identity checks', () => void checks(idTerm, idType))

  // applying it: a level-1 identity applied to Type0 (which lives in Type1)
  ok('identity applied to a type', () => {
    const idType1 = pi(0, ty(1), pi(1, v(0), v(1)))
    const applied: Term = app({ tag: 'ann', term: idTerm, type: idType1 }, ty(0))
    infer(emptyContext, applied)
  })

  // ---- quantities / linearity ----
  // a linear argument used once: ok
  ok('linear used once', () => void checks(lam(v(0)), pi(1, ty(0), ty(0))))
  // a linear argument used zero times: rejected
  rejects('linear used zero times', () => void checks(lam(ty(0)), pi(1, ty(0), ty(1))))
  // an erased argument used at runtime: rejected
  rejects('erased argument used', () => void checks(lam(v(0)), pi(0, ty(0), ty(0))))
  // an unrestricted argument used zero times: ok
  ok('many used zero times', () => void checks(lam(ty(0)), pi('many', ty(0), ty(1))))

  // ---- identity type, refl, J ----
  // refl : Id Type0 Type0 Type0  (under cumulativity Type0 : Type1, so the carrier is Type1 here)
  ok('refl of a type', () => {
    // Id (Type 1) (Type 0) (Type 0)
    const t = id(ty(1), ty(0), ty(0))
    const r = refl(ty(1), ty(0))
    if (!checks(r, t)) throw new CoreTypeError('refl did not check')
  })
  rejects('refl with unequal sides', () => {
    // refl can only prove reflexive equations; Id Type1 Type0 Type1 has unequal sides
    const t = id(ty(2), ty(0), ty(1))
    void check(emptyContext, refl(ty(2), ty(0)), { v: 'id', type: { v: 'type', level: 2 }, left: { v: 'type', level: 0 }, right: { v: 'type', level: 1 } })
    void t
  })

  // J reduces on refl: transport along refl returns the base unchanged.
  // motive : (x: Type1) -> Id Type1 Type0 x -> Type1  =  \x \e (Id Type1 Type0 x)
  // base : motive Type0 refl = Id Type1 Type0 Type0, inhabited by refl
  ok('J on refl type-checks', () => {
    const motive = lam(lam(id(ty(1), ty(0), v(1))))
    const base = refl(ty(1), ty(0))
    const proof = refl(ty(1), ty(0))
    // the motive returns Id Type1 _ _, whose carrier Type1 lives in Type2, so the motive's universe is 2
    const jTerm: Term = { tag: 'j', proof, motive, base, level: 2 }
    // result type : motive Type0 proof = Id Type1 Type0 Type0
    void check(emptyContext, jTerm, { v: 'id', type: { v: 'type', level: 1 }, left: { v: 'type', level: 0 }, right: { v: 'type', level: 0 } })
  })

  // ---- observational: funext is expressible and usable (postulated; full OTT computation is a later refinement) ----
  ok('funext type is well-formed and applicable', () => {
    // funext : (0 A: Type0) (0 B: (1 A) -> Type0) (0 f: (1 A) -> B) (0 g: (1 A) -> B)
    //          (1 _: (1 x: A) -> Id (B x) (f x) (g x)) -> Id ((1 A) -> B) f g
    // build its type and confirm it type-checks as a Type (so it can be postulated in a context)
    const funextType: Term = pi(0, ty(0),
      pi(0, pi(1, v(0), ty(0)),
        pi(0, pi(1, v(1), app(v(1), v(0))),
          pi(0, pi(1, v(2), app(v(2), v(0))),
            pi(1, pi(1, v(3), id(app(v(3), v(0)), app(v(2), v(0)), app(v(1), v(0)))),
              id(pi(1, v(4), app(v(4), v(0))), v(2), v(1)))))))
    const result = infer(emptyContext, funextType)
    if (result.type.v !== 'type') throw new CoreTypeError('funext type is not a type')
  })

  console.log(`\njudge: ${pass} pass, ${fail} fail`)
}

main()
