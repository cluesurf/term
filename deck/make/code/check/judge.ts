// The dependent type core: a bidirectional type checker by normalization-by-evaluation, implementing the decided
// kernel (see note/research/vibe/computation/plans/12-type-systems.md):
//   1. a predicative, cumulative, universe-POLYMORPHIC hierarchy (levels are expressions over level variables;
//      Type i : Type (i+1); no Type : Type) -- the sound logic
//   2. quantities (multiplicities 0 / 1 / many) with linear usage checking
//   3. an identity type with refl and J, AND observational function extensionality that COMPUTES: Id at a
//      function type reduces to the pointwise identity, so funext is derivable (the identity function), not
//      postulated
// Self-type inductive encodings live in the companion kernel.ts. Browser-safe, no host APIs.
//
// The kernel is Term, check/judging.tree (self-hosting, 2026-10-06), whose header says how it is represented: a closure
// defunctionalized (one case per native function the original built), the module state one shared record, a
// multiplicity the original's own value. This face holds the one state and the original's API over it, and it is where
// a kernel error becomes the original's class again: `TypeError` (this module's, which the elaborator catches) or a
// plain `Error`. It also gives the unfold fuel back when a call throws, which the original did in a `finally` on every
// conversion that unfolded: nothing inside the kernel catches such a throw, so the value at the call is the value the
// original's `finally` chain restored.

import * as judging from '@term/make/code/check/judging'

// ---- universe levels: max(constant, max over (variable + offset)) ----
export type Level = { constant: number; vars: Map<string, number> }

export const litLevel = (n: number): Level => judging.litLevel(n)
export const varLevel = (name: string): Level => judging.varLevel(name)

export function succLevel(level: Level): Level {
  return judging.succLevel(level)
}

export function maxLevel(a: Level, b: Level): Level {
  return judging.maxLevel(a, b)
}

// the universe a Pi inhabits: impredicative at the bottom (literally Type 0), predicative above
export function piLevel(domainLevel: Level, codomainLevel: Level): Level {
  return judging.piLevel(domainLevel, codomainLevel)
}

export const eqLevel = (a: Level, b: Level): boolean => judging.eqLevel(a, b)

// ---- multiplicities (the {0, 1, ω} semiring) ----
export type Mult = 0 | 1 | 'many'

// ---- terms (de Bruijn indices) ----
export type Term =
  | { tag: 'var'; index: number }
  | { tag: 'meta'; id: number } // a metavariable (inference hole), solved by unification
  | { tag: 'const'; name: string } // a postulated global constant (base type or primitive in the signature)
  | { tag: 'type'; level: Level }
  | { tag: 'pi'; mult: Mult; domain: Term; codomain: Term }
  // `name` is what the source called the bound variable. Read only to print an error, never to decide one
  | { tag: 'lam'; body: Term; name?: string }
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

// ---- values (normal forms). A closure is the kernel's own (judging.tree `kernel-closure`), read only through
// `closeOver` ----
type Closure = judging.KernelClosure
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

export const neutralVar = (level: number): Value => judging.neutralVar(level) as Value

// ---- the one state: the metacontext, the transparent definitions, the unfold fuel, the truncations, the circle ----
const state = judging.newState()

export class TypeError extends Error {}

// a kernel error as the original threw it: the elaborator catches `TypeError` and lets a plain `Error` through. The
// raised error is REUSED, given the class and the message without its prefix, rather than a second one built: the
// elaborator throws and catches thousands a program, and each new error captures a stack
function original(error: unknown): unknown {
  const raised = error as { form?: unknown; note?: unknown } | undefined

  if (raised && raised.form === 'failure' && typeof raised.note === 'string') {
    const note = raised.note

    if (note.startsWith('kernel-type:')) {
      return recast(error as Error, TypeError.prototype, note.slice('kernel-type:'.length))
    }

    if (note.startsWith('kernel-fault:')) {
      return recast(error as Error, Error.prototype, note.slice('kernel-fault:'.length))
    }
  }

  return error
}

function recast(error: Error, prototype: object, message: string): Error {
  Object.setPrototypeOf(error, prototype)
  error.message = message
  delete (error as { name?: string }).name
  return error
}

// the one state, for a Term caller that calls the kernel itself (check/elaborating-cases.tree and the elaborator's
// other parts), which then reaches TypeScript through `kernel` like any call here
export function judgeState(): judging.JudgeState {
  return state
}

// a call into the kernel: on a throw the fuel is what it was at the call, and the error is the original's class
export function kernel<T>(call: () => T): T {
  const fuel = judging.unfoldFuelOf(state)

  try {
    return call()
  } catch (error) {
    judging.setUnfoldFuel(state, fuel)

    throw original(error)
  }
}

// ---- transparent definitions (delta reduction), truncations, the circle ----

export function defineConstant(name: string, value: Value): void {
  judging.defineConstant(state, name, value as never)
}

// a truncation constructor WITH ITS ARITY: two applications of exactly that many arguments are equal whatever the proof
export function registerTruncation(name: string, arity: number): void {
  judging.registerTruncation(state, name, arity)
}

export function isTruncationConstructor(name: string): boolean {
  return judging.isTruncationConstructor(state, name)
}

// THE CIRCLE's computation rules fire only once whoever postulates its signature enables them
export function enableCircle(): void {
  judging.enableCircle(state)
}

export function resetDefinitions(): void {
  judging.resetDefinitions(state)
}

// a value in weak head normal form, transparent heads unfolded under a fuel and metavariable solutions followed
export function whnf(value: Value): Value {
  return kernel(() => judging.whnf(state, value as never) as Value)
}

// a fresh metavariable of the given type, as a term ready to splice into elaboration
export function freshMeta(type: Value): Term {
  return judging.freshMeta(state, type as never) as Term
}

// reset solutions between independent elaboration runs (types are re-registered as metas are created)
export function resetMetas(): void {
  judging.resetMetas(state)
}

export function evaluate(env: Value[], term: Term): Value {
  return kernel(() => judging.evaluate(state, env as never, term as never) as Value)
}

export function closeOver(closure: Closure, value: Value): Value {
  return kernel(() => judging.closeOver(state, closure, value as never) as Value)
}

export function applyValue(fun: Value, arg: Value): Value {
  return kernel(() => judging.applyValue(state, fun as never, arg as never) as Value)
}

// A NORMAL FORM TO REWRITE IN: every transparent definition unfolded, except a constant in `opaque` and a call whose
// unfolding only gets stuck, which stay as written
export function normalTerm(level: number, value: Value, opaque: ReadonlySet<string>, depth = 0): Term {
  return kernel(() => judging.normalTerm(state, level, value as never, name => opaque.has(name), depth) as Term)
}

export function quote(level: number, value: Value): Term {
  return kernel(() => judging.quote(state, level, value as never) as Term)
}

// are two values definitionally equal? (the refinement layer discharges a non-linear hold through it)
export function areConvertible(level: number, a: Value, b: Value): boolean {
  return kernel(() => judging.areConvertible(state, level, a as never, b as never))
}

// are two values equal in the theory extended by the given (induction-) hypothesis equalities?
export function convertibleModulo(level: number, a: Value, b: Value, hypotheses: [Value, Value][]): boolean {
  return kernel(() => judging.convertibleModulo(state, level, a as never, b as never, hypotheses as never))
}

// ---- context and usage ----
// `globals` is the signature: each postulated constant mapped to its type (a value). Threaded through binders.
// `names` is what the source called each bound variable, in the order of `env` ('' where it had no name). The kernel
// never reads it: it is how an error prints `c` where it printed `#1` (guides: proofs/equality, 2026-10-04).
export type Context = {
  level: number
  env: Value[]
  types: Value[]
  mults: Mult[]
  names: string[]
  globals: Map<string, Value>
}
export const emptyContext: Context = judging.emptyContext() as Context

// build a context whose signature postulates each named constant at the given (closed) type term
export function contextWithSignature(signature: { name: string; type: Term }[]): Context {
  return kernel(() => judging.contextWithSignature(state, signature as never) as Context)
}

export function bind(context: Context, mult: Mult, type: Value, name = ''): Context {
  return judging.bindContext(context as never, mult, type as never, name) as Context
}

type Inferred = { type: Value; usage: Mult[] }

export function infer(context: Context, term: Term): Inferred {
  return kernel(() => judging.infer(state, context as never, term as never) as Inferred)
}

export function check(context: Context, term: Term, expected: Value): Mult[] {
  return kernel(() => judging.check(state, context as never, term as never, expected as never) as Mult[])
}

// A term as a person reads it: a variable by the name the source gave it, a binder the term opens by a fresh name.
// The kernel errors print through this. `showTerm` is the exact form.
export function showNamed(term: Term, names: string[] = []): string {
  return judging.showNamed(term as never, names)
}

export function showTerm(term: Term): string {
  return judging.showTerm(term as never)
}

// instantiate a level-polymorphic term: replace a level variable with a concrete level throughout
export function instantiateLevel(term: Term, name: string, replacement: Level): Term {
  return judging.instantiateLevel(term as never, name, replacement) as Term
}

// public helper: check a closed term against a closed type
export function checks(term: Term, type: Term): boolean {
  return kernel(() => judging.checks(state, term as never, type as never))
}
