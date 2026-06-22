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

export const litLevel = (n: number): Level => ({
  constant: n,
  vars: new Map(),
})
export const varLevel = (name: string): Level => ({
  constant: 0,
  vars: new Map([[name, 0]]),
})

export function succLevel(level: Level): Level {
  const vars = new Map<string, number>()

  for (const [v, o] of level.vars) {
    vars.set(v, o + 1)
  }

  return { constant: level.constant + 1, vars }
}

function shiftLevel(level: Level, by: number): Level {
  const vars = new Map<string, number>()

  for (const [v, o] of level.vars) {
    vars.set(v, o + by)
  }

  return { constant: level.constant + by, vars }
}

export function maxLevel(a: Level, b: Level): Level {
  const vars = new Map(a.vars)

  for (const [v, o] of b.vars) {
    vars.set(v, Math.max(vars.get(v) ?? -Infinity, o))
  }

  return { constant: Math.max(a.constant, b.constant), vars }
}

// the bottom universe is impredicative: a level is literally Type 0 (constant 0, no variables). A Pi whose codomain
// lands here stays here regardless of the domain's level, which is what lets a self-encoded inductive live in Type 0
// rather than floating one universe above its motive (the large-elimination fork, resolved this way per the plan's
// CoC-derived self-type encoding). Only the literal bottom is impredicative; Type 1 and above stay predicative, and
// Type 0 : Type 1 is unchanged, so this is the impredicative-Set discipline, not Type : Type.
const isBottomLevel = (level: Level): boolean =>
  level.constant === 0 && level.vars.size === 0

// the universe a Pi inhabits: impredicative at the bottom, predicative above.
export function piLevel(
  domainLevel: Level,
  codomainLevel: Level,
): Level {
  return isBottomLevel(codomainLevel)
    ? litLevel(0)
    : maxLevel(domainLevel, codomainLevel)
}

// a <= b for ALL instantiations of the level variables
function leqLevel(a: Level, b: Level): boolean {
  if (a.constant > b.constant) {
    return false
  }

  for (const [v, o] of a.vars) {
    const ob = b.vars.get(v)

    if (ob === undefined || ob < o) {
      return false
    }
  }

  return true
}

export const eqLevel = (a: Level, b: Level): boolean =>
  leqLevel(a, b) && leqLevel(b, a)

function showLevel(level: Level): string {
  const atoms = [...level.vars].map(([v, o]) =>
    o === 0 ? v : `${v}+${o}`,
  )

  if (atoms.length === 0) {
    return String(level.constant)
  }

  if (level.constant > 0) {
    atoms.unshift(String(level.constant))
  }

  return atoms.length === 1 ? atoms[0]! : `max(${atoms.join(', ')})`
}

// substitute a level variable with a level (for instantiating a polymorphic definition)
function substLevel(
  level: Level,
  name: string,
  replacement: Level,
): Level {
  let result: Level = { constant: level.constant, vars: new Map() }

  for (const [v, o] of level.vars) {
    if (v === name) {
      result = maxLevel(result, shiftLevel(replacement, o))
    } else {
      result = maxLevel(result, {
        constant: 0,
        vars: new Map([[v, o]]),
      })
    }
  }

  return result
}

// ---- multiplicities (the {0, 1, ω} semiring) ----
export type Mult = 0 | 1 | 'many'

function addMult(a: Mult, b: Mult): Mult {
  if (a === 0) {
    return b
  }

  if (b === 0) {
    return a
  }

  return 'many'
}

function mulMult(a: Mult, b: Mult): Mult {
  if (a === 0 || b === 0) {
    return 0
  }

  if (a === 1) {
    return b
  }

  if (b === 1) {
    return a
  }

  return 'many'
}

function fitsMult(use: Mult, need: Mult): boolean {
  if (need === 'many') {
    return true
  }

  return use === need
}

// ---- terms (de Bruijn indices) ----
export type Term =
  | { tag: 'var'; index: number }
  | { tag: 'meta'; id: number } // a metavariable (inference hole), solved by unification
  | { tag: 'const'; name: string } // a postulated global constant (base type or primitive in the signature)
  | { tag: 'type'; level: Level }
  | { tag: 'pi'; mult: Mult; domain: Term; codomain: Term }
  | { tag: 'lam'; body: Term }
  | { tag: 'app'; fun: Term; arg: Term }
  | { tag: 'ann'; term: Term; type: Term }
  | { tag: 'id'; type: Term; left: Term; right: Term }
  | { tag: 'refl'; type: Term; value: Term }
  | { tag: 'j'; proof: Term; motive: Term; base: Term; level: Level }
  // dependent pairs (sigma): Sigma (x : domain) codomain, with a pair constructor and two projections
  | { tag: 'sigma'; mult: Mult; domain: Term; codomain: Term }
  | { tag: 'pair'; first: Term; second: Term }
  | { tag: 'fst'; pair: Term }
  | { tag: 'snd'; pair: Term }
  // self types (the inductive foundation): Self (x) body, where x stands for the value of the type itself
  | { tag: 'self'; body: Term }

// ---- values (normal forms) ----
type Closure =
  | { env: Value[]; body: Term }
  | { native: (arg: Value) => Value }
type Elim =
  | { e: 'app'; arg: Value }
  | { e: 'j'; motive: Value; base: Value }
  | { e: 'fst' }
  | { e: 'snd' }
export type Value =
  | { v: 'type'; level: Level }
  | { v: 'pi'; mult: Mult; domain: Value; codomain: Closure }
  | { v: 'lam'; body: Closure }
  | { v: 'neutral'; head: number; spine: Elim[] }
  // a rigid constant from the signature, stuck like a neutral (it has no definition to unfold)
  | { v: 'rigid'; name: string; spine: Elim[] }
  // a flexible neutral headed by an unsolved metavariable; collapses to its solution once solved
  | { v: 'flex'; id: number; spine: Elim[] }
  | { v: 'id'; type: Value; left: Value; right: Value }
  | { v: 'refl'; type: Value; value: Value }
  | { v: 'sigma'; mult: Mult; domain: Value; codomain: Closure }
  | { v: 'pair'; first: Value; second: Value }
  | { v: 'self'; body: Closure }

export const neutralVar = (level: number): Value => ({
  v: 'neutral',
  head: level,
  spine: [],
})

// ---- the metacontext: metavariable types and solutions (module-level, ids globally fresh and monotonic) ----
const metaType = new Map<number, Value>()
const metaSolution = new Map<number, Value>()

let nextMeta = 0

// ---- transparent definitions (delta reduction): a constant with a definition may unfold during conversion ----
// Only sound for terminating definitions, so the elaborator registers non-recursive ones; recursive / effectful
// functions stay opaque postulates.
const definition = new Map<string, Value>()

// fuel bounds how deeply transparent definitions may unfold during one conversion, so a recursive (or pathological
// self-referential) definition can be made transparent without the checker ever looping. Exhausting fuel makes the
// unfold stuck (conversion returns not-equal): sound but incomplete, never wrong. Raising the cap only lets MORE true
// equalities be found (it never makes non-convertible terms convertible), so it is always sound. It is set generously
// because transparent definitions are termination-gated (only a function proven terminating is made transparent, see
// check/elaborate.ts), so they always halt on their own. The cap is a backstop for self-referential type unfolding, not
// a real bound on computation, and a low value wrongly rejected legitimate deep-but-finite proofs (a Lie bracket of a
// bracket, a multiplication table chained several deep). A successful conversion returns early, so the cost is paid
// only by a conversion that genuinely needs to unfold this far.
let unfoldFuel = 0

const MAX_UNFOLD = 1024

export function defineConstant(name: string, value: Value): void {
  definition.set(name, value)
}

// constructors of a PROPOSITIONAL TRUNCATION (an hProp): any two applications of one are equal regardless of the proof
// argument (proof irrelevance, "a mere proposition has at most one inhabitant"). Registered by the elaborator for a
// truncation type's constructor; consulted by `convert`.
const truncationConstructor = new Set<string>()

export function registerTruncation(name: string): void {
  truncationConstructor.add(name)
}

export function isTruncationConstructor(name: string): boolean {
  return truncationConstructor.has(name)
}

export function resetDefinitions(): void {
  definition.clear()
  truncationConstructor.clear()
}

// unfold a rigid constant that has a definition, replaying its spine onto the definition's value
function unfoldRigid(value: Extract<Value, { v: 'rigid' }>): Value {
  let result = definition.get(value.name)!

  for (const elim of value.spine) {
    if (elim.e === 'app') {
      result = applyValue(result, elim.arg)
    } else if (elim.e === 'fst') {
      result = applyFst(result)
    } else if (elim.e === 'snd') {
      result = applySnd(result)
    } else {
      result = applyJ(result, elim.motive, elim.base)
    }
  }

  return result
}

// reduce a value to weak head normal form, unfolding transparent definitions at the head (the same delta step the
// converter takes at lines 1116/1120) and following metavariable solutions. Bounded by the unfold fuel so a
// self-referential definition cannot loop. Lets the elaborator see the literal a closed numeric expression computes to.
export function whnf(value: Value): Value {
  let current = force(value)
  let fuel = MAX_UNFOLD

  while (
    current.v === 'rigid' &&
    definition.has(current.name) &&
    fuel-- > 0
  ) {
    current = force(unfoldRigid(current))
  }

  return current
}

// create a fresh metavariable of the given type, returned as a term ready to splice into elaboration
export function freshMeta(type: Value): Term {
  const id = nextMeta++
  metaType.set(id, type)

  return { tag: 'meta', id }
}

// reset solutions between independent elaboration runs (types are re-registered as metas are created)
export function resetMetas(): void {
  metaType.clear()
  metaSolution.clear()
  nextMeta = 0
}

// follow a flexible value to its solution (applying the recorded spine), as far as it resolves
function force(value: Value): Value {
  if (value.v !== 'flex') {
    return value
  }

  const solution = metaSolution.get(value.id)

  if (!solution) {
    return value
  }

  let result = solution

  for (const elim of value.spine) {
    if (elim.e === 'app') {
      result = applyValue(result, elim.arg)
    } else if (elim.e === 'fst') {
      result = applyFst(result)
    } else if (elim.e === 'snd') {
      result = applySnd(result)
    } else {
      result = applyJ(result, elim.motive, elim.base)
    }
  }

  return force(result)
}

// Miller pattern unification. A flexible value `?m x1 .. xn` (the spine is distinct bound variables) unifies with
// `rhs` by solving `?m := \ x1 .. xn. rhs`, where rhs is renamed into the scope of the new binders. The renaming
// also enforces the scope check (rhs may not mention variables outside x1..xn) and the occurs check (rhs may not
// mention ?m). This is the standard algorithm (Abel-Pientka / elaboration-zoo), here over our value language.

// a partial renaming from outer de Bruijn levels (the spine variables) to the solution's local de Bruijn levels
type Renaming = { codomain: number; map: Map<number, number> }

// invert a spine: succeed only when it is a list of distinct bound variables (a Miller pattern)
function invertSpine(spine: Elim[]): Renaming | null {
  const map = new Map<number, number>()

  let codomain = 0

  for (const elim of spine) {
    if (elim.e !== 'app') {
      return null
    }

    const arg = force(elim.arg)

    if (arg.v !== 'neutral' || arg.spine.length !== 0) {
      return null
    } // not a bare variable

    if (map.has(arg.head)) {
      return null
    } // not distinct

    map.set(arg.head, codomain)
    codomain++
  }

  return { codomain, map }
}

// extend a renaming under one new binder: the fresh outer variable maps to a fresh local variable
function liftRenaming(
  renaming: Renaming,
  outerLevel: number,
): Renaming {
  const map = new Map(renaming.map)
  map.set(outerLevel, renaming.codomain)

  return { codomain: renaming.codomain + 1, map }
}

// rename a value into a term valid under the solution's binders. Throws on an escaping variable (scope check) or a
// self-reference of `metaId` (occurs check). `level` is the current outer de Bruijn level.
function renameValue(
  metaId: number,
  renaming: Renaming,
  level: number,
  value: Value,
): Term {
  value = force(value)

  switch (value.v) {
    case 'type':
      return { tag: 'type', level: value.level }

    case 'flex': {
      if (value.id === metaId) {
        throw new TypeError(
          'occurs check: a metavariable appears in its own solution',
        )
      }

      return renameSpine(
        metaId,
        renaming,
        level,
        { tag: 'meta', id: value.id },
        value.spine,
      )
    }

    case 'neutral': {
      const local = renaming.map.get(value.head)

      if (local === undefined) {
        throw new TypeError(
          'a variable escapes the scope of the metavariable solution',
        )
      }

      return renameSpine(
        metaId,
        renaming,
        level,
        { tag: 'var', index: renaming.codomain - local - 1 },
        value.spine,
      )
    }

    case 'rigid':
      return renameSpine(
        metaId,
        renaming,
        level,
        { tag: 'const', name: value.name },
        value.spine,
      )
    case 'pi':
      return {
        tag: 'pi',
        mult: value.mult,
        domain: renameValue(metaId, renaming, level, value.domain),
        codomain: renameUnder(metaId, renaming, level, value.codomain),
      }
    case 'sigma':
      return {
        tag: 'sigma',
        mult: value.mult,
        domain: renameValue(metaId, renaming, level, value.domain),
        codomain: renameUnder(metaId, renaming, level, value.codomain),
      }
    case 'lam':
      return {
        tag: 'lam',
        body: renameUnder(metaId, renaming, level, value.body),
      }
    case 'self':
      return {
        tag: 'self',
        body: renameUnder(metaId, renaming, level, value.body),
      }
    case 'pair':
      return {
        tag: 'pair',
        first: renameValue(metaId, renaming, level, value.first),
        second: renameValue(metaId, renaming, level, value.second),
      }
    case 'id':
      return {
        tag: 'id',
        type: renameValue(metaId, renaming, level, value.type),
        left: renameValue(metaId, renaming, level, value.left),
        right: renameValue(metaId, renaming, level, value.right),
      }
    case 'refl':
      return {
        tag: 'refl',
        type: renameValue(metaId, renaming, level, value.type),
        value: renameValue(metaId, renaming, level, value.value),
      }
  }
}

function renameUnder(
  metaId: number,
  renaming: Renaming,
  level: number,
  closure: Closure,
): Term {
  return renameValue(
    metaId,
    liftRenaming(renaming, level),
    level + 1,
    closeOver(closure, neutralVar(level)),
  )
}

function renameSpine(
  metaId: number,
  renaming: Renaming,
  level: number,
  head: Term,
  spine: Elim[],
): Term {
  let term = head

  for (const elim of spine) {
    if (elim.e === 'app') {
      term = {
        tag: 'app',
        fun: term,
        arg: renameValue(metaId, renaming, level, elim.arg),
      }
    } else if (elim.e === 'fst') {
      term = { tag: 'fst', pair: term }
    } else if (elim.e === 'snd') {
      term = { tag: 'snd', pair: term }
    } else {
      term = {
        tag: 'j',
        proof: term,
        motive: renameValue(metaId, renaming, level, elim.motive),
        base: renameValue(metaId, renaming, level, elim.base),
        level: litLevel(0),
      }
    }
  }

  return term
}

// solve `?id spine := rhs` by Miller pattern unification (covers the empty-spine case too). Returns false if the
// spine is not a pattern, or the scope / occurs check fails.
function solveMeta(
  level: number,
  id: number,
  spine: Elim[],
  rhs: Value,
): boolean {
  const renaming = invertSpine(spine)

  if (!renaming) {
    return false
  }

  let body: Term

  try {
    body = renameValue(id, renaming, level, rhs)
  } catch {
    return false
  }

  let solution = body

  for (let i = 0; i < renaming.codomain; i++) {
    solution = { tag: 'lam', body: solution }
  }

  metaSolution.set(id, evaluate([], solution))

  return true
}

export function evaluate(env: Value[], term: Term): Value {
  switch (term.tag) {
    case 'var':
      return env[term.index]!
    case 'meta':
      return force({ v: 'flex', id: term.id, spine: [] })
    case 'const':
      return { v: 'rigid', name: term.name, spine: [] }
    case 'type':
      return { v: 'type', level: term.level }
    case 'pi':
      return {
        v: 'pi',
        mult: term.mult,
        domain: evaluate(env, term.domain),
        codomain: { env, body: term.codomain },
      }
    case 'lam':
      return { v: 'lam', body: { env, body: term.body } }
    case 'app':
      return applyValue(
        evaluate(env, term.fun),
        evaluate(env, term.arg),
      )
    case 'ann':
      return evaluate(env, term.term)
    case 'id':
      return idValue(
        evaluate(env, term.type),
        evaluate(env, term.left),
        evaluate(env, term.right),
      )
    case 'refl':
      return {
        v: 'refl',
        type: evaluate(env, term.type),
        value: evaluate(env, term.value),
      }
    case 'j':
      return applyJ(
        evaluate(env, term.proof),
        evaluate(env, term.motive),
        evaluate(env, term.base),
      )
    case 'sigma':
      return {
        v: 'sigma',
        mult: term.mult,
        domain: evaluate(env, term.domain),
        codomain: { env, body: term.codomain },
      }
    case 'pair':
      return {
        v: 'pair',
        first: evaluate(env, term.first),
        second: evaluate(env, term.second),
      }
    case 'fst':
      return applyFst(evaluate(env, term.pair))
    case 'snd':
      return applySnd(evaluate(env, term.pair))
    case 'self':
      return { v: 'self', body: { env, body: term.body } }
  }
}

function applyFst(value: Value): Value {
  value = force(value)

  if (value.v === 'pair') {
    return value.first
  }

  if (value.v === 'neutral') {
    return {
      v: 'neutral',
      head: value.head,
      spine: [...value.spine, { e: 'fst' }],
    }
  }

  if (value.v === 'rigid') {
    return {
      v: 'rigid',
      name: value.name,
      spine: [...value.spine, { e: 'fst' }],
    }
  }

  if (value.v === 'flex') {
    return {
      v: 'flex',
      id: value.id,
      spine: [...value.spine, { e: 'fst' }],
    }
  }

  throw new Error('fst of a non-pair')
}

function applySnd(value: Value): Value {
  value = force(value)

  if (value.v === 'pair') {
    return value.second
  }

  if (value.v === 'neutral') {
    return {
      v: 'neutral',
      head: value.head,
      spine: [...value.spine, { e: 'snd' }],
    }
  }

  if (value.v === 'rigid') {
    return {
      v: 'rigid',
      name: value.name,
      spine: [...value.spine, { e: 'snd' }],
    }
  }

  if (value.v === 'flex') {
    return {
      v: 'flex',
      id: value.id,
      spine: [...value.spine, { e: 'snd' }],
    }
  }

  throw new Error('snd of a non-pair')
}

// does the term reference the variable bound `depth` binders outward? (used to detect a non-dependent codomain)
function usesVar(term: Term, depth: number): boolean {
  switch (term.tag) {
    case 'var':
      return term.index === depth
    case 'pi':
    case 'sigma':
      return (
        usesVar(term.domain, depth) || usesVar(term.codomain, depth + 1)
      )
    case 'lam':
    case 'self':
      return usesVar(term.body, depth + 1)
    case 'app':
      return usesVar(term.fun, depth) || usesVar(term.arg, depth)
    case 'pair':
      return usesVar(term.first, depth) || usesVar(term.second, depth)
    case 'fst':
    case 'snd':
      return usesVar(term.pair, depth)
    case 'ann':
      return usesVar(term.term, depth) || usesVar(term.type, depth)
    case 'id':
      return (
        usesVar(term.type, depth) ||
        usesVar(term.left, depth) ||
        usesVar(term.right, depth)
      )
    case 'refl':
      return usesVar(term.type, depth) || usesVar(term.value, depth)
    case 'j':
      return (
        usesVar(term.proof, depth) ||
        usesVar(term.motive, depth) ||
        usesVar(term.base, depth)
      )
    default:
      return false
  }
}

// a codomain depends on its argument unless it is a closed (non-native) body that never mentions the bound variable
function dependsOnArgument(closure: Closure): boolean {
  return 'native' in closure ? true : usesVar(closure.body, 0)
}

// the observational identity, which makes extensionality COMPUTE:
//   Id ((a:S) -> T a) f g   ==   (a:S) -> Id (T a) (f a) (g a)             (function extensionality)
//   Id ((x:A) * B) p q       ==   (Id A p.1 q.1) * (Id B p.2 q.2)           (pair extensionality, B non-dependent)
// A proof of pointwise / componentwise equality IS a proof of equality of the function / pair.
function idValue(type: Value, left: Value, right: Value): Value {
  if (type.v === 'pi') {
    return {
      v: 'pi',
      mult: type.mult,
      domain: type.domain,
      codomain: {
        native: (a: Value) =>
          idValue(
            closeOver(type.codomain, a),
            applyValue(left, a),
            applyValue(right, a),
          ),
      },
    }
  }

  if (type.v === 'sigma') {
    const firstLeft = applyFst(left)
    const firstRight = applyFst(right)
    const firstId = idValue(type.domain, firstLeft, firstRight)

    if (!dependsOnArgument(type.codomain)) {
      // non-dependent product: Id (A * B) p q = (Id A p.1 q.1) * (Id B p.2 q.2)
      const secondType = closeOver(type.codomain, firstLeft)

      return {
        v: 'sigma',
        mult: 'many',
        domain: firstId,
        codomain: {
          native: () =>
            idValue(secondType, applySnd(left), applySnd(right)),
        },
      }
    }

    // dependent pair: Id (Sigma(x:A) B) p q = Sigma (h : Id A p.1 q.1) (Id (B q.1) (transport B h p.2) q.2). The
    // second component is transported along the first-component proof h, using J (so when h is refl it computes
    // away and this is the ordinary componentwise identity).
    const secondTypeAtRight = closeOver(type.codomain, firstRight)
    const secondLeft = applySnd(left)
    const secondRight = applySnd(right)
    // the transport motive: \ y. \ _. B y
    const motive: Value = {
      v: 'lam',
      body: {
        native: (y: Value) => ({
          v: 'lam',
          body: { native: () => closeOver(type.codomain, y) },
        }),
      },
    }

    return {
      v: 'sigma',
      mult: 'many',
      domain: firstId,
      codomain: {
        native: (h: Value) =>
          idValue(
            secondTypeAtRight,
            applyJ(h, motive, secondLeft),
            secondRight,
          ),
      },
    }
  }

  return { v: 'id', type, left, right }
}

export function closeOver(closure: Closure, value: Value): Value {
  return 'native' in closure
    ? closure.native(value)
    : evaluate([value, ...closure.env], closure.body)
}

export function applyValue(fun: Value, arg: Value): Value {
  fun = force(fun)

  if (fun.v === 'lam') {
    return closeOver(fun.body, arg)
  }

  if (fun.v === 'neutral') {
    return {
      v: 'neutral',
      head: fun.head,
      spine: [...fun.spine, { e: 'app', arg }],
    }
  }

  if (fun.v === 'rigid') {
    return {
      v: 'rigid',
      name: fun.name,
      spine: [...fun.spine, { e: 'app', arg }],
    }
  }

  if (fun.v === 'flex') {
    return {
      v: 'flex',
      id: fun.id,
      spine: [...fun.spine, { e: 'app', arg }],
    }
  }

  throw new Error('applied a non-function')
}

function applyJ(proof: Value, motive: Value, base: Value): Value {
  proof = force(proof)

  if (proof.v === 'refl') {
    return base
  }

  if (proof.v === 'neutral') {
    return {
      v: 'neutral',
      head: proof.head,
      spine: [...proof.spine, { e: 'j', motive, base }],
    }
  }

  if (proof.v === 'rigid') {
    return {
      v: 'rigid',
      name: proof.name,
      spine: [...proof.spine, { e: 'j', motive, base }],
    }
  }

  if (proof.v === 'flex') {
    return {
      v: 'flex',
      id: proof.id,
      spine: [...proof.spine, { e: 'j', motive, base }],
    }
  }

  throw new Error('J on a non-identity')
}

// quote a spine of eliminators onto a head term (shared by metavariable, neutral, and rigid heads)
function quoteSpine(level: number, head: Term, spine: Elim[]): Term {
  let term = head

  for (const elim of spine) {
    if (elim.e === 'app') {
      term = { tag: 'app', fun: term, arg: quote(level, elim.arg) }
    } else if (elim.e === 'fst') {
      term = { tag: 'fst', pair: term }
    } else if (elim.e === 'snd') {
      term = { tag: 'snd', pair: term }
    } else {
      term = {
        tag: 'j',
        proof: term,
        motive: quote(level, elim.motive),
        base: quote(level, elim.base),
        level: litLevel(0),
      }
    }
  }

  return term
}

export function quote(level: number, value: Value): Term {
  value = force(value)

  switch (value.v) {
    case 'type':
      return { tag: 'type', level: value.level }
    case 'flex':
      return quoteSpine(
        level,
        { tag: 'meta', id: value.id },
        value.spine,
      )
    case 'pi':
      return {
        tag: 'pi',
        mult: value.mult,
        domain: quote(level, value.domain),
        codomain: quote(
          level + 1,
          closeOver(value.codomain, neutralVar(level)),
        ),
      }
    case 'lam':
      return {
        tag: 'lam',
        body: quote(
          level + 1,
          closeOver(value.body, neutralVar(level)),
        ),
      }
    case 'id':
      return {
        tag: 'id',
        type: quote(level, value.type),
        left: quote(level, value.left),
        right: quote(level, value.right),
      }
    case 'refl':
      return {
        tag: 'refl',
        type: quote(level, value.type),
        value: quote(level, value.value),
      }
    case 'sigma':
      return {
        tag: 'sigma',
        mult: value.mult,
        domain: quote(level, value.domain),
        codomain: quote(
          level + 1,
          closeOver(value.codomain, neutralVar(level)),
        ),
      }
    case 'pair':
      return {
        tag: 'pair',
        first: quote(level, value.first),
        second: quote(level, value.second),
      }
    case 'self':
      return {
        tag: 'self',
        body: quote(
          level + 1,
          closeOver(value.body, neutralVar(level)),
        ),
      }
    case 'neutral':
      return quoteSpine(
        level,
        { tag: 'var', index: level - value.head - 1 },
        value.spine,
      )
    case 'rigid':
      return quoteSpine(
        level,
        { tag: 'const', name: value.name },
        value.spine,
      )
  }
}

// compare two eliminator spines structurally (shared by neutral and rigid heads)
function convertSpine(level: number, a: Elim[], b: Elim[]): boolean {
  if (a.length !== b.length) {
    return false
  }

  for (let i = 0; i < a.length; i++) {
    const x = a[i]!
    const y = b[i]!

    if (x.e === 'app' && y.e === 'app') {
      if (!convert(level, x.arg, y.arg)) {
        return false
      }
    } else if (x.e === 'j' && y.e === 'j') {
      if (
        !convert(level, x.motive, y.motive) ||
        !convert(level, x.base, y.base)
      ) {
        return false
      }
    } else if (x.e === 'fst' && y.e === 'fst') {
      // a projection: nothing to compare beyond the elimination kind
    } else if (x.e === 'snd' && y.e === 'snd') {
      // ditto
    } else {
      return false
    }
  }

  return true
}

function convert(level: number, a: Value, b: Value): boolean {
  a = force(a)
  b = force(b)

  // metavariable solving by Miller pattern unification
  if (a.v === 'flex' && b.v === 'flex' && a.id === b.id) {
    return convertSpine(level, a.spine, b.spine)
  }

  if (a.v === 'flex') {
    return solveMeta(level, a.id, a.spine, b)
  }

  if (b.v === 'flex') {
    return solveMeta(level, b.id, b.spine, a)
  }

  if (a.v === 'type' && b.v === 'type') {
    return eqLevel(a.level, b.level)
  }

  if (a.v === 'pi' && b.v === 'pi') {
    return (
      a.mult === b.mult &&
      convert(level, a.domain, b.domain) &&
      convert(
        level + 1,
        closeOver(a.codomain, neutralVar(level)),
        closeOver(b.codomain, neutralVar(level)),
      )
    )
  }

  if (a.v === 'lam' || b.v === 'lam') {
    return convert(
      level + 1,
      applyValue(a, neutralVar(level)),
      applyValue(b, neutralVar(level)),
    )
  }

  if (a.v === 'sigma' && b.v === 'sigma') {
    return (
      a.mult === b.mult &&
      convert(level, a.domain, b.domain) &&
      convert(
        level + 1,
        closeOver(a.codomain, neutralVar(level)),
        closeOver(b.codomain, neutralVar(level)),
      )
    )
  }

  if (a.v === 'pair' || b.v === 'pair') {
    // eta for pairs: compare componentwise, eta-expanding a neutral pair via its projections
    return (
      convert(level, applyFst(a), applyFst(b)) &&
      convert(level, applySnd(a), applySnd(b))
    )
  }

  if (a.v === 'self' && b.v === 'self') {
    return convert(
      level + 1,
      closeOver(a.body, neutralVar(level)),
      closeOver(b.body, neutralVar(level)),
    )
  }

  if (a.v === 'id' && b.v === 'id') {
    return (
      convert(level, a.type, b.type) &&
      convert(level, a.left, b.left) &&
      convert(level, a.right, b.right)
    )
  }

  if (a.v === 'refl' && b.v === 'refl') {
    return convert(level, a.value, b.value)
  }

  if (a.v === 'neutral' && b.v === 'neutral') {
    if (a.head !== b.head) {
      return false
    }

    return convertSpine(level, a.spine, b.spine)
  }

  // PROOF IRRELEVANCE for a propositional truncation (hProp): two applications of a truncation constructor are equal
  // regardless of the proof argument. The constructor is `squash : (0 A) -> A -> Squash A`, so the spine is
  // [type-arg, .., proof]; compare everything BUT the last element (the proof). This makes `Squash A` a mere
  // proposition (at most one inhabitant up to convertibility), the basis of "mere existence" without leaking a witness.
  if (
    a.v === 'rigid' &&
    b.v === 'rigid' &&
    a.name === b.name &&
    truncationConstructor.has(a.name) &&
    a.spine.length === b.spine.length &&
    a.spine.length >= 1
  ) {
    return convertSpine(level, a.spine.slice(0, -1), b.spine.slice(0, -1))
  }

  // rigid constants: try the fast structural path first, then delta-unfold any transparent definition and retry
  if (
    a.v === 'rigid' &&
    b.v === 'rigid' &&
    a.name === b.name &&
    a.spine.length === b.spine.length &&
    convertSpine(level, a.spine, b.spine)
  ) {
    return true
  }

  if (a.v === 'rigid' && definition.has(a.name)) {
    return convertUnfolding(level, unfoldRigid(a), b)
  }

  if (b.v === 'rigid' && definition.has(b.name)) {
    return convertUnfolding(level, a, unfoldRigid(b))
  }

  return false
}

// convert after a delta unfold, charging fuel so recursive / self-referential definitions cannot loop the checker
function convertUnfolding(level: number, a: Value, b: Value): boolean {
  if (unfoldFuel >= MAX_UNFOLD) {
    return false
  }

  unfoldFuel++

  const result = convert(level, a, b)
  unfoldFuel--

  return result
}

// public: are two values definitionally equal? (used by the refinement layer to discharge a non-linear hold via
// the kernel, leveraging delta so e.g. a transparent `double(n)` is equal to `add(n, n)`)
export function areConvertible(
  level: number,
  a: Value,
  b: Value,
): boolean {
  return convert(level, a, b)
}

// ---- conversion modulo a set of (induction) hypotheses ----
// like `convert`, but at EVERY node it also accepts the two values when they match a hypothesis equation L == R (in
// either orientation), tested by ordinary definitional equality. This is exactly the reasoning a structural-induction
// step needs: the recurrence peels a constructor, exposing a recursive sub-call that the induction hypothesis equates
// to the other side. Sound: a hypothesis is a TRUE equation in the step's context, so substituting equals preserves
// equality. Terminating: it mirrors `convert`'s lazy, fuel-bounded structure (no eager full normalization).
function matchesHypothesis(
  level: number,
  a: Value,
  b: Value,
  hyps: [Value, Value][],
): boolean {
  // fast path: a == b is directly one hypothesis, in either orientation
  for (const [l, r] of hyps) {
    if (
      (convert(level, a, l) && convert(level, b, r)) ||
      (convert(level, a, r) && convert(level, b, l))
    ) {
      return true
    }
  }

  if (hyps.length < 2) {
    return false
  }

  // TRANSITIVE CLOSURE over hypothesis endpoints: each hypothesis `l == r` is an undirected edge, and two endpoints
  // that are themselves convertible are the same node. `a` and `b` are equal under the hypotheses if some endpoint
  // convertible to `a` reaches some endpoint convertible to `b` through that graph (a chain `a = .. = b`). This is the
  // closure step that makes the hypothesis reasoning transitive (combined with the structural recursion in `convertMod`,
  // which supplies congruence). Sound: every edge is a real equality, and transitivity of equality is valid. Bounded:
  // the endpoint set is small (two per hypothesis) and the search visits each at most once.
  const endpoints: Value[] = []

  for (const [l, r] of hyps) {
    endpoints.push(l, r)
  }

  const reached = new Array<boolean>(endpoints.length).fill(false)
  const queue: number[] = []

  endpoints.forEach((endpoint, i) => {
    if (convert(level, a, endpoint)) {
      reached[i] = true
      queue.push(i)
    }
  })

  while (queue.length > 0) {
    const i = queue.shift()!
    // the other end of the SAME hypothesis (endpoints are pushed in (l, r) pairs), plus any convertible endpoint
    const partner = i % 2 === 0 ? i + 1 : i - 1

    for (let j = 0; j < endpoints.length; j++) {
      if (
        !reached[j] &&
        (j === partner || convert(level, endpoints[i]!, endpoints[j]!))
      ) {
        reached[j] = true
        queue.push(j)
      }
    }
  }

  return endpoints.some(
    (endpoint, i) => reached[i] && convert(level, b, endpoint),
  )
}

function convertModSpine(
  level: number,
  a: Elim[],
  b: Elim[],
  hyps: [Value, Value][],
): boolean {
  if (a.length !== b.length) {
    return false
  }

  for (let i = 0; i < a.length; i++) {
    const x = a[i]!
    const y = b[i]!

    if (x.e === 'app' && y.e === 'app') {
      if (!convertMod(level, x.arg, y.arg, hyps)) {
        return false
      }
    } else if (x.e === 'j' && y.e === 'j') {
      if (
        !convertMod(level, x.motive, y.motive, hyps) ||
        !convertMod(level, x.base, y.base, hyps)
      ) {
        return false
      }
    } else if (x.e === 'fst' && y.e === 'fst') {
      // a projection: nothing to compare beyond the elimination kind
    } else if (x.e === 'snd' && y.e === 'snd') {
      // ditto
    } else {
      return false
    }
  }

  return true
}

function convertModUnfolding(
  level: number,
  a: Value,
  b: Value,
  hyps: [Value, Value][],
): boolean {
  if (unfoldFuel >= MAX_UNFOLD) {
    return false
  }

  unfoldFuel++

  const result = convertMod(level, a, b, hyps)
  unfoldFuel--

  return result
}

function convertMod(
  level: number,
  a: Value,
  b: Value,
  hyps: [Value, Value][],
): boolean {
  if (convert(level, a, b)) {
    return true
  }

  if (matchesHypothesis(level, a, b, hyps)) {
    return true
  }

  a = force(a)
  b = force(b)

  if (a.v === 'pi' && b.v === 'pi') {
    return (
      a.mult === b.mult &&
      convertMod(level, a.domain, b.domain, hyps) &&
      convertMod(
        level + 1,
        closeOver(a.codomain, neutralVar(level)),
        closeOver(b.codomain, neutralVar(level)),
        hyps,
      )
    )
  }

  if (a.v === 'lam' || b.v === 'lam') {
    return convertMod(
      level + 1,
      applyValue(a, neutralVar(level)),
      applyValue(b, neutralVar(level)),
      hyps,
    )
  }

  if (a.v === 'sigma' && b.v === 'sigma') {
    return (
      a.mult === b.mult &&
      convertMod(level, a.domain, b.domain, hyps) &&
      convertMod(
        level + 1,
        closeOver(a.codomain, neutralVar(level)),
        closeOver(b.codomain, neutralVar(level)),
        hyps,
      )
    )
  }

  if (a.v === 'pair' || b.v === 'pair') {
    return (
      convertMod(level, applyFst(a), applyFst(b), hyps) &&
      convertMod(level, applySnd(a), applySnd(b), hyps)
    )
  }

  if (a.v === 'self' && b.v === 'self') {
    return convertMod(
      level + 1,
      closeOver(a.body, neutralVar(level)),
      closeOver(b.body, neutralVar(level)),
      hyps,
    )
  }

  if (a.v === 'id' && b.v === 'id') {
    return (
      convertMod(level, a.type, b.type, hyps) &&
      convertMod(level, a.left, b.left, hyps) &&
      convertMod(level, a.right, b.right, hyps)
    )
  }

  if (a.v === 'refl' && b.v === 'refl') {
    return convertMod(level, a.value, b.value, hyps)
  }

  if (a.v === 'neutral' && b.v === 'neutral' && a.head === b.head) {
    return convertModSpine(level, a.spine, b.spine, hyps)
  }

  if (
    a.v === 'rigid' &&
    b.v === 'rigid' &&
    a.name === b.name &&
    a.spine.length === b.spine.length &&
    convertModSpine(level, a.spine, b.spine, hyps)
  ) {
    return true
  }

  if (a.v === 'rigid' && definition.has(a.name)) {
    return convertModUnfolding(level, unfoldRigid(a), b, hyps)
  }

  if (b.v === 'rigid' && definition.has(b.name)) {
    return convertModUnfolding(level, a, unfoldRigid(b), hyps)
  }

  return false
}

// public: are two values equal in the theory extended by the given (induction-) hypothesis equalities? Used by the
// structural-induction tactic to discharge a constructor case using the hypotheses on the recursive fields.
export function convertibleModulo(
  level: number,
  a: Value,
  b: Value,
  hypotheses: [Value, Value][],
): boolean {
  return convertMod(level, a, b, hypotheses)
}

// subtyping with universe cumulativity
function subtype(level: number, a: Value, b: Value): boolean {
  a = force(a)
  b = force(b)

  if (a.v === 'flex' || b.v === 'flex') {
    return convert(level, a, b)
  } // let the meta solver handle either side

  if (a.v === 'type' && b.v === 'type') {
    return leqLevel(a.level, b.level)
  }

  if (a.v === 'pi' && b.v === 'pi') {
    return (
      a.mult === b.mult &&
      convert(level, a.domain, b.domain) &&
      subtype(
        level + 1,
        closeOver(a.codomain, neutralVar(level)),
        closeOver(b.codomain, neutralVar(level)),
      )
    )
  }

  if (a.v === 'sigma' && b.v === 'sigma') {
    return (
      a.mult === b.mult &&
      subtype(level, a.domain, b.domain) &&
      subtype(
        level + 1,
        closeOver(a.codomain, neutralVar(level)),
        closeOver(b.codomain, neutralVar(level)),
      )
    )
  }

  return convert(level, a, b)
}

// ---- context and usage ----
// `globals` is the signature: each postulated constant mapped to its type (a value). Threaded through binders.
export type Context = {
  level: number
  env: Value[]
  types: Value[]
  mults: Mult[]
  globals: Map<string, Value>
}
export const emptyContext: Context = {
  level: 0,
  env: [],
  types: [],
  mults: [],
  globals: new Map(),
}

// build a context whose signature postulates each named constant at the given (closed) type term
export function contextWithSignature(
  signature: { name: string; type: Term }[],
): Context {
  const globals = new Map<string, Value>()

  for (const entry of signature) {
    globals.set(entry.name, evaluate([], entry.type))
  }

  return { ...emptyContext, globals }
}

export function bind(
  context: Context,
  mult: Mult,
  type: Value,
): Context {
  return {
    level: context.level + 1,
    env: [neutralVar(context.level), ...context.env],
    types: [type, ...context.types],
    mults: [mult, ...context.mults],
    globals: context.globals,
  }
}

type Usage = Mult[]
const zeroUsage = (n: number): Usage => new Array<Mult>(n).fill(0)
const addUsage = (a: Usage, b: Usage): Usage =>
  a.map((m, i) => addMult(m, b[i]!))

const scaleUsage = (k: Mult, a: Usage): Usage =>
  a.map(m => mulMult(k, m))

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

      if (!type) {
        throw new TypeError(`unbound variable ${term.index}`)
      }

      return { type, usage: singletonUsage(context.level, term.index) }
    }

    case 'const': {
      const type = context.globals.get(term.name)

      if (!type) {
        throw new TypeError(`unknown constant ${term.name}`)
      }

      return { type, usage: zeroUsage(context.level) }
    }

    case 'meta': {
      const type = metaType.get(term.id)

      if (!type) {
        throw new TypeError(`unknown metavariable ${term.id}`)
      }

      return { type, usage: zeroUsage(context.level) }
    }

    case 'type':
      return {
        type: { v: 'type', level: succLevel(term.level) },
        usage: zeroUsage(context.level),
      }

    case 'pi': {
      const domainLevel = inferUniverse(context, term.domain)
      const inner = bind(
        context,
        'many',
        evaluate(context.env, term.domain),
      )

      const codomainLevel = inferUniverse(inner, term.codomain)

      return {
        type: {
          v: 'type',
          level: piLevel(domainLevel, codomainLevel),
        },
        usage: zeroUsage(context.level),
      }
    }

    case 'app': {
      const fun = infer(context, term.fun)

      let funType = force(fun.type)

      // self elimination at application: a self-typed function unfolds to its body with the self value
      // substituted, so a recursive constructor can apply its own recursive argument (itself self-typed) without
      // a manual annotation. The unfolded body of an inductive's self type is a pi, so application then proceeds.
      if (funType.v === 'self') {
        funType = force(
          closeOver(funType.body, evaluate(context.env, term.fun)),
        )
      }

      if (funType.v !== 'pi') {
        throw new TypeError('applied a non-function')
      }

      const argUsage = check(context, term.arg, funType.domain)
      const result = closeOver(
        funType.codomain,
        evaluate(context.env, term.arg),
      )

      return {
        type: result,
        usage: addUsage(fun.usage, scaleUsage(funType.mult, argUsage)),
      }
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

      return {
        type: { v: 'type', level },
        usage: zeroUsage(context.level),
      }
    }

    case 'refl': {
      inferUniverse(context, term.type)

      const type = evaluate(context.env, term.type)
      check(context, term.value, type)

      const value = evaluate(context.env, term.value)

      return {
        type: idValue(type, value, value),
        usage: zeroUsage(context.level),
      }
    }

    case 'j': {
      const proof = infer(context, term.proof)

      if (proof.type.v !== 'id') {
        throw new TypeError('J needs an identity proof')
      }

      const { type: aType, left: a, right: b } = proof.type
      check(
        context,
        term.motive,
        motivePiType(context, aType, a, term.level),
      )

      const motive = evaluate(context.env, term.motive)
      const reflA: Value = { v: 'refl', type: aType, value: a }
      const baseType = applyValue(applyValue(motive, a), reflA)
      check(context, term.base, baseType)

      const proofValue = evaluate(context.env, term.proof)
      const resultType = applyValue(applyValue(motive, b), proofValue)

      return { type: resultType, usage: zeroUsage(context.level) }
    }

    case 'sigma': {
      const domainLevel = inferUniverse(context, term.domain)
      const inner = bind(
        context,
        'many',
        evaluate(context.env, term.domain),
      )

      const codomainLevel = inferUniverse(inner, term.codomain)

      return {
        type: {
          v: 'type',
          level: maxLevel(domainLevel, codomainLevel),
        },
        usage: zeroUsage(context.level),
      }
    }

    case 'fst': {
      const pair = infer(context, term.pair)
      const pairType = force(pair.type)

      if (pairType.v !== 'sigma') {
        throw new TypeError('fst of a non-pair')
      }

      return { type: pairType.domain, usage: pair.usage }
    }

    case 'snd': {
      const pair = infer(context, term.pair)
      const pairType = force(pair.type)

      if (pairType.v !== 'sigma') {
        throw new TypeError('snd of a non-pair')
      }

      const first = applyFst(evaluate(context.env, term.pair))

      return {
        type: closeOver(pairType.codomain, first),
        usage: pair.usage,
      }
    }

    case 'self': {
      // formation: Self x. T : Type i, where T is typed with x standing for the self type itself
      const selfType: Value = {
        v: 'self',
        body: { env: context.env, body: term.body },
      }

      const inner = bind(context, 'many', selfType)
      const level = inferUniverse(inner, term.body)

      return {
        type: { v: 'type', level },
        usage: zeroUsage(context.level),
      }
    }

    case 'pair':
      throw new TypeError(
        'cannot infer a bare pair; annotate it or check it against a sigma type',
      )
    case 'lam':
      throw new TypeError(
        'cannot infer a bare function; annotate it or check it against a pi type',
      )
  }
}

function motivePiType(
  context: Context,
  aType: Value,
  a: Value,
  level: Level,
): Value {
  return {
    v: 'pi',
    mult: 'many',
    domain: aType,
    codomain: {
      env: [a, aType, ...context.env],
      body: {
        tag: 'pi',
        mult: 'many',
        domain: {
          tag: 'id',
          type: { tag: 'var', index: 2 },
          left: { tag: 'var', index: 1 },
          right: { tag: 'var', index: 0 },
        },
        codomain: { tag: 'type', level },
      },
    },
  }
}

export function check(
  context: Context,
  term: Term,
  expected: Value,
): Usage {
  expected = force(expected)

  if (expected.v === 'self') {
    // checking against Self x. T. The self-introduction rule is: a term has type Self x. T exactly when it has type
    // T[x := itself]. But a term may instead ALREADY have the self type (a variable of that type, or an eliminator
    // result like the body of plus, which computes to the self type). So:
    //   - a canonical introduction form (lam / pair) cannot be inferred, so introduce it directly: check it against
    //     the unfolded body. This is what lets a recursive constructor (succ : Nat -> Nat) check.
    //   - otherwise infer first; if the term already has the self type (up to conversion), accept it. Only when it
    //     does not, fall back to self-introduction against the unfolded body. This keeps eliminator results, which
    //     already carry the self type, from being forced to inhabit the unfolded body.
    const unfolded = (): Value =>
      closeOver(expected.body, evaluate(context.env, term))

    if (term.tag === 'lam' || term.tag === 'pair') {
      return check(context, term, unfolded())
    }

    const actual = infer(context, term)

    if (subtype(context.level, actual.type, expected)) {
      return actual.usage
    }

    return check(context, term, unfolded())
  }

  if (term.tag === 'lam') {
    if (expected.v !== 'pi') {
      throw new TypeError(
        'a function must be checked against a pi type',
      )
    }

    const inner = bind(context, expected.mult, expected.domain)
    const bodyType = closeOver(
      expected.codomain,
      neutralVar(context.level),
    )

    const bodyUsage = check(inner, term.body, bodyType)

    if (!fitsMult(bodyUsage[0]!, expected.mult)) {
      throw new TypeError(
        `linearity: a ${showMult(
          expected.mult,
        )} argument was used ${showMult(bodyUsage[0]!)} times`,
      )
    }

    return bodyUsage.slice(1)
  }

  if (term.tag === 'refl') {
    if (expected.v !== 'id') {
      throw new TypeError(
        'refl must be checked against an identity type',
      )
    }

    if (!convert(context.level, expected.left, expected.right)) {
      throw new TypeError(
        'refl: the two sides of the identity are not definitionally equal',
      )
    }

    check(context, term.value, expected.type)

    return zeroUsage(context.level)
  }

  if (term.tag === 'pair') {
    if (expected.v !== 'sigma') {
      throw new TypeError('a pair must be checked against a sigma type')
    }

    const firstUsage = check(context, term.first, expected.domain)
    const secondType = closeOver(
      expected.codomain,
      evaluate(context.env, term.first),
    )

    const secondUsage = check(context, term.second, secondType)

    return addUsage(scaleUsage(expected.mult, firstUsage), secondUsage)
  }

  const actual = infer(context, term)
  const actualType = force(actual.type)

  // self elimination: a term of type Self x. T may be used at T[x := itself]
  if (
    actualType.v === 'self' &&
    !subtype(context.level, actualType, expected)
  ) {
    const unfolded = closeOver(
      actualType.body,
      evaluate(context.env, term),
    )

    if (subtype(context.level, unfolded, expected)) {
      return actual.usage
    }
  }

  if (!subtype(context.level, actual.type, expected)) {
    throw new TypeError(
      `type mismatch:\n  expected ${showValue(
        context.level,
        expected,
      )}\n  found    ${showValue(context.level, actual.type)}`,
    )
  }

  return actual.usage
}

function inferUniverse(context: Context, term: Term): Level {
  const inferred = infer(context, term)

  if (inferred.type.v !== 'type') {
    throw new TypeError('expected a type')
  }

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
    case 'meta':
      return `?${term.id}`
    case 'const':
      return term.name
    case 'type':
      return `Type ${showLevel(term.level)}`
    case 'pi':
      return `(${showMult(term.mult)} ${showTerm(
        term.domain,
      )}) -> ${showTerm(term.codomain)}`
    case 'lam':
      return `\\ ${showTerm(term.body)}`
    case 'app':
      return `(${showTerm(term.fun)} ${showTerm(term.arg)})`
    case 'ann':
      return `(${showTerm(term.term)} : ${showTerm(term.type)})`
    case 'id':
      return `Id ${showTerm(term.type)} ${showTerm(
        term.left,
      )} ${showTerm(term.right)}`
    case 'refl':
      return `refl`
    case 'j':
      return `J(${showTerm(term.proof)})`
    case 'sigma':
      return `(${showMult(term.mult)} ${showTerm(
        term.domain,
      )}) * ${showTerm(term.codomain)}`
    case 'pair':
      return `(${showTerm(term.first)}, ${showTerm(term.second)})`
    case 'fst':
      return `${showTerm(term.pair)}.1`
    case 'snd':
      return `${showTerm(term.pair)}.2`
    case 'self':
      return `Self ${showTerm(term.body)}`
  }
}

// instantiate a level-polymorphic term: replace a level variable with a concrete level throughout
export function instantiateLevel(
  term: Term,
  name: string,
  replacement: Level,
): Term {
  const go = (t: Term): Term => {
    switch (t.tag) {
      case 'type':
        return {
          tag: 'type',
          level: substLevel(t.level, name, replacement),
        }
      case 'pi':
        return {
          tag: 'pi',
          mult: t.mult,
          domain: go(t.domain),
          codomain: go(t.codomain),
        }
      case 'lam':
        return { tag: 'lam', body: go(t.body) }
      case 'app':
        return { tag: 'app', fun: go(t.fun), arg: go(t.arg) }
      case 'ann':
        return { tag: 'ann', term: go(t.term), type: go(t.type) }
      case 'id':
        return {
          tag: 'id',
          type: go(t.type),
          left: go(t.left),
          right: go(t.right),
        }
      case 'refl':
        return { tag: 'refl', type: go(t.type), value: go(t.value) }
      case 'j':
        return {
          tag: 'j',
          proof: go(t.proof),
          motive: go(t.motive),
          base: go(t.base),
          level: substLevel(t.level, name, replacement),
        }
      case 'sigma':
        return {
          tag: 'sigma',
          mult: t.mult,
          domain: go(t.domain),
          codomain: go(t.codomain),
        }
      case 'pair':
        return { tag: 'pair', first: go(t.first), second: go(t.second) }
      case 'fst':
        return { tag: 'fst', pair: go(t.pair) }
      case 'snd':
        return { tag: 'snd', pair: go(t.pair) }
      case 'self':
        return { tag: 'self', body: go(t.body) }
      case 'var':
      case 'const':
      case 'meta':
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
