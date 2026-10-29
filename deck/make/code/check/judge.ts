// The dependent type core: a bidirectional type checker by normalization-by-evaluation (universe-polymorphic levels,
// quantities 0 / 1 / many, an identity type whose function extensionality computes, dependent pairs, self types), see
// note/project/term/archive/computation/plans/12-type-systems.md. Browser-safe, no host APIs.
//
// THE FACE (item term-self-host-001-0072). The kernel is Term, check/judging.tree, and a call into it runs through
// check/judge-call.tree, which puts the unfold fuel back when the call raises. This face holds the one `judge-state`
// (spec 4.8, until the driver is Term), the names callers import, and the error classes: a kernel error comes back as
// the raise itself, thrown again as this module's `TypeError` or a plain `Error`. Before: tmp/retired/make/check/judge-face.ts.

import * as judging from '@term/make/code/check/judging'
import * as judgeCall from '@term/make/code/check/judge-call'

// universe levels, max(constant, max over (variable + offset)), and multiplicities, the {0, 1, ω} semiring
export type Level = { constant: number; vars: Map<string, number> }
export type Mult = 0 | 1 | 'many'

// ---- terms (de Bruijn indices). A lam's `name` is read only to print an error ----
export type Term =
  | { tag: 'var'; index: number }
  | { tag: 'meta'; id: number }
  | { tag: 'const'; name: string }
  | { tag: 'type'; level: Level }
  | { tag: 'pi'; mult: Mult; domain: Term; codomain: Term }
  | { tag: 'lam'; body: Term; name?: string }
  | { tag: 'app'; fun: Term; arg: Term }
  | { tag: 'ann'; term: Term; type: Term }
  | { tag: 'id'; type: Term; left: Term; right: Term }
  | { tag: 'refl'; type: Term; value: Term }
  | { tag: 'j'; proof: Term; motive: Term; base: Term; level: Level }
  | { tag: 'sigma'; mult: Mult; domain: Term; codomain: Term }
  | { tag: 'pair'; first: Term; second: Term }
  | { tag: 'fst'; pair: Term }
  | { tag: 'snd'; pair: Term }
  | { tag: 'self'; body: Term }

type Closure = judging.KernelClosure // values (normal forms): a closure is the kernel's own, read through `closeOver`
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
  | { v: 'rigid'; name: string; spine: Elim[] }
  | { v: 'flex'; id: number; spine: Elim[] }
  | { v: 'id'; type: Value; left: Value; right: Value }
  | { v: 'refl'; type: Value; value: Value }
  | { v: 'sigma'; mult: Mult; domain: Value; codomain: Closure }
  | { v: 'pair'; first: Value; second: Value }
  | { v: 'self'; body: Closure }

// ---- context: `globals` is the signature, `names` what the source called each bound variable ('' for none) ----
export type Context = {
  level: number
  env: Value[]
  types: Value[]
  mults: Mult[]
  names: string[]
  globals: Map<string, Value>
}
type Inferred = { type: Value; usage: Mult[] }

const state = judging.newState()

export class TypeError extends Error {}

// the raise judge-call handed back, as the original's class: the same object, given the class and the message without
// its prefix, never a second one built (traps.md T039)
function thrown(out: {
  raised: unknown
  kind: string
  message: string
}): unknown {
  if (out.kind === '') {
    return out.raised
  }

  const error = out.raised as Error
  Object.setPrototypeOf(
    error,
    out.kind === 'type' ? TypeError.prototype : Error.prototype,
  )
  error.message = out.message
  delete (error as { name?: string }).name

  return error
}

// a call into the kernel: on a raise the fuel is what it was at the call, and the error is the original's class
export function kernel<T>(call: () => T): T {
  const out = judgeCall.runInKernel(state, call)

  if (out.form === 'judge-done') {
    return out.value as T
  }

  throw thrown(out)
}

// the one state, for a Term caller that calls the kernel itself (check/elaborating-cases.tree and the elaborator's other
// parts), which then reaches TypeScript through `kernel` like any call here
export const judgeState = (): judging.JudgeState => state

export const litLevel = (n: number): Level => judging.litLevel(n)
export const varLevel = (name: string): Level => judging.varLevel(name)
export const succLevel = (level: Level): Level =>
  judging.succLevel(level)
export const maxLevel = (a: Level, b: Level): Level =>
  judging.maxLevel(a, b)
// the universe a Pi inhabits: impredicative at the bottom (literally Type 0), predicative above
export const piLevel = (
  domainLevel: Level,
  codomainLevel: Level,
): Level => judging.piLevel(domainLevel, codomainLevel)
export const eqLevel = (a: Level, b: Level): boolean =>
  judging.eqLevel(a, b)
export const neutralVar = (level: number): Value =>
  judging.neutralVar(level) as Value

// transparent definitions (delta reduction), truncations WITH their arity, the circle's computation rules
export const defineConstant = (name: string, value: Value): void =>
  judging.defineConstant(state, name, value as never)
export const registerTruncation = (name: string, arity: number): void =>
  judging.registerTruncation(state, name, arity)
export const isTruncationConstructor = (name: string): boolean =>
  judging.isTruncationConstructor(state, name)
export const enableCircle = (): void => judging.enableCircle(state)
export const resetDefinitions = (): void =>
  judging.resetDefinitions(state)

export const freshMeta = (type: Value): Term =>
  judging.freshMeta(state, type as never) as Term
export const resetMetas = (): void => judging.resetMetas(state)

export const whnf = (value: Value): Value =>
  kernel(() => judging.whnf(state, value as never) as Value)
export const evaluate = (env: Value[], term: Term): Value =>
  kernel(
    () => judging.evaluate(state, env as never, term as never) as Value,
  )
export const closeOver = (closure: Closure, value: Value): Value =>
  kernel(
    () => judging.closeOver(state, closure, value as never) as Value,
  )
export const applyValue = (fun: Value, arg: Value): Value =>
  kernel(
    () =>
      judging.applyValue(state, fun as never, arg as never) as Value,
  )

// A NORMAL FORM TO REWRITE IN: every transparent definition unfolded, except a constant in `opaque` and a call whose
// unfolding only gets stuck, which stay as written
export function normalTerm(
  level: number,
  value: Value,
  opaque: ReadonlySet<string>,
  depth = 0,
): Term {
  return kernel(
    () =>
      judging.normalTerm(
        state,
        level,
        value as never,
        name => opaque.has(name),
        depth,
      ) as Term,
  )
}

export const quote = (level: number, value: Value): Term =>
  kernel(() => judging.quote(state, level, value as never) as Term)

// definitional equality, and equality in the theory extended by the given (induction-) hypothesis equalities
export const areConvertible = (
  level: number,
  a: Value,
  b: Value,
): boolean =>
  kernel(() =>
    judging.areConvertible(state, level, a as never, b as never),
  )
export const convertibleModulo = (
  level: number,
  a: Value,
  b: Value,
  hypotheses: [Value, Value][],
): boolean =>
  kernel(() =>
    judging.convertibleModulo(
      state,
      level,
      a as never,
      b as never,
      hypotheses as never,
    ),
  )

export const emptyContext: Context = judging.emptyContext() as Context

// a context whose signature postulates each named constant at the given (closed) type term
export const contextWithSignature = (
  signature: { name: string; type: Term }[],
): Context =>
  kernel(
    () =>
      judging.contextWithSignature(
        state,
        signature as never,
      ) as Context,
  )
export const bind = (
  context: Context,
  mult: Mult,
  type: Value,
  name = '',
): Context =>
  judging.bindContext(
    context as never,
    mult,
    type as never,
    name,
  ) as Context

export const infer = (context: Context, term: Term): Inferred =>
  kernel(
    () =>
      judging.infer(state, context as never, term as never) as Inferred,
  )
export const check = (
  context: Context,
  term: Term,
  expected: Value,
): Mult[] =>
  kernel(
    () =>
      judging.check(
        state,
        context as never,
        term as never,
        expected as never,
      ) as Mult[],
  )

// a term as a person reads it (a variable by its source name, a binder by a fresh one), and the exact form
export const showNamed = (term: Term, names: string[] = []): string =>
  judging.showNamed(term as never, names)
export const showTerm = (term: Term): string =>
  judging.showTerm(term as never)

// replace a level variable with a concrete level throughout a level-polymorphic term
export const instantiateLevel = (
  term: Term,
  name: string,
  replacement: Level,
): Term =>
  judging.instantiateLevel(term as never, name, replacement) as Term

// check a closed term against a closed type
export const checks = (term: Term, type: Term): boolean =>
  kernel(() => judging.checks(state, term as never, type as never))
