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
import * as holds from '@term/make/code/check/elaborating-holds'
import * as main from '@term/make/code/check/elaborating-main'
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

// does a term have a FREE de Bruijn variable below `depth`, an index that escapes all its binders? The safety gate on
// a generated type: one that is not closed falls back to an opaque postulate. A null term is not closed
function hasFreeVar(term: Term | null, depth = 0): boolean {
  return !term ? true : elaborating.hasFreeVar(term as never, depth)
}

// ---- the base signature: base types and primitive operations as postulated kernel constants ----
const number = constant('Number')
const boolean = constant('Boolean')
const BASE_SIGNATURE = elaborating.baseSignature() as { name: string; type: Term }[]

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

    `${enumName}__${variant}`

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

  // check one `hold` proof obligation by the KERNEL (check/elaborating-holds.tree). A discharged hold's span is
  // recorded so the linear prover drops it, a named one becomes a citable lemma, a false explicit proof is an
  // `invalid-proof` error. What it asks of this face is one host: the facts, the unfolding table, induct.ts's folds,
  // holds.ts's `isLinearGoal`, `etaPair` (a spread), `diagnose` with exactly the input the original wrote, and
  // `callsItself`
  const holdState = {
    is: inductionState,
    host: {
      callsImpureExpression: (expression: unknown) => impure(expression as Expression),
      unfoldDefinitions: (expression: unknown) => unfoldDefinitions(expression as Expression, program),
      checkFold: (goal: unknown, inductVar: string) => checkFold(program, goal as Expression, inductVar),
      checkFoldOrder: (goal: unknown, inductVar: string, guards: unknown) =>
        checkFoldOrder(program, goal as Expression, inductVar, guards as Expression[]),
      isLinearGoal: (goal: unknown) => isLinearGoal(goal as Expression),
      etaPair: (left: unknown, right: unknown) => {
        const [l, r] = etaPair(left as Expression, right as Expression)

        return { left: l, right: r }
      },
      diagnose: (name: string, span: unknown, message: string, hint: string) =>
        diagnose(name as never, { file, span: span as Span, message, ...(hint ? { hint } : {}) }),
      callsItself: (statement: unknown) => callsItself(statement as Extract<Statement, { form: 'function' }>),
    },
    program,
    diagnostics,
    discharged,
  }

  function checkHold(
    statement: Extract<Statement, { form: 'hold' }>,
    scope: Scope,
    context: Context,
    assumptions: [Expression, Expression][] = [],
  ): void {
    viaKernel(() =>
      holds.checkHold(holdState as never, statement as never, scopeOf(scope), context as never, pairsFor(assumptions) as never),
    )
  }

  // The loop over the tasks and the top-level holds is check/elaborating-main.tree. This face sets each task's fact
  // names (`enter-task`: a stub's carried body spread over its own, as the original's `task` was) and prints the
  // `TERM_KERNEL_TRACE` line; the stubs whose carried body this unit reaches stay here (a reflective walk)
  const toSet = (names: Set<string>): Map<string, boolean> => new Map([...names].map(name => [name, true]))
  const mainState = {
    ts: termState,
    hs: holdState,
    commands: commandHost,
    host: {
      enterTask: (statement: unknown, stub: boolean) => {
        const fn = statement as Extract<Statement, { form: 'function' }>
        const task = stub ? { ...fn, body: fn.stubBody! } : fn
        factsLocal = localNames(task)
        factsVolatile = volatileNames(task.body)
        ruleMarks = fn.theorem ? new Set(fn.params.map(param => param.name)) : new Set()

        return true
      },
      leaveTask: () => {
        factsLocal = new Set()
        factsVolatile = new Set()
        ruleMarks = new Set()

        return true
      },
      trace: (name: string, message: string) => {
        // TERM_KERNEL_TRACE=1 prints where the kernel failed on a task, which the decline reason alone cannot say
        if (typeof process !== 'undefined' && process.env?.TERM_KERNEL_TRACE) {
          console.error(`kernel trace for ${name}:`, message)
        }

        return true
      },
    },
    baseContext,
    terminating: toSet(terminating),
    pure: toSet(factsPure),
    carried: toSet(carriedBodies(program)),
    verified,
    proven,
    declined,
  }

  viaKernel(() => main.checkProgram(mainState as never, program as never, file))

  return { diagnostics, verified, proven, declined, discharged }
}

// the span of an expression the kernel builds for the ring from its own terms (`ringCase`), which no source wrote
const NO_SPAN = { start: { line: 0, column: 0, offset: 0 }, end: { line: 0, column: 0, offset: 0 } }

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
