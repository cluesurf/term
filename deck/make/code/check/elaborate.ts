// Elaboration: the bridge that makes the sound dependent kernel (judge.ts) the single type-checking authority.
// The surface pass (resolve + infer) is the inference front-end; here we translate the now-annotated surface AST
// into explicit kernel terms and let the KERNEL verify them. This realizes step 5 of the committed stack in
// note/research/vibe/computation/plans/12-type-systems.md: surface integration, kernel as the island of truth.
//
// Base types and primitives live IN the kernel as a signature of postulated constants, so a `Number` or `+` is a
// genuine kernel term, not a parallel notion. Everyday types thus elaborate to the quantitative dependent theory.
//
// Coverage is in two tiers. The pure functional fragment (functions, literals, arithmetic/comparison/logic, calls,
// generics with erased type witnesses, immutable let, if-as-value, records and structs via constructors and
// projections, enums via constructors and the match eliminator, arrays, recursion) elaborates to a proof-relevant
// kernel term and is registered as a transparent delta definition. The effectful fragment (mutation, loops, `match`
// with field projection, throw, hold) is type-checked as kernel commands (`checkCommands`) rather than as a single
// proof term, so it is still kernel-verified but not made transparent for downstream delta. Anything genuinely
// unrepresentable (the `map` literal, holes) cleanly declines and the surface checker covers it. The kernel is the
// authority for every function it can model; nothing is judged by two theories at once.

import type {
  Diagnostic,
  Span,
} from '@term/make/code/parser/diagnostic'
import { diagnose } from '@term/make/code/parser/diagnostic'
import { armLocals } from '@term/make/code/check/arm'
import { throughAlias, transparentAliases } from '@term/make/code/check/alias'
import * as elaborating from '@term/make/code/check/elaborating-data'
import * as rewriting from '@term/make/code/check/elaborating-rewrite'
import * as cases from '@term/make/code/check/elaborating-cases'
import * as terms from '@term/make/code/check/elaborating-terms'
import * as proofs from '@term/make/code/check/elaborating-proof'
import * as commands from '@term/make/code/check/elaborating-commands'
import * as theorems from '@term/make/code/check/elaborating-theorems'
import * as induction from '@term/make/code/check/elaborating-induction'
import type {
  Expression,
  Program,
  Proof,
  Statement,
  Type,
} from '@term/make/code/compile/node'
import type {
  Context,
  Term,
  Value,
} from '@term/make/code/check/judge'
import {
  TypeError,
  applyValue,
  areConvertible,
  bind,
  check,
  closeOver,
  contextWithSignature,
  convertibleModulo,
  defineConstant,
  registerTruncation,
  evaluate,
  freshMeta,
  infer,
  judgeState,
  kernel,
  litLevel,
  neutralVar,
  normalTerm,
  quote,
  resetDefinitions,
  resetMetas,
  showNamed,
  showTerm,
  whnf,
} from '@term/make/code/check/judge'
import { terminatingFunctions } from '@term/make/code/check/totality'
import { isLinearGoal, orderFollows } from '@term/make/code/check/holds'
import {
  ringEqual,
  ringEqualByEquations,
  ringEqualModulo,
  nonNegativeDifference,
} from '@term/make/code/check/ring'
import { checkFold, checkFoldOrder } from '@term/make/code/check/induct'
import { substitute, unfoldDefinitions } from '@term/make/code/check/unfold'
import {
  callsImpure,
  EVERYTHING,
  functionNames,
  localNames,
  pureFunctions,
  readNames,
  readsAny,
  readsState,
  rootName,
  volatileNames,
  writtenNames,
} from '@term/make/code/check/facts'
import { integerText } from '@term/make/code/compile/type-text'

// ---- term builders ----
const constant = (name: string): Term => ({ tag: 'const', name })
const variable = (index: number): Term => ({ tag: 'var', index })
const TYPE0: Term = { tag: 'type', level: litLevel(0) }
const arrow = (domain: Term, codomain: Term): Term => ({
  tag: 'pi',
  mult: 'many',
  domain,
  codomain,
})

const erasedPi = (domain: Term, codomain: Term): Term => ({
  tag: 'pi',
  mult: 0,
  domain,
  codomain,
})

function apply(fun: Term, ...args: Term[]): Term {
  return args.reduce<Term>(
    (f, a) => ({ tag: 'app', fun: f, arg: a }),
    fun,
  )
}

// wrap a body in `count` lambdas
function lambdas(count: number, body: Term): Term {
  let term = body

  for (let i = 0; i < count; i++) {
    term = { tag: 'lam', body: term }
  }

  return term
}

// the head constant name of a (possibly applied) type term: peel `apply(.. apply(constant(T), a) ..)` to `T`. Used to
// recognise a polymorphic inductive type (`stack natural`) by its type former (`stack`) in the induction machinery.
function headConstantName(term: Term): string | undefined {
  let head = term

  while (head.tag === 'app') {
    head = head.fun
  }

  return head.tag === 'const' ? head.name : undefined
}

// does a term have a FREE de Bruijn variable below `depth`, an index that escapes all its binders? The safety gate on
// a generated type: one that is not closed falls back to an opaque postulate. A null term is not closed
function hasFreeVar(term: Term | null, depth = 0): boolean {
  return !term ? true : elaborating.hasFreeVar(term as never, depth)
}

// ---- the base signature: base types and primitive operations as postulated kernel constants ----
const number = constant('Number')
const boolean = constant('Boolean')
const BASE_SIGNATURE = elaborating.baseSignature() as { name: string; type: Term }[]

// surface binary operators to their primitive constant name (== / != are polymorphic, handled separately)
const OPERATOR: Record<string, string> = {
  '+': 'add',
  '-': 'sub',
  '*': 'mul',
  '/': 'div',
  '%': 'mod',
  '<': 'lt',
  '<=': 'le',
  '>': 'gt',
  '>=': 'ge',
  '&&': 'and',
  '||': 'or',
}

// translate a surface type to a kernel type term at a given context depth (check/elaborating-data.tree
// `kernel-type-at`), null where it has no kernel encoding. `owners` maps a variant to the forms encoding it, so an
// index constructor resolves to its `enum__variant` key. The program's transparent aliases, and the ones being read
// through right now, are one state per elaboration
let aliasState = elaborating.newAliasState(new Map())

function kernelTypeAt(
  type: Type | undefined,
  depth: number,
  generics: Map<string, number>,
  known: ReadonlyMap<string, boolean>,
  valueScope: Map<string, number> = new Map(),
  owners: Map<string, string[]> = new Map(),
): Term | null {
  // a hidden name (`hide`) is a key with no level, which the original's `get` read as absent
  let scope = valueScope

  for (const level of valueScope.values()) {
    if (level === undefined) {
      scope = new Map([...valueScope].filter(([, l]) => l !== undefined))
      break
    }
  }

  const read = elaborating.kernelTypeAt(
    aliasState,
    type === undefined ? { form: 'none' } : { form: 'some', value: type as never },
    depth,
    generics,
    known as Map<string, boolean>,
    scope,
    owners,
  )

  return read.form === 'some' ? (read.value as Term) : null
}

// two lists of value arguments, compared as written (spans, resolved types and bindings set aside)
function sameValueArgs(
  a: Expression[] | undefined,
  b: Expression[] | undefined,
): boolean {
  const text = (e: Expression[] | undefined): string =>
    JSON.stringify(e ?? [], (key, value) =>
      key === 'span' || key === 'type' || key === 'binding' ? undefined : value,
    )

  return text(a) === text(b)
}


const isUnit = (term: Term): boolean =>
  term.tag === 'const' && term.name === 'Unit'

// thrown to abandon checking a construct the effect layer cannot represent yet (distinct from a real type error,
// which surfaces as the kernel's TypeError). A declined function is left to the surface checker and counted, with
// the reason, in the report's `declined`.
class Decline extends Error {
  constructor(readonly reason: string = 'an expression the kernel cannot represent') {
    super(reason)
  }
}

// a Term part's decline (a `failure` whose note is `decline:` and the reason, check/judging.tree `decline`) as the
// original's `Decline`, and any other raise as it came
function asDecline(error: unknown): unknown {
  const raised = error as { form?: unknown; note?: unknown } | undefined

  if (raised && raised.form === 'failure' && typeof raised.note === 'string' && raised.note.startsWith('decline:')) {
    return new Decline(raised.note.slice('decline:'.length))
  }

  return error
}

function need<T>(value: T | null, reason?: string): T {
  if (value === null) {
    throw new Decline(reason)
  }

  return value
}

// the elaboration result: kernel diagnostics, plus which functions the kernel actually verified (versus declined
// as outside the covered fragment). The `verified` set is what proves the kernel did the work, not a rubber stamp.
export type ElaborationReport = {
  diagnostics: Diagnostic[]
  verified: string[]
  // the tasks whose WHOLE BODY elaborated to one kernel term checked against the declared type. This is the only
  // kind of verification that is a proof: a body the command checker accepts is type-safe statement by statement,
  // but nothing there checks that every path returns a value, so a body with no return at all passed it. A claim's
  // fill must be in this set (check/claim.ts).
  proven: string[]
  // every task the kernel did not verify, with the reason, so "the kernel checked it" and "the kernel never looked"
  // can be told apart and counted (proof-by-default-0005)
  declined: { name: string; reason: string }[]
  discharged: Span[]
}

// the pipeline entry point: just the diagnostics
// every distinct numeric literal becomes its OWN postulated kernel constant, named `numberValue#<value>`. Collapsing all
// numbers to a single `numberValue` made any two literals definitionally equal, so a false equality like `24 == 999`
// would slip through whenever the closed-arithmetic linear prover did not also cover the goal (e.g. when one side is a
// task call that the kernel reduces to a literal). Distinct constants close that soundness hole, while equal literals
// still share a name, so `24 == 24` and a function returning `24` both still discharge by convertibility.
const numberLiteralConstant = (value: string | number): string =>
  elaborating.numberLiteralConstant(String(value))


// the name of a numeric-literal constant a value computes to, or undefined if it is not a closed numeric literal. Two
// distinct such names denote two different numbers, so an equality between them is refutable (the numeric companion of
// constructor-disjointness). Used to turn a provably-false numeric equality into a hard error rather than a soft warning.
// `whnf` first unfolds any transparent task call (e.g. `order(tee)` reducing to `24`) so the literal it computes to is
// seen, not its un-forced neutral application.
function numericLiteralName(value: Value): string | undefined {
  const head = whnf(value)

  return head.v === 'rigid' &&
    head.spine.length === 0 &&
    head.name.startsWith('numberValue#')
    ? head.name
    : undefined
}

// deep-walk the program collecting every integer / float literal value, so each can be postulated in the signature
// before checking (an unregistered constant is a type error in the kernel). A generic walk avoids hard-coding the
// expression AST shape; a seen-set guards against any shared / cyclic references introduced by resolution.
function collectNumberLiteralValues(program: Program): Set<string> {
  const values = new Set<string>()
  const seen = new Set<unknown>()

  const visit = (node: unknown): void => {
    if (node === null || typeof node !== 'object' || seen.has(node)) {
      return
    }

    seen.add(node)

    if (Array.isArray(node)) {
      for (const item of node) {
        visit(item)
      }

      return
    }

    const form = (node as { form?: unknown }).form

    // an integer by its EXACT text, the name every use of it is elaborated to (`integerText`): past 2^53 its `value`
    // is the rounded number, so registering that left `numberValue#9007199254740993` unknown (test/compile/guide-gaps.ts,
    // "a literal past 2^53"). A float has no exact text but its value
    if (form === 'integer') {
      values.add(integerText(node as Parameters<typeof integerText>[0]))
    } else if (form === 'float') {
      values.add(String((node as { value?: unknown }).value))
    }

    for (const key of Object.keys(node)) {
      visit((node as Record<string, unknown>)[key])
    }
  }

  visit(program)

  return values
}

export function elaborate(
  program: Program,
  file: string,
): Diagnostic[] {
  return elaborateReport(program, file).diagnostics
}

// ONE NAME, TWO KINDS (module-scope-0005). A task and a form may share a name, told apart by where it stands, but the
// kernel keeps one namespace of constants: the form's type former and the task's definition were both `point`, and a
// type position found the task (`kernel: expected a type`). So, on the kernel's OWN copy of the program, a form whose
// name a task also has is renamed `<name>__form` everywhere it stands as a type: a named type, a construction, a raise,
// a method's owner. Tasks keep their names. The emitted program never sees this copy.
//
// A PARAMETER is the same collision one scope down (self-hosting, 2026-10-04): a task is a Π type, so its result type
// sits under its parameters' binders, and `take box, like box` / `like box` found the PARAMETER `box` where the result
// type named the form, `kernel: type mismatch: expected box, found box`. The ir/net port met it as `take net, like net`.
// So a form whose name any parameter has is renamed the same way. test/check/form-parameter.ts holds it.
//
// And a TASK named like one of the kernel's own constants (BASE_SIGNATURE: `equal`, `notequal`, `cond`, ...) is renamed
// `<name>__task` on the kernel's copy, at its definition and every call of it. The kernel lowers `is-equal` to its
// `equal`, so a user task `equal` took the comparison over: every `is-equal` in the module failed as
// `expected <form>, found Type 0`, pointing at a task that had nothing wrong with it (the check/cubical port,
// 2026-10-04). test/check/builtin-name.ts holds it
function kindsApart(program: Program): Program {
  const tasks = new Set(program.flatMap(s => (s.form === 'function' && !s.method ? [s.name] : [])))
  const params = new Set(program.flatMap(s => (s.form === 'function' ? s.params.map(p => p.name) : [])))
  // and a form named `type` is the same collision with the kernel's UNIVERSE, which `like type` names when no form
  // does: the compiler's own AST declares one (compile/node.tree), and every task answering it failed as `kernel: type
  // mismatch` (2026-10-05, test/check/form-named-type.ts)
  const shared = new Set(
    program.flatMap(s =>
      s.form === 'record-type' && (tasks.has(s.name) || params.has(s.name) || s.name === 'type') ? [s.name] : [],
    ),
  )
  const kernelNames = new Set(BASE_SIGNATURE.map(entry => entry.name))
  const clashing = new Set([...tasks].filter(name => kernelNames.has(name)))

  if (shared.size === 0 && clashing.size === 0) {
    return program
  }

  const copy = structuredClone(program)
  const apart = (name: string): string => (shared.has(name) ? `${name}__form` : name)
  const task = (name: string): string => (clashing.has(name) ? `${name}__task` : name)

  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') {
      return
    }

    if (Array.isArray(node)) {
      node.forEach(visit)

      return
    }

    const record = node as Record<string, unknown>

    if (record.kind === 'named' && typeof record.name === 'string') {
      record.name = apart(record.name)
    }

    if ((record.form === 'record' || record.form === 'record-type') && typeof record.name === 'string') {
      record.name = apart(record.name)
    }

    if (record.form === 'throw' && typeof record.raise === 'string') {
      record.raise = apart(record.raise)
    }

    if (record.form === 'function' && record.method && typeof (record.method as { form?: unknown }).form === 'string') {
      const method = record.method as { form: string }
      method.form = apart(method.form)
    }

    // a top-level task named like a kernel constant, and every call of it
    if (record.form === 'function' && !record.method && typeof record.name === 'string') {
      record.name = task(record.name)
    }

    if (record.form === 'call') {
      const callee = record.callee as { form?: string; name?: unknown } | undefined

      if (callee?.form === 'variable' && typeof callee.name === 'string') {
        callee.name = task(callee.name)
      }
    }

    for (const [key, value] of Object.entries(record)) {
      if (key !== 'span') {
        visit(value)
      }
    }
  }

  visit(copy)

  return copy
}

export function elaborateReport(
  written: Program,
  file: string,
): ElaborationReport {
  resetMetas()
  resetDefinitions()
  const program = kindsApart(written)

  // transparent aliases, read through wherever the kernel reads a type (`kernelTypeAt`), as the checker reads them
  // through when it unifies (check/infer.ts `unfoldAlias`)
  aliasState = elaborating.newAliasState(transparentAliases(program))

  // How many arguments each function DECLARES, and how many it REQUIRES, is check/elaborating-terms.tree's
  // `declared-arity`: a call leaving out a `need false` parameter is no partial application, and is left to the
  // inference pass, which checks the arity as a range

  // gate for transparent definitions. Best-effort: a failure here just means no
  // function is treated as transparent (a sound, conservative fallback), never a
  // compiler crash.
  let terminating: Set<string>

  try {
    terminating = terminatingFunctions(program)
  } catch {
    terminating = new Set<string>()
  }

  // which tasks are pure, and for the task being checked, the names it binds itself and the names a closure inside it
  // may write at any time. The command checker reads these to decide which path facts survive. check/facts.ts.
  const factsPure = pureFunctions(program)
  const factsFunctions = functionNames(program)
  let factsLocal = new Set<string>()
  let factsVolatile = new Set<string>()
  // the marks of the RULE being checked. A task-typed mark ranges over the kernel's functions, which are pure, so a call
  // to one is a value and not an effect: `v(n)` for an assignment `v`. A task's callback parameter is not, and stays
  // in `factsLocal`, where a call to it may do anything
  let ruleMarks = new Set<string>()
  // the tasks with a `natural-number` parameter, whose subtraction truncates: never unfolded for the ring
  const truncating = program.flatMap(s =>
    s.form === 'function' && s.params.some(p => p.refine === 'natural') ? [s.name] : [],
  )
  const withoutRuleMarks = (locals: Set<string>): Set<string> => new Set([...locals].filter(name => !ruleMarks.has(name)))

  // RECORD ETA, for the ring normalizer: a value of a form with no cases IS the construction of its fields. So when one
  // side of an equation unfolds to `make vector-two(...)` and the other is a name, the name is read as
  // `make vector-two(v/x, v/y)`, each field an unknown of its own, spelled as check/unfold.ts spells a field read
  const etaPair = (left: Expression, right: Expression): [Expression, Expression] => {
    const expand = (named: Expression, record: Extract<Expression, { form: 'record' }>): Expression => {
      const fields = recordFields.get(record.name)

      return fields && named.form === 'variable'
        ? {
            ...record,
            fields: fields.map(field => ({
              name: field,
              value: { form: 'variable', name: `${named.name}/${field}`, span: record.span },
            })),
          }
        : named
    }

    if (left.form === 'record' && right.form !== 'record') {
      return [left, expand(right, left)]
    }

    if (right.form === 'record' && left.form !== 'record') {
      return [expand(left, right), right]
    }

    return [left, right]
  }
  // the case of the `fold` being closed, and the first COUNTEREXAMPLE the truth table found in one, which the fold's
  // refusal names: in the case `modus-ponens`, evaluate(v, a) is yes and evaluate(v, b) is no. Both are `caseState`,
  // which check/elaborating-cases.tree writes. `sides` when there was nothing to choose: the two sides computed to two
  // different cases outright
  const counterexampleOf = (): { at?: string; text: string; given: boolean; sides?: [string, string] } | undefined => {
    const found = caseState.counterexample

    if (found.form === 'none') {
      return undefined
    }

    const { at, text, given, sides } = found.value

    return {
      at: at.form === 'some' ? at.value : undefined,
      text,
      given,
      ...(sides.length > 0 ? { sides: [sides[0]!, sides[1]!] as [string, string] } : {}),
    }
  }

  const diagnostics: Diagnostic[] = []
  const verified: string[] = []
  const proven: string[] = []
  const declined: { name: string; reason: string }[] = []
  const discharged: Span[] = [] // holds the kernel proved by definitional equality (the non-linear fallback)
  // the named, proven `a == b` holds, for `cite`; the same as UNIVERSAL rewrite rules (`binderCount` leading universal
  // binders, the sides quoted at that depth so their `var`s are the holes); and the program's theorems, whose `cite`
  // this pass holds no lemma for is the arithmetic provers' (holds.ts `citedFacts`). One check/elaborating-proof.tree
  // `lemma-state`, its maps the original's
  const lemmaState = proofs.newLemmaState(
    new Map(program.flatMap(s => (s.form === 'function' && s.theorem ? [[s.name, true] as const] : []))),
  )
  const lemmas = lemmaState.lemmas as Map<string, { left: string; right: string }>
  const theoremNames = lemmaState.theorems
  const lemmaRules = lemmaState.rules as unknown as Map<string, { binderCount: number; lhs: Term; rhs: Term }>

  // the program's types and data as the kernel reads them (check/elaborating-data.tree): the named types, each form's
  // encoding, the signature and each task's kernel type
  const elaborated = elaborating.elaborationDataOf(
    program as never,
    aliasState,
    [...collectNumberLiteralValues(program)],
    (left, right) =>
      sameValueArgs(
        (left as { valueArgs?: Expression[] }).valueArgs,
        (right as { valueArgs?: Expression[] }).valueArgs,
      ),
  )

  // a PROPOSITIONAL TRUNCATION's constructors are registered for proof irrelevance and kept rigid, each with its arity
  for (const entry of elaborated.truncations) {
    registerTruncation(entry.name, entry.arity)
  }

  const unboxed = <T,>(found: { form: 'some'; value: T } | { form: 'none' }): T | undefined =>
    found.form === 'some' ? found.value : undefined
  const infos = (
    from: Map<string, elaborating.FieldInfo[]>,
  ): Map<string, { name: string; type: Term }[]> =>
    new Map(
      [...from].map(([key, fields]) => [
        key,
        fields.map(field => ({ name: field.name, type: (unboxed(field.type) ?? null) as Term })),
      ]),
    )
  const heads = (from: Map<string, elaborating.Maybe<string>[]>): Map<string, (string | undefined)[]> =>
    new Map([...from].map(([key, found]) => [key, found.map(unboxed)]))

  const namedTypes = elaborated.namedTypes
  const recordFields = elaborated.recordFields
  const recordFieldInfo = infos(elaborated.recordFieldInfo)
  const variantNames = elaborated.variantNames
  const variantToEnum = elaborated.variantToEnum
  const declaredOwners = elaborated.declaredOwners
  const variantFieldInfo = infos(elaborated.variantFieldInfo)
  const enumEncodings = elaborated.enumEncodings.map(entry => ({ name: entry.name, encoding: entry.term as Term }))
  const enumDefs = elaborated.enumDefs as { name: string; term: Term }[]
  const typeFormerArity = elaborated.typeFormerArity
  const typeFormerIndices = elaborated.typeFormerIndices as Map<string, Term[]>
  const largeForms = elaborated.largeForms
  const variantIndexHead = elaborated.variantIndexHead
  const variantIndexExpr = elaborated.variantIndexExpr as Map<string, Expression>
  const familyIndexTypes = heads(elaborated.familyIndexTypes)
  const variantIndexHeads = heads(elaborated.variantIndexHeads)
  const signature = elaborated.signature as { name: string; type: Term }[]
  const functionType = elaborated.functionType as Map<string, Term>
  const functionGenerics = elaborated.functionGenerics
  const representable = elaborated.representable
  const unreadable = elaborated.unreadable

  const ctorKey = (enumName: string, variant: string): string =>
    `${enumName}__${variant}`

  // an enum variant used inside an index expression (`zero`, `succ`) to its `enum__variant` kernel key, single-owner only
  const resolveIndexCtor = (variant: string): string | null => {
    const owners = variantToEnum.get(variant)

    return owners && owners.length === 1
      ? ctorKey(owners[0]!, variant)
      : null
  }

  // the context levels of the CURRENT function's erased generic binders, while its body elaborates, and the same
  // binders BY NAME: check/elaborating-terms.tree's `generic-levels` and `generics`, set below where a task's body
  // starts and ends


  const baseContext = contextWithSignature(signature)

  // make each enum transparently equal to its derived self-type encoding, but only if that encoding type-checks as
  // a well-formed type (otherwise leave it as the postulated opaque type). The fuel-bounded delta keeps the
  // recursive reference safe.
  for (const { name, encoding } of enumEncodings) {
    try {
      if (infer(baseContext, encoding).type.v === 'type') {
        defineConstant(name, evaluate([], encoding))
      }
    } catch {
      // the encoding did not form: keep the postulated type, no derivation
    }
  }

  // register the computing constructor / eliminator definitions so the kernel REDUCES a match on a constructor. These
  // are closed terms (no free variables), so they evaluate in the empty environment.
  for (const { name, term } of enumDefs) {
    try {
      defineConstant(name, evaluate([], term))
    } catch {
      // a malformed encoding: leave the constructor / eliminator as an opaque postulate
    }
  }

  const TYPE0_VALUE = evaluate([], TYPE0)
  const NUMBER_VALUE = evaluate([], number)
  const BOOLEAN_VALUE = evaluate([], boolean)
  const isUnitValue = (value: Value): boolean => isUnit(quote(0, value))
  type Scope = Map<string, number> // surface name -> the context level at which it was bound

  // a name in scope that the kernel did not bind (a match arm's field on the statement path): a KEY with no level, so
  // `get` finds nothing to apply and `has` still stops the lookup from reaching a global of the same name
  const hide = (scope: Scope, name: string): void => {
    scope.set(name, undefined as unknown as number)
  }

  // An expression or a body as one kernel term is check/elaborating-terms.tree. Its state holds what the closures
  // shared, and a scope crosses with a hidden name's level as -1 where this face stores `undefined`
  const termState = terms.newTermState(judgeState(), elaborated as never, aliasState, program as never, TYPE0_VALUE as never)
  const scopeOf = (scope: Scope): Map<string, number> => {
    const out = new Map<string, number>()

    for (const [name, level] of scope) {
      out.set(name, level === undefined ? -1 : level)
    }

    return out
  }
  const termOf = (found: { form: 'some'; value: unknown } | { form: 'none' }): Term | null =>
    found.form === 'some' ? (found.value as Term) : null

  // a fresh type metavariable for one erased generic argument at a call site, contextual inside a generic task
  function contextualTypeMeta(context: Context): Term {
    return kernel(() => terms.contextualTypeMeta(termState, context as never)) as Term
  }

  // elaborate an expression to a kernel term in the given context, or null if out of the covered fragment
  function expr(
    node: Expression,
    scope: Scope,
    context: Context,
    // the type this expression is checked against, when known, which resolves an OVERLOADED constructor
    expected?: Value,
  ): Term | null {
    return termOf(
      viaKernel(() =>
        terms.expr(
          termState,
          node as never,
          scopeOf(scope),
          context as never,
          expected === undefined ? { form: 'none' } : { form: 'some', value: expected as never },
        ),
      ),
    )
  }

  // elaborate a statement body to a single kernel term of the result type, or null if out of the fragment
  function body(
    statements: Statement[],
    scope: Scope,
    context: Context,
    resultValue: Value,
  ): Term | null {
    return termOf(
      viaKernel(() => terms.body(termState, statements as never, scopeOf(scope), context as never, resultValue as never)),
    )
  }

  // check an explicit proof of `left == right` (check/elaborating-proof.tree): 'ok' = proved, 'fail' = an explicit
  // tactic that did not work, 'open' = no proof or a tactic not lowered (the linear prover then gets a chance), 'bad'
  // = the proof cites a lemma that does not exist, a hard error no fallback may rescue
  function checkProof(
    proof: Proof[] | undefined,
    level: number,
    left: Value,
    right: Value,
  ): 'ok' | 'fail' | 'open' | 'bad' {
    return viaKernel(() =>
      proofs.checkProof(judgeState(), lemmaState, (proof ?? []) as never, level, left as never, right as never),
    ) as 'ok' | 'fail' | 'open' | 'bad'
  }

  // the effect layer: a statement body type-checked as imperative commands, the path's equations carried and dropped
  // where a write could make them false (check/elaborating-commands.tree). What it asks of this face is one host: the
  // facts (check/facts.ts, with the task being checked's names), the two reflective walks below, and `checkHold`
  const tuplesOf = (pairs: { left: Expression; right: Expression }[]): [Expression, Expression][] =>
    pairs.map(pair => [pair.left, pair.right])
  const pairsFor = (pairs: [Expression, Expression][]): { left: Expression; right: Expression }[] =>
    pairs.map(([left, right]) => ({ left, right }))
  const sceneOf = (scope: Map<string, number>): Scope => {
    const out: Scope = new Map()

    for (const [name, level] of scope) {
      out.set(name, level < 0 ? (undefined as unknown as number) : level)
    }

    return out
  }
  const impure = (node: Statement | Statement[] | Expression): boolean =>
    callsImpure(node, factsPure, factsFunctions, withoutRuleMarks(factsLocal))
  const commandHost = {
    callsImpureStatement: (statement: unknown) => impure(statement as Statement),
    callsImpureBody: (body: unknown) => impure(body as Statement[]),
    callsImpureExpression: (expression: unknown) => impure(expression as Expression),
    readsState: (expression: unknown) => readsState(expression as Expression),
    readsAny: (expression: unknown, names: string[]) => readsAny(expression as Expression, new Set(names)),
    readsName: (expression: unknown, name: string) => readNames(expression as Expression).has(name),
    writtenNames: (statement: unknown) => [...writtenNames(statement as Statement)],
    writtenNamesBody: (body: unknown) => [...writtenNames(body as Statement[])],
    rootName: (expression: unknown) => rootName(expression as Expression) ?? EVERYTHING,
    everything: EVERYTHING,
    volatileNames: () => [...factsVolatile],
    containsMemberWrite: (body: unknown) => containsMemberWrite(body as Statement[]),
    readsMember: (expression: unknown) => readsMember(expression as Expression),
    checkHold: (statement: unknown, scope: Map<string, number>, ctx: unknown, assumptions: unknown) => {
      checkHold(
        statement as Extract<Statement, { form: 'hold' }>,
        sceneOf(scope),
        ctx as Context,
        tuplesOf(assumptions as { left: Expression; right: Expression }[]),
      )

      return true
    },
  }

  function checkCommands(
    statements: Statement[],
    scope: Scope,
    context: Context,
    resultValue: Value,
    // equation hypotheses true on this control-flow path, as their two side EXPRESSIONS
    assumptions: [Expression, Expression][] = [],
  ): void {
    viaKernel(() =>
      commands.checkCommands(
        termState,
        commandHost as never,
        statements as never,
        scopeOf(scope),
        context as never,
        resultValue as never,
        pairsFor(assumptions) as never,
      ),
    )
  }

  function containsMemberWrite(body: Statement[]): boolean {
    let found = false
    const stack: unknown[] = [body]

    while (stack.length > 0 && !found) {
      const node = stack.pop()

      if (node === null || typeof node !== 'object') {
        continue
      }

      if (Array.isArray(node)) {
        stack.push(...node)
        continue
      }

      const record = node as Record<string, unknown>

      if (
        record.form === 'assign' &&
        (record.target as { form?: string } | undefined)?.form === 'member'
      ) {
        found = true
      }

      for (const key of Object.keys(record)) {
        if (key !== 'type' && key !== 'span' && key !== 'binding') {
          stack.push(record[key])
        }
      }
    }

    return found
  }

  function readsMember(expression: Expression): boolean {
    let found = false
    const stack: unknown[] = [expression]

    while (stack.length > 0 && !found) {
      const node = stack.pop()

      if (node === null || typeof node !== 'object') {
        continue
      }

      if (Array.isArray(node)) {
        stack.push(...node)
        continue
      }

      const record = node as Record<string, unknown>

      if (record.form === 'member') {
        found = true
      }

      for (const key of Object.keys(record)) {
        if (key !== 'type' && key !== 'span') {
          stack.push(record[key])
        }
      }
    }

    return found
  }

  // discharge `left == right` modulo a set of induction-hypothesis equalities, by the kernel. With no hypotheses this
  // is plain definitional equality (the base case of an induction); otherwise the kernel may also equate two subterms
  // by any hypothesis, the reasoning the type's eliminator licenses for the step.
  function dischargeModulo(
    level: number,
    left: Value,
    right: Value,
    hypotheses: [Value, Value][],
  ): boolean {
    return convertibleModulo(level, left, right, hypotheses)
  }

  // Rewriting kernel terms is check/elaborating-rewrite.tree: a first-order match of a lemma's side, one rewrite
  // leftmost-outermost, rewriting to a fixed point, the shapes of a commutativity and an associativity law, and
  // normalizing and rewriting modulo AC. A rule's holes cross as a hash, and a term none of them answers as `null`
  type RewriteRule = { binderCount: number; lhs: Term; rhs: Term; holes?: Set<number> }
  const ruleOf = (rule: RewriteRule): rewriting.RewriteRule => ({
    binderCount: rule.binderCount,
    lhs: rule.lhs as never,
    rhs: rule.rhs as never,
    holes: new Map([...(rule.holes ?? [])].map(hole => [hole, true])),
  })
  const operatorsOf = (operators: Set<string>): Map<string, boolean> =>
    new Map([...operators].map(name => [name, true]))
  const found = <T,>(maybe: { form: 'some'; value: T } | { form: 'none' }): T | null =>
    maybe.form === 'some' ? maybe.value : null

  // structural equality of two kernel terms (both from `quote`, so a syntactic comparison is exact)
  function termsEqual(a: Term, b: Term): boolean {
    return rewriting.termsEqual(a as never, b as never)
  }

  // free de Bruijn variables replaced per `map` (indices in the depth-0 frame), respecting binders: a dependent match's
  // result type refined at an index constructor's branch
  function substituteVars(
    term: Term,
    map: Map<number, number>,
    depth = 0,
  ): Term {
    return rewriting.substituteVars(term as never, map, depth) as Term
  }

  // the free de Bruijn variable indices of a term, added to `acc` in the order they are met
  function freeVarIndices(
    term: Term,
    depth = 0,
    acc = new Set<number>(),
  ): Set<number> {
    const met = new Map<number, boolean>()
    rewriting.freeVarIndices(term as never, depth, met)

    for (const index of met.keys()) {
      acc.add(index)
    }

    return acc
  }

  // a term rewritten ONCE by a lemma, left to right, or null where it fires nowhere
  function rewriteOnce(target: Term, rule: RewriteRule): Term | null {
    return found(rewriting.rewriteOnce(target as never, ruleOf(rule))) as Term | null
  }

  // a term rewritten to a fixed point by the lemmas, directed left to right, bounded by fuel
  function rewriteWithLemmas(target: Term, rules: RewriteRule[], fuel: number): Term {
    return rewriting.rewriteWithLemmas(target as never, rules.map(ruleOf), fuel) as Term
  }

  // is this rule a commutativity statement `f a b == f b a`? The operator constant name, or null
  function commutativityOperator(rule: { binderCount: number; lhs: Term; rhs: Term }): string | null {
    return found(rewriting.commutativityOperator(ruleOf(rule)))
  }

  // is this rule an associativity statement `f (f a b) c == f a (f b c)`? The operator name, or null
  function associativityOperator(rule: { binderCount: number; lhs: Term; rhs: Term }): string | null {
    return found(rewriting.associativityOperator(ruleOf(rule)))
  }

  // a nested chain of one AC operator flattened to its operand list, or null
  function flattenAc(term: Term, operators: Set<string>): { op: string; operands: Term[] } | null {
    return found(rewriting.flattenAc(term as never, operatorsOf(operators))) as { op: string; operands: Term[] } | null
  }

  // a term normalized modulo associativity and commutativity of the operators, which are PROVEN both
  function acNormalize(term: Term, operators: Set<string>): Term {
    return rewriting.acNormalize(term as never, operatorsOf(operators)) as Term
  }

  // AC rewriting to a fixed point, the directed rewrites interleaved and the term renormalized between steps
  function acRewriteFix(
    term: Term,
    operators: Set<string>,
    acRules: { lhs: Term; rhs: Term }[],
    syntacticRules: { binderCount: number; lhs: Term; rhs: Term }[],
    fuel: number,
  ): Term {
    return rewriting.acRewriteFix(
      term as never,
      operatorsOf(operators),
      acRules as never,
      syntacticRules.map(ruleOf),
      fuel,
    ) as Term
  }

  // What the kernel decides by running a form's eliminator is check/elaborating-cases.tree: which case a value is, its
  // fields, no-confusion at any depth, the truth table and an induction case read as ring arithmetic or as an order.
  // Each is called through judge.ts's `kernel`, so a raise reaches this face as the original's class; a `decline:`
  // failure becomes `Decline` here
  const st = judgeState()
  const caseState = cases.newCaseState()
  const viaKernel = <T,>(call: () => T): T => {
    try {
      return kernel(call)
    } catch (error) {
      throw asDecline(error)
    }
  }
  const pairsOf = (pairs: [Value, Value][]): Value[] => pairs.flat()
  const casesRules = (rules: { binderCount: number; lhs: Term; rhs: Term }[]) =>
    rules.map(rule => ({ binderCount: rule.binderCount, lhs: rule.lhs, rhs: rule.rhs, holes: new Map() })) as never
  const data = elaborated as never

  // the two sides of an equality goal, each guiding the other's overloaded constructors (check/elaborating-theorems.tree)
  function elaborateGoalSides(
    leftNode: Expression,
    rightNode: Expression,
    scope: Scope,
    ctx: Context,
  ): [Term | null, Term | null] {
    const sides = viaKernel(() =>
      theorems.elaborateGoalSides(termState, leftNode as never, rightNode as never, scopeOf(scope), ctx as never),
    )

    return [termOf(sides.left as never), termOf(sides.right as never)]
  }

  function equationAbsurd(
    context: Context,
    leftTerm: Term,
    leftValue: Value,
    rightValue: Value,
  ): boolean {
    return viaKernel(() =>
      cases.equationAbsurd(st, data, context as never, leftTerm as never, leftValue as never, rightValue as never),
    )
  }

  // THE TRUTH TABLE (math-foundations-0017): a goal over values of a form whose cases hold nothing, decided by trying
  // every case for each atom. `stated` is how many hypotheses were WRITTEN
  function truthTable(
    context: Context,
    left: Value,
    right: Value,
    hypotheses: [Value, Value][],
    stated = hypotheses.length,
  ): boolean {
    return viaKernel(() =>
      cases.truthTable(st, data, caseState, context as never, left as never, right as never, pairsOf(hypotheses) as never, stated),
    )
  }

  // AN INDUCTION CASE THAT IS ARITHMETIC: a ring identity modulo the hypotheses, in atoms the kernel cannot compute
  function ringCase(
    level: number,
    left: Value,
    right: Value,
    hypotheses: [Value, Value][],
    rules: { binderCount: number; lhs: Term; rhs: Term }[] = [],
  ): boolean {
    return viaKernel(() =>
      cases.ringCase(st, truncating, NO_SPAN as never, level, left as never, right as never, pairsOf(hypotheses) as never, casesRules(rules)),
    )
  }

  // AN INDUCTION CASE THAT IS AN ORDER, by the hold checker's `orderFollows`
  function orderCase(
    level: number,
    op: string,
    left: Value,
    right: Value,
    ordered: [Value, Value][],
    equal: [Value, Value][],
    rules: { binderCount: number; lhs: Term; rhs: Term }[] = [],
  ): boolean {
    return viaKernel(() =>
      cases.orderCase(
        st,
        truncating,
        NO_SPAN as never,
        level,
        op as never,
        left as never,
        right as never,
        pairsOf(ordered) as never,
        pairsOf(equal) as never,
        casesRules(rules),
        (goal, facts) => orderFollows(goal as never, facts as never),
      ),
    )
  }

  // Induction is check/elaborating-induction.tree: closing a case, structural induction over one variable (field
  // splits, an indexed family's index refined, the hypothesis generalized), simultaneous induction over several (a
  // deep split over finite fields). Its state is the terms', the lemmas, the fold's case and the finite forms found
  const inductionState = induction.newInductionState(
    termState,
    lemmaState as never,
    caseState as never,
    truncating,
    NO_SPAN as never,
    (goal, facts) => orderFollows(goal as never, facts as never),
  )

  // structural induction over an inductive self-type: the `fold <var>` tactic. False (never a throw) outside it
  function structuralInduction(
    goal: Extract<Expression, { form: 'binary' }>,
    scope: Scope,
    context: Context,
    inductVar: string,
    citedLemmas: string[],
    assumptions: [Expression, Expression][] = [],
  ): boolean {
    return viaKernel(() =>
      induction.structuralInduction(
        inductionState,
        goal.left as never,
        goal.right as never,
        goal.op as never,
        scopeOf(scope),
        context as never,
        inductVar,
        citedLemmas,
        pairsFor(assumptions) as never,
      ),
    )
  }

  // simultaneous structural induction on SEVERAL variables (`fold a b ...`); `deep` also splits every finite field
  function multiInduction(
    goal: Extract<Expression, { form: 'binary' }>,
    scope: Scope,
    context: Context,
    inductVars: string[],
    citedLemmas: string[],
    assumptions: [Expression, Expression][] = [],
    deep = false,
  ): boolean {
    return viaKernel(() =>
      induction.multiInduction(
        inductionState,
        goal.left as never,
        goal.right as never,
        goal.op as never,
        scopeOf(scope),
        context as never,
        inductVars,
        citedLemmas,
        pairsFor(assumptions) as never,
        deep,
      ),
    )
  }

  // What a hold asks of the theorem around it is check/elaborating-theorems.tree: the theorem that holds it alone, its
  // `have` guards (null when the hold is not in that shape), whether it is an order, or applies a task taking a function
  // or a recursive task, and the universal hypotheses at the goal's terms. `callsItself` stays here: it reads every key
  // of every node
  const theoremOf = (found: { form: 'some'; value: unknown } | { form: 'none' }) =>
    (found.form === 'some' ? found.value : undefined) as Extract<Statement, { form: 'function' }> | undefined

  function enclosingTheorem(program: Program, hold: Statement): Extract<Statement, { form: 'function' }> | undefined {
    return theoremOf(theorems.enclosingTheorem(program as never, hold as never))
  }

  // whether a term is a number, or cannot be typed (read as a number, leaving it to the arithmetic provers)
  function numericTerm(context: Context, term: Term): boolean {
    return viaKernel(() => theorems.numericTerm(termState, context as never, term as never))
  }

  // THE UNIVERSAL HYPOTHESES OF A THEOREM, at the goal's own terms (math-foundations-0004)
  function universalInstances(
    statement: Extract<Statement, { form: 'hold' }>,
    scope: Scope,
    context: Context,
    assumptions: [Expression, Expression][],
  ): [Expression, Expression][] {
    return tuplesOf(
      viaKernel(() =>
        theorems.universalInstances(
          termState,
          program as never,
          statement as never,
          scopeOf(scope),
          context as never,
          pairsFor(assumptions) as never,
        ),
      ) as never,
    )
  }

  // a comparison, or a conjunction of comparisons: what checkFoldOrder inducts over
  function isOrderGoal(e: Expression): boolean {
    return theorems.isOrderGoal(e as never)
  }

  // `fold n` on a number in a theorem about functions
  function numberFoldOverFunctions(program: Program, hold: Extract<Statement, { form: 'hold' }>): boolean {
    return theorems.numberFoldOverFunctions(termState, program as never, hold as never, statement =>
      callsItself(statement as unknown as Extract<Statement, { form: 'function' }>),
    )
  }

  // a task whose body holds a call of its own name, found by walking every node of it
  function callsItself(s: Extract<Statement, { form: 'function' }>): boolean {
    const stack: unknown[] = [s.body]

    while (stack.length > 0) {
      const node = stack.pop()

      if (node === null || typeof node !== 'object') {
        continue
      }

      if (Array.isArray(node)) {
        stack.push(...node)
        continue
      }

      const record = node as Record<string, unknown>
      const callee = record.callee as { form?: string; name?: string } | undefined

      if (record.form === 'call' && callee?.form === 'variable' && callee.name === s.name) {
        return true
      }

      stack.push(...Object.values(record))
    }

    return false
  }

  // does the expression apply a task that takes a function (`total(f, n)`)
  function appliesHigherOrder(program: Program, expr: Expression): boolean {
    return theorems.appliesHigherOrder(termState, program as never, expr as never)
  }

  function inUniversalTheorem(program: Program, hold: Statement): boolean {
    return theorems.inUniversalTheorem(program as never, hold as never)
  }

  function ruleGuards(
    program: Program,
    hold: Statement,
  ): Expression[] | null {
    const found = theorems.ruleGuards(program as never, hold as never)

    return found.form === 'some' ? (found.value as Expression[]) : null
  }

  // a proven equation recorded as a citable lemma and a rewrite rule
  function recordLemmaRule(
    name: string | undefined,
    goal: Extract<Statement, { form: 'hold' }>['expr'],
    scope: Scope,
    context: Context,
  ): void {
    viaKernel(() =>
      theorems.recordLemmaRule(termState, lemmaState as never, name ?? '', goal as never, scopeOf(scope), context as never),
    )
  }

  // FUNCTION EXTENSIONALITY: discharge `f == g` by a cited pointwise lemma `f x == g x`
  function tryFunext(
    goal: Extract<Statement, { form: 'hold' }>['expr'],
    scope: Scope,
    context: Context,
    citedName: string,
  ): boolean {
    return viaKernel(() =>
      theorems.tryFunext(termState, lemmaState as never, goal as never, scopeOf(scope), context as never, citedName),
    )
  }

  // check one `hold` proof obligation (an `a == b` claim plus an optional proof tree) by the KERNEL, in a given
  // scope/context. Used both inside a function body and at the top level. Discharges when the sides are definitionally
  // equal or an explicit proof tree (`calm`/`cite`/`turn`/`link`) closes it, recording the span so the linear prover
  // drops it; a discharged named hold becomes a citable lemma. A false explicit proof is an `invalid-proof` error.
  // Anything the kernel leaves open is handled by the linear prover (`checkHolds`), which now walks both function
  // bodies AND top-level holds, so it is the single place that flags an unproven obligation.
  function checkHold(
    statement: Extract<Statement, { form: 'hold' }>,
    scope: Scope,
    context: Context,
    assumptions: [Expression, Expression][] = [],
  ): void {
    const goal = statement.expr
    // the theorem's universal hypotheses, at the terms this goal and its guards name, are equations true on this path
    const instances = universalInstances(statement, scope, context, assumptions)
    assumptions = [...assumptions, ...instances]

    // a goal that calls something two calls may disagree on is not the kernel's to decide: every task is a constant
    // in the signature, so `roll() == roll()` would be convertible by construction. Leave it to the linear prover,
    // which reports it as outside the fragment. See check/facts.ts.
    if (callsImpure(goal, factsPure, factsFunctions, withoutRuleMarks(factsLocal))) {
      return
    }

    // `calm miss`: a `show miss` over an equality is lowered by the mill to `! (a == b)`. Discharge it by definitional
    // DISTINCTNESS (no confusion): if `a` and `b` reduce to different constructors of the same enum, the equality is
    // impossible, so its negation holds by computation. This is the refutation companion of `calm hold`. Sound: it reuses
    // `equationAbsurd`, the same constructor-disjointness check that closes impossible induction cases.
    if (
      goal.form === 'unary' &&
      goal.op === '!' &&
      goal.operand.form === 'binary' &&
      goal.operand.op === '==' &&
      statement.proof?.[0]?.head === 'calm'
    ) {
      const eq = goal.operand
      const leftTerm = expr(eq.left, scope, context)
      const rightTerm = expr(eq.right, scope, context)

      if (leftTerm && rightTerm) {
        try {
          const lv = evaluate(context.env, leftTerm)
          const rv = evaluate(context.env, rightTerm)

          if (equationAbsurd(context, leftTerm, lv, rv)) {
            discharged.push(statement.span)
          } else {
            diagnostics.push(
              diagnose('invalid-proof', {
                file,
                span: statement.span,
                message:
                  'calm miss needs the two sides to compute to distinct constructors',
              }),
            )
          }
        } catch {
          // leave to the linear prover / unproven reporting
        }
      }

      return
    }

    if (goal.form !== 'binary') {
      return
    }

    // boolean-connective goals: `meet and` lowers to `&&`, `meet or` to `||`. Discharge a conjunction by proving BOTH
    // operands and a disjunction by proving ONE, recursively, with each equality leaf settled by convertibility or the
    // ring normalizer (modulo the path hypotheses). Sound: a connective is discharged only when its leaves genuinely
    // hold. On failure, fall through to the linear prover (unchanged behavior), so nothing true is newly rejected.
    // a conjunction proved by `fold n`: Peano induction over order goals, whose hypothesis is the whole conjunction
    // (induct.ts checkFoldOrder). A conjunction is how an induction carries a second fact through its step.
    // a theorem with universal hypotheses is the hold checker's, its inductions too, and so is an induction on a number
    // in a theorem about a function (`total(f, n)` by `fold n`): the hold checker reads the summed task's equations
    // as such hypotheses (check/holds.ts `recurrenceFacts`), and the kernel's own induction has no use for `f`
    // An ORDER goal stays here: induct.ts checkFoldOrder proves an inequality over a recursive task, which the hold
    // checker's equations do not, and handing it over left test/check/fold-order.ts unproven
    if (
      statement.proof?.[0]?.head === 'fold' &&
      !isOrderGoal(goal) &&
      (inUniversalTheorem(program, statement) || numberFoldOverFunctions(program, statement))
    ) {
      return
    }

    if (goal.op === '&&' && statement.proof?.[0]?.head === 'fold' && statement.proof[0].arg) {
      const guards = ruleGuards(program, statement)

      if (guards !== null && checkFoldOrder(program, goal, statement.proof[0].arg, guards)) {
        discharged.push(statement.span)
      } else {
        // a hard error, never left to the hold checker: an unchecked hold is not reported in a file that already has
        // a kernel error, so a failed induction left there could pass unseen
        diagnostics.push(
          diagnose('invalid-proof', {
            file,
            span: statement.span,
            message: 'the induction did not establish the conjunction',
          }),
        )
      }

      return
    }

    if (goal.op === '&&' || goal.op === '||') {
      const proveConnective = (claim: Expression): boolean => {
        if (
          claim.form === 'binary' &&
          (claim.op === '&&' || claim.op === '||')
        ) {
          const leftHolds = proveConnective(claim.left)
          const rightHolds = proveConnective(claim.right)

          return claim.op === '&&'
            ? leftHolds && rightHolds
            : leftHolds || rightHolds
        }

        if (claim.form === 'binary' && claim.op === '==') {
          if (ringEqual(claim.left, claim.right)) {
            return true
          }

          if (
            assumptions.length > 0 &&
            ringEqualModulo(claim.left, claim.right, assumptions.map(([left, right]) => ({ left, right })))
          ) {
            return true
          }

          const [l, r] = elaborateGoalSides(
            claim.left,
            claim.right,
            scope,
            context,
          )

          if (l && r) {
            try {
              return areConvertible(
                context.level,
                evaluate(context.env, l),
                evaluate(context.env, r),
              )
            } catch {
              return false
            }
          }
        }

        return false
      }

      if (proveConnective(goal)) {
        discharged.push(statement.span)
      }

      return
    }

    const hasProof = (statement.proof?.length ?? 0) > 0
    // explicit induction: `fold <var>` proves a universal `L(n) == R(n)` by Peano induction over a recursive function
    // in the goal, discharged symbolically by the ring normalizer (no kernel computation). See induct.ts.
    const tactic = statement.proof?.[0]

    // FUNEXT: prove two FUNCTIONS equal (`is-equal f g`) by citing a pointwise lemma `mark x / is-equal (f x) (g x)`.
    // Sound by the kernel's observational equality (Id at a function type IS the pointwise identity), so the pointwise
    // proof IS the function-equality proof. Discharges a NON-definitional function equality (e.g. two recursive
    // definitions of the same function) that `calm` cannot.
    // `seek` / firstorder: discharge the goal by rewriting BOTH sides with EVERY proven lemma (the hint database is
    // `lemmaRules`) to a fixed point, then checking convertibility (which also runs computation). Additive and SOUND --
    // it only uses already-proven equalities and definitional reduction, so it can never prove a falsehood; it just
    // automates "cite each lemma + calm" with a depth-bounded search, so the user need not name the lemmas. It was
    // `auto` until 2026-10-02, a head outside hold/base/terms.json (proof-by-default-0021).
    if (tactic?.head === 'seek' && goal.form === 'binary' && goal.op === '==') {
      const rules = [...lemmaRules.values()]
      const [l, r] = elaborateGoalSides(
        goal.left,
        goal.right,
        scope,
        context,
      )

      if (l && r) {
        try {
          // BACKTRACKING firstorder search: from the left side, apply each known lemma as a SINGLE rewrite (depth-
          // bounded) and check whether the result is convertible to the right side (convertibility also runs
          // computation, so it subsumes `calm`). A single rewrite per step avoids the non-termination of a symmetric
          // lemma like commutativity (rewriting BOTH sides to a fixed point would oscillate). Sound: every step is a
          // proven equality or a reduction, so a closed goal is genuinely true.
          const rhs = evaluate(context.env, r)
          const closes = (term: Term): boolean =>
            areConvertible(
              context.level,
              evaluate(context.env, term),
              rhs,
            )

          let frontier: Term[] = [
            quote(context.level, evaluate(context.env, l)),
          ]
          const seen = new Set<string>()
          let closed = false

          for (let depth = 0; depth <= 3 && !closed; depth++) {
            const next: Term[] = []

            for (const term of frontier) {
              if (closes(term)) {
                closed = true
                break
              }

              for (const rule of rules) {
                const rewritten = rewriteOnce(term, rule)

                if (rewritten) {
                  const key = JSON.stringify(rewritten)

                  if (!seen.has(key)) {
                    seen.add(key)
                    next.push(rewritten)
                  }
                }
              }
            }

            frontier = next.slice(0, 64)
          }

          if (closed) {
            discharged.push(statement.span)
            recordLemmaRule(statement.name, goal, scope, context)
            return
          }
        } catch {
          // fall through to the diagnostic below
        }
      }

      diagnostics.push(
        diagnose('invalid-proof', {
          file,
          span: statement.span,
          message:
            'seek could not close the goal by rewriting with the known lemmas and computing',
        }),
      )

      return
    }

    if (
      tactic?.head === 'melt' &&
      tactic.arg &&
      tryFunext(goal, scope, context, tactic.arg)
    ) {
      discharged.push(statement.span)

      return
    }

    if (tactic?.head === 'fold' && tactic.arg) {
      caseState.foldCase = { form: 'none' }
      caseState.counterexample = { form: 'none' }

      // try structural induction over an inductive type first (it handles lists, trees, and the like, and proves the
      // non-definitional arithmetic laws such as n + 0 == n); fall back to ring-level Peano induction for the numeric
      // accumulator recurrences (closed-form sums) that the symbolic ring certificate decides. `cite <lemma>` children
      // name previously proven universal equalities to chain into the induction.
      const cited = tactic.children
        .filter(child => child.head === 'cite' && child.arg)
        .map(child => child.arg!)

      // `fold a b ...`: the extra bare children (not `cite`) are additional induction variables for a SIMULTANEOUS
      // induction over the product of their constructors (min / max / order comparisons recurse on several arguments).
      const extraVars = tactic.children
        .filter(child => child.head !== 'cite' && !child.arg)
        .map(child => child.head)

      const inductVars = [tactic.arg, ...extraVars]

      const byInduction =
        inductVars.length > 1
          ? multiInduction(
              goal,
              scope,
              context,
              inductVars,
              cited,
              assumptions,
            )
          : structuralInduction(
              goal,
              scope,
              context,
              tactic.arg,
              cited,
              assumptions,
            )

      // when the split above leaves a record's fields standing as variables the goal cannot compute on, split those
      // too, down to closed values (exhaustive over finite types, so sound). Tried only after the shallow attempt
      // fails, so every proof that closed before closes the same way.
      const byDeepSplit =
        !byInduction &&
        multiInduction(
          goal,
          scope,
          context,
          inductVars,
          cited,
          assumptions,
          true,
        )

      // an ORDER goal (a comparison, or a conjunction of them) about a recursive function, by Peano induction with the
      // product prover closing each case (induct.ts checkFoldOrder). Its hypotheses are the rule's `have` guards.
      const guards = ruleGuards(program, statement)
      const byOrder =
        !byInduction &&
        !byDeepSplit &&
        guards !== null &&
        checkFoldOrder(program, goal, tactic.arg, guards)

      if (byInduction || byDeepSplit || byOrder || checkFold(program, goal, tactic.arg)) {
        discharged.push(statement.span)

        // only an equation is a rewrite: a proved inequality recorded as `lhs -> rhs` would rewrite one side into the other
        if (goal.form === 'binary' && goal.op === '==') {
          recordLemmaRule(statement.name, goal, scope, context)
        }
      } else {
        // a counterexample the truth table found is the reason, and the most useful sentence the refusal can say
        const found = counterexampleOf()
        const where = found?.at ? `in the case \`${found.at}\`` : 'in one case'

        diagnostics.push(
          diagnose('invalid-proof', {
            file,
            span: statement.span,
            message: !found
              ? 'the induction did not establish the equality'
              : found.sides
                ? `the induction did not establish the equality: it is FALSE ${where}, where its two sides compute to ${found.sides[0]} and ${found.sides[1]}`
                : `the induction did not establish the equality: it is FALSE ${where}, where ${found.text}${found.given ? ', with every hypothesis of the case holding' : ''}`,
            ...(found
              ? { hint: 'no proof step makes a false case true. Change the case or the statement, and check the values named above by hand' }
              : {}),
          }),
        )
      }

      return
    }

    // non-negativity by a sum-of-squares certificate: `E >= F` (or `F <= E`) holds for ALL values when E - F is a sum
    // of square monomials. This proves the non-linear inequality "every square is non-negative" and its kin (for any
    // bound, not just zero) without induction. (The univariate real-arithmetic / Sturm route, and the inequality
    // discharge in general, live in the linear prover `holds.ts`, which owns every comparison goal regardless of an
    // attached `calm hold`.)
    if (!hasProof) {
      // a polynomial named as a task (a norm) is unfolded first, the same as for a ring identity (see unfold.ts)
      const orderLeft = unfoldDefinitions(goal.left, program)
      const orderRight = unfoldDefinitions(goal.right, program)

      if (
        goal.op === '>=' &&
        nonNegativeDifference(orderLeft, orderRight)
      ) {
        discharged.push(statement.span)

        return
      }

      if (
        goal.op === '<=' &&
        nonNegativeDifference(orderRight, orderLeft)
      ) {
        discharged.push(statement.span)

        return
      }
    }

    if (goal.op !== '==') {
      return
    }

    // a commutative-ring identity (when no explicit proof is given): L and R normalize to the same polynomial, so the
    // equality holds for ALL values of the variables. This discharges the non-linear algebraic universals (the
    // multiplicative norm, the four-square and doubling identities) that the linear prover (degree one) and the
    // kernel's opaque arithmetic cannot. Sound: a zero polynomial is identically zero over any commutative ring. With
    // an explicit proof present, the kernel validates that proof instead, so a bogus tactic is still caught.
    // the sides with every non-recursive single-expression task unfolded, so a polynomial defined once as a task
    // (a norm, a product's coordinates) can be named in a ring identity rather than written out (see unfold.ts)
    const [ringLeft, ringRight] = etaPair(unfoldDefinitions(goal.left, program), unfoldDefinitions(goal.right, program))

    if (!hasProof && ringEqual(ringLeft, ringRight)) {
      discharged.push(statement.span)
      // a named ring identity becomes a citable lemma (and rewrite rule), so `cite` / `link` (calc chains) can use it,
      // the same as an induction- or kernel-discharged hold. Sound: it is a proven universal equality.
      recordLemmaRule(statement.name, goal, scope, context)

      return
    }

    // a ring identity MODULO the path's equational hypotheses: `L - R` reduces to zero in the ideal the `have` equations
    // generate, so the identity holds whenever the hypotheses do. This discharges CONDITIONAL algebraic identities that
    // the kernel's literal-subterm hypothesis rewrite cannot thread through an AC-normalized polynomial (rational
    // well-definedness, where `a*d = a'*b` forces a cross-multiplied sum identity). Sound over the integers (see
    // `ringEqualModulo`), and only fires when the goal genuinely holds modulo the hypotheses, so a stated tactic that
    // does no real work is never masking an unsound step.
    if (
      goal.op === '==' &&
      assumptions.length > 0 &&
      ringEqualModulo(
        ringLeft,
        ringRight,
        assumptions.map(([l, r]) => ({ left: unfoldDefinitions(l, program), right: unfoldDefinitions(r, program) })),
      )
    ) {
      discharged.push(statement.span)
      recordLemmaRule(statement.name, goal, scope, context)

      return
    }

    // the kernel handles the NON-linear (definitional / structural) fragment; the linear prover (checkHolds) owns the
    // linear fragment. When a goal the linear prover can decide carries NO explicit proof tree, skip it here so the
    // linear prover is authoritative -- this is what stops the kernel from wrongly discharging a value-false
    // arithmetic claim like `add 3 3 == add 4 4` through its opaque view of number literals. A goal WITH an explicit
    // proof (`calm`/`cite`/...) is still validated by the kernel, so a bogus tactic is caught.
    const [left, right] = elaborateGoalSides(
      goal.left,
      goal.right,
      scope,
      context,
    )

    // linear in SHAPE is not enough: `x == y` over an arbitrary type `a` is no arithmetic, and the linear prover cannot
    // see the equations (a left inverse at x and y) that prove it. Only a goal over numbers is that prover's
    if (!hasProof && isLinearGoal(goal) && (!left || numericTerm(context, left))) {
      return
    }

    if (!left || !right) {
      return
    }

    // A GOAL OVER TRUTH VALUES DECIDES ITSELF, by its truth table, as a ring identity does by its normal form: a law
    // of flags needs no step (`either(s(x), t(x)) == either(t(x), s(x))`). And a false one is refused with the values
    // that break it, which is what a reader needs to fix it
    if (!hasProof && goal.op === '==') {
      try {
        const values = (pairs: [Expression, Expression][]): [Value, Value][] =>
          pairs.flatMap(([l, r]): [Value, Value][] => {
            const lt = expr(l, scope, context)
            const rt = expr(r, scope, context)

            return lt && rt ? [[evaluate(context.env, lt), evaluate(context.env, rt)]] : []
          })
        // the written guards first, then the universal instances (which a counterexample does not name)
        const stated = values(assumptions.slice(0, assumptions.length - instances.length))
        const given = [...stated, ...values(instances)]

        caseState.foldCase = { form: 'none' }
        caseState.counterexample = { form: 'none' }

        if (truthTable(context, evaluate(context.env, left), evaluate(context.env, right), given, stated.length)) {
          discharged.push(statement.span)
          recordLemmaRule(statement.name, goal, scope, context)

          return
        }

        // and an identity of the integers once the definitions run: `count(one()) == 1` is `0 + 1 == 1`, which the
        // kernel's postulated arithmetic cannot see and the ring does (`ringCase`), under the path's equations
        if (ringCase(context.level, evaluate(context.env, left), evaluate(context.env, right), given)) {
          discharged.push(statement.span)
          recordLemmaRule(statement.name, goal, scope, context)

          return
        }

        const found = counterexampleOf()

        // under a universal hypothesis the table saw it only at the goal's own terms, so its choice is a case the
        // hypotheses do not rule out there, not a counterexample to them everywhere
        if (found && !found.sides && (enclosingTheorem(program, statement)?.universals?.length ?? 0) > 0) {
          diagnostics.push(
            diagnose('invalid-proof', {
              file,
              span: statement.span,
              message: `this rule does not follow from its hypotheses at the terms it names: they all hold where ${found.text}, and the goal does not`,
              hint: 'a universal hypothesis is used only at the terms the goal and its guards name. State the term it is needed at, or change the statement',
            }),
          )

          return
        }

        if (found) {
          diagnostics.push(
            diagnose('invalid-proof', {
              file,
              span: statement.span,
              message: found.sides
                ? `this rule is FALSE: its two sides compute to ${found.sides[0]} and ${found.sides[1]}, whatever its seats are`
                : `this rule is FALSE where ${found.text}`,
              hint: 'no proof step makes a false law true. Change the statement, and check the values named above by hand',
            }),
          )

          return
        }
      } catch {
        // outside the table's reach: the paths below decide it
      }
    }

    // and a goal over a recursion of a task that takes a function (`total(f, n + 1) == ...`), with no step, that the
    // table did not decide, is the hold checker's: it reads the task's own equations (check/holds.ts
    // `recurrenceFacts`). Conversion here unfolds the recursion on a symbolic counter, each unfolding stuck on its test
    // and unfolded again inside its branches up to the fuel bound: seconds per goal, for what takes milliseconds there
    if (!hasProof && appliesHigherOrder(program, goal)) {
      return
    }

    try {
      const leftType = infer(context, left).type
      infer(context, right)

      const leftValue = evaluate(context.env, left)
      const rightValue = evaluate(context.env, right)

      // RECORD EXTENSIONALITY (eta / surjective pairing): two values of a record type are equal iff their projections
      // agree field by field. Since a projection reduces on a constructed record, this discharges `x == make r (x.f1)
      // (x.f2)` and any record equality whose fields are convertible. Sound: a record IS determined by its fields. This
      // uses the goal's type, which is available here at the hold level (the kernel's `convert` is untyped). A record
      // equality whose fields differ does NOT match, so it stays correctly unproven.
      if (goal.op === '==') {
        const recordName = headConstantName(
          quote(context.level, leftType),
        )
        const recordInfo = recordName
          ? recordFieldInfo.get(recordName)
          : undefined

        if (recordInfo && recordInfo.length > 0) {
          const project = (value: Value, field: string): Value =>
            evaluate(
              context.env,
              apply(
                constant(`${recordName}__${field}`),
                quote(context.level, value),
              ),
            )

          const allFieldsAgree = recordInfo.every(f =>
            areConvertible(
              context.level,
              project(leftValue, f.name),
              project(rightValue, f.name),
            ),
          )

          if (allFieldsAgree) {
            discharged.push(statement.span)
            recordLemmaRule(statement.name, goal, scope, context)

            return
          }
        }
      }

      // hypothesis-discharge (no induction): rewrite both sides by the path's `have` equations and check convertibility
      // modulo them. This proves the congruence / substitution laws (`a == b -> f a == f b`, transitivity of equality)
      // directly from their antecedents. Sound: an assumption is true on this path, so rewriting by it preserves truth.
      if (assumptions.length > 0) {
        const assumeHyps: [Value, Value][] = []
        const assumeRules: {
          binderCount: number
          lhs: Term
          rhs: Term
        }[] = []

        for (const [aLeft, aRight] of assumptions) {
          const lt = expr(aLeft, scope, context)
          const rt = expr(aRight, scope, context)

          if (lt && rt) {
            const lv = evaluate(context.env, lt)
            const rv = evaluate(context.env, rt)
            assumeHyps.push([lv, rv])
            assumeRules.push({
              binderCount: 0,
              lhs: quote(context.level, lv),
              rhs: quote(context.level, rv),
            })
          }
        }

        if (assumeRules.length > 0) {
          const lRewritten = evaluate(
            context.env,
            rewriteWithLemmas(
              quote(context.level, leftValue),
              assumeRules,
              200,
            ),
          )

          const rRewritten = evaluate(
            context.env,
            rewriteWithLemmas(
              quote(context.level, rightValue),
              assumeRules,
              200,
            ),
          )

          if (
            dischargeModulo(
              context.level,
              lRewritten,
              rRewritten,
              assumeHyps,
            )
          ) {
            discharged.push(statement.span)

            return
          }
        }
      }

      // definitional DISPROOF: with no explicit proof, if both sides compute to distinct numeric-literal constants the
      // equality is provably false (each literal is its own constant), so reject it outright instead of leaving it as a
      // soft unproven warning. This makes a false numeric claim the linear prover cannot reach -- e.g. one side is a task
      // call the kernel reduces to a literal -- fail compilation like every other false claim.
      if (!hasProof) {
        const leftLiteral = numericLiteralName(leftValue)
        const rightLiteral = numericLiteralName(rightValue)

        if (
          leftLiteral !== undefined &&
          rightLiteral !== undefined &&
          leftLiteral !== rightLiteral
        ) {
          diagnostics.push(
            diagnose('invalid-proof', {
              file,
              span: statement.span,
              message:
                'this equality is false: the two sides compute to different numbers',
            }),
          )

          return
        }
      }

      const verdict = checkProof(
        statement.proof,
        context.level,
        leftValue,
        rightValue,
      )

      if (verdict === 'ok') {
        discharged.push(statement.span)

        if (statement.name) {
          lemmas.set(statement.name, {
            left: showTerm(quote(context.level, leftValue)),
            right: showTerm(quote(context.level, rightValue)),
          })
          lemmaRules.set(statement.name, {
            binderCount: context.level,
            lhs: quote(context.level, leftValue),
            rhs: quote(context.level, rightValue),
          })
        }
      } else if (verdict === 'bad') {
        // a dangling reference (citing a lemma that does not exist) is a hard error: the goal being otherwise
        // provable cannot rescue a proof built on a name that names nothing
        diagnostics.push(
          diagnose('invalid-proof', {
            file,
            span: statement.span,
            message: 'this proof cites a lemma that does not exist',
          }),
        )
      } else if (verdict === 'fail') {
        // a `calm` / explicit tactic that did not close by definitional equality still succeeds if the goal is a
        // commutative-ring identity (`add a b == add b a`) or holds modulo the path hypotheses, so `calm hold`
        // robustly discharges a linear / ring law the user need not rewrite as a bare hold. Sound: `ringEqual` and
        // `ringEqualModulo` are decision procedures, firing only on genuine identities.
        const unfoldedLeft = unfoldDefinitions(goal.left, program)
        const unfoldedRight = unfoldDefinitions(goal.right, program)

        if (
          goal.op === '==' &&
          (ringEqual(unfoldedLeft, unfoldedRight) ||
            (assumptions.length > 0 &&
              ringEqualModulo(
                unfoldedLeft,
                unfoldedRight,
                assumptions.map(([l, r]) => ({ left: unfoldDefinitions(l, program), right: unfoldDefinitions(r, program) })),
              )))
        ) {
          discharged.push(statement.span)
          // register it as a citable lemma too, so a ring identity proven with `calm hold` is reusable like one proven
          // as a bare hold (consistent lemma registration across all sound discharge paths).
          recordLemmaRule(statement.name, goal, scope, context)
        } else {
          diagnostics.push(
            diagnose('invalid-proof', {
              file,
              span: statement.span,
              message: 'this proof does not establish the equality',
            }),
          )
        }
      }
      // 'open': leave it to the linear prover (checkHolds)
    } catch {
      // the sides did not elaborate / type-check: leave it to the linear prover
    }
  }

  const carried = carriedBodies(program)
  // the claims stated here: a task of one of these names is its PROOF, and a kernel type error in it is a proof that
  // does not prove its claim (`unverified-proof`, note/term/law-and-proof.md), not an ordinary mismatch
  const claimNames = new Set(
    program.flatMap(statement => (statement.form === 'function' && statement.claim ? [statement.name] : [])),
  )
  // the stubs first, so every body of this unit, and every proof inside one, can reduce through them
  const stubsFirst = [
    ...program.filter(statement => statement.form === 'function' && statement.stub),
    ...program.filter(statement => !(statement.form === 'function' && statement.stub)),
  ]

  for (const statement of stubsFirst) {
    if (statement.form !== 'function' || statement.claim) {
      // a claim is a signature, not a body
      continue
    }

    // A SEPARATE-COMPILATION STUB is elaborated only for its carried body (compile/stub.ts `stubBody`), and only when
    // this unit reaches it, so a proof here can run a task defined in another file. Its signature is registered above,
    // and its own unit verified the body and reported on it, so nothing about it is reported again here
    const stub = statement.stub === true

    if (stub && !carried.has(statement.name)) {
      continue
    }

    const task = stub ? { ...statement, body: statement.stubBody! } : statement

    if (!representable.has(statement.name)) {
      if (stub) {
        continue
      }

      declined.push({
        name: statement.name,
        reason: `its signature names a type the kernel cannot read (${unreadable.get(statement.name) ?? 'the signature'})`,
      })
      continue
    }

    // peel the function's kernel type pi-by-pi to build the body context: the leading generic binders, then the
    // value parameters (named into scope), leaving the result type. This handles generics and dependency uniformly.
    let context = baseContext

    const scope: Scope = new Map()

    let remaining: Value = evaluate(
      [],
      functionType.get(statement.name)!,
    )

    const genericLevels: number[] = []

    for (let i = 0; i < statement.generics.length; i++) {
      if (remaining.v !== 'pi') {
        break
      }

      const witness = neutralVar(context.level)
      genericLevels.push(context.level)
      const domain = remaining.domain
      const codomain = remaining.codomain
      context = bind(context, remaining.mult, domain, statement.generics[i]!.name)
      remaining = closeOver(codomain, witness)
    }

    for (const parameter of statement.params) {
      if (remaining.v !== 'pi') {
        break
      }

      const witness = neutralVar(context.level)
      scope.set(parameter.name, context.level)

      const domain = remaining.domain
      const codomain = remaining.codomain
      context = bind(context, remaining.mult, domain, parameter.name)
      remaining = closeOver(codomain, witness)
    }

    const resultValue = remaining
    // first try a pure term (proof-relevant); if the body is outside the pure fragment, type-check it as effectful
    // commands. Either way the kernel is the authority for the expression types.
    termState.genericLevels = genericLevels
    termState.generics = new Map(
      statement.generics
        .slice(0, genericLevels.length)
        .map((g, i) => [g.name, genericLevels[i]!]),
    )
    factsLocal = localNames(task)
    factsVolatile = volatileNames(task.body)
    ruleMarks = statement.theorem ? new Set(statement.params.map(param => param.name)) : new Set()

    // a stub that is a RULE carries its `show hold` as its body, so a `cite` of it here finds it as a lemma. Checking
    // it again registers the lemma and must report nothing: its own unit reported on it, and its spans are not ours
    const reported = stub ? { diagnostics: diagnostics.length, discharged: discharged.length } : undefined

    try {
      // inside the try: a refusal raised while the term is BUILT (a type-returning match on a large form) is reported
      // like one raised while it is checked, where it used to escape and end the compile
      const term = body(task.body, scope, context, resultValue)

      // a stub's body is only ever wanted as a definition to see through: one outside the pure fragment, or not shown
      // to end, stays opaque, and is checked and reported nowhere but its own unit
      if (stub) {
        if (term && terminating.has(statement.name) && factsPure.has(statement.name)) {
          check(context, term, resultValue)
          defineConstant(statement.name, evaluate([], lambdaOver(term, statement.generics.length + statement.params.length)))
        } else if (!term && statement.theorem) {
          checkCommands(task.body, scope, context, resultValue)
        }

        continue
      }

      if (term) {
        check(context, term, resultValue)

        // register a pure, termination-verified function as a transparent definition (delta), so the kernel can
        // see through its calls. Termination is the gate: a function whose recursion is not verified stays opaque,
        // so it can never make the checker loop (fuel-bounded delta is the additional backstop). Recursive
        // verified functions are included.
        // and purity is the second gate: an impure task's body is one run of it, not what every call answers
        if (terminating.has(statement.name) && factsPure.has(statement.name)) {
          defineConstant(statement.name, evaluate([], lambdaOver(term, statement.generics.length + statement.params.length)))
        }

        proven.push(statement.name)
      } else {
        checkCommands(statement.body, scope, context, resultValue)
      }

      verified.push(statement.name)
    } catch (error) {
      if (stub) {
        continue
      }

      // TERM_KERNEL_TRACE=1 prints where the kernel failed on a task, which the decline reason alone cannot say
      if (
        typeof process !== 'undefined' &&
        process.env?.TERM_KERNEL_TRACE &&
        !(error instanceof Decline)
      ) {
        console.error(`kernel trace for ${statement.name}:`, error)
      }

      declined.push({
        name: statement.name,
        reason:
          error instanceof Decline
            ? error.reason
            : error instanceof TypeError
              ? `a kernel type error: ${error.message}`
              : `the kernel failed on it: ${error instanceof Error ? error.message : String(error)}`,
      })

      if (error instanceof TypeError) {
        const proof = !statement.claim && claimNames.has(statement.name)

        diagnostics.push(
          diagnose(proof ? 'unverified-proof' : 'type-mismatch', {
            file,
            span: statement.span,
            message: proof
              ? `the proof of \`${statement.name}\` does not check against its claim, so it proves nothing: ${error.message}`
              : `kernel: ${error.message}`,
            ...(proof
              ? { hint: 'the type the claim states is printed over the type the proof builds. Change the proof, or the claim' }
              : {}),
          }),
        )
      }
      // Decline (unrepresentable) or any other error: leave this function to the surface checker, no diagnostic
    } finally {
      termState.genericLevels = []
      termState.generics = new Map()
      factsLocal = new Set()
      factsVolatile = new Set()
      ruleMarks = new Set()

      if (reported) {
        diagnostics.length = reported.diagnostics
        discharged.length = reported.discharged
      }
    }
  }

  // top-level proof obligations: a `hold` declared at module scope is kernel-checked here, AFTER the function loop has
  // registered every terminating function as a transparent definition, so a definitional proof can reduce through
  // them (e.g. `double 3` unfolds to `add 3 3`). Whatever the kernel leaves open is handled by the linear prover
  // (`checkHolds`), which also walks top-level holds.
  for (const statement of program) {
    if (statement.form === 'hold') {
      checkHold(statement, new Map(), baseContext)
    }
  }

  return { diagnostics, verified, proven, declined, discharged }
}

// the most branches the truth table's search visits (`truthTable`): every choice of thirteen flag atoms with nothing
// pruned, and far more once hypotheses prune. Past it the goal is left to the other provers, undecided
const TRUTH_TABLE_CHOICES = 16384

// the most instances of one universal hypothesis the kernel adds to a goal's path (`universalInstances`), the bound the
// hold checker keeps for its own (check/holds.ts `instances`)
const UNIVERSAL_INSTANCES = 512

// the span of an expression the kernel builds for the ring from its own terms (`ringCase`), which no source wrote
const NO_SPAN = { start: { line: 0, column: 0, offset: 0 }, end: { line: 0, column: 0, offset: 0 } }

// a body under one lambda per generic and parameter: the closed term a transparent definition is registered as
function lambdaOver(term: Term, count: number): Term {
  let lambda = term

  for (let i = 0; i < count; i++) {
    lambda = { tag: 'lam', body: lambda }
  }

  return lambda
}

// THE STUBS WHOSE CARRIED BODY THIS UNIT REACHES: named by one of its own statements, or by a body reached so. A unit
// reaches a few tasks of its dependency closure, so elaborating every carried body of the closure in every unit would
// pay for thousands to use a handful. Read by name, every text in a statement, as compile/stub.ts `namesUsed` does,
// which may take a few more than are called and never fewer
function carriedBodies(program: Program): Set<string> {
  const bodies = new Map<string, Statement[]>()

  for (const statement of program) {
    if (statement.form === 'function' && statement.stub && statement.stubBody) {
      bodies.set(statement.name, statement.stubBody)
    }
  }

  const reached = new Set<string>()

  if (bodies.size === 0) {
    return reached
  }

  const queue: unknown[] = program.filter(statement => !(statement.form === 'function' && statement.stub))

  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      const body = bodies.get(node)

      if (body && !reached.has(node)) {
        reached.add(node)
        queue.push(body)
      }
    } else if (Array.isArray(node)) {
      node.forEach(walk)
    } else if (node !== null && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        if (key !== 'span') {
          walk(value)
        }
      }
    }
  }

  while (queue.length > 0) {
    walk(queue.pop())
  }

  return reached
}
