// The dependent type core: a bidirectional type checker by normalization-by-evaluation, implementing the decided
// kernel (see note/research/vibe/computation/plans/12-type-systems.md):
//   1. a predicative, cumulative universe hierarchy (Type 0 : Type 1 : ..., no Type : Type)
//   2. quantities (multiplicities 0 / 1 / many) with linear usage checking
//   3. an identity type with refl and J (transport), plus funext as a postulate
// Self-type inductive encodings live in the companion kernel.ts. Browser-safe, no host APIs.

// ---- multiplicities (the {0, 1, ω} semiring) ----
export type Mult = 0 | 1 | 'many'

function addMult(a: Mult, b: Mult): Mult {
  if (a === 0) return b
  if (b === 0) return a
  return 'many' // 1+1, 1+many, many+many all saturate to many
}
function mulMult(a: Mult, b: Mult): Mult {
  if (a === 0 || b === 0) return 0
  if (a === 1) return b
  if (b === 1) return a
  return 'many'
}
// does observed usage `use` satisfy a binder declared at multiplicity `need`?
function fitsMult(use: Mult, need: Mult): boolean {
  if (need === 'many') return true // ω allows any usage
  return use === need // 0 must be unused, 1 must be used exactly once
}

// ---- terms (de Bruijn indices) ----
export type Term =
  | { tag: 'var'; index: number }
  | { tag: 'type'; level: number }
  | { tag: 'pi'; mult: Mult; domain: Term; codomain: Term } // codomain binds one var
  | { tag: 'lam'; body: Term } // checked against a pi; body binds one var
  | { tag: 'app'; fun: Term; arg: Term }
  | { tag: 'ann'; term: Term; type: Term }
  | { tag: 'id'; type: Term; left: Term; right: Term }
  | { tag: 'refl'; type: Term; value: Term }
  | { tag: 'j'; proof: Term; motive: Term; base: Term; level: number } // eliminate an Id; level is the motive's universe

// ---- values (normal forms) ----
type Closure = { env: Array<Value>; body: Term }
type Elim = { e: 'app'; arg: Value } | { e: 'j'; motive: Value; base: Value }
export type Value =
  | { v: 'type'; level: number }
  | { v: 'pi'; mult: Mult; domain: Value; codomain: Closure }
  | { v: 'lam'; body: Closure }
  | { v: 'neutral'; head: number; spine: Array<Elim> } // head is a de Bruijn level
  | { v: 'id'; type: Value; left: Value; right: Value }
  | { v: 'refl'; type: Value; value: Value }

const neutralVar = (level: number): Value => ({ v: 'neutral', head: level, spine: [] })

function evaluate(env: Array<Value>, term: Term): Value {
  switch (term.tag) {
    case 'var':
      return env[term.index]!
    case 'type':
      return { v: 'type', level: term.level }
    case 'pi':
      return { v: 'pi', mult: term.mult, domain: evaluate(env, term.domain), codomain: { env, body: term.codomain } }
    case 'lam':
      return { v: 'lam', body: { env, body: term.body } }
    case 'app':
      return applyValue(evaluate(env, term.fun), evaluate(env, term.arg))
    case 'ann':
      return evaluate(env, term.term)
    case 'id':
      return { v: 'id', type: evaluate(env, term.type), left: evaluate(env, term.left), right: evaluate(env, term.right) }
    case 'refl':
      return { v: 'refl', type: evaluate(env, term.type), value: evaluate(env, term.value) }
    case 'j':
      return applyJ(evaluate(env, term.proof), evaluate(env, term.motive), evaluate(env, term.base))
  }
}

function closeOver(closure: Closure, value: Value): Value {
  return evaluate([value, ...closure.env], closure.body)
}

function applyValue(fun: Value, arg: Value): Value {
  if (fun.v === 'lam') return closeOver(fun.body, arg)
  if (fun.v === 'neutral') return { v: 'neutral', head: fun.head, spine: [...fun.spine, { e: 'app', arg }] }
  throw new Error('applied a non-function')
}

// J: eliminating refl yields the base case; otherwise it is stuck (neutral)
function applyJ(proof: Value, motive: Value, base: Value): Value {
  if (proof.v === 'refl') return base
  if (proof.v === 'neutral') return { v: 'neutral', head: proof.head, spine: [...proof.spine, { e: 'j', motive, base }] }
  throw new Error('J on a non-identity')
}

function quote(level: number, value: Value): Term {
  switch (value.v) {
    case 'type':
      return { tag: 'type', level: value.level }
    case 'pi':
      return { tag: 'pi', mult: value.mult, domain: quote(level, value.domain), codomain: quote(level + 1, closeOver(value.codomain, neutralVar(level))) }
    case 'lam':
      return { tag: 'lam', body: quote(level + 1, closeOver(value.body, neutralVar(level))) }
    case 'id':
      return { tag: 'id', type: quote(level, value.type), left: quote(level, value.left), right: quote(level, value.right) }
    case 'refl':
      return { tag: 'refl', type: quote(level, value.type), value: quote(level, value.value) }
    case 'neutral': {
      let term: Term = { tag: 'var', index: level - value.head - 1 }
      for (const elim of value.spine) {
        if (elim.e === 'app') term = { tag: 'app', fun: term, arg: quote(level, elim.arg) }
        else term = { tag: 'j', proof: term, motive: quote(level, elim.motive), base: quote(level, elim.base) }
      }
      return term
    }
  }
}

// definitional equality
function convert(level: number, a: Value, b: Value): boolean {
  if (a.v === 'type' && b.v === 'type') return a.level === b.level
  if (a.v === 'pi' && b.v === 'pi') {
    return a.mult === b.mult && convert(level, a.domain, b.domain) &&
      convert(level + 1, closeOver(a.codomain, neutralVar(level)), closeOver(b.codomain, neutralVar(level)))
  }
  if (a.v === 'lam' || b.v === 'lam') {
    // eta
    return convert(level + 1, applyValue(a, neutralVar(level)), applyValue(b, neutralVar(level)))
  }
  if (a.v === 'id' && b.v === 'id') return convert(level, a.type, b.type) && convert(level, a.left, b.left) && convert(level, a.right, b.right)
  if (a.v === 'refl' && b.v === 'refl') return convert(level, a.value, b.value)
  if (a.v === 'neutral' && b.v === 'neutral') {
    if (a.head !== b.head || a.spine.length !== b.spine.length) return false
    for (let i = 0; i < a.spine.length; i++) {
      const x = a.spine[i]!
      const y = b.spine[i]!
      if (x.e === 'app' && y.e === 'app') {
        if (!convert(level, x.arg, y.arg)) return false
      } else if (x.e === 'j' && y.e === 'j') {
        if (!convert(level, x.motive, y.motive) || !convert(level, x.base, y.base)) return false
      } else return false
    }
    return true
  }
  return false
}

// subtyping with universe cumulativity: a is usable where b is expected
function subtype(level: number, a: Value, b: Value): boolean {
  if (a.v === 'type' && b.v === 'type') return a.level <= b.level
  if (a.v === 'pi' && b.v === 'pi') {
    // contravariant domain, covariant codomain, multiplicities must match
    return a.mult === b.mult && convert(level, a.domain, b.domain) &&
      subtype(level + 1, closeOver(a.codomain, neutralVar(level)), closeOver(b.codomain, neutralVar(level)))
  }
  return convert(level, a, b)
}

// ---- context and usage ----
type Context = { level: number; env: Array<Value>; types: Array<Value>; mults: Array<Mult> }
export const emptyContext: Context = { level: 0, env: [], types: [], mults: [] }

function bind(context: Context, mult: Mult, type: Value): Context {
  return {
    level: context.level + 1,
    env: [neutralVar(context.level), ...context.env],
    types: [type, ...context.types],
    mults: [mult, ...context.mults],
  }
}

type Usage = Array<Mult> // indexed by de Bruijn index (0 = innermost)
const zeroUsage = (n: number): Usage => new Array<Mult>(n).fill(0)
const addUsage = (a: Usage, b: Usage): Usage => a.map((m, i) => addMult(m, b[i]!))
const scaleUsage = (k: Mult, a: Usage): Usage => a.map((m) => mulMult(k, m))
function singletonUsage(n: number, index: number): Usage {
  const u = zeroUsage(n)
  u[index] = 1
  return u
}

export class TypeError extends Error {}

type Inferred = { type: Value; usage: Usage }

export function infer(context: Context, term: Term): Inferred {
  switch (term.tag) {
    case 'var': {
      const type = context.types[term.index]
      if (!type) throw new TypeError(`unbound variable ${term.index}`)
      return { type, usage: singletonUsage(context.level, term.index) }
    }
    case 'type':
      return { type: { v: 'type', level: term.level + 1 }, usage: zeroUsage(context.level) }
    case 'pi': {
      const domainLevel = inferUniverse(context, term.domain)
      const inner = bind(context, 'many', evaluate(context.env, term.domain))
      const codomainLevel = inferUniverse(inner, term.codomain)
      // types live in the erased fragment, so a pi consumes nothing
      return { type: { v: 'type', level: Math.max(domainLevel, codomainLevel) }, usage: zeroUsage(context.level) }
    }
    case 'app': {
      const fun = infer(context, term.fun)
      const funType = fun.type
      if (funType.v !== 'pi') throw new TypeError('applied a non-function')
      const argUsage = check(context, term.arg, funType.domain)
      const result = closeOver(funType.codomain, evaluate(context.env, term.arg))
      // the argument is consumed `mult` times
      return { type: result, usage: addUsage(fun.usage, scaleUsage(funType.mult, argUsage)) }
    }
    case 'ann': {
      inferUniverse(context, term.type)
      const type = evaluate(context.env, term.type)
      const usage = check(context, term.term, type)
      return { type, usage }
    }
    case 'id': {
      inferUniverse(context, term.type)
      const type = evaluate(context.env, term.type)
      check(context, term.left, type)
      check(context, term.right, type)
      const level = inferUniverse(context, term.type)
      return { type: { v: 'type', level }, usage: zeroUsage(context.level) }
    }
    case 'refl': {
      inferUniverse(context, term.type)
      const type = evaluate(context.env, term.type)
      check(context, term.value, type)
      const value = evaluate(context.env, term.value)
      return { type: { v: 'id', type, left: value, right: value }, usage: zeroUsage(context.level) }
    }
    case 'j': {
      // proof : Id A a b ; motive : (x: A) -> Id A a x -> Type k ; base : motive a refl ; result : motive b proof
      const proof = infer(context, term.proof)
      if (proof.type.v !== 'id') throw new TypeError('J needs an identity proof')
      const { type: aType, left: a, right: b } = proof.type
      // check the motive against (x: A) -> Id A a x -> Type level  (a bare lambda must be checked, not inferred)
      check(context, term.motive, motivePiType(context, aType, a, term.level))
      const motive = evaluate(context.env, term.motive)
      const reflA: Value = { v: 'refl', type: aType, value: a }
      const baseType = applyValue(applyValue(motive, a), reflA)
      check(context, term.base, baseType)
      const proofValue = evaluate(context.env, term.proof)
      const resultType = applyValue(applyValue(motive, b), proofValue)
      return { type: resultType, usage: zeroUsage(context.level) }
    }
    case 'lam':
      throw new TypeError('cannot infer a bare function; annotate it or check it against a pi type')
  }
}

// the J motive's type: (x: A) -> Id A a x -> Type level
function motivePiType(context: Context, aType: Value, a: Value, level: number): Value {
  return {
    v: 'pi',
    mult: 'many',
    domain: aType,
    codomain: {
      // captured env: index1 = a, index2 = aType (index0 will be the pi var x after closeOver)
      env: [a, aType, ...context.env],
      body: {
        tag: 'pi',
        mult: 'many',
        domain: { tag: 'id', type: { tag: 'var', index: 2 }, left: { tag: 'var', index: 1 }, right: { tag: 'var', index: 0 } },
        codomain: { tag: 'type', level },
      },
    },
  }
}

export function check(context: Context, term: Term, expected: Value): Usage {
  if (term.tag === 'lam') {
    if (expected.v !== 'pi') throw new TypeError('a function must be checked against a pi type')
    const inner = bind(context, expected.mult, expected.domain)
    const bodyType = closeOver(expected.codomain, neutralVar(context.level))
    const bodyUsage = check(inner, term.body, bodyType)
    const boundUse = bodyUsage[0]!
    if (!fitsMult(boundUse, expected.mult)) {
      throw new TypeError(`linearity: a ${showMult(expected.mult)} argument was used ${showMult(boundUse)} times`)
    }
    return bodyUsage.slice(1)
  }
  if (term.tag === 'refl') {
    if (expected.v !== 'id') throw new TypeError('refl must be checked against an identity type')
    if (!convert(context.level, expected.left, expected.right)) {
      throw new TypeError('refl: the two sides of the identity are not definitionally equal')
    }
    check(context, term.value, expected.type)
    return zeroUsage(context.level)
  }
  const actual = infer(context, term)
  if (!subtype(context.level, actual.type, expected)) {
    throw new TypeError(`type mismatch:\n  expected ${showValue(context.level, expected)}\n  found    ${showValue(context.level, actual.type)}`)
  }
  return actual.usage
}

// infer a term that must be a type, returning its universe level
function inferUniverse(context: Context, term: Term): number {
  const inferred = infer(context, term)
  if (inferred.type.v !== 'type') throw new TypeError('expected a type')
  return inferred.type.level
}

function showMult(m: Mult): string {
  return m === 'many' ? 'many' : String(m)
}
function showValue(level: number, value: Value): string {
  return showTerm(quote(level, value))
}
export function showTerm(term: Term): string {
  switch (term.tag) {
    case 'var':
      return `#${term.index}`
    case 'type':
      return `Type ${term.level}`
    case 'pi':
      return `(${showMult(term.mult)} ${showTerm(term.domain)}) -> ${showTerm(term.codomain)}`
    case 'lam':
      return `\\ ${showTerm(term.body)}`
    case 'app':
      return `(${showTerm(term.fun)} ${showTerm(term.arg)})`
    case 'ann':
      return `(${showTerm(term.term)} : ${showTerm(term.type)})`
    case 'id':
      return `Id ${showTerm(term.type)} ${showTerm(term.left)} ${showTerm(term.right)}`
    case 'refl':
      return `refl`
    case 'j':
      return `J(${showTerm(term.proof)})`
  }
}

// public helper: check a closed term against a closed type, return true if it type-checks
export function checks(term: Term, type: Term): boolean {
  inferUniverse(emptyContext, type)
  const typeValue = evaluate([], type)
  check(emptyContext, term, typeValue)
  return true
}
