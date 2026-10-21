// THE SECOND CHECKER'S INPUT: every claim the kernel checked as one term, written out as Lean 4 source, so the proof is
// re-checked by a kernel that shares no code with Term's (note/project/term/proof/lean-export/spec.md).
//
// A prototype (2026-10-20). It runs the front end the build runs up to the kernel (parse, mill, resolve, the claim fill,
// the declared types, the surface check), elaborates, and reads back what elaboration left in the judge state: a pure,
// terminating task the kernel proved is registered as a transparent definition (check/elaborating-main.tree
// `check-task`), so its value quoted back IS the term the kernel checked. Its type is the one the kernel checked it
// against (check/elaborating-data.tree `function-type`). Nothing here decides whether a proof is right: Lean does.
//
// The translation, in short (the spec has the whole of it):
//   - Term's `Type n` is Lean's `Type n`. Term's Type 0 is impredicative and Lean's `Type` is not, so a proof that
//     needed the impredicativity is refused by Lean (a false refusal, never a false acceptance)
//   - every form is a Lean `inductive`: its type heads are parameters, its value heads indices, its cases constructors.
//     A record (fields, no cases) has one constructor `make`, and the kernel's `Unit` one constructor `unitValue`
//   - `match__T` and `matchType__T` (the eliminators the self-type encoding gives each form) are defined by Lean's
//     `T.casesOn`, so Lean checks that the eliminator Term postulates is the one the inductive has. The motive's sort is
//     a universe variable, Lean's reading of Term's cumulative universes
//   - a task that calls itself inside a match on one of its parameters is rewritten to `T.rec`, as Lean's equation
//     compiler would: its calls on the matched value's fields become the induction hypotheses, and a parameter the
//     calls change is generalized in the motive, so Lean's kernel checks a term with no recursion in it
//   - multiplicities are dropped: Lean re-checks the types, never the usage
//   - a constant with no definition (a primitive, a task the kernel did not keep) is an `axiom`, and every one is
//     reported, since a claim resting on one is not fully re-checked
//
// It refuses, naming the reason, any term holding the built-in identity type, sigma, a self type or an unsolved
// metavariable: none of the stdlib's claims do, and each needs a translation decided first (the spec's open list).

import { parse } from '@term/make/code/parser/tree'
import type { Node } from '@term/make/code/parser/tree'
import { headWord } from '@term/make/code/compile/mill-run'
import { expandTemplates } from '@term/make/code/compile/template'
import { mill } from '@term/make/code/compile/mill'
import { resolve } from '@term/make/code/check/resolve'
import { check } from '@term/make/code/check/infer'
import { fillClaims } from '@term/make/code/check/claim'
import { elaborateReport } from '@term/make/code/check/elaborate'
import { transparentAliases } from '@term/make/code/check/alias'
import * as elaborating from '@term/make/code/check/elaborating-data'
import type { Level, Term } from '@term/make/code/check/judge'
import { judgeState, quote } from '@term/make/code/check/judge'
import type { Program } from '@term/make/code/compile/node'

// the namespace every exported name lives in, so no Term name meets one of Lean's own (`absurd`, `Eq`, `not`)
const SPACE = 'TermExport'

export type LeanSource = { file: string; text: string }

// one exported definition: its Term name, whether it is a claim (a `rule` with no `show`), and the axioms it rests on
export type LeanEntry = { name: string; claim: boolean; axioms: string[] }

export type LeanExport = {
  // the Lean 4 source, ready for `lean <file>`
  lean: string
  // every claim of the source, in order
  claims: string[]
  // what was written: claims and the definitions they reach
  exported: LeanEntry[]
  // a claim or definition left out, with the reason
  refused: { name: string; reason: string }[]
  // every constant written as an axiom
  axioms: string[]
  // what the kernel itself said about the source
  kernel: { proven: string[]; declined: { name: string; reason: string }[]; diagnostics: string[] }
  // the kernel's own terms, for a caller that re-checks them (the test does, with the judge)
  terms: Map<string, { type: Term; value: Term }>
  signature: { name: string; type: Term }[]
}

// thrown where a term cannot be written in Lean yet. Caught per definition and reported, never a crash
class Refuse extends Error {}

// ---- a named copy of a kernel term: each binder gets a name of its own, unique in the export, so substituting one
// term into another can never capture ----
type Named =
  | { k: 'var'; name: string }
  | { k: 'const'; name: string }
  | { k: 'type'; level: Level }
  | { k: 'pi'; name: string; domain: Named; codomain: Named }
  | { k: 'lam'; name: string; body: Named }
  | { k: 'app'; fun: Named; arg: Named }
  | { k: 'ann'; term: Named; type: Named }

class Names {
  private count = 0

  fresh(hint = 'x'): string {
    const base = hint.replace(/[^A-Za-z0-9]/g, '_').replace(/^[^A-Za-z]+/, '') || 'x'
    this.count++
    return `${base}_${this.count}`
  }
}

// a kernel term (de Bruijn indices) as a named one. `env` names the binders in scope, innermost last
function named(term: Term, env: string[], names: Names): Named {
  switch (term.tag) {
    case 'var': {
      const name = env[env.length - 1 - term.index]
      if (name === undefined) {
        throw new Refuse(`a variable out of scope (#${term.index})`)
      }
      return { k: 'var', name }
    }
    case 'const':
      return { k: 'const', name: term.name }
    case 'type':
      return { k: 'type', level: term.level }
    case 'pi': {
      const name = names.fresh()
      return { k: 'pi', name, domain: named(term.domain, env, names), codomain: named(term.codomain, [...env, name], names) }
    }
    case 'lam': {
      const name = names.fresh(term.name)
      return { k: 'lam', name, body: named(term.body, [...env, name], names) }
    }
    case 'app':
      return { k: 'app', fun: named(term.fun, env, names), arg: named(term.arg, env, names) }
    case 'ann':
      return { k: 'ann', term: named(term.term, env, names), type: named(term.type, env, names) }
    case 'meta':
      throw new Refuse('an unsolved metavariable')
    case 'id':
    case 'refl':
    case 'j':
      throw new Refuse(`the built-in identity type (${term.tag}), whose Lean reading is not decided`)
    case 'sigma':
    case 'pair':
    case 'fst':
    case 'snd':
      throw new Refuse(`a built-in sigma (${term.tag}), whose Lean reading is not decided`)
    case 'self':
      throw new Refuse('a self type, which Lean has no reading of')
  }
}

// peel up to `count` leading pis of a type, naming each binder by `hints` where given
function peelPis(type: Term, count: number, hints: string[], names: Names): { binders: { name: string; domain: Named }[]; rest: Named; env: string[] } {
  const binders: { name: string; domain: Named }[] = []
  const env: string[] = []
  let at = type

  while (binders.length < count && at.tag === 'pi') {
    const name = names.fresh(hints[binders.length])
    binders.push({ name, domain: named(at.domain, env, names) })
    env.push(name)
    at = at.codomain
  }

  return { binders, rest: named(at, env, names), env }
}

// peel the leading lambdas of a value onto names already given to its type's binders
function peelLams(value: Term, env: string[]): { body: Term; bound: string[] } {
  let at = value
  const bound: string[] = []

  while (bound.length < env.length && at.tag === 'lam') {
    bound.push(env[bound.length]!)
    at = at.body
  }

  return { body: at, bound }
}

function spine(term: Named): { head: Named; args: Named[] } {
  const args: Named[] = []
  let at = term

  while (at.k === 'app') {
    args.unshift(at.arg)
    at = at.fun
  }

  return { head: at, args }
}

function applyAll(head: Named, args: Named[]): Named {
  return args.reduce<Named>((fun, arg) => ({ k: 'app', fun, arg }), head)
}

// replace free names. Every binder name is unique in the export, so no binder can capture a replacement
function substitute(term: Named, map: Map<string, Named>): Named {
  switch (term.k) {
    case 'var':
      return map.get(term.name) ?? term
    case 'const':
    case 'type':
      return term
    case 'pi':
      return { ...term, domain: substitute(term.domain, map), codomain: substitute(term.codomain, map) }
    case 'lam':
      return { ...term, body: substitute(term.body, map) }
    case 'app':
      return { k: 'app', fun: substitute(term.fun, map), arg: substitute(term.arg, map) }
    case 'ann':
      return { k: 'ann', term: substitute(term.term, map), type: substitute(term.type, map) }
  }
}

// whether a term names a variable
function mentions(term: Named, name: string): boolean {
  switch (term.k) {
    case 'var':
      return term.name === name
    case 'const':
    case 'type':
      return false
    case 'pi':
      return mentions(term.domain, name) || mentions(term.codomain, name)
    case 'lam':
      return mentions(term.body, name)
    case 'app':
      return mentions(term.fun, name) || mentions(term.arg, name)
    case 'ann':
      return mentions(term.term, name) || mentions(term.type, name)
  }
}

// AN ELIMINATOR'S MOTIVE TARGETS ANY UNIVERSE. Term's universes are cumulative (judge.ts: `Type 0` is a `Type 1`), so a
// motive `T -> Type 1` (the large eliminator `matchType__T`) also takes a motive into `Type 0`, which every dependent
// match on a form with no indices is. Lean has no cumulativity, so the motive's sort is a universe variable: the
// eliminator is defined once for every universe, and Lean checks the definition at all of them
const MOTIVE_LEVEL: Level = { constant: 0, vars: new Map([['motive', 0]]) }

function anySort(domain: Named): Named {
  switch (domain.k) {
    case 'pi':
      return { ...domain, codomain: anySort(domain.codomain) }
    case 'type':
      return { k: 'type', level: MOTIVE_LEVEL }
    default:
      return domain
  }
}

// a function applied to variables, its leading lambdas reduced: `(fun a b => M) x y` is `M[a := x, b := y]`. The
// arguments are variables, so substituting never copies a binder
function beta(fun: Named, args: Named[]): Named {
  let at = fun
  let used = 0
  const map = new Map<string, Named>()

  while (at.k === 'lam' && used < args.length) {
    map.set(at.name, args[used]!)
    at = at.body
    used++
  }

  return applyAll(substitute(at, map), args.slice(used))
}

function constants(term: Named, into: Set<string>): Set<string> {
  switch (term.k) {
    case 'const':
      into.add(term.name)
      break
    case 'pi':
      constants(term.domain, into)
      constants(term.codomain, into)
      break
    case 'lam':
      constants(term.body, into)
      break
    case 'app':
      constants(term.fun, into)
      constants(term.arg, into)
      break
    case 'ann':
      constants(term.term, into)
      constants(term.type, into)
      break
    default:
      break
  }

  return into
}

function sameNamed(a: Named, b: Named, renaming: Map<string, string> = new Map()): boolean {
  if (a.k !== b.k) {
    return false
  }

  switch (a.k) {
    case 'var':
      return (renaming.get(a.name) ?? a.name) === (b as { name: string }).name
    case 'const':
      return a.name === (b as { name: string }).name
    case 'type':
      return levelText(a.level) === levelText((b as { level: Level }).level)
    case 'pi': {
      const other = b as Extract<Named, { k: 'pi' }>
      return sameNamed(a.domain, other.domain, renaming) && sameNamed(a.codomain, other.codomain, new Map([...renaming, [a.name, other.name]]))
    }
    case 'lam': {
      const other = b as Extract<Named, { k: 'lam' }>
      return sameNamed(a.body, other.body, new Map([...renaming, [a.name, other.name]]))
    }
    case 'app': {
      const other = b as Extract<Named, { k: 'app' }>
      return sameNamed(a.fun, other.fun, renaming) && sameNamed(a.arg, other.arg, renaming)
    }
    case 'ann': {
      const other = b as Extract<Named, { k: 'ann' }>
      return sameNamed(a.term, other.term, renaming) && sameNamed(a.type, other.type, renaming)
    }
  }
}

// ---- printing ----

function levelVars(level: Level): [string, number][] {
  const vars = level.vars as unknown

  if (vars instanceof Map) {
    return [...(vars as Map<string, number>).entries()]
  }

  return Object.entries((vars ?? {}) as Record<string, number>)
}

function universeName(name: string): string {
  return `u_${name.replace(/[^A-Za-z0-9]/g, '_')}`
}

// Term's `Type n` is Lean's `Type n` (Sort (n+1)); a level over variables is Lean's `max` of the same parts
function levelText(level: Level): string {
  const parts = levelVars(level).map(([name, offset]) => (offset === 0 ? universeName(name) : `${universeName(name)}+${offset}`))

  if (parts.length === 0) {
    return String(level.constant)
  }

  const all = level.constant > 0 ? [String(level.constant), ...parts] : parts

  return all.reduce((left, right) => `max (${left}) (${right})`)
}

function quoteName(part: string): string {
  return `«${part.replace(/[«»]/g, '_')}»`
}

class Printer {
  constructor(private readonly constName: (name: string) => string) {}

  print(term: Named): string {
    switch (term.k) {
      case 'var':
        return term.name
      case 'const':
        return this.constName(term.name)
      case 'type': {
        const text = levelText(term.level)
        return text === '0' ? 'Type' : /^\d+$/.test(text) ? `Type ${text}` : `Type (${text})`
      }
      case 'pi':
        return `((${term.name} : ${this.print(term.domain)}) → ${this.print(term.codomain)})`
      case 'lam':
        return `(fun ${term.name} => ${this.print(term.body)})`
      case 'app': {
        // one flat spine: `(@T.casesOn a b c)`, never `((@T.casesOn a) b)`, where Lean would insert the implicit
        // arguments `@` turned off after the first
        const { head, args } = spine(term)
        return `(${this.print(head)} ${args.map(arg => this.print(arg)).join(' ')})`
      }
      case 'ann':
        return `(${this.print(term.term)} : ${this.print(term.type)})`
    }
  }
}

// ---- the front end, as the build runs it up to the kernel (compile/compile.ts, from the parse to `elaborateReport`)
// ----

function frontEnd(source: LeanSource): { program: Program; claims: string[] } {
  const parsed = parse({ file: source.file, text: source.text })

  if (!parsed.ok) {
    throw new Error(`parse failed: ${parsed.diagnostics.map(d => d.message).join('; ')}`)
  }

  const built = mill(expandTemplates(parsed.tree), source.file)

  if (!built.ok) {
    throw new Error(`mill failed: ${built.diagnostics.map(d => d.message).join('; ')}`)
  }

  resolve(built.program, source.file)

  const claims = built.program.flatMap(s => (s.form === 'function' && s.claim === true && !s.theorem ? [s.name] : []))
  const program = fillClaims(built.program as never) as unknown as Program

  for (const statement of program) {
    if (statement.form === 'function') {
      statement.declared = {
        params: statement.params.map(p => (p.type ? { type: structuredClone(p.type) } : {})),
        ...(statement.result ? { result: structuredClone(statement.result) } : {}),
      }
    }
  }

  check(program, source.file)

  return { program, claims: [...new Set(claims)] }
}

type Data = {
  signature: { name: string; type: Term }[]
  functionType: Map<string, Term>
  enumDefs: { name: string; term: Term }[]
  variantNames: Map<string, string[]>
  typeFormerArity: Map<string, number>
  // a form with no cases, a record: its fields in order. Its constructor is `make__R`, its projections `R__field`
  recordFields: Map<string, string[]>
}

// one case of a form: its name in Lean, and the constant Term gives its constructor
type Case = { variant: string; key: string }

// ---- the export ----

export function exportLean(source: LeanSource): LeanExport {
  const { program, claims } = frontEnd(source)

  // the kernel's reading of the program's types, the same one elaboration builds for itself (pure in the program)
  const data = elaborating.elaborationDataOf(
    structuredClone(program) as never,
    elaborating.newAliasState(transparentAliases(program)),
    [],
    () => false,
  ) as unknown as Data

  const report = elaborateReport(program, source.file)
  const definitions = (judgeState() as unknown as { definition: Map<string, unknown> }).definition

  // the signature, the last entry of a name winning as it does in the kernel's context
  const signature = new Map<string, Term>()

  for (const entry of data.signature) {
    signature.set(entry.name, entry.type)
  }

  // EVERY FORM IS AN INDUCTIVE, whatever its number of cases: a form with cases has one constructor per case, a record
  // (a form with fields and no cases, `form person / link id ...`) one constructor `make` taking its fields, and the
  // kernel's own unit type (`Unit`, postulated with its one value `unitValue`) one constructor with no fields. So no
  // form reaches Lean as an axiom
  const cases = new Map<string, Case[]>()

  for (const [form, variants] of data.variantNames) {
    cases.set(form, variants.map(variant => ({ variant, key: `${form}__${variant}` })))
  }

  // a record's projections, `R__field`, each defined by the record's `casesOn`
  const projections = new Map<string, { form: string; index: number; count: number }>()

  for (const [form, fields] of data.recordFields ?? new Map<string, string[]>()) {
    if (!cases.has(form) && signature.has(`make__${form}`)) {
      cases.set(form, [{ variant: 'make', key: `make__${form}` }])
      fields.forEach((field, index) => projections.set(`${form}__${field}`, { form, index, count: fields.length }))
    }
  }

  if (!cases.has('Unit') && signature.has('Unit') && signature.has('unitValue')) {
    cases.set('Unit', [{ variant: 'unitValue', key: 'unitValue' }])
  }

  // THE KERNEL'S LIST is an inductive too: `Array A` with `arrayEmpty` and `arrayPush` (the element at the end), and its
  // eliminator `arrayElim` is that inductive's `Array.rec`, minor for minor, so the rule the kernel computes by
  // (check/judging.tree `reduce-array`) is the one Lean's recursor has, and no list reaches Lean as an axiom
  const ARRAY_ARITY = 1

  if (!cases.has('Array') && signature.has('Array') && signature.has('arrayEmpty') && signature.has('arrayPush')) {
    cases.set('Array', [
      { variant: 'arrayEmpty', key: 'arrayEmpty' },
      { variant: 'arrayPush', key: 'arrayPush' },
    ])
  }

  const formArity = (form: string): number =>
    form === 'Array' && !data.typeFormerArity.has(form) ? ARRAY_ARITY : (data.typeFormerArity.get(form) ?? 0)

  const constructors = new Map<string, { form: string; variant: string }>()

  for (const [form, list] of cases) {
    for (const one of list) {
      constructors.set(one.key, { form, variant: one.variant })
    }
  }

  const eliminators = new Map<string, string>()

  for (const form of data.variantNames.keys()) {
    eliminators.set(`match__${form}`, form)
    eliminators.set(`matchType__${form}`, form)
  }

  const enumDefs = new Map(data.enumDefs.map(entry => [entry.name, entry.term]))
  const proven = new Set(report.proven)
  const names = new Names()
  const terms = new Map<string, { type: Term; value: Term }>()
  const paramHints = new Map<string, string[]>()

  for (const statement of program) {
    if (statement.form === 'function') {
      paramHints.set(statement.name, [...statement.generics.map(g => g.name), ...statement.params.map(p => p.name)])
    }
  }

  const constName = (name: string): string => {
    // a form's own recursor and case split, which the export names `<form>.rec` and `<form>.casesOn`, applied with
    // every argument explicit
    const recursor = /^(.*)\.(rec|casesOn)$/.exec(name)

    if (recursor && cases.has(recursor[1]!)) {
      return `@${SPACE}.${quoteName(recursor[1]!)}.${recursor[2]}`
    }

    const constructor = constructors.get(name)

    // with `@`: a Lean constructor takes its form's parameters implicitly, and Term's takes them first and explicitly
    if (constructor) {
      return `@${SPACE}.${quoteName(constructor.form)}.${quoteName(constructor.variant)}`
    }

    return `${SPACE}.${quoteName(name)}`
  }

  const printer = new Printer(constName)
  const blocks = new Map<string, string>()
  const order: string[] = []
  const refused = new Map<string, string>()
  const axioms = new Set<string>()
  const reaches = new Map<string, Set<string>>()
  const visiting = new Set<string>()
  const universes = new Set<string>()

  const noteUniverses = (term: Named): void => {
    if (term.k === 'type') {
      for (const [name] of levelVars(term.level)) universes.add(universeName(name))
    } else if (term.k === 'pi') {
      noteUniverses(term.domain)
      noteUniverses(term.codomain)
    } else if (term.k === 'lam') {
      noteUniverses(term.body)
    } else if (term.k === 'app') {
      noteUniverses(term.fun)
      noteUniverses(term.arg)
    } else if (term.k === 'ann') {
      noteUniverses(term.term)
      noteUniverses(term.type)
    }
  }

  // an eliminator read from its definition: `fun xs => major motive minors...`, the self-type encoding's shape, with
  // the major's parameters and indices read from the eliminator's type. All under one set of binder names
  type Eliminator = {
    form: string
    binders: { name: string; domain: Named }[]
    result: Named
    major: string
    params: Named[]
    indices: Named[]
    motive: Named
    minors: Named[]
  }
  const eliminatorCache = new Map<string, Eliminator>()

  const readEliminator = (name: string): Eliminator => {
    const cached = eliminatorCache.get(name)

    if (cached) {
      return cached
    }

    const form = eliminators.get(name)!
    const type = signature.get(name)
    const value = enumDefs.get(name)

    if (!type || !value) {
      throw new Refuse(`the eliminator ${name} has no type or no definition`)
    }

    const { binders, rest, env } = peelPis(type, Number.MAX_SAFE_INTEGER, [], names)
    const { body, bound } = peelLams(value, env)

    if (bound.length !== binders.length) {
      throw new Refuse(`the eliminator ${name} takes ${bound.length} arguments where its type has ${binders.length}`)
    }

    const shape = spine(named(body, bound, names))

    if (shape.head.k !== 'var' || shape.args.length < 1) {
      throw new Refuse(`the eliminator ${name} is not a match on one of its arguments`)
    }

    const major = shape.head.name
    const majorBinder = binders.find(binder => binder.name === major)!
    const typed = spine(majorBinder.domain)

    if (typed.head.k !== 'const' || typed.head.name !== form) {
      throw new Refuse(`the eliminator ${name} matches a value that is not a ${form}`)
    }

    const arity = formArity(form)
    const read: Eliminator = {
      form,
      binders,
      result: rest,
      major,
      params: typed.args.slice(0, arity),
      indices: typed.args.slice(arity),
      motive: shape.args[0]!,
      minors: shape.args.slice(1),
    }
    eliminatorCache.set(name, read)

    return read
  }

  const binderText = (binders: { name: string; domain: Named }[]): string =>
    binders.map(binder => ` (${binder.name} : ${printer.print(binder.domain)})`).join('')

  // write one constant and, first, everything it reaches. Returns false when it could not be written
  const emit = (name: string): boolean => {
    if (blocks.has(name)) {
      return true
    }

    if (refused.has(name)) {
      return false
    }

    if (visiting.has(name)) {
      throw new Refuse(`${name} is reached through itself by another definition (mutual recursion)`)
    }

    visiting.add(name)

    try {
      const constructor = constructors.get(name)

      if (constructor) {
        return emit(constructor.form)
      }

      if (cases.has(name)) {
        emitForm(name)
      } else if (projections.has(name)) {
        emitProjection(name)
      } else if (eliminators.has(name) && enumDefs.has(name)) {
        emitEliminator(name)
      } else if (name === 'arrayElim' && cases.has('Array')) {
        emitArrayEliminator(name)
      } else if (proven.has(name) && definitions.has(name) && data.functionType.has(name)) {
        emitTask(name)
      } else {
        emitAxiom(name)
      }

      order.push(name)

      return true
    } catch (error) {
      if (error instanceof Refuse) {
        refused.set(name, error.message)
        return false
      }

      throw error
    } finally {
      visiting.delete(name)
    }
  }

  const needAll = (name: string, used: Set<string>): void => {
    const set = reaches.get(name) ?? new Set<string>()

    for (const other of used) {
      if (other === name) {
        continue
      }

      const owner = constructors.get(other)?.form ?? other

      if (owner === name) {
        continue
      }

      if (!emit(owner)) {
        throw new Refuse(`it reaches ${owner}, which was refused: ${refused.get(owner)}`)
      }

      set.add(owner)
    }

    reaches.set(name, set)
  }

  // a form as a Lean inductive: the first `arity` binders of the type former are parameters, which every constructor
  // takes first and passes through unchanged (Lean's own rule for a parameter)
  const emitForm = (form: string): void => {
    const formerType = signature.get(form)

    if (!formerType) {
      throw new Refuse(`the form ${form} has no type former in the signature`)
    }

    const arity = formArity(form)
    const former = peelPis(formerType, arity, [], names)

    if (former.binders.length !== arity) {
      throw new Refuse(`the form ${form} has ${former.binders.length} parameters where ${arity} were expected`)
    }

    const used = constants(former.rest, new Set())
    former.binders.forEach(binder => constants(binder.domain, used))
    noteUniverses(former.rest)
    const lines: string[] = []

    for (const { variant, key } of cases.get(form) ?? []) {
      const ctorType = signature.get(key)

      if (!ctorType) {
        throw new Refuse(`the case ${variant} of ${form} has no constructor in the signature`)
      }

      // the constructor's leading binders are the form's parameters, bound to the same names
      let at = ctorType
      const env: string[] = []

      for (const binder of former.binders) {
        if (at.tag !== 'pi' || !sameNamed(named(at.domain, env, names), binder.domain)) {
          throw new Refuse(`the case ${variant} of ${form} does not take the form's parameters first`)
        }

        env.push(binder.name)
        at = at.codomain
      }

      const rest = named(at, env, names)
      let result = rest

      while (result.k === 'pi') {
        result = result.codomain
      }

      const shape = spine(result)
      const passes = former.binders.every((binder, i) => {
        const arg = shape.args[i]
        return arg?.k === 'var' && arg.name === binder.name
      })

      if (shape.head.k !== 'const' || shape.head.name !== form || !passes) {
        throw new Refuse(`the case ${variant} of ${form} does not build a ${form} of its own parameters`)
      }

      constants(rest, used)
      noteUniverses(rest)
      lines.push(`  | ${quoteName(variant)} : ${printer.print(rest)}`)
    }

    used.delete(form)
    needAll(form, used)
    blocks.set(
      form,
      [`inductive ${constName(form)}${binderText(former.binders)} : ${printer.print(former.rest)} where`, ...lines].join('\n'),
    )
  }

  // `match__T` by Lean's `T.casesOn`: parameters, motive, indices, the major, then one minor per case. Lean checks the
  // definition against the type Term gave the eliminator, so a wrong eliminator type is refused there
  const emitEliminator = (name: string): void => {
    const read = readEliminator(name)
    const binders = read.binders.map(binder =>
      read.motive.k === 'var' && binder.name === read.motive.name ? { ...binder, domain: anySort(binder.domain) } : binder,
    )
    const body = applyAll({ k: 'const', name: `${read.form}.casesOn` }, [
      ...read.params,
      read.motive,
      ...read.indices,
      { k: 'var', name: read.major },
      ...read.minors,
    ])
    const used = constants(body, new Set())
    binders.forEach(binder => constants(binder.domain, used))
    constants(read.result, used)
    used.delete(`${read.form}.casesOn`)
    used.add(read.form)
    needAll(name, used)
    binders.forEach(binder => noteUniverses(binder.domain))
    blocks.set(name, `def ${constName(name)}${binderText(binders)} : ${printer.print(read.result)} :=\n  ${printer.print(body)}`)
  }

  // `arrayElim` by `Array.rec`: the element type, the motive, the two minors and the list, in the order both take them.
  // Lean checks the definition against the type Term gives the eliminator, so a wrong rule is refused there
  const emitArrayEliminator = (name: string): void => {
    const type = signature.get(name)

    if (!type) {
      throw new Refuse(`the eliminator ${name} is in no signature`)
    }

    const { binders, rest } = peelPis(type, 5, ['A', 'motive', 'empty', 'push', 'list'], names)

    if (binders.length !== 5) {
      throw new Refuse(`the eliminator ${name} takes ${binders.length} arguments where Array.rec takes 5`)
    }

    const typed = binders.map((binder, i) => (i === 1 ? { ...binder, domain: anySort(binder.domain) } : binder))
    const body = applyAll(
      { k: 'const', name: 'Array.rec' },
      binders.map(binder => ({ k: 'var', name: binder.name }) as Named),
    )
    const used = constants(rest, new Set())
    typed.forEach(binder => constants(binder.domain, used))
    used.add('Array')
    needAll(name, used)
    typed.forEach(binder => noteUniverses(binder.domain))
    blocks.set(name, `def ${constName(name)}${binderText(typed)} : ${printer.print(rest)} :=\n  ${printer.print(body)}`)
  }

  // a record's projection `R__field` by `R.casesOn`, its one case returning the field. Lean checks it against the type
  // Term gives the projection
  const emitProjection = (name: string): void => {
    const { form, index, count } = projections.get(name)!
    const type = signature.get(name)

    if (!type) {
      throw new Refuse(`the projection ${name} is in no signature`)
    }

    const { binders, rest } = peelPis(type, 1, ['r'], names)

    if (binders.length !== 1) {
      throw new Refuse(`the projection ${name} does not take its record`)
    }

    const fields = Array.from({ length: count }, () => names.fresh('field'))
    const body = applyAll({ k: 'const', name: `${form}.casesOn` }, [
      { k: 'lam', name: names.fresh('m'), body: rest },
      { k: 'var', name: binders[0]!.name },
      fields.reduceRight<Named>((inner, field) => ({ k: 'lam', name: field, body: inner }), { k: 'var', name: fields[index]! }),
    ])
    const used = constants(rest, new Set())
    constants(binders[0]!.domain, used)
    used.add(form)
    needAll(name, used)
    blocks.set(name, `def ${constName(name)}${binderText(binders)} : ${printer.print(rest)} :=\n  ${printer.print(body)}`)
  }

  // a task the kernel proved: its type, its value, and when it calls itself, the call turned into `T.rec`
  const emitTask = (name: string): void => {
    const type = data.functionType.get(name)!
    const value = quote(0, definitions.get(name) as never) as Term
    terms.set(name, { type, value })
    const { binders, rest, env } = peelPis(type, Number.MAX_SAFE_INTEGER, paramHints.get(name) ?? [], names)
    const { body, bound } = peelLams(value, env)
    // binders the value does not open stay in the type: the value is then a function, written as one
    const outer = binders.slice(0, bound.length)
    const result = binders.slice(bound.length).reduceRight<Named>(
      (codomain, binder) => ({ k: 'pi', name: binder.name, domain: binder.domain, codomain }),
      rest,
    )
    let term = named(body, bound, names)

    if (constants(term, new Set()).has(name)) {
      term = recursion(name, term, outer)
    }

    const used = constants(term, new Set())
    binders.forEach(binder => constants(binder.domain, used))
    constants(rest, used)
    used.delete(name)
    // `T.rec` stands for its form
    for (const one of [...used]) {
      if (one.endsWith('.rec')) {
        used.delete(one)
        used.add(one.slice(0, -'.rec'.length))
      }
    }

    needAll(name, used)
    noteUniverses(result)
    outer.forEach(binder => noteUniverses(binder.domain))
    blocks.set(name, `def ${constName(name)}${binderText(outer)} : ${printer.print(result)} :=\n  ${printer.print(term)}`)
  }

  // A TASK THAT CALLS ITSELF, inside a match on one of its own parameters, each call on a field of the matched value:
  // structural recursion, the shape a `fold` is. Written with `T.rec` the way Lean's own equation compiler writes it,
  // so the Lean kernel checks a term with no recursion left in it and needs no termination argument:
  //   - the minor for a case takes the case's fields, then one induction hypothesis per field of the form's own type,
  //     and a call on such a field becomes that hypothesis
  //   - a parameter that is an INDEX of the matched value's family (`seen : shows s viewer v` makes s, viewer and v
  //     indices) may change in a call only to the field's own index: `T.rec` gives the hypothesis at exactly that index
  //   - any other parameter a call changes (`same(p, q)`, where b becomes q) is GENERALIZED: the motive quantifies over
  //     it, `fun idx x => (b : B) → M`, each minor takes it as a lambda, each hypothesis is applied to the call's own
  //     argument, and the recursor's result is applied to the parameter itself
  // Anything else is refused: a call on something not a field (well-founded recursion) needs a termination argument
  // the kernel's term does not carry (Term checks it beside the kernel, check/totality.ts), and never reaches Lean
  // with `partial` or a `sorry`
  const recursion = (name: string, body: Named, params: { name: string; domain: Named }[]): Named => {
    const paramNames = params.map(param => param.name)
    const shape = spine(body)

    if (shape.head.k !== 'const' || !eliminators.has(shape.head.name)) {
      throw new Refuse('it calls itself outside a match on one of its parameters')
    }

    const read = readEliminator(shape.head.name)

    if (shape.args.length < read.binders.length) {
      throw new Refuse('it calls itself in a match not applied to all of its arguments')
    }

    const map = new Map(read.binders.map((binder, i) => [binder.name, shape.args[i]!] as [string, Named]))
    // a match whose result is a function, applied on (a convoy): the arguments after the eliminator's own
    const extra = shape.args.slice(read.binders.length)
    const major = map.get(read.major)!

    if (major.k !== 'var' || !paramNames.includes(major.name)) {
      throw new Refuse('it calls itself in a match on something other than one of its parameters')
    }

    const position = paramNames.indexOf(major.name)
    const formParams = read.params.map(t => substitute(t, map))
    const indices = read.indices.map(t => substitute(t, map))
    const motive = substitute(read.motive, map)
    const variants = cases.get(read.form) ?? []
    const arity = formArity(read.form)

    if (read.minors.length !== variants.length) {
      throw new Refuse(`its match has ${read.minors.length} cases where ${read.form} has ${variants.length}`)
    }

    // the task's parameters the matched value's indices are: parameter position to index position
    const indexAt = new Map<number, number>()

    indices.forEach((index, j) => {
      const at = index.k === 'var' ? paramNames.indexOf(index.name) : -1

      if (at >= 0 && at !== position && !indexAt.has(at)) {
        indexAt.set(at, j)
      }
    })

    // each case's fields, named by its minor's own binders, with the indices of each field of the form's own type
    type Field = { name: string; recursive: boolean; indices: Named[] }
    const pieces = read.minors.map((piece, i) => {
      const ctorType = signature.get(variants[i]!.key)!
      const env: string[] = []
      const fromParams = new Map<string, Named>()
      const fields: Field[] = []
      let minor = substitute(piece, map)
      let at = ctorType
      let count = 0

      while (at.tag === 'pi') {
        if (count < arity) {
          const param = names.fresh('p')
          env.push(param)
          fromParams.set(param, formParams[count]!)
        } else {
          let field: string

          if (minor.k === 'lam') {
            field = minor.name
            minor = minor.body
          } else {
            field = names.fresh('field')
            minor = { k: 'app', fun: minor, arg: { k: 'var', name: field } }
          }

          const type = spine(substitute(named(at.domain, env, names), fromParams))
          const recursive = type.head.k === 'const' && type.head.name === read.form
          fields.push({ name: field, recursive, indices: recursive ? type.args.slice(arity) : [] })
          env.push(field)
        }

        count++
        at = at.codomain
      }

      return { fields, minor }
    })

    // the parameters a call changes, other than the matched one and its indices: these are generalized
    const varying = new Set<number>()

    const scan = (term: Named): void => {
      const call = spine(term)

      if (call.head.k === 'const' && call.head.name === name) {
        if (call.args.length !== params.length) {
          throw new Refuse(`it calls itself with ${call.args.length} arguments where it takes ${params.length}`)
        }

        call.args.forEach((arg, i) => {
          if (i !== position && !indexAt.has(i) && !(arg.k === 'var' && arg.name === paramNames[i])) {
            varying.add(i)
          }

          scan(arg)
        })
        return
      }

      switch (term.k) {
        case 'const':
          if (term.name === name) {
            throw new Refuse('it uses itself other than by a call')
          }
          return
        case 'pi':
          scan(term.domain)
          scan(term.codomain)
          return
        case 'lam':
          scan(term.body)
          return
        case 'app':
          scan(term.fun)
          scan(term.arg)
          return
        case 'ann':
          scan(term.term)
          scan(term.type)
          return
        default:
          return
      }
    }

    pieces.forEach(piece => scan(piece.minor))

    const general = [...varying].sort((a, b) => a - b)
    const generalNames = new Set(general.map(i => paramNames[i]!))

    for (const term of [...formParams, ...indices]) {
      if ([...generalNames].some(one => mentions(term, one))) {
        throw new Refuse(`a parameter its calls change is in the type of the matched value, so the motive cannot be generalized over it`)
      }
    }

    // the generalized parameters, renamed inside the motive and the minors
    const fresh = general.map(i => names.fresh(paramNames[i]))
    const rename = new Map<string, Named>(general.map((i, k) => [paramNames[i]!, { k: 'var', name: fresh[k]! }]))

    // the motive, over the indices and the matched value, quantified over the generalized parameters
    const motiveBinders = [...indices.map(() => names.fresh('i')), names.fresh('x')]
    const generalized = fresh.reduceRight<Named>(
      (inner, binder, k) => ({ k: 'pi', name: binder, domain: substitute(params[general[k]!]!.domain, rename), codomain: inner }),
      substitute(beta(motive, motiveBinders.map(binder => ({ k: 'var', name: binder }))), rename),
    )
    const newMotive = motiveBinders.reduceRight<Named>((inner, binder) => ({ k: 'lam', name: binder, body: inner }), generalized)

    const minors = pieces.map(({ fields, minor }) => {
      const hypotheses = new Map<string, { hypothesis: string; field: Field }>()

      for (const field of fields) {
        if (field.recursive) {
          hypotheses.set(field.name, { hypothesis: names.fresh('ih'), field })
        }
      }

      const replace = (term: Named): Named => {
        const call = spine(term)

        if (call.head.k === 'const' && call.head.name === name) {
          const on = call.args[position]!
          const found = on.k === 'var' ? hypotheses.get(on.name) : undefined

          if (!found) {
            throw new Refuse('it calls itself on something other than a field of the matched value (well-founded, not structural, recursion)')
          }

          for (const [i, j] of indexAt) {
            if (!sameNamed(call.args[i]!, found.field.indices[j]!)) {
              throw new Refuse(`it calls itself with an index of the matched value other than the field's own (argument ${i + 1})`)
            }
          }

          return applyAll(
            { k: 'var', name: found.hypothesis },
            general.map(i => replace(call.args[i]!)),
          )
        }

        switch (term.k) {
          case 'var':
          case 'type':
          case 'const':
            return term
          case 'pi':
            return { ...term, domain: replace(term.domain), codomain: replace(term.codomain) }
          case 'lam':
            return { ...term, body: replace(term.body) }
          case 'app':
            return { k: 'app', fun: replace(term.fun), arg: replace(term.arg) }
          case 'ann':
            return { k: 'ann', term: replace(term.term), type: replace(term.type) }
        }
      }

      const rewritten = fresh.reduceRight<Named>(
        (inner, binder) => ({ k: 'lam', name: binder, body: inner }),
        substitute(replace(minor), rename),
      )
      const binders = [...fields.map(field => field.name), ...fields.flatMap(field => (hypotheses.has(field.name) ? [hypotheses.get(field.name)!.hypothesis] : []))]

      return binders.reduceRight<Named>((inner, binder) => ({ k: 'lam', name: binder, body: inner }), rewritten)
    })

    const term = applyAll({ k: 'const', name: `${read.form}.rec` }, [
      ...formParams,
      newMotive,
      ...minors,
      ...indices,
      major,
      ...general.map(i => ({ k: 'var', name: paramNames[i]! }) as Named),
      ...extra,
    ])

    if (constants(term, new Set()).has(name)) {
      throw new Refuse('it calls itself outside the cases of its match')
    }

    return term
  }

  // a constant with no definition here: postulated, and reported
  const emitAxiom = (name: string): void => {
    const type = signature.get(name)

    if (!type) {
      throw new Refuse(`${name} is in no signature`)
    }

    const term = named(type, [], names)
    const used = constants(term, new Set())
    used.delete(name)
    needAll(name, used)
    noteUniverses(term)
    axioms.add(name)
    blocks.set(name, `axiom ${constName(name)} : ${printer.print(term)}`)
  }

  for (const claim of claims) {
    if (!proven.has(claim)) {
      const declined = report.declined.find(d => d.name === claim)
      refused.set(claim, `the kernel did not prove it${declined ? `: ${declined.reason}` : ''}`)
      continue
    }

    if (!definitions.has(claim)) {
      refused.set(claim, 'the kernel proved it but kept no term (not both pure and terminating)')
      continue
    }

    emit(claim)
  }

  // the axioms each definition rests on, transitively
  const axiomsOf = (name: string, seen = new Set<string>()): Set<string> => {
    const found = new Set<string>()

    if (seen.has(name)) {
      return found
    }

    seen.add(name)

    if (axioms.has(name)) {
      found.add(name)
    }

    for (const other of reaches.get(name) ?? []) {
      for (const axiom of axiomsOf(other, seen)) found.add(axiom)
    }

    return found
  }

  const claimSet = new Set(claims)
  const exported = order
    .filter(name => blocks.has(name) && !axioms.has(name) && (claimSet.has(name) || proven.has(name)))
    .map(name => ({ name, claim: claimSet.has(name), axioms: [...axiomsOf(name)].sort() }))

  const lean = [
    `-- Generated by deck/make/code/check/lean-export.ts from ${source.file}. Do not edit: export again.`,
    '-- Term\'s Type n is Lean\'s Type n, so a proof that used Term\'s impredicative Type 0 is refused here.',
    '-- The translation: note/project/term/proof/lean-export/spec.md',
    ...(universes.size > 0 ? [`universe ${[...universes].sort().join(' ')}`] : []),
    '',
    // Lean promotes an index that every constructor fills with its own binder (equal's first value) to a parameter,
    // which puts one more argument before the motive of `casesOn` than Term's form has. Keep the form as Term has it.
    'set_option inductive.autoPromoteIndices false',
    // a translated binder Term never reads (a motive's major premise) is not a defect: keep the run's output clean
    'set_option linter.unusedVariables false',
    '',
    'noncomputable section',
    '',
    ...order.flatMap(name => [blocks.get(name)!, '']),
    'end',
    '',
    ...exported.filter(entry => entry.claim).map(entry => `#print axioms ${constName(entry.name)}`),
    '',
  ].join('\n')

  return {
    lean,
    claims,
    exported,
    refused: [...refused].map(([name, reason]) => ({ name, reason })),
    axioms: [...axioms],
    kernel: {
      proven: report.proven,
      declined: report.declined,
      diagnostics: report.diagnostics.map(d => d.message),
    },
    terms,
    signature: data.signature,
  }
}

// a planted twin: the same export with one definition's body replaced by another term, written in the same names.
// Lean must refuse the file. The test plants a wrong proof this way
export function plantLean(lean: string, name: string, body: string): string {
  const head = `def ${SPACE}.${quoteName(name)}`
  const start = lean.indexOf(head)

  if (start < 0) {
    throw new Error(`no definition of ${name} to plant into`)
  }

  const bodyStart = lean.indexOf(':=\n', start) + ':=\n'.length
  const bodyEnd = lean.indexOf('\n\n', bodyStart)

  return `${lean.slice(0, bodyStart)}  ${body}${lean.slice(bodyEnd)}`
}

// the stdlib's files, read as one source: each file's top-level `load` groups (the line and the `find` lines under it)
// are dropped, since the files are joined into one program and every name they load is in it. Which lines a load
// covers is read off the Term tree parser (the spans its leaves carry), never off the text, so the grammar has one
// reader (note/project/term/one-parser.md). A prototype's stand-in for the build's module binding
export function joinSources(sources: LeanSource[]): LeanSource {
  const text = sources
    .map(source => {
      const parsed = parse({ file: source.file, text: source.text })

      if (!parsed.ok) {
        throw new Error(`parse failed in ${source.file}: ${parsed.diagnostics.map(d => d.message).join('; ')}`)
      }

      const dropped = new Set<number>()

      for (const node of parsed.tree.nodes) {
        if (node.kind === 'group' && headWord(node) === 'load') {
          const lines = linesOf(node)

          for (let line = Math.min(...lines); line <= Math.max(...lines); line++) {
            dropped.add(line)
          }
        }
      }

      const out = source.text.split('\n').filter((_, index) => !dropped.has(index + LINE_BASE))

      return `# ---- ${source.file}\n${out.join('\n')}`
    })
    .join('\n\n')

  return { file: sources.map(source => source.file).join(' + '), text }
}

// the parser's spans count lines from 0
const LINE_BASE = 0

// every line a parsed node's leaves and inner comments stand on. A group's own comments (the lines above it) are not
// its lines: a comment above a `load` stays, as it stood in the file
function linesOf(node: Node): number[] {
  switch (node.kind) {
    case 'group':
      return node.nodes.flatMap(child => [
        ...linesOf(child),
        ...('comments' in child ? (child.comments ?? []).flatMap(c => [c.span.start.line, c.span.end.line]) : []),
      ])
    case 'name':
    case 'text':
      return node.parts.flatMap(part => linesOf(part))
    case 'interpolation':
      return node.group ? linesOf(node.group) : []
    default:
      return [node.span.start.line, node.span.end.line]
  }
}
