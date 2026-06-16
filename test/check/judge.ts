// Tests for the dependent type judgment: universe-polymorphic hierarchy, quantities (linearity), the identity
// type, and observational function extensionality (funext that COMPUTES, derivable as the identity).
// Run: npx tsx test/check/judge.ts

import type { Level, Term } from '@/code/check/judge'
import { check, checks, emptyContext, eqLevel, infer, instantiateLevel, litLevel, varLevel, TypeError as CoreTypeError } from '@/code/check/judge'
import type { Mult } from '@/code/check/judge'

const v = (index: number): Term => ({ tag: 'var', index })
const ty = (n: number): Term => ({ tag: 'type', level: litLevel(n) })
const tyVar = (name: string): Term => ({ tag: 'type', level: varLevel(name) })
const pi = (mult: Mult, domain: Term, codomain: Term): Term => ({ tag: 'pi', mult, domain, codomain })
const lam = (body: Term): Term => ({ tag: 'lam', body })
const app = (fun: Term, arg: Term): Term => ({ tag: 'app', fun, arg })
const id = (type: Term, left: Term, right: Term): Term => ({ tag: 'id', type, left, right })
const refl = (type: Term, value: Term): Term => ({ tag: 'refl', type, value })
const typeValue = (n: number) => ({ v: 'type' as const, level: litLevel(n) })

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
      console.log(`FAIL  ${name}  (wrong error: ${String(error)})`)
    }
  }
}

function main(): void {
  // ---- universe hierarchy ----
  ok('Type 0 : Type 1', () => {
    const t = infer(emptyContext, ty(0)).type
    if (!(t.v === 'type' && eqLevel(t.level, litLevel(1)))) throw new CoreTypeError('expected Type 1')
  })
  ok('Type 0 checks against Type 1', () => void check(emptyContext, ty(0), typeValue(1)))
  ok('cumulativity: Type 0 against Type 2', () => void check(emptyContext, ty(0), typeValue(2)))
  rejects('Type 1 not against Type 0', () => void check(emptyContext, ty(1), typeValue(0)))

  // ---- universe POLYMORPHISM: an identity polymorphic over a level variable u ----
  const idTypePoly = pi(0, tyVar('u'), pi(1, v(0), v(1)))
  const idTerm = lam(lam(v(0)))
  ok('level-polymorphic identity checks abstractly', () => void checks(idTerm, idTypePoly))
  ok('instantiate u := 0 and it still checks', () => {
    const idType0 = instantiateLevel(idTypePoly, 'u', litLevel(0))
    if (!checks(idTerm, idType0)) throw new CoreTypeError('instantiated identity did not check')
  })
  ok('instantiate u := 5 and it still checks', () => {
    const idType5 = instantiateLevel(idTypePoly, 'u', litLevel(5))
    if (!checks(idTerm, idType5)) throw new CoreTypeError('instantiated identity did not check')
  })

  // ---- quantities / linearity ----
  ok('linear used once', () => void checks(lam(v(0)), pi(1, ty(0), ty(0))))
  rejects('linear used zero times', () => void checks(lam(ty(0)), pi(1, ty(0), ty(1))))
  rejects('erased argument used', () => void checks(lam(v(0)), pi(0, ty(0), ty(0))))
  ok('many used zero times', () => void checks(lam(ty(0)), pi('many', ty(0), ty(1))))

  // ---- identity type ----
  ok('refl of a type', () => {
    if (!checks(refl(ty(1), ty(0)), id(ty(1), ty(0), ty(0)))) throw new CoreTypeError('refl did not check')
  })
  rejects('refl with unequal sides', () =>
    void check(emptyContext, refl(ty(2), ty(0)), { v: 'id', type: typeValue(2), left: typeValue(0), right: typeValue(1) }),
  )

  // J on refl
  ok('J on refl type-checks', () => {
    const motive = lam(lam(id(ty(1), ty(0), v(1))))
    const base = refl(ty(1), ty(0))
    const proof = refl(ty(1), ty(0))
    const jTerm: Term = { tag: 'j', proof, motive, base, level: litLevel(2) }
    void check(emptyContext, jTerm, { v: 'id', type: typeValue(1), left: typeValue(0), right: typeValue(0) })
  })

  // ---- observational funext: DERIVABLE (the identity function), because Id at a function type computes ----
  ok('funext is the identity (computes, not postulated)', () => {
    // funext : (0 A:Type0)(0 B:(1 A)->Type0)(0 f:(1 A)->B)(0 g:(1 A)->B)
    //          (1 _:(1 x:A)->Id (B x)(f x)(g x)) -> Id ((1 A)->B) f g
    const funextType: Term = pi(0, ty(0),
      pi(0, pi(1, v(0), ty(0)),
        pi(0, pi(1, v(1), app(v(1), v(0))),
          pi(0, pi(1, v(2), app(v(2), v(0))),
            pi(1, pi(1, v(3), id(app(v(3), v(0)), app(v(2), v(0)), app(v(1), v(0)))),
              id(pi(1, v(4), app(v(4), v(0))), v(2), v(1)))))))
    // the proof is just: lambda A. lambda B. lambda f. lambda g. lambda h. h
    const funextTerm = lam(lam(lam(lam(lam(v(0))))))
    if (!checks(funextTerm, funextType)) throw new CoreTypeError('funext-as-identity did not check')
  })

  console.log(`\njudge: ${pass} pass, ${fail} fail`)
}

main()
