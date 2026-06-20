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

import type { Diagnostic, Span } from '@/code/parser/diagnostic'
import { diagnose } from '@/code/parser/diagnostic'
import type {
  Expression,
  Program,
  Proof,
  Statement,
  Type,
} from '@/code/compile/node'
import type { Context, Term, Value } from '@/code/check/judge'
import {
  TypeError,
  areConvertible,
  bind,
  check,
  closeOver,
  contextWithSignature,
  defineConstant,
  evaluate,
  freshMeta,
  infer,
  litLevel,
  neutralVar,
  quote,
  resetDefinitions,
  resetMetas,
  showTerm,
} from '@/code/check/judge'
import { terminatingFunctions } from '@/code/check/totality'

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
function apply(fun: Term, ...args: Array<Term>): Term {
  return args.reduce<Term>(
    (f, a) => ({ tag: 'app', fun: f, arg: a }),
    fun,
  )
}

// ---- the base signature: base types and primitive operations as postulated kernel constants ----
// Built once. Each surface base type is a constant in Type 0; each primitive is a constant of its kernel type.
const BASE_TYPES = ['Number', 'Boolean', 'String', 'Unit'] as const
const number = constant('Number')
const boolean = constant('Boolean')

// a polymorphic, runtime-erased type argument is bound with multiplicity 0: present for typing, gone at run time.
// equal : (0 A : Type 0) -> A -> A -> Boolean    (so == works at any type, with the witness type erased)
const polyEquality = erasedPi(
  TYPE0,
  arrow(variable(0), arrow(variable(1), boolean)),
)
// cond : (0 A : Type 0) -> Boolean -> A -> A -> A    (the if-as-value eliminator, result type erased)
const conditional = erasedPi(
  TYPE0,
  arrow(boolean, arrow(variable(1), arrow(variable(2), variable(3)))),
)

const BASE_SIGNATURE: Array<{ name: string; type: Term }> = [
  ...BASE_TYPES.map(name => ({ name, type: TYPE0 })),
  // a canonical inhabitant per base type, so a literal elaborates to a genuine term of that type
  { name: 'numberValue', type: number },
  { name: 'stringValue', type: constant('String') },
  { name: 'unitValue', type: constant('Unit') },
  { name: 'boolTrue', type: boolean },
  { name: 'boolFalse', type: boolean },
  // arithmetic
  { name: 'add', type: arrow(number, arrow(number, number)) },
  { name: 'sub', type: arrow(number, arrow(number, number)) },
  { name: 'mul', type: arrow(number, arrow(number, number)) },
  { name: 'div', type: arrow(number, arrow(number, number)) },
  { name: 'mod', type: arrow(number, arrow(number, number)) },
  { name: 'neg', type: arrow(number, number) },
  // comparison
  { name: 'lt', type: arrow(number, arrow(number, boolean)) },
  { name: 'le', type: arrow(number, arrow(number, boolean)) },
  { name: 'gt', type: arrow(number, arrow(number, boolean)) },
  { name: 'ge', type: arrow(number, arrow(number, boolean)) },
  // logic
  { name: 'and', type: arrow(boolean, arrow(boolean, boolean)) },
  { name: 'or', type: arrow(boolean, arrow(boolean, boolean)) },
  { name: 'not', type: arrow(boolean, boolean) },
  // polymorphic equality and the conditional eliminator
  { name: 'equal', type: polyEquality },
  { name: 'notequal', type: polyEquality },
  { name: 'cond', type: conditional },
  // arrays: a type former and its constructors (element type erased)
  { name: 'Array', type: arrow(TYPE0, TYPE0) },
  {
    name: 'arrayEmpty',
    type: erasedPi(TYPE0, apply(constant('Array'), variable(0))),
  },
  {
    name: 'arrayPush',
    type: erasedPi(
      TYPE0,
      arrow(
        apply(constant('Array'), variable(0)),
        arrow(variable(1), apply(constant('Array'), variable(2))),
      ),
    ),
  },
]

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

// translate a surface type to a kernel type term at a given context depth. A named generic resolves to the de
// Bruijn variable of its binder (generics are bound first, as erased type parameters); a base or known named type
// resolves to its constant. Returns null if the type has no kernel encoding yet.
function kernelTypeAt(
  type: Type | undefined,
  depth: number,
  generics: Map<string, number>,
  known: Set<string>,
): Term | null {
  if (!type) return null
  switch (type.kind) {
    case 'number':
      return number
    case 'boolean':
      return boolean
    case 'string':
      return constant('String')
    case 'unit':
      return constant('Unit')
    case 'named': {
      const position = generics.get(type.name)
      if (position !== undefined) return variable(depth - position - 1) // a generic type parameter, by de Bruijn index
      return known.has(type.name) ? constant(type.name) : null
    }
    case 'array': {
      const element = kernelTypeAt(type.element, depth, generics, known)
      return element ? apply(constant('Array'), element) : null
    }
    default:
      return null // function / unknown / inference variable: not representable yet
  }
}

// the closed kernel case (no generics in scope), for signatures of named types and the like
const kernelType = (
  type: Type | undefined,
  known: Set<string>,
): Term | null => kernelTypeAt(type, 0, new Map(), known)

const isUnit = (term: Term): boolean =>
  term.tag === 'const' && term.name === 'Unit'

// thrown to abandon checking a construct the effect layer cannot represent yet (distinct from a real type error,
// which surfaces as the kernel's TypeError). A declined function is left to the surface checker, with no diagnostic.
class Decline extends Error {}
function need<T>(value: T | null): T {
  if (value === null) throw new Decline()
  return value
}

// the elaboration result: kernel diagnostics, plus which functions the kernel actually verified (versus declined
// as outside the covered fragment). The `verified` set is what proves the kernel did the work, not a rubber stamp.
export type ElaborationReport = {
  diagnostics: Array<Diagnostic>
  verified: Array<string>
  discharged: Array<Span>
}

// the pipeline entry point: just the diagnostics
export function elaborate(
  program: Program,
  file: string,
): Array<Diagnostic> {
  return elaborateReport(program, file).diagnostics
}

export function elaborateReport(
  program: Program,
  file: string,
): ElaborationReport {
  resetMetas()
  resetDefinitions()
  const terminating = terminatingFunctions(program) // gate for transparent definitions
  const diagnostics: Array<Diagnostic> = []
  const verified: Array<string> = []
  const discharged: Array<Span> = [] // holds the kernel proved by definitional equality (the non-linear fallback)
  const lemmas = new Map<string, { left: string; right: string }>() // named, proven `a == b` holds, for `cite`

  // named types we postulate as constants (record-types / enums), so they can appear in signatures
  const namedTypes = new Set<string>()
  for (const statement of program)
    if (statement.form === 'record-type') namedTypes.add(statement.name)

  // data: encode each record-type as kernel constants. A struct gets a constructor (make__r) and one projection
  // per field (r__field); an enum gets a constructor per variant and a non-dependent eliminator (match__e). All
  // sound postulates the kernel checks against, with their field/result types drawn from the declared types.
  const dataSignature: Array<{ name: string; type: Term }> = []
  const recordFields = new Map<string, Array<string>>() // record name -> field names in declaration order
  const variantNames = new Map<string, Array<string>>() // enum name -> variant names in declaration order
  const variantToEnum = new Map<string, string>() // variant name -> its enum
  const enumEncodings: Array<{ name: string; encoding: Term }> = [] // each enum's derived self-type encoding
  for (const statement of program) {
    if (statement.form !== 'record-type') continue
    const self = constant(statement.name)
    if (statement.variants.length > 0) {
      // an enum: a constructor per variant (carrying its field types) and a match eliminator
      const ok = statement.variants.every(variant =>
        variant.fields.every(f => kernelType(f.type, namedTypes)),
      )
      if (!ok) continue
      for (const variant of statement.variants) {
        const fieldTypes = variant.fields.map(
          f => kernelType(f.type, namedTypes)!,
        )
        dataSignature.push({
          name: variant.name,
          type: fieldTypes.reduceRight<Term>(
            (codomain, domain) => arrow(domain, codomain),
            self,
          ),
        })
        variantToEnum.set(variant.name, statement.name)
      }
      variantNames.set(
        statement.name,
        statement.variants.map(v => v.name),
      )
      // match__e : (0 A : Type0) -> e -> A -> ... -> A  (one branch result per variant; fields are not bound by
      // the surface match, so each branch is just a value of the result type). Built inside-out: the result A sits
      // under (subject + n branch) binders, and branch i's domain A sits under (subject + i-1) binders.
      const n = statement.variants.length
      let eliminator: Term = variable(n + 1) // result A, deepest
      for (let i = n; i >= 1; i--)
        eliminator = arrow(variable(i), eliminator) // branch i domain = A at index i
      eliminator = erasedPi(TYPE0, arrow(self, eliminator))
      dataSignature.push({
        name: `match__${statement.name}`,
        type: eliminator,
      })
      // derive the enum's self-type encoding: e = Self x. (P : e -> Type0) -> P v0 -> .. -> P vn -> P x. The enum
      // type then *is* its self-encoding (a transparent definition), not merely an opaque postulate. Constructors
      // and the eliminator above are exactly its introduction and elimination forms.
      const variants = statement.variants.map(v => v.name)
      let body: Term = apply(variable(n), variable(n + 1)) // P x
      for (let i = n - 1; i >= 0; i--)
        body = arrow(apply(variable(i), constant(variants[i]!)), body) // P v_i -> ..
      body = arrow(arrow(self, TYPE0), body) // (P : e -> Type0) -> ..
      enumEncodings.push({
        name: statement.name,
        encoding: { tag: 'self', body },
      })
    } else {
      // a struct: a constructor and one projection per field
      const ok = statement.fields.every(f =>
        kernelType(f.type, namedTypes),
      )
      if (!ok) continue
      const fieldTypes = statement.fields.map(
        f => kernelType(f.type, namedTypes)!,
      )
      dataSignature.push({
        name: `make__${statement.name}`,
        type: fieldTypes.reduceRight<Term>(
          (codomain, domain) => arrow(domain, codomain),
          self,
        ),
      })
      for (const field of statement.fields)
        dataSignature.push({
          name: `${statement.name}__${field.name}`,
          type: arrow(self, kernelType(field.type, namedTypes)!),
        })
      recordFields.set(
        statement.name,
        statement.fields.map(f => f.name),
      )
    }
  }

  // every function we can give a kernel type becomes a constant in the signature; its callers can then resolve it.
  // a generic function gains a leading erased type parameter (0 g : Type 0) per generic, so it is polymorphic in
  // the quantitative kernel and its type witnesses are erased at run time.
  const signature: Array<{ name: string; type: Term }> = [
    ...BASE_SIGNATURE,
    ...(namedTypes.size
      ? [...namedTypes].map(name => ({ name, type: TYPE0 }))
      : []),
    ...dataSignature,
  ]
  const functionType = new Map<string, Term>()
  const functionGenerics = new Map<string, number>() // function name -> number of leading type parameters
  const representable = new Set<string>()
  for (const statement of program) {
    if (statement.form !== 'function') continue
    const generics = new Map<string, number>()
    statement.generics.forEach((g, i) => generics.set(g.name, i))
    const arity = statement.generics.length + statement.params.length
    // result is at full depth (after all generic + value binders); each param at the depth before its own binder
    const resultType = kernelTypeAt(
      statement.result,
      arity,
      generics,
      namedTypes,
    )
    const paramTypes = statement.params.map((p, i) =>
      kernelTypeAt(
        p.type,
        statement.generics.length + i,
        generics,
        namedTypes,
      ),
    )
    if (!resultType || paramTypes.some(t => t === null)) continue
    // build inside-out: result, then value params (many), then erased generic type params (0)
    let type = (paramTypes as Array<Term>).reduceRight<Term>(
      (codomain, domain) => arrow(domain, codomain),
      resultType,
    )
    for (let i = 0; i < statement.generics.length; i++)
      type = erasedPi(TYPE0, type)
    functionType.set(statement.name, type)
    functionGenerics.set(statement.name, statement.generics.length)
    representable.add(statement.name)
    signature.push({ name: statement.name, type })
  }

  const baseContext = contextWithSignature(signature)
  // make each enum transparently equal to its derived self-type encoding, but only if that encoding type-checks as
  // a well-formed type (otherwise leave it as the postulated opaque type). The fuel-bounded delta keeps the
  // recursive reference safe.
  for (const { name, encoding } of enumEncodings) {
    try {
      if (infer(baseContext, encoding).type.v === 'type')
        defineConstant(name, evaluate([], encoding))
    } catch {
      // the encoding did not form: keep the postulated type, no derivation
    }
  }
  const TYPE0_VALUE = evaluate([], TYPE0)
  const NUMBER_VALUE = evaluate([], number)
  const BOOLEAN_VALUE = evaluate([], boolean)
  const isUnitValue = (value: Value): boolean => isUnit(quote(0, value))
  type Scope = Map<string, number> // surface name -> the context level at which it was bound

  // elaborate an expression to a kernel term in the given context, or null if out of the covered fragment
  function expr(
    node: Expression,
    scope: Scope,
    context: Context,
  ): Term | null {
    switch (node.form) {
      case 'integer':
      case 'float':
        return constant('numberValue')
      case 'string':
        return constant('stringValue')
      case 'boolean':
        return constant(node.value ? 'boolTrue' : 'boolFalse')
      case 'unit':
        return constant('unitValue')
      case 'variable': {
        const level = scope.get(node.name)
        if (level !== undefined)
          return variable(context.level - level - 1)
        if (functionType.has(node.name)) return constant(node.name) // a nullary function used as a value
        return null
      }
      case 'unary': {
        const operand = expr(node.operand, scope, context)
        if (!operand) return null
        return apply(constant(node.op === '-' ? 'neg' : 'not'), operand)
      }
      case 'binary': {
        const left = expr(node.left, scope, context)
        const right = expr(node.right, scope, context)
        if (!left || !right) return null
        if (node.op === '==' || node.op === '!=') {
          // polymorphic equality: synthesize the operand type from the kernel and pass it as the erased witness
          let witness: Term
          try {
            witness = quote(context.level, infer(context, left).type)
          } catch {
            return null
          }
          return apply(
            constant(node.op === '==' ? 'equal' : 'notequal'),
            witness,
            left,
            right,
          )
        }
        const op = OPERATOR[node.op]
        if (!op) return null
        return apply(constant(op), left, right)
      }
      case 'call': {
        if (
          node.callee.form !== 'variable' ||
          !functionType.has(node.callee.name)
        )
          return null
        // a generic call gets a fresh metavariable per type parameter; the kernel solves them from the value
        // arguments by unification (the type witnesses are erased, multiplicity 0)
        const typeArguments = Array.from(
          { length: functionGenerics.get(node.callee.name) ?? 0 },
          () => freshMeta(TYPE0_VALUE),
        )
        const args: Array<Term> = []
        for (const argument of node.args) {
          const term = expr(argument, scope, context)
          if (!term) return null
          args.push(term)
        }
        return apply(
          constant(node.callee.name),
          ...typeArguments,
          ...args,
        )
      }
      case 'member': {
        // p.field -> apply the field projection, after learning p's record type from the kernel
        const target = expr(node.target, scope, context)
        if (!target) return null
        let recordName: string | null = null
        try {
          const type = quote(context.level, infer(context, target).type)
          if (type.tag === 'const') recordName = type.name
        } catch {
          return null
        }
        if (recordName === null || !recordFields.has(recordName))
          return null
        if (!recordFields.get(recordName)!.includes(node.name))
          return null
        return apply(constant(`${recordName}__${node.name}`), target)
      }
      case 'record': {
        // a variant constructor (fieldless or applied), or a struct construction via make__r
        if (variantToEnum.has(node.name)) {
          const fieldValues: Array<Term> = []
          for (const field of node.fields) {
            const value = expr(field.value, scope, context)
            if (!value) return null
            fieldValues.push(value)
          }
          return apply(constant(node.name), ...fieldValues)
        }
        const order = recordFields.get(node.name)
        if (!order) return null
        const byName = new Map(node.fields.map(f => [f.name, f.value]))
        const args: Array<Term> = []
        for (const fieldName of order) {
          const value = byName.get(fieldName)
          if (!value) return null // a missing field: decline (the surface checker covers it)
          const term = expr(value, scope, context)
          if (!term) return null
          args.push(term)
        }
        return apply(constant(`make__${node.name}`), ...args)
      }
      case 'await':
        // await unwraps an async result; in this type model the awaited value has the inner type directly
        return expr(node.expr, scope, context)
      case 'array': {
        // [a, b, ...] -> arrayPush A (... (arrayEmpty A) a ...) b, with A the element type
        const items: Array<Term> = []
        for (const item of node.items) {
          const term = expr(item, scope, context)
          if (!term) return null
          items.push(term)
        }
        let element: Term
        if (items.length === 0) {
          element = freshMeta(TYPE0_VALUE)
        } else {
          try {
            element = quote(
              context.level,
              infer(context, items[0]!).type,
            )
          } catch {
            return null
          }
        }
        let result = apply(constant('arrayEmpty'), element)
        for (const item of items)
          result = apply(constant('arrayPush'), element, result, item)
        return result
      }
      default:
        return null // map / await / hole: not in the covered fragment yet
    }
  }

  // elaborate a statement body to a single kernel term of the result type, or null if out of the fragment. The
  // result type is carried as a value and re-quoted at the current depth wherever a term is needed, so generic
  // result types stay correctly indexed under inner binders.
  function body(
    statements: Array<Statement>,
    scope: Scope,
    context: Context,
    resultValue: Value,
  ): Term | null {
    if (statements.length === 0) return null
    const [head, ...tail] = statements
    switch (head!.form) {
      case 'return': {
        if (tail.length > 0) return null // unreachable code after a return
        if (!head!.value)
          return isUnit(quote(context.level, resultValue))
            ? constant('unitValue')
            : null
        return expr(head!.value, scope, context)
      }
      case 'let': {
        if (head!.mutable) return null // a reassignable binding is not a pure let; decline
        const value = expr(head!.init, scope, context)
        if (!value) return null
        let valueType
        try {
          valueType = infer(context, value).type
        } catch {
          return null
        }
        const inner = bind(context, 'many', valueType)
        const innerScope = new Map(scope).set(head!.name, context.level)
        const rest = body(tail, innerScope, inner, resultValue)
        if (!rest) return null
        // model `let x = v; rest` as an immediately-applied lambda: (\ (x : T). rest) v. The codomain is the result
        // type quoted one binder deeper (so any generic reference is shifted past the new binding).
        const lambda: Term = { tag: 'lam', body: rest }
        const piType: Term = arrow(
          quote(context.level, valueType),
          quote(context.level + 1, resultValue),
        )
        const annotated: Term = {
          tag: 'ann',
          term: lambda,
          type: piType,
        }
        return apply(annotated, value)
      }
      case 'if': {
        // the fall-through (or explicit else) is the final branch; require it so the value is total
        const elseStatements = head!.otherwise ?? tail
        if (head!.otherwise && tail.length > 0) return null // if/else followed by more code: decline
        if (elseStatements.length === 0) return null
        let result = body(elseStatements, scope, context, resultValue)
        if (!result) return null
        for (let i = head!.branches.length - 1; i >= 0; i--) {
          const branch = head!.branches[i]!
          const condition = expr(branch.cond, scope, context)
          const consequent = body(
            branch.body,
            scope,
            context,
            resultValue,
          )
          if (!condition || !consequent) return null
          result = apply(
            constant('cond'),
            quote(context.level, resultValue),
            condition,
            consequent,
            result,
          )
        }
        return result
      }
      case 'match': {
        // a match on an enum is its eliminator applied to the subject and one branch value per variant, in
        // declaration order. The eliminator binds no fields, so a branch that projects a variant field declines
        // (its body() returns null) and the surface checker covers it; an `otherwise` or missing variant also
        // declines (the eliminator is total over exactly the variants).
        if (tail.length > 0) return null // the match must produce the result (be the tail)
        if (head!.otherwise) return null
        const subject = expr(head!.subject, scope, context)
        if (!subject) return null
        let enumName: string | null = null
        try {
          const type = quote(
            context.level,
            infer(context, subject).type,
          )
          if (type.tag === 'const') enumName = type.name
        } catch {
          return null
        }
        const order = enumName ? variantNames.get(enumName) : undefined
        if (!order) return null
        const branches: Array<Term> = []
        for (const variant of order) {
          const branch = head!.cases.find(c => c.label === variant)
          if (!branch) return null // non-exhaustive against the eliminator: decline
          const term = body(branch.body, scope, context, resultValue)
          if (!term) return null
          branches.push(term)
        }
        return apply(
          constant(`match__${enumName}`),
          quote(context.level, resultValue),
          subject,
          ...branches,
        )
      }
      default:
        return null
    }
  }

  // check an explicit proof of `left == right`. 'ok' = proved, 'fail' = an explicit tactic that did not work,
  // 'open' = no proof or a tactic not yet supported (the linear prover then gets a chance). Implemented tactics:
  // `melt` / `calm` (definitional equality) and `cite` (a previously proven lemma of the same equality).
  function checkProof(
    proof: Array<Proof> | undefined,
    level: number,
    left: Value,
    right: Value,
  ): 'ok' | 'fail' | 'open' {
    if (!proof || proof.length === 0)
      return areConvertible(level, left, right) ? 'ok' : 'open'
    if (proof.length > 1) return 'open' // a sequence of top-level tactics is not lowered yet
    const tactic = proof[0]!
    const here = {
      left: showTerm(quote(level, left)),
      right: showTerm(quote(level, right)),
    }
    switch (tactic.head) {
      case 'melt':
      case 'calm':
        return areConvertible(level, left, right) ? 'ok' : 'fail'
      case 'cite': {
        const lemma = tactic.arg ? lemmas.get(tactic.arg) : undefined
        if (!lemma) return 'fail'
        // a cited lemma must state the same equality, in either orientation (== is symmetric)
        return (lemma.left === here.left &&
          lemma.right === here.right) ||
          (lemma.left === here.right && lemma.right === here.left)
          ? 'ok'
          : 'fail'
      }
      case 'turn': {
        // symmetry: prove a == b by citing the reversed lemma b == a
        const lemma = tactic.arg ? lemmas.get(tactic.arg) : undefined
        if (!lemma) return 'fail'
        return lemma.left === here.right && lemma.right === here.left
          ? 'ok'
          : 'fail'
      }
      case 'link': {
        // transitivity: a chain of cited lemmas a == m, m == ..., == b whose ends match the goal
        const steps = tactic.children
        if (steps.length === 0) return 'fail'
        const eqs: Array<{ left: string; right: string }> = []
        for (const step of steps) {
          if (step.head !== 'cite' || !step.arg) return 'open' // only chains of `cite` are lowered
          const lemma = lemmas.get(step.arg)
          if (!lemma) return 'fail'
          eqs.push(lemma)
        }
        if (eqs[0]!.left !== here.left) return 'fail'
        for (let i = 0; i < eqs.length - 1; i++)
          if (eqs[i]!.right !== eqs[i + 1]!.left) return 'fail'
        return eqs[eqs.length - 1]!.right === here.right ? 'ok' : 'fail'
      }
      default:
        return 'open' // a recognized but not-yet-lowered tactic (self / weld): fall back to the linear prover
    }
  }

  // the effect layer: type-check a statement body as imperative commands. Expressions are typed by the KERNEL (so
  // it stays the authority); control flow, mutation, loops, and match are typed structurally. This covers the
  // effectful surface (it is not a pure proof term). Throws Decline if anything is unrepresentable, or the
  // kernel's TypeError on a genuine mismatch. Threads the context through bindings.
  function checkCommands(
    statements: Array<Statement>,
    scope: Scope,
    context: Context,
    resultValue: Value,
  ): void {
    let sc = scope
    let ctx = context
    for (const statement of statements) {
      switch (statement.form) {
        case 'let': {
          const term = need(expr(statement.init, sc, ctx))
          const type = infer(ctx, term).type
          sc = new Map(sc).set(statement.name, ctx.level)
          ctx = bind(ctx, 'many', type)
          break
        }
        case 'assign': {
          const target = need(expr(statement.target, sc, ctx))
          const targetType = infer(ctx, target).type
          const value = need(expr(statement.value, sc, ctx))
          if (statement.op === '=') {
            check(ctx, value, targetType)
          } else {
            // compound arithmetic assignment (+=, -=, *=, /=): both sides are numbers
            check(ctx, target, NUMBER_VALUE)
            check(ctx, value, NUMBER_VALUE)
          }
          break
        }
        case 'expression':
          infer(ctx, need(expr(statement.expr, sc, ctx))) // ensure it is well-typed
          break
        case 'return':
          if (statement.value)
            check(
              ctx,
              need(expr(statement.value, sc, ctx)),
              resultValue,
            )
          else if (!isUnitValue(resultValue)) throw new Decline()
          break
        case 'if':
          for (const branch of statement.branches) {
            check(ctx, need(expr(branch.cond, sc, ctx)), BOOLEAN_VALUE)
            checkCommands(branch.body, sc, ctx, resultValue)
          }
          if (statement.otherwise)
            checkCommands(statement.otherwise, sc, ctx, resultValue)
          break
        case 'while':
          check(ctx, need(expr(statement.cond, sc, ctx)), BOOLEAN_VALUE)
          checkCommands(statement.body, sc, ctx, resultValue)
          break
        case 'for-each': {
          const iterable = need(expr(statement.iterable, sc, ctx))
          const iterableType = quote(
            ctx.level,
            infer(ctx, iterable).type,
          )
          if (
            iterableType.tag !== 'app' ||
            iterableType.fun.tag !== 'const' ||
            iterableType.fun.name !== 'Array'
          )
            throw new Decline()
          const elementType = evaluate(ctx.env, iterableType.arg)
          const innerScope = new Map(sc).set(statement.item, ctx.level)
          checkCommands(
            statement.body,
            innerScope,
            bind(ctx, 'many', elementType),
            resultValue,
          )
          break
        }
        case 'match': {
          const subject = need(expr(statement.subject, sc, ctx))
          const subjectType = quote(ctx.level, infer(ctx, subject).type)
          if (
            subjectType.tag !== 'const' ||
            !variantNames.has(subjectType.name)
          )
            throw new Decline()
          for (const branch of statement.cases)
            checkCommands(branch.body, sc, ctx, resultValue)
          if (statement.otherwise)
            checkCommands(statement.otherwise, sc, ctx, resultValue)
          break
        }
        case 'throw':
          infer(ctx, need(expr(statement.value, sc, ctx))) // a thrown value must still be well-typed
          break
        case 'hold': {
          // the kernel fallback / proof layer. A non-linear `a == b` hold is discharged when the two sides are
          // definitionally equal (delta makes a transparent `double(n)` equal to `add(n, n)`), or by an explicit
          // proof tree. A named hold that is discharged is registered as a lemma for later `cite`.
          const goal = statement.expr
          if (goal.form === 'binary' && goal.op === '==') {
            const left = expr(goal.left, sc, ctx)
            const right = expr(goal.right, sc, ctx)
            if (left && right) {
              try {
                infer(ctx, left)
                infer(ctx, right)
                const leftValue = evaluate(ctx.env, left)
                const rightValue = evaluate(ctx.env, right)
                const verdict = checkProof(
                  statement.proof,
                  ctx.level,
                  leftValue,
                  rightValue,
                )
                if (verdict === 'ok') {
                  discharged.push(statement.span)
                  if (statement.name)
                    lemmas.set(statement.name, {
                      left: showTerm(quote(ctx.level, leftValue)),
                      right: showTerm(quote(ctx.level, rightValue)),
                    })
                } else if (verdict === 'fail') {
                  diagnostics.push(
                    diagnose('invalid-proof', {
                      file,
                      span: statement.span,
                      message:
                        'this proof does not establish the equality',
                    }),
                  )
                }
                // 'open' (no proof, or a tactic not yet supported): leave it to the linear prover
              } catch {
                // the sides did not elaborate / type-check: leave it to the linear prover
              }
            }
          }
          break // never decline on a hold; the linear prover handles the rest
        }
        case 'break':
        case 'continue':
          break
        default:
          throw new Decline() // a nested declaration or anything else unhandled
      }
    }
  }

  for (const statement of program) {
    if (
      statement.form !== 'function' ||
      !representable.has(statement.name)
    )
      continue
    // peel the function's kernel type pi-by-pi to build the body context: the leading generic binders, then the
    // value parameters (named into scope), leaving the result type. This handles generics and dependency uniformly.
    let context = baseContext
    const scope: Scope = new Map()
    let remaining: Value = evaluate(
      [],
      functionType.get(statement.name)!,
    )
    for (let i = 0; i < statement.generics.length; i++) {
      if (remaining.v !== 'pi') break
      const witness = neutralVar(context.level)
      const domain = remaining.domain
      const codomain = remaining.codomain
      context = bind(context, remaining.mult, domain)
      remaining = closeOver(codomain, witness)
    }
    for (const parameter of statement.params) {
      if (remaining.v !== 'pi') break
      const witness = neutralVar(context.level)
      scope.set(parameter.name, context.level)
      const domain = remaining.domain
      const codomain = remaining.codomain
      context = bind(context, remaining.mult, domain)
      remaining = closeOver(codomain, witness)
    }
    const resultValue = remaining
    // first try a pure term (proof-relevant); if the body is outside the pure fragment, type-check it as effectful
    // commands. Either way the kernel is the authority for the expression types.
    const term = body(statement.body, scope, context, resultValue)
    try {
      if (term) {
        check(context, term, resultValue)
        // register a pure, termination-verified function as a transparent definition (delta), so the kernel can
        // see through its calls. Termination is the gate: a function whose recursion is not verified stays opaque,
        // so it can never make the checker loop (fuel-bounded delta is the additional backstop). Recursive
        // verified functions are included.
        if (terminating.has(statement.name)) {
          let lambda: Term = term
          for (
            let i = 0;
            i < statement.generics.length + statement.params.length;
            i++
          )
            lambda = { tag: 'lam', body: lambda }
          defineConstant(statement.name, evaluate([], lambda))
        }
      } else {
        checkCommands(statement.body, scope, context, resultValue)
      }
      verified.push(statement.name)
    } catch (error) {
      if (error instanceof TypeError) {
        diagnostics.push(
          diagnose('type-mismatch', {
            file,
            span: statement.span,
            message: `kernel: ${error.message}`,
          }),
        )
      }
      // Decline (unrepresentable) or any other error: leave this function to the surface checker, no diagnostic
    }
  }

  return { diagnostics, verified, discharged }
}
