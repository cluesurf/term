// The dependent type core: a bidirectional type checker by normalization-by-evaluation, implementing the decided
// kernel (see note/research/vibe/computation/plans/12-type-systems.md):
//   1. a predicative, cumulative, universe-POLYMORPHIC hierarchy (levels are expressions over level variables;
//      Type i : Type (i+1); no Type : Type) -- the sound logic
//   2. quantities (multiplicities 0 / 1 / many) with linear usage checking
//   3. an identity type with refl and J, AND observational function extensionality that COMPUTES: Id at a
//      function type reduces to the pointwise identity, so funext is derivable (the identity function), not
//      postulated
// Self-type inductive encodings live in the companion kernel.ts. Browser-safe, no host APIs.

// ---- universe levels (an algebra over level variables) ----
// A level is max(constant, max over (variable + offset)). This is the standard Agda/Lean level algebra and makes
// comparison decidable, which is what universe polymorphism needs.
export type Level = { constant: number; vars: Map<string, number> }

export const litLevel = (n: number): Level => ({ constant: n, vars: new Map() })
export const varLevel = (name: string): Level => ({ constant: 0, vars: new Map([[name, 0]]) })
export function succLevel(level: Level): Level {
  const vars = new Map<string, number>()
  for (const [v, o] of level.vars) vars.set(v, o + 1)
  return { constant: level.constant + 1, vars }
}
function shiftLevel(level: Level, by: number): Level {
  const vars = new Map<string, number>()
  for (const [v, o] of level.vars) vars.set(v, o + by)
  return { constant: level.constant + by, vars }
}
export function maxLevel(a: Level, b: Level): Level {
  const vars = new Map(a.vars)
  for (const [v, o] of b.vars) vars.set(v, Math.max(vars.get(v) ?? -Infinity, o))
  return { constant: Math.max(a.constant, b.constant), vars }
}
// a <= b for ALL instantiations of the level variables
function leqLevel(a: Level, b: Level): boolean {
  if (a.constant > b.constant) return false
  for (const [v, o] of a.vars) {
    const ob = b.vars.get(v)
    if (ob === undefined || ob < o) return false
  }
  return true
}
export const eqLevel = (a: Level, b: Level): boolean => leqLevel(a, b) && leqLevel(b, a)
function showLevel(level: Level): string {
  const atoms = [...level.vars].map(([v, o]) => (o === 0 ? v : `${v}+${o}`))
  if (atoms.length === 0) return String(level.constant)
  if (level.constant > 0) atoms.unshift(String(level.constant))
  return atoms.length === 1 ? atoms[0]! : `max(${atoms.join(', ')})`
}
// substitute a level variable with a level (for instantiating a polymorphic definition)
function substLevel(level: Level, name: string, replacement: Level): Level {
  let result: Level = { constant: level.constant, vars: new Map() }
  for (const [v, o] of level.vars) {
    if (v === name) result = maxLevel(result, shiftLevel(replacement, o))
    else result = maxLevel(result, { constant: 0, vars: new Map([[v, o]]) })
  }
  return result
}

// ---- multiplicities (the {0, 1, ω} semiring) ----
export type Mult = 0 | 1 | 'many'
function addMult(a: Mult, b: Mult): Mult {
  if (a === 0) return b
  if (b === 0) return a
  return 'many'
}
function mulMult(a: Mult, b: Mult): Mult {
  if (a === 0 || b === 0) return 0
  if (a === 1) return b
  if (b === 1) return a
  return 'many'
}
function fitsMult(use: Mult, need: Mult): boolean {
  if (need === 'many') return true
  return use === need
}

// ---- terms (de Bruijn indices) ----
export type Term =
  | { tag: 'var'; index: number }
  | { tag: 'type'; level: Level }
  | { tag: 'pi'; mult: Mult; domain: Term; codomain: Term }
  | { tag: 'lam'; body: Term }
  | { tag: 'app'; fun: Term; arg: Term }
  | { tag: 'ann'; term: Term; type: Term }
  | { tag: 'id'; type: Term; left: Term; right: Term }
  | { tag: 'refl'; type: Term; value: Term }
  | { tag: 'j'; proof: Term; motive: Term; base: Term; level: Level }

// ---- values (normal forms) ----
type Closure = { env: Array<Value>; body: Term } | { native: (arg: Value) => Value }
type Elim = { e: 'app'; arg: Value } | { e: 'j'; motive: Value; base: Value }
export type Value =
  | { v: 'type'; level: Level }
  | { v: 'pi'; mult: Mult; domain: Value; codomain: Closure }
  | { v: 'lam'; body: Closure }
  | { v: 'neutral'; head: number; spine: Array<Elim> }
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
      return idValue(evaluate(env, term.type), evaluate(env, term.left), evaluate(env, term.right))
    case 'refl':
      return { v: 'refl', type: evaluate(env, term.type), value: evaluate(env, term.value) }
    case 'j':
      return applyJ(evaluate(env, term.proof), evaluate(env, term.motive), evaluate(env, term.base))
  }
}

// the observational identity: Id ((a:S) -> T a) f g  ==  (a:S) -> Id (T a) (f a) (g a). This is what makes
// function extensionality compute: a proof of pointwise equality IS a proof of equality of functions.
function idValue(type: Value, left: Value, right: Value): Value {
  if (type.v === 'pi') {
    return {
      v: 'pi',
      mult: type.mult,
      domain: type.domain,
      codomain: { native: (a: Value) => idValue(closeOver(type.codomain, a), applyValue(left, a), applyValue(right, a)) },
    }
  }
  return { v: 'id', type, left, right }
}

function closeOver(closure: Closure, value: Value): Value {
  return 'native' in closure ? closure.native(value) : evaluate([value, ...closure.env], closure.body)
}

function applyValue(fun: Value, arg: Value): Value {
  if (fun.v === 'lam') return closeOver(fun.body, arg)
  if (fun.v === 'neutral') return { v: 'neutral', head: fun.head, spine: [...fun.spine, { e: 'app', arg }] }
  throw new Error('applied a non-function')
}

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
        else term = { tag: 'j', proof: term, motive: quote(level, elim.motive), base: quote(level, elim.base), level: litLevel(0) }
      }
      return term
    }
  }
}

function convert(level: number, a: Value, b: Value): boolean {
  if (a.v === 'type' && b.v === 'type') return eqLevel(a.level, b.level)
  if (a.v === 'pi' && b.v === 'pi') {
    return a.mult === b.mult && convert(level, a.domain, b.domain) &&
      convert(level + 1, closeOver(a.codomain, neutralVar(level)), closeOver(b.codomain, neutralVar(level)))
  }
  if (a.v === 'lam' || b.v === 'lam') {
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

// subtyping with universe cumulativity
function subtype(level: number, a: Value, b: Value): boolean {
  if (a.v === 'type' && b.v === 'type') return leqLevel(a.level, b.level)
  if (a.v === 'pi' && b.v === 'pi') {
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

type Usage = Array<Mult>
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
      return { type: { v: 'type', level: succLevel(term.level) }, usage: zeroUsage(context.level) }
    case 'pi': {
      const domainLevel = inferUniverse(context, term.domain)
      const inner = bind(context, 'many', evaluate(context.env, term.domain))
      const codomainLevel = inferUniverse(inner, term.codomain)
      return { type: { v: 'type', level: maxLevel(domainLevel, codomainLevel) }, usage: zeroUsage(context.level) }
    }
    case 'app': {
      const fun = infer(context, term.fun)
      if (fun.type.v !== 'pi') throw new TypeError('applied a non-function')
      const argUsage = check(context, term.arg, fun.type.domain)
      const result = closeOver(fun.type.codomain, evaluate(context.env, term.arg))
      return { type: result, usage: addUsage(fun.usage, scaleUsage(fun.type.mult, argUsage)) }
    }
    case 'ann': {
      inferUniverse(context, term.type)
      const type = evaluate(context.env, term.type)
      return { type, usage: check(context, term.term, type) }
    }
    case 'id': {
      const level = inferUniverse(context, term.type)
      const type = evaluate(context.env, term.type)
      check(context, term.left, type)
      check(context, term.right, type)
      return { type: { v: 'type', level }, usage: zeroUsage(context.level) }
    }
    case 'refl': {
      inferUniverse(context, term.type)
      const type = evaluate(context.env, term.type)
      check(context, term.value, type)
      const value = evaluate(context.env, term.value)
      return { type: idValue(type, value, value), usage: zeroUsage(context.level) }
    }
    case 'j': {
      const proof = infer(context, term.proof)
      if (proof.type.v !== 'id') throw new TypeError('J needs an identity proof')
      const { type: aType, left: a, right: b } = proof.type
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

function motivePiType(context: Context, aType: Value, a: Value, level: Level): Value {
  return {
    v: 'pi',
    mult: 'many',
    domain: aType,
    codomain: {
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
    if (!fitsMult(bodyUsage[0]!, expected.mult)) {
      throw new TypeError(`linearity: a ${showMult(expected.mult)} argument was used ${showMult(bodyUsage[0]!)} times`)
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

function inferUniverse(context: Context, term: Term): Level {
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
      return `Type ${showLevel(term.level)}`
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

// instantiate a level-polymorphic term: replace a level variable with a concrete level throughout
export function instantiateLevel(term: Term, name: string, replacement: Level): Term {
  const go = (t: Term): Term => {
    switch (t.tag) {
      case 'type':
        return { tag: 'type', level: substLevel(t.level, name, replacement) }
      case 'pi':
        return { tag: 'pi', mult: t.mult, domain: go(t.domain), codomain: go(t.codomain) }
      case 'lam':
        return { tag: 'lam', body: go(t.body) }
      case 'app':
        return { tag: 'app', fun: go(t.fun), arg: go(t.arg) }
      case 'ann':
        return { tag: 'ann', term: go(t.term), type: go(t.type) }
      case 'id':
        return { tag: 'id', type: go(t.type), left: go(t.left), right: go(t.right) }
      case 'refl':
        return { tag: 'refl', type: go(t.type), value: go(t.value) }
      case 'j':
        return { tag: 'j', proof: go(t.proof), motive: go(t.motive), base: go(t.base), level: substLevel(t.level, name, replacement) }
      case 'var':
        return t
    }
  }
  return go(term)
}

// public helper: check a closed term against a closed type
export function checks(term: Term, type: Term): boolean {
  inferUniverse(emptyContext, type)
  check(emptyContext, term, evaluate([], type))
  return true
}
