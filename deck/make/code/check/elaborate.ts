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
} from '@cluesurf/make/code/parser/diagnostic'
import { diagnose } from '@cluesurf/make/code/parser/diagnostic'
import type {
  Expression,
  Program,
  Proof,
  Statement,
  Type,
} from '@cluesurf/make/code/compile/node'
import type {
  Context,
  Term,
  Value,
} from '@cluesurf/make/code/check/judge'
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
  evaluate,
  freshMeta,
  infer,
  litLevel,
  neutralVar,
  quote,
  resetDefinitions,
  resetMetas,
  showTerm,
} from '@cluesurf/make/code/check/judge'
import { terminatingFunctions } from '@cluesurf/make/code/check/totality'
import { isLinearGoal } from '@cluesurf/make/code/check/holds'
import {
  ringEqual,
  nonNegativeDifference,
} from '@cluesurf/make/code/check/ring'
import { checkFold } from '@cluesurf/make/code/check/induct'

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

  for (let i = 0; i < count; i++) {term = { tag: 'lam', body: term }}

  return term
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

const BASE_SIGNATURE: { name: string; type: Term }[] = [
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
  if (!type) {return null}

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

      if (position !== undefined) {return variable(depth - position - 1)} // a generic type parameter, by de Bruijn index

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
  if (value === null) {throw new Decline()}

  return value
}

// the elaboration result: kernel diagnostics, plus which functions the kernel actually verified (versus declined
// as outside the covered fragment). The `verified` set is what proves the kernel did the work, not a rubber stamp.
export type ElaborationReport = {
  diagnostics: Diagnostic[]
  verified: string[]
  discharged: Span[]
}

// the pipeline entry point: just the diagnostics
export function elaborate(
  program: Program,
  file: string,
): Diagnostic[] {
  return elaborateReport(program, file).diagnostics
}

export function elaborateReport(
  program: Program,
  file: string,
): ElaborationReport {
  resetMetas()
  resetDefinitions()

  // gate for transparent definitions. Best-effort: a failure here just means no
  // function is treated as transparent (a sound, conservative fallback), never a
  // compiler crash.
  let terminating: Set<string>
  try {
    terminating = terminatingFunctions(program)
  } catch {
    terminating = new Set<string>()
  }
  const diagnostics: Diagnostic[] = []
  const verified: string[] = []
  const discharged: Span[] = [] // holds the kernel proved by definitional equality (the non-linear fallback)
  const lemmas = new Map<string, { left: string; right: string }>() // named, proven `a == b` holds, for `cite`
  // named, proven UNIVERSAL equational lemmas, stored as rewrite rules: `binderCount` leading universal binders (the
  // rule's `mark`s), and `lhs`/`rhs` quoted at that depth so their `var`s are the universal holes. Used by `fold ...`
  // with `cite <lemma>` children: each cited lemma is instantiated by first-order matching against the goal and fed in
  // as a ground hypothesis, so a proof can chain previously proven lemmas (e.g. commutativity over `n + 0 = n`).
  const lemmaRules = new Map<
    string,
    { binderCount: number; lhs: Term; rhs: Term }
  >()

  // named types we postulate as constants (record-types / enums), so they can appear in signatures
  const namedTypes = new Set<string>()

  for (const statement of program)
    {if (statement.form === 'record-type') {namedTypes.add(statement.name)}}

  // data: encode each record-type as kernel constants. A struct gets a constructor (make__r) and one projection
  // per field (r__field); an enum gets a constructor per variant and a non-dependent eliminator (match__e). All
  // sound postulates the kernel checks against, with their field/result types drawn from the declared types.
  const dataSignature: { name: string; type: Term }[] = []
  const recordFields = new Map<string, string[]>() // record name -> field names in declaration order
  const variantNames = new Map<string, string[]>() // enum name -> variant names in declaration order
  const variantToEnum = new Map<string, string>() // variant name -> its enum
  // variant name -> its fields (surface name + kernel type term), for binding them in a match branch
  const variantFieldInfo = new Map<
    string,
    { name: string; type: Term }[]
  >()
  const enumEncodings: { name: string; encoding: Term }[] = [] // each enum's derived self-type encoding
  const enumDefs: { name: string; term: Term }[] = [] // computing definitions for constructors + eliminators

  for (const statement of program) {
    if (statement.form !== 'record-type') {continue}

    const self = constant(statement.name)

    if (statement.variants.length > 0) {
      // an enum: a constructor per variant (carrying its field types) and a match eliminator
      const ok = statement.variants.every(variant =>
        variant.fields.every(f => kernelType(f.type, namedTypes)),
      )

      if (!ok) {continue}

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
        variantFieldInfo.set(
          variant.name,
          variant.fields.map((f, fi) => ({
            name: f.name,
            type: fieldTypes[fi]!,
          })),
        )
      }

      variantNames.set(
        statement.name,
        statement.variants.map(v => v.name),
      )

      // match__e : (0 A : Type0) -> e -> (F_0 -> A) -> ... -> (F_{k} -> A) -> A. Each branch carries its variant's
      // FIELD types, so a match on a constructor passes the fields to the branch (succ's branch is `Pred -> A`, not
      // `A`). This is what makes a field-carrying recursive function (plus) compute through the eliminator. The result A
      // sits under (subject + n branch) binders; inside branch i, under its own k field binders, A is at index i + k.
      const n = statement.variants.length

      let eliminator: Term = variable(n + 1) // result A, deepest

      for (let i = n; i >= 1; i--) {
        const fieldTs = statement.variants[i - 1]!.fields.map(
          f => kernelType(f.type, namedTypes)!,
        )
        const k = fieldTs.length

        // branch i's type: F_0 -> F_1 -> .. -> F_{k-1} -> A, with A at index i + k from the deepest point
        let branch: Term = variable(i + k)

        for (let j = k - 1; j >= 0; j--)
          {branch = arrow(fieldTs[j]!, branch)}

        eliminator = arrow(branch, eliminator)
      }

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
        {body = arrow(apply(variable(i), constant(variants[i]!)), body)} // P v_i -> ..

      body = arrow(arrow(self, TYPE0), body) // (P : e -> Type0) -> ..
      enumEncodings.push({
        name: statement.name,
        encoding: { tag: 'self', body },
      })

      // COMPUTING definitions for the constructors and eliminator (the Church / self-encoding lambdas), so the kernel
      // actually REDUCES `match (v_i) ... -> branch_i` rather than treating them as opaque postulates. With these,
      // `calm` (definitional equality) discharges `flip off = on`, `plus one one = two`, and the like.
      //   constructor v_i (k fields) = \f_0..f_{k-1}. \P. \b_0..b_{n-1}. b_i f_0 .. f_{k-1}
      //   eliminator match__e        = \A. \x. \b_0..b_{n-1}. x (\_. A) b_0 .. b_{n-1}
      // de Bruijn (innermost = 0): for a constructor, branches b_{n-1}..b_0 are 0..n-1, P is n, fields f_{k-1}..f_0
      // are n+1..n+k; for the eliminator, branches are 0..n-1, x is n, A is n+1.
      statement.variants.forEach((variant, i) => {
        const k = variant.fields.length
        let cbody: Term = variable(n - 1 - i) // b_i

        for (let j = 0; j < k; j++)
          {cbody = apply(cbody, variable(n + k - j))} // f_0 .. f_{k-1}

        enumDefs.push({
          name: variant.name,
          term: lambdas(k + 1 + n, cbody),
        })
      })

      const motive: Term = { tag: 'lam', body: variable(n + 2) } // \_. A
      let ebody: Term = apply(variable(n), motive) // x (\_. A)

      for (let j = 0; j < n; j++)
        {ebody = apply(ebody, variable(n - 1 - j))} // b_0 .. b_{n-1}

      enumDefs.push({
        name: `match__${statement.name}`,
        term: lambdas(n + 2, ebody),
      })
    } else {
      // a struct: a constructor and one projection per field
      const ok = statement.fields.every(f =>
        kernelType(f.type, namedTypes),
      )

      if (!ok) {continue}

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
        {dataSignature.push({
          name: `${statement.name}__${field.name}`,
          type: arrow(self, kernelType(field.type, namedTypes)!),
        })}

      recordFields.set(
        statement.name,
        statement.fields.map(f => f.name),
      )
    }
  }

  // every function we can give a kernel type becomes a constant in the signature; its callers can then resolve it.
  // a generic function gains a leading erased type parameter (0 g : Type 0) per generic, so it is polymorphic in
  // the quantitative kernel and its type witnesses are erased at run time.
  const signature: { name: string; type: Term }[] = [
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
    if (statement.form !== 'function') {continue}

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

    if (!resultType || paramTypes.some(t => t === null)) {continue}

    // build inside-out: result, then value params (many), then erased generic type params (0)
    let type = (paramTypes as Term[]).reduceRight<Term>(
      (codomain, domain) => arrow(domain, codomain),
      resultType,
    )

    for (let i = 0; i < statement.generics.length; i++)
      {type = erasedPi(TYPE0, type)}

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
        {defineConstant(name, evaluate([], encoding))}
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
          {return variable(context.level - level - 1)}

        if (functionType.has(node.name)) {return constant(node.name)} // a nullary function used as a value

        return null
      }

      case 'unary': {
        const operand = expr(node.operand, scope, context)

        if (!operand) {return null}

        return apply(constant(node.op === '-' ? 'neg' : 'not'), operand)
      }

      case 'binary': {
        const left = expr(node.left, scope, context)
        const right = expr(node.right, scope, context)

        if (!left || !right) {return null}

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

        if (!op) {return null}

        return apply(constant(op), left, right)
      }

      case 'call': {
        if (
          node.callee.form !== 'variable' ||
          !functionType.has(node.callee.name)
        )
          {return null}

        // a generic call gets a fresh metavariable per type parameter; the kernel solves them from the value
        // arguments by unification (the type witnesses are erased, multiplicity 0)
        const typeArguments = Array.from(
          { length: functionGenerics.get(node.callee.name) ?? 0 },
          () => freshMeta(TYPE0_VALUE),
        )

        const args: Term[] = []

        for (const argument of node.args) {
          const term = expr(argument, scope, context)

          if (!term) {return null}

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

        if (!target) {return null}

        let recordName: string | null = null

        try {
          const type = quote(context.level, infer(context, target).type)

          if (type.tag === 'const') {recordName = type.name}
        } catch {
          return null
        }

        if (recordName === null || !recordFields.has(recordName))
          {return null}

        if (!recordFields.get(recordName)!.includes(node.name))
          {return null}

        return apply(constant(`${recordName}__${node.name}`), target)
      }

      case 'record': {
        // a variant constructor (fieldless or applied), or a struct construction via make__r
        if (variantToEnum.has(node.name)) {
          const fieldValues: Term[] = []

          for (const field of node.fields) {
            const value = expr(field.value, scope, context)

            if (!value) {return null}

            fieldValues.push(value)
          }

          return apply(constant(node.name), ...fieldValues)
        }

        const order = recordFields.get(node.name)

        if (!order) {return null}

        const byName = new Map(node.fields.map(f => [f.name, f.value]))
        const args: Term[] = []

        for (const fieldName of order) {
          const value = byName.get(fieldName)

          if (!value) {return null} // a missing field: decline (the surface checker covers it)

          const term = expr(value, scope, context)

          if (!term) {return null}

          args.push(term)
        }

        return apply(constant(`make__${node.name}`), ...args)
      }

      case 'await':
        // await unwraps an async result; in this type model the awaited value has the inner type directly
        return expr(node.expr, scope, context)

      case 'array': {
        // [a, b, ...] -> arrayPush A (... (arrayEmpty A) a ...) b, with A the element type
        const items: Term[] = []

        for (const item of node.items) {
          const term = expr(item, scope, context)

          if (!term) {return null}

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
          {result = apply(constant('arrayPush'), element, result, item)}

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
    statements: Statement[],
    scope: Scope,
    context: Context,
    resultValue: Value,
  ): Term | null {
    if (statements.length === 0) {return null}

    const [head, ...tail] = statements

    switch (head!.form) {
      case 'return': {
        if (tail.length > 0) {return null} // unreachable code after a return

        if (!head.value)
          {return isUnit(quote(context.level, resultValue))
            ? constant('unitValue')
            : null}

        return expr(head.value, scope, context)
      }

      case 'let': {
        if (head.mutable) {return null} // a reassignable binding is not a pure let; decline

        const value = expr(head.init, scope, context)

        if (!value) {return null}

        let valueType

        try {
          valueType = infer(context, value).type
        } catch {
          return null
        }

        const inner = bind(context, 'many', valueType)
        const innerScope = new Map(scope).set(head.name, context.level)
        const rest = body(tail, innerScope, inner, resultValue)

        if (!rest) {return null}

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
        const elseStatements = head.otherwise ?? tail

        if (head.otherwise && tail.length > 0) {return null} // if/else followed by more code: decline

        if (elseStatements.length === 0) {return null}

        let result = body(elseStatements, scope, context, resultValue)

        if (!result) {return null}

        for (let i = head.branches.length - 1; i >= 0; i--) {
          const branch = head.branches[i]!
          const condition = expr(branch.cond, scope, context)
          const consequent = body(
            branch.body,
            scope,
            context,
            resultValue,
          )

          if (!condition || !consequent) {return null}

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
        if (tail.length > 0) {return null} // the match must produce the result (be the tail)

        if (head.otherwise) {return null}

        const subject = expr(head.subject, scope, context)

        if (!subject) {return null}

        let enumName: string | null = null

        try {
          const type = quote(
            context.level,
            infer(context, subject).type,
          )

          if (type.tag === 'const') {enumName = type.name}
        } catch {
          return null
        }

        const order = enumName ? variantNames.get(enumName) : undefined

        if (!order) {return null}

        const branches: Term[] = []

        for (const variant of order) {
          const branch = head.cases.find(c => c.label === variant)

          if (!branch) {return null} // non-exhaustive against the eliminator: decline

          // bind the variant's fields: each branch is a lambda over its fields (the eliminator passes them in), with
          // the fields in scope in the branch body. `succ p`'s branch becomes `\p. <body using p>`.
          const fieldInfo = variantFieldInfo.get(variant) ?? []
          let branchScope = scope
          let branchContext = context

          fieldInfo.forEach((field, fieldIndex) => {
            // honor a `binds` field-rename on the branch, else the variant's declared field name
            const localName = branch.binds?.[fieldIndex] ?? field.name
            branchScope = new Map(branchScope).set(
              localName,
              branchContext.level,
            )
            branchContext = bind(
              branchContext,
              'many',
              evaluate([], field.type),
            )
          })

          const inner = body(
            branch.body,
            branchScope,
            branchContext,
            resultValue,
          )

          if (!inner) {return null}

          // wrap the body in one lambda per field, innermost field last
          let term = inner

          for (let w = 0; w < fieldInfo.length; w++)
            {term = { tag: 'lam', body: term }}

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
    proof: Proof[] | undefined,
    level: number,
    left: Value,
    right: Value,
  ): 'ok' | 'fail' | 'open' {
    if (!proof || proof.length === 0)
      {return areConvertible(level, left, right) ? 'ok' : 'open'}

    if (proof.length > 1) {return 'open'} // a sequence of top-level tactics is not lowered yet

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

        if (!lemma) {return 'fail'}

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

        if (!lemma) {return 'fail'}

        return lemma.left === here.right && lemma.right === here.left
          ? 'ok'
          : 'fail'
      }

      case 'link': {
        // transitivity: a chain of cited lemmas a == m, m == ..., == b whose ends match the goal
        const steps = tactic.children

        if (steps.length === 0) {return 'fail'}

        const eqs: { left: string; right: string }[] = []

        for (const step of steps) {
          if (step.head !== 'cite' || !step.arg) {return 'open'} // only chains of `cite` are lowered

          const lemma = lemmas.get(step.arg)

          if (!lemma) {return 'fail'}

          eqs.push(lemma)
        }

        if (eqs[0]!.left !== here.left) {return 'fail'}

        for (let i = 0; i < eqs.length - 1; i++)
          {if (eqs[i]!.right !== eqs[i + 1]!.left) {return 'fail'}}

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
    statements: Statement[],
    scope: Scope,
    context: Context,
    resultValue: Value,
    // equation hypotheses true on this control-flow path: each `have`/`if` guard that is an equation `L == R` is added
    // (as its two side EXPRESSIONS, so an induction can re-elaborate and specialize them per case) for the branch it
    // governs, so a `hold` inside can be discharged USING its antecedents (the hypothesis-discharge path:
    // `a == b -> f a == f b`, cancellation, and inductive implications).
    assumptions: [Expression, Expression][] = [],
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
            {check(
              ctx,
              need(expr(statement.value, sc, ctx)),
              resultValue,
            )}
          else if (!isUnitValue(resultValue)) {throw new Decline()}

          break
        case 'if':
          for (const branch of statement.branches) {
            check(ctx, need(expr(branch.cond, sc, ctx)), BOOLEAN_VALUE)

            // an equation guard (`have a == b`) is assumed true inside its branch
            const branchAssumptions = [...assumptions]
            const cond = branch.cond

            if (cond.form === 'binary' && cond.op === '==')
              {branchAssumptions.push([cond.left, cond.right])}

            checkCommands(
              branch.body,
              sc,
              ctx,
              resultValue,
              branchAssumptions,
            )
          }

          if (statement.otherwise)
            {checkCommands(
              statement.otherwise,
              sc,
              ctx,
              resultValue,
              assumptions,
            )}

          break
        case 'while':
          check(ctx, need(expr(statement.cond, sc, ctx)), BOOLEAN_VALUE)
          checkCommands(statement.body, sc, ctx, resultValue, assumptions)
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
            {throw new Decline()}

          const elementType = evaluate(ctx.env, iterableType.arg)
          const innerScope = new Map(sc).set(statement.item, ctx.level)
          checkCommands(
            statement.body,
            innerScope,
            bind(ctx, 'many', elementType),
            resultValue,
            assumptions,
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
            {throw new Decline()}

          for (const branch of statement.cases)
            {checkCommands(branch.body, sc, ctx, resultValue, assumptions)}

          if (statement.otherwise)
            {checkCommands(
              statement.otherwise,
              sc,
              ctx,
              resultValue,
              assumptions,
            )}

          break
        }

        case 'throw':
          infer(ctx, need(expr(statement.value, sc, ctx))) // a thrown value must still be well-typed
          break

        case 'hold': {
          // the kernel fallback / proof layer. A non-linear `a == b` hold is discharged when the two sides are
          // definitionally equal (delta makes a transparent `double(n)` equal to `add(n, n)`), or by an explicit
          // proof tree. A named hold that is discharged is registered as a lemma for later `cite`. An undischarged
          // hold here is left to the linear prover (topLevel = false, so no unchecked flag). Path assumptions (the
          // enclosing `have`/`if` equation guards) are passed so the goal can be discharged using its antecedents.
          checkHold(statement, sc, ctx, assumptions)
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

  // structural equality of two kernel terms (for matching folded normal forms; both come from `quote`, so a syntactic
  // comparison is exact up to the shared readback).
  function termsEqual(a: Term, b: Term): boolean {
    return showTerm(a) === showTerm(b)
  }

  // first-order match: bind the pattern's universal holes (its `var`s, at indices below `binders`) to subterms of the
  // subject so that the instantiated pattern equals the subject. `depth` tracks binders crossed inside the pattern (a
  // var at or above `depth` is a hole; below it is locally bound). Returns false on any clash. Used to instantiate a
  // cited lemma against the goal.
  function matchPattern(
    pattern: Term,
    subject: Term,
    binders: number,
    depth: number,
    subst: Map<number, Term>,
  ): boolean {
    if (pattern.tag === 'var' && pattern.index - depth >= 0 && pattern.index - depth < binders) {
      const hole = pattern.index - depth
      const prior = subst.get(hole)

      if (prior) {return termsEqual(prior, subject)}

      subst.set(hole, subject)

      return true
    }

    if (pattern.tag !== subject.tag) {return false}

    switch (pattern.tag) {
      case 'var':
        return subject.tag === 'var' && pattern.index === subject.index
      case 'const':
        return subject.tag === 'const' && pattern.name === subject.name
      case 'app':
        return (
          subject.tag === 'app' &&
          matchPattern(pattern.fun, subject.fun, binders, depth, subst) &&
          matchPattern(pattern.arg, subject.arg, binders, depth, subst)
        )
      case 'lam':
        return (
          subject.tag === 'lam' &&
          matchPattern(pattern.body, subject.body, binders, depth + 1, subst)
        )
      default:
        // other shapes (pi, sigma, id, ...) do not occur in the first-order equational lemmas we cite
        return termsEqual(pattern, subject)
    }
  }

  // substitute a lemma's hole assignments into its rhs (the holes are the `var`s below `binders`), yielding a concrete
  // term in the goal's context. No inner binders occur in these first-order lemmas, so a plain replacement is exact.
  function instantiate(
    rhs: Term,
    binders: number,
    depth: number,
    subst: Map<number, Term>,
  ): Term | null {
    if (rhs.tag === 'var' && rhs.index - depth >= 0 && rhs.index - depth < binders) {
      const value = subst.get(rhs.index - depth)

      return value ?? null
    }

    switch (rhs.tag) {
      case 'app': {
        const fun = instantiate(rhs.fun, binders, depth, subst)
        const arg = instantiate(rhs.arg, binders, depth, subst)

        return fun && arg ? { tag: 'app', fun, arg } : null
      }
      case 'lam': {
        const body = instantiate(rhs.body, binders, depth + 1, subst)

        return body ? { tag: 'lam', body } : null
      }
      default:
        return rhs
    }
  }

  // rewrite a term ONCE by a lemma (left-to-right): find the leftmost-outermost subterm matching the lemma's lhs and
  // replace it with the instantiated rhs. Returns the rewritten term, or null if the lemma does not fire anywhere.
  function rewriteOnce(
    target: Term,
    rule: { binderCount: number; lhs: Term; rhs: Term },
  ): Term | null {
    const subst = new Map<number, Term>()

    if (matchPattern(rule.lhs, target, rule.binderCount, 0, subst)) {
      const rhs = instantiate(rule.rhs, rule.binderCount, 0, subst)

      if (rhs) {return rhs}
    }

    switch (target.tag) {
      case 'app': {
        const fun = rewriteOnce(target.fun, rule)

        if (fun) {return { tag: 'app', fun, arg: target.arg }}

        const arg = rewriteOnce(target.arg, rule)

        if (arg) {return { tag: 'app', fun: target.fun, arg }}

        return null
      }
      case 'lam': {
        const body = rewriteOnce(target.body, rule)

        return body ? { tag: 'lam', body } : null
      }
      default:
        return null
    }
  }

  // rewrite a term to a fixed point by a set of lemmas (directed left-to-right), bounded by fuel so a non-terminating
  // rewrite set cannot loop. Each rewrite replaces a subterm by a provably equal one, so the result equals the input.
  function rewriteWithLemmas(
    target: Term,
    rules: { binderCount: number; lhs: Term; rhs: Term }[],
    fuel: number,
  ): Term {
    let current = target
    let budget = fuel

    while (budget > 0) {
      let progressed = false

      for (const rule of rules) {
        const next = rewriteOnce(current, rule)

        if (next) {
          current = next
          progressed = true
          budget--
          break
        }
      }

      if (!progressed) {break}
    }

    return current
  }

  // is this rule a commutativity statement `f a b == f b a`? returns the operator constant name, or null.
  function commutativityOperator(rule: {
    binderCount: number
    lhs: Term
    rhs: Term
  }): string | null {
    const { lhs, rhs } = rule

    if (
      lhs.tag === 'app' &&
      lhs.fun.tag === 'app' &&
      lhs.fun.fun.tag === 'const' &&
      lhs.fun.arg.tag === 'var' &&
      lhs.arg.tag === 'var' &&
      lhs.fun.arg.index !== lhs.arg.index &&
      rhs.tag === 'app' &&
      rhs.fun.tag === 'app' &&
      rhs.fun.fun.tag === 'const' &&
      rhs.fun.fun.name === lhs.fun.fun.name &&
      rhs.fun.arg.tag === 'var' &&
      rhs.arg.tag === 'var' &&
      rhs.fun.arg.index === lhs.arg.index &&
      rhs.arg.index === lhs.fun.arg.index
    )
      {return lhs.fun.fun.name}

    return null
  }

  // is this rule an associativity statement `f (f a b) c == f a (f b c)`? returns the operator name, or null.
  function associativityOperator(rule: {
    binderCount: number
    lhs: Term
    rhs: Term
  }): string | null {
    const { lhs, rhs } = rule
    const op = (t: Term): string | null =>
      t.tag === 'app' && t.fun.tag === 'app' && t.fun.fun.tag === 'const'
        ? t.fun.fun.name
        : null
    const left = (t: Term): Term | null =>
      t.tag === 'app' && t.fun.tag === 'app' ? t.fun.arg : null
    const right = (t: Term): Term | null =>
      t.tag === 'app' ? t.arg : null
    const f = op(lhs)

    if (!f || op(rhs) !== f) {return null}

    const ll = left(lhs)
    const lr = right(lhs)
    const rl = left(rhs)
    const rr = right(rhs)

    // lhs inner is on the LEFT: f (f a b) c ; rhs inner is on the RIGHT: f a (f b c)
    if (ll && op(ll) === f && rr && op(rr) === f) {return f}

    return null
  }

  // flatten a nested chain of one AC operator into its operand list (so `f (f a b) c` and `f a (f b c)` both flatten to
  // [a, b, c]). Returns null if the term is not headed by an AC operator.
  function flattenAc(
    term: Term,
    operators: Set<string>,
  ): { op: string; operands: Term[] } | null {
    if (
      term.tag !== 'app' ||
      term.fun.tag !== 'app' ||
      term.fun.fun.tag !== 'const' ||
      !operators.has(term.fun.fun.name)
    )
      {return null}

    const op = term.fun.fun.name
    const operands: Term[] = []

    for (const side of [term.fun.arg, term.arg]) {
      const inner = flattenAc(side, operators)

      if (inner && inner.op === op) {operands.push(...inner.operands)}
      else {operands.push(side)}
    }

    return { op, operands }
  }

  // normalize a term modulo associativity and commutativity of the given operators: flatten each AC chain, normalize and
  // canonically sort its operands, and rebuild a right-nested tree. Two AC-equal terms get identical normal forms, so a
  // law that only needs to commute and reassociate a sum (which a directed rewrite cannot do, as commutativity loops)
  // closes by syntactic equality. Sound: only operators PROVEN both commutative and associative are passed in.
  function acNormalize(term: Term, operators: Set<string>): Term {
    const flat = flattenAc(term, operators)

    if (flat) {
      const parts = flat.operands
        .map(part => acNormalize(part, operators))
        .sort((a, b) => {
          const sa = showTerm(a)
          const sb = showTerm(b)

          return sa < sb ? -1 : sa > sb ? 1 : 0
        })

      return parts.reduceRight((acc, part) => ({
        tag: 'app',
        fun: { tag: 'app', fun: constant(flat.op), arg: part },
        arg: acc,
      }))
    }

    switch (term.tag) {
      case 'app':
        return {
          tag: 'app',
          fun: acNormalize(term.fun, operators),
          arg: acNormalize(term.arg, operators),
        }
      case 'lam':
        return { tag: 'lam', body: acNormalize(term.body, operators) }
      default:
        return term
    }
  }

  // rewrite a term modulo associativity-commutativity: a rule whose lhs is itself an AC chain `f(l1, .. lk)` fires when
  // its operands are a SUB-MULTISET of some `f`-chain in the term, replacing those operands by the rule's rhs. This is
  // AC MATCHING: it lets the induction hypothesis `a + b = c` apply inside a larger sum `a + x + b` (which AC
  // normalization alone could not, since `a + b` is not a syntactic subterm). Used for the closed Fibonacci / sum
  // identities. Sound: f is a congruence and the rule equates its two sides, so swapping the matched operands preserves
  // the value. Bounded by fuel.
  function acRewriteAt(
    term: Term,
    operators: Set<string>,
    rules: { lhs: Term; rhs: Term }[],
  ): Term | null {
    const flat = flattenAc(term, operators)

    if (flat) {
      const operandKeys = flat.operands.map(showTerm)

      for (const rule of rules) {
        const lhsFlat = flattenAc(rule.lhs, operators)

        if (!lhsFlat || lhsFlat.op !== flat.op) {continue}

        // does the rule's lhs chain occur as a sub-multiset of this chain?
        const used = new Array(flat.operands.length).fill(false)
        let matched = true

        for (const need of lhsFlat.operands.map(showTerm)) {
          const at = operandKeys.findIndex(
            (k, i) => !used[i] && k === need,
          )

          if (at < 0) {
            matched = false
            break
          }

          used[at] = true
        }

        if (!matched) {continue}

        const keep = flat.operands.filter((_, i) => !used[i])
        const rhsFlat = flattenAc(rule.rhs, operators)
        const rhsOperands =
          rhsFlat && rhsFlat.op === flat.op
            ? rhsFlat.operands
            : [rule.rhs]
        const next = [...keep, ...rhsOperands]

        if (next.length === 0) {return rule.rhs}

        return next.reduceRight((acc, part) => ({
          tag: 'app',
          fun: { tag: 'app', fun: constant(flat.op), arg: part },
          arg: acc,
        }))
      }
    }

    switch (term.tag) {
      case 'app': {
        const fun = acRewriteAt(term.fun, operators, rules)

        if (fun) {return { tag: 'app', fun, arg: term.arg }}

        const arg = acRewriteAt(term.arg, operators, rules)

        if (arg) {return { tag: 'app', fun: term.fun, arg }}

        return null
      }
      case 'lam': {
        const body = acRewriteAt(term.body, operators, rules)

        return body ? { tag: 'lam', body } : null
      }
      default:
        return null
    }
  }

  // AC-rewrite to a fixed point, INTERLEAVING the directed syntactic rewrites (so a sub-term the AC step introduces,
  // like the hypothesis's right side, is itself reduced by the cited lemmas) and renormalizing between steps so the
  // canonical form is compared.
  function acRewriteFix(
    term: Term,
    operators: Set<string>,
    acRules: { lhs: Term; rhs: Term }[],
    syntacticRules: { binderCount: number; lhs: Term; rhs: Term }[],
    fuel: number,
  ): Term {
    const reduce = (t: Term): Term =>
      acNormalize(rewriteWithLemmas(t, syntacticRules, 200), operators)

    let current = reduce(term)

    for (let i = 0; i < fuel; i++) {
      const next = acRewriteAt(current, operators, acRules)

      if (!next) {break}

      current = reduce(next)
    }

    return current
  }

  // which constructor (by declaration index) a value of an enum reduces to, or null if it is not a manifest constructor
  // of that enum. Built by running the enum's eliminator with each branch returning a distinct projection function
  // (variant i -> the function that selects its i-th argument), then matching the result against those projections.
  // Sound and precise: it returns an index only when the value really IS that constructor (a neutral stays unmatched).
  function constructorIndex(
    level: number,
    value: Value,
    enumName: string,
  ): number | null {
    const order = variantNames.get(enumName)

    if (!order) {return null}

    const n = order.length
    // the n distinct separators: separator_i = \a0..a_{n-1}. a_i (pairwise non-convertible)
    const separators = order.map((_, i) =>
      evaluate([], lambdas(n, variable(n - 1 - i))),
    )
    // branch_i : (its fields) -> separator_i ; ignores the fields, returns the i-th separator
    const branches = order.map((variant, i) => {
      const fieldCount = (variantFieldInfo.get(variant) ?? []).length

      return lambdas(fieldCount + n, variable(n - 1 - i))
    })

    const idEnv: Value[] = []

    for (let l = level - 1; l >= 0; l--) {idEnv.push(neutralVar(l))}

    const discriminated = evaluate(
      idEnv,
      apply(
        constant(`match__${enumName}`),
        TYPE0,
        quote(level, value),
        ...branches,
      ),
    )

    for (let i = 0; i < n; i++)
      {if (areConvertible(level, discriminated, separators[i]!))
        {return i}}

    return null
  }

  // is an equation hypothesis ABSURD, i.e. does it equate two DISTINCT constructors of the same enum? Constructors are
  // disjoint (no confusion), so such an equation cannot hold, which makes its case vacuously true. This is what lets a
  // conditional theorem (like the transitivity of an order) discharge the cases whose antecedent is impossible.
  function equationAbsurd(
    context: Context,
    leftTerm: Term,
    leftValue: Value,
    rightValue: Value,
  ): boolean {
    try {
      const type = quote(context.level, infer(context, leftTerm).type)

      if (type.tag !== 'const' || !variantNames.has(type.name))
        {return false}

      const iLeft = constructorIndex(context.level, leftValue, type.name)
      const iRight = constructorIndex(context.level, rightValue, type.name)

      return iLeft !== null && iRight !== null && iLeft !== iRight
    } catch {
      return false
    }
  }

  // close one induction case: given the two sides of the case goal and the hypotheses in force (the induction
  // hypotheses, the specialized path assumptions), discharge it. Cited lemmas are applied as directed rewrites; an
  // operator proven both commutative and associative is normalized modulo AC; the rest is convertibility modulo the
  // hypotheses. Shared by single-variable `structuralInduction` and multi-variable `multiInduction`.
  function closeCase(
    level: number,
    env: Value[],
    caseLeft: Value,
    caseRight: Value,
    hypotheses: [Value, Value][],
    citedLemmas: string[],
  ): boolean {
    const acOperators = new Set<string>()
    const commutative = new Set<string>()
    const associative = new Set<string>()

    for (const name of citedLemmas) {
      const rule = lemmaRules.get(name)

      if (!rule) {continue}

      const c = commutativityOperator(rule)

      if (c) {commutative.add(c)}

      const a = associativityOperator(rule)

      if (a) {associative.add(a)}
    }

    for (const op of commutative)
      {if (associative.has(op)) {acOperators.add(op)}}

    const rewriteRules: { binderCount: number; lhs: Term; rhs: Term }[] =
      hypotheses.map(([ihLeft, ihRight]) => ({
        binderCount: 0,
        lhs: quote(level, ihLeft),
        rhs: quote(level, ihRight),
      }))

    for (const name of citedLemmas) {
      const rule = lemmaRules.get(name)

      if (!rule) {continue}

      const c = commutativityOperator(rule)
      const a = associativityOperator(rule)

      if ((c && acOperators.has(c)) || (a && acOperators.has(a)))
        {continue}

      rewriteRules.push(rule)
    }

    const leftTermRewritten = rewriteWithLemmas(
      quote(level, caseLeft),
      rewriteRules,
      200,
    )
    const rightTermRewritten = rewriteWithLemmas(
      quote(level, caseRight),
      rewriteRules,
      200,
    )

    if (acOperators.size > 0) {
      // the hypotheses (and ground lemma instances) whose lhs is itself an AC chain can fire modulo AC, applying inside
      // a larger sum than a syntactic match would reach (this closes the inductive sum identities).
      const acRules = rewriteRules.filter(
        rule =>
          rule.binderCount === 0 &&
          flattenAc(rule.lhs, acOperators) !== null,
      )

      const lacf = acRewriteFix(
        leftTermRewritten,
        acOperators,
        acRules,
        rewriteRules,
        64,
      )
      const racf = acRewriteFix(
        rightTermRewritten,
        acOperators,
        acRules,
        rewriteRules,
        64,
      )

      if (showTerm(lacf) === showTerm(racf)) {return true}
    }

    return dischargeModulo(
      level,
      evaluate(env, leftTermRewritten),
      evaluate(env, rightTermRewritten),
      hypotheses,
    )
  }

  // structural induction over an inductive self-type: the `fold <var>` tactic when <var> ranges over a record-type
  // enum. Proves a universal equation L(x) == R(x) for ALL x of the type by checking one case per constructor, using
  // the induction hypothesis on each recursive field as a rewrite (via dischargeModulo). This is exactly the type's
  // dependent eliminator, so it is sound. It substitutes the constructor through the evaluation environment (no surface
  // rewriting, no de Bruijn shifting), re-elaborating the goal in a context extended by the constructor's fields.
  // `citedLemmas` are previously proven universal equalities, instantiated against each case and added as hypotheses,
  // so a proof can chain lemmas (e.g. commutativity over `n + 0 = n`). Returns false (never throws) for anything outside
  // its fragment, so the ring-level `checkFold` still gets a turn.
  function structuralInduction(
    goal: Extract<Expression, { form: 'binary' }>,
    scope: Scope,
    context: Context,
    inductVar: string,
    citedLemmas: string[],
    // path assumptions (the rule's `have` equations, as side expressions) re-elaborated and specialized per case, then
    // added as ground rewrites + convertibility hypotheses, so an inductive implication can use its antecedent.
    assumptions: [Expression, Expression][] = [],
  ): boolean {
    if (goal.op !== '==') {return false}

    const varLevel = scope.get(inductVar)

    if (varLevel === undefined) {return false}

    try {
      const index = context.level - varLevel - 1
      const typeValue = context.types[index]

      if (!typeValue) {return false}

      const typeTerm = quote(context.level, typeValue)

      if (typeTerm.tag !== 'const') {return false}

      const variants = variantNames.get(typeTerm.name)

      if (!variants || variants.length === 0) {return false}

      // close a case, splitting on a constructor's FIELDS when it does not reduce. `subst` maps a variable's level to a
      // constructor RECIPE (a variant + the levels of its field variables); the environment is rebuilt by applying each
      // recipe to its field values, deepest level first, so a value built FROM a split field (e.g. `negsucc p` once `p`
      // becomes `succ q`) reflects the split. Try to close the case; if it does not reduce and budget remains, pick an
      // inductive-typed field still standing for a neutral, split it into its own constructors, and recurse on each.
      // Bounded case analysis on sub-terms (what a function matching a field needs); sound because every leaf is a case.
      type Recipe = { variant: string; fieldLevels: number[] }

      const buildSplitEnv = (
        ctx: Context,
        subst: Map<number, Recipe>,
      ): Value[] => {
        const env = [...ctx.env]
        const levels = [...subst.keys()].sort((a, b) => b - a) // deepest (highest level) first

        for (const lvl of levels) {
          const recipe = subst.get(lvl)!
          env[ctx.level - lvl - 1] = evaluate(
            env,
            apply(
              constant(recipe.variant),
              ...recipe.fieldLevels.map(fl =>
                variable(ctx.level - fl - 1),
              ),
            ),
          )
        }

        return env
      }

      const closeWithFieldSplits = (
        ctx: Context,
        subst: Map<number, Recipe>,
        splittable: { level: number; enumName: string }[],
        hyps: [Value, Value][],
        depth: number,
      ): boolean => {
        const lt = expr(goal.left, scope, ctx)
        const rt = expr(goal.right, scope, ctx)

        if (!lt || !rt) {return false}

        const env = buildSplitEnv(ctx, subst)

        if (
          closeCase(
            ctx.level,
            ctx.env,
            evaluate(env, lt),
            evaluate(env, rt),
            hyps,
            citedLemmas,
          )
        )
          {return true}

        if (depth <= 0) {return false}

        for (let si = 0; si < splittable.length; si++) {
          const target = splittable[si]!
          const rest = splittable.filter((_, i) => i !== si)
          const targetVariants = variantNames.get(target.enumName)

          if (!targetVariants) {continue}

          let allClosed = true

          for (const targetVariant of targetVariants) {
            const subFields = variantFieldInfo.get(targetVariant) ?? []
            let inner2 = ctx
            const subLevels: number[] = []

            for (const f of subFields) {
              subLevels.push(inner2.level)
              inner2 = bind(inner2, 'many', evaluate(inner2.env, f.type))
            }

            const subst2 = new Map(subst)
            subst2.set(target.level, {
              variant: targetVariant,
              fieldLevels: subLevels,
            })

            const newSplit = [
              ...rest,
              ...subFields
                .map((f, j) => ({ field: f, level: subLevels[j]! }))
                .filter(
                  x =>
                    x.field.type.tag === 'const' &&
                    variantNames.has(x.field.type.name),
                )
                .map(x => ({
                  level: x.level,
                  enumName: (x.field.type as { name: string }).name,
                })),
            ]

            if (
              !closeWithFieldSplits(
                inner2,
                subst2,
                newSplit,
                hyps,
                depth - 1,
              )
            ) {
              allClosed = false
              break
            }
          }

          if (allClosed) {return true}
        }

        return false
      }

      for (const variant of variants) {
        const fields = variantFieldInfo.get(variant) ?? []
        const k = fields.length

        // extend the context with one fresh free variable per field of this constructor
        let inner = context

        for (const field of fields)
          {inner = bind(inner, 'many', evaluate(inner.env, field.type))}

        // the constructor applied to its fresh field variables (field j sits at de Bruijn index k-1-j in `inner`)
        const consValue = evaluate(
          inner.env,
          apply(
            constant(variant),
            ...fields.map((_, j) => variable(k - 1 - j)),
          ),
        )

        // re-elaborate the goal in the extended context: the induction variable is now at index `index + k`
        const leftTerm = expr(goal.left, scope, inner)
        const rightTerm = expr(goal.right, scope, inner)

        if (!leftTerm || !rightTerm) {return false}

        const subject = index + k

        // the case goal: substitute the induction variable with the constructor, through the environment
        const caseEnv = [...inner.env]
        caseEnv[subject] = consValue
        const caseLeft = evaluate(caseEnv, leftTerm)
        const caseRight = evaluate(caseEnv, rightTerm)

        // induction hypotheses: for each RECURSIVE field (its type is this same enum), assume L == R at that field
        const hypotheses: [Value, Value][] = []

        fields.forEach((field, j) => {
          if (
            field.type.tag === 'const' &&
            field.type.name === typeTerm.name
          ) {
            const ihEnv = [...inner.env]
            ihEnv[subject] = inner.env[k - 1 - j]!
            hypotheses.push([
              evaluate(ihEnv, leftTerm),
              evaluate(ihEnv, rightTerm),
            ])
          }
        })

        // path assumptions, specialized to this case: re-elaborate each `have` equation in the extended context and
        // substitute the induction variable with the constructor (the same caseEnv as the goal), so the antecedent holds
        // at this case. Added as a hypothesis the discharge can use (and, below, as a directed rewrite).
        const assumptionPairs: [Value, Value][] = []
        let caseVacuous = false

        for (const [aLeft, aRight] of assumptions) {
          const lt = expr(aLeft, scope, inner)
          const rt = expr(aRight, scope, inner)

          if (lt && rt) {
            const lv = evaluate(caseEnv, lt)
            const rv = evaluate(caseEnv, rt)

            // an antecedent that equates distinct constructors is impossible: this case is vacuously true
            if (equationAbsurd(inner, lt, lv, rv)) {caseVacuous = true}

            assumptionPairs.push([lv, rv])
          }
        }

        if (caseVacuous) {continue}

        hypotheses.push(...assumptionPairs)

        // the inductive-typed fields of this constructor, which can be split further if the case does not reduce
        // fields to split when the case will not reduce: inductive-typed fields of a DIFFERENT enum than the induction
        // variable. A field of the SAME enum is the recursive position carrying the induction hypothesis, so splitting
        // it would clobber that hypothesis; it is handled by the IH, not by case analysis.
        const splittable = fields
          .map((field, j) => ({ field, level: context.level + j }))
          .filter(
            x =>
              x.field.type.tag === 'const' &&
              variantNames.has(x.field.type.name) &&
              x.field.type.name !== typeTerm.name,
          )
          .map(x => ({
            level: x.level,
            enumName: (x.field.type as { name: string }).name,
          }))

        if (
          !closeWithFieldSplits(
            inner,
            new Map([
              [
                varLevel,
                {
                  variant,
                  fieldLevels: fields.map((_, j) => context.level + j),
                },
              ],
            ]),
            splittable,
            hypotheses,
            2,
          )
        )
          {return false}
      }

      return true
    } catch {
      return false
    }
  }

  // simultaneous structural induction on SEVERAL variables (`fold a b ...`): it walks the cartesian product of the
  // variables' constructors and discharges each combination. In a case where every inducted variable is at a recursive
  // constructor, the induction hypothesis is the goal with all of them stepped to their fields at once (the diagonal),
  // which is exactly the recursion of a function that matches several arguments together (min, max, the order `at-most`).
  // Sound: this is well-founded induction on the product order. Returns false (never throws) for anything outside it.
  function multiInduction(
    goal: Extract<Expression, { form: 'binary' }>,
    scope: Scope,
    context: Context,
    inductVars: string[],
    citedLemmas: string[],
    assumptions: [Expression, Expression][] = [],
  ): boolean {
    if (goal.op !== '==') {return false}

    try {
      const infos = inductVars.map(name => {
        const level = scope.get(name)

        if (level === undefined) {return null}

        const typeValue = context.types[context.level - level - 1]

        if (!typeValue) {return null}

        const typeTerm = quote(context.level, typeValue)

        if (typeTerm.tag !== 'const') {return null}

        const variants = variantNames.get(typeTerm.name)

        if (!variants || variants.length === 0) {return null}

        return { name, level, enumName: typeTerm.name, variants }
      })

      if (infos.some(i => i === null)) {return false}

      const chosen: {
        level: number
        enumName: string
        variant: string
        fields: { name: string; type: Term }[]
        fieldLevels: number[]
      }[] = []

      // discharge the current cartesian combination (all variables already assigned a constructor in `chosen`)
      const dischargeLeaf = (ctx: Context): boolean => {
        const caseEnv = [...ctx.env]

        for (const choice of chosen) {
          const consTerm = apply(
            constant(choice.variant),
            ...choice.fields.map((_, j) =>
              variable(ctx.level - choice.fieldLevels[j]! - 1),
            ),
          )
          caseEnv[ctx.level - choice.level - 1] = evaluate(
            ctx.env,
            consTerm,
          )
        }

        const leftTerm = expr(goal.left, scope, ctx)
        const rightTerm = expr(goal.right, scope, ctx)

        if (!leftTerm || !rightTerm) {return false}

        const caseLeft = evaluate(caseEnv, leftTerm)
        const caseRight = evaluate(caseEnv, rightTerm)

        const hypotheses: [Value, Value][] = []

        // the diagonal induction hypothesis: step every variable at a recursive constructor to its field, together
        const recursive = chosen.filter(choice =>
          choice.fields.some(
            f => f.type.tag === 'const' && f.type.name === choice.enumName,
          ),
        )

        if (recursive.length > 0) {
          const ihEnv = [...caseEnv]

          for (const choice of recursive) {
            const fieldIndex = choice.fields.findIndex(
              f =>
                f.type.tag === 'const' && f.type.name === choice.enumName,
            )
            ihEnv[ctx.level - choice.level - 1] =
              ctx.env[ctx.level - choice.fieldLevels[fieldIndex]! - 1]!
          }

          hypotheses.push([
            evaluate(ihEnv, leftTerm),
            evaluate(ihEnv, rightTerm),
          ])
        }

        for (const [aLeft, aRight] of assumptions) {
          const lt = expr(aLeft, scope, ctx)
          const rt = expr(aRight, scope, ctx)

          if (lt && rt) {
            const lv = evaluate(caseEnv, lt)
            const rv = evaluate(caseEnv, rt)

            // an antecedent that equates distinct constructors is impossible: this case is vacuously true
            if (equationAbsurd(ctx, lt, lv, rv)) {return true}

            hypotheses.push([lv, rv])
          }
        }

        return closeCase(
          ctx.level,
          ctx.env,
          caseLeft,
          caseRight,
          hypotheses,
          citedLemmas,
        )
      }

      // pick a constructor for variable `i`, extend the context with its fields, and recurse to the next variable
      const pick = (i: number, ctx: Context): boolean => {
        if (i === infos.length) {return dischargeLeaf(ctx)}

        const info = infos[i]!

        for (const variant of info.variants) {
          const fields = variantFieldInfo.get(variant) ?? []
          let inner = ctx
          const fieldLevels: number[] = []

          for (const field of fields) {
            fieldLevels.push(inner.level)
            inner = bind(inner, 'many', evaluate(inner.env, field.type))
          }

          chosen.push({
            level: info.level,
            enumName: info.enumName,
            variant,
            fields,
            fieldLevels,
          })

          const ok = pick(i + 1, inner)
          chosen.pop()

          if (!ok) {return false}
        }

        return true
      }

      return pick(0, context)
    } catch {
      return false
    }
  }

  // record a discharged named equation as a citable rewrite rule (its `mark` binders are the universal holes). Stores
  // both the structural rule (for `fold ... / cite`) and the string form (for the exact-match `cite`/`turn`/`link`).
  function recordLemmaRule(
    name: string | undefined,
    goal: Extract<Statement, { form: 'hold' }>['expr'],
    scope: Scope,
    context: Context,
  ): void {
    if (!name || goal.form !== 'binary') {return}

    try {
      const left = expr(goal.left, scope, context)
      const right = expr(goal.right, scope, context)

      if (!left || !right) {return}

      const leftValue = evaluate(context.env, left)
      const rightValue = evaluate(context.env, right)
      const lhs = quote(context.level, leftValue)
      const rhs = quote(context.level, rightValue)
      lemmaRules.set(name, { binderCount: context.level, lhs, rhs })
      lemmas.set(name, { left: showTerm(lhs), right: showTerm(rhs) })
    } catch {
      // not elaborable: skip; the proof still stands, it just is not citable
    }
  }

  // function extensionality: discharge a goal `is-equal f g` between two FUNCTIONS by a cited pointwise lemma that
  // states `f x == g x` for all x. Sound by the kernel's observational equality (Id at a function type computes to the
  // pointwise identity): a proof of the pointwise equality IS a proof of the function equality. Checks that the cited
  // (already proven, so it is in `lemmaRules`) lemma's two sides, at a fresh point, are the two functions applied to it.
  function tryFunext(
    goal: Extract<Statement, { form: 'hold' }>['expr'],
    scope: Scope,
    context: Context,
    citedName: string,
  ): boolean {
    if (goal.form !== 'binary' || goal.op !== '==') {return false}

    const lemma = lemmaRules.get(citedName)

    if (!lemma || lemma.binderCount !== 1) {return false}

    try {
      const left = expr(goal.left, scope, context)
      const right = expr(goal.right, scope, context)

      if (!left || !right) {return false}

      // both sides must be functions (their type is a pi)
      if (quote(context.level, infer(context, left).type).tag !== 'pi')
        {return false}

      const point = neutralVar(context.level)
      const leftAtPoint = applyValue(
        evaluate(context.env, left),
        point,
      )
      const rightAtPoint = applyValue(
        evaluate(context.env, right),
        point,
      )
      // the lemma instantiated at the same fresh point (its single binder -> the point)
      const lemmaLeft = evaluate([point], lemma.lhs)
      const lemmaRight = evaluate([point], lemma.rhs)

      return (
        areConvertible(context.level + 1, leftAtPoint, lemmaLeft) &&
        areConvertible(context.level + 1, rightAtPoint, lemmaRight)
      )
    } catch {
      return false
    }
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

    if (goal.form !== 'binary') {return}

    const hasProof = (statement.proof?.length ?? 0) > 0
    // explicit induction: `fold <var>` proves a universal `L(n) == R(n)` by Peano induction over a recursive function
    // in the goal, discharged symbolically by the ring normalizer (no kernel computation). See induct.ts.
    const tactic = statement.proof?.[0]

    // FUNEXT: prove two FUNCTIONS equal (`is-equal f g`) by citing a pointwise lemma `mark x / is-equal (f x) (g x)`.
    // Sound by the kernel's observational equality (Id at a function type IS the pointwise identity), so the pointwise
    // proof IS the function-equality proof. Discharges a NON-definitional function equality (e.g. two recursive
    // definitions of the same function) that `calm` cannot.
    if (
      tactic?.head === 'melt' &&
      tactic.arg &&
      tryFunext(goal, scope, context, tactic.arg)
    ) {
      discharged.push(statement.span)

      return
    }

    if (tactic?.head === 'fold' && tactic.arg) {
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

      if (byInduction || checkFold(program, goal, tactic.arg)) {
        discharged.push(statement.span)
        recordLemmaRule(statement.name, goal, scope, context)
      } else
        {diagnostics.push(
          diagnose('invalid-proof', {
            file,
            span: statement.span,
            message: 'the induction did not establish the equality',
          }),
        )}

      return
    }

    // non-negativity by a sum-of-squares certificate: `E >= F` (or `F <= E`) holds for ALL values when E - F is a sum
    // of square monomials. This proves the non-linear inequality "every square is non-negative" and its kin (for any
    // bound, not just zero) without induction.
    if (!hasProof) {
      if (
        goal.op === '>=' &&
        nonNegativeDifference(goal.left, goal.right)
      ) {
        discharged.push(statement.span)

        return
      }

      if (
        goal.op === '<=' &&
        nonNegativeDifference(goal.right, goal.left)
      ) {
        discharged.push(statement.span)

        return
      }
    }

    if (goal.op !== '==') {return}

    // a commutative-ring identity (when no explicit proof is given): L and R normalize to the same polynomial, so the
    // equality holds for ALL values of the variables. This discharges the non-linear algebraic universals (the
    // multiplicative norm, the four-square and doubling identities) that the linear prover (degree one) and the
    // kernel's opaque arithmetic cannot. Sound: a zero polynomial is identically zero over any commutative ring. With
    // an explicit proof present, the kernel validates that proof instead, so a bogus tactic is still caught.
    if (!hasProof && ringEqual(goal.left, goal.right)) {
      discharged.push(statement.span)

      return
    }

    // the kernel handles the NON-linear (definitional / structural) fragment; the linear prover (checkHolds) owns the
    // linear fragment. When a goal the linear prover can decide carries NO explicit proof tree, skip it here so the
    // linear prover is authoritative -- this is what stops the kernel from wrongly discharging a value-false
    // arithmetic claim like `add 3 3 == add 4 4` through its opaque view of number literals. A goal WITH an explicit
    // proof (`calm`/`cite`/...) is still validated by the kernel, so a bogus tactic is caught.
    if (!hasProof && isLinearGoal(goal)) {return}

    const left = expr(goal.left, scope, context)
    const right = expr(goal.right, scope, context)

    if (!left || !right) {return}

    try {
      infer(context, left)
      infer(context, right)

      const leftValue = evaluate(context.env, left)
      const rightValue = evaluate(context.env, right)

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
      } else if (verdict === 'fail') {
        diagnostics.push(
          diagnose('invalid-proof', {
            file,
            span: statement.span,
            message: 'this proof does not establish the equality',
          }),
        )
      }
      // 'open': leave it to the linear prover (checkHolds)
    } catch {
      // the sides did not elaborate / type-check: leave it to the linear prover
    }
  }

  for (const statement of program) {
    if (
      statement.form !== 'function' ||
      !representable.has(statement.name)
    )
      {continue}

    // peel the function's kernel type pi-by-pi to build the body context: the leading generic binders, then the
    // value parameters (named into scope), leaving the result type. This handles generics and dependency uniformly.
    let context = baseContext

    const scope: Scope = new Map()

    let remaining: Value = evaluate(
      [],
      functionType.get(statement.name)!,
    )

    for (let i = 0; i < statement.generics.length; i++) {
      if (remaining.v !== 'pi') {break}

      const witness = neutralVar(context.level)
      const domain = remaining.domain
      const codomain = remaining.codomain
      context = bind(context, remaining.mult, domain)
      remaining = closeOver(codomain, witness)
    }

    for (const parameter of statement.params) {
      if (remaining.v !== 'pi') {break}

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
            {lambda = { tag: 'lam', body: lambda }}

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

  // top-level proof obligations: a `hold` declared at module scope is kernel-checked here, AFTER the function loop has
  // registered every terminating function as a transparent definition, so a definitional proof can reduce through
  // them (e.g. `double 3` unfolds to `add 3 3`). Whatever the kernel leaves open is handled by the linear prover
  // (`checkHolds`), which also walks top-level holds.
  for (const statement of program) {
    if (statement.form === 'hold')
      {checkHold(statement, new Map(), baseContext)}
  }

  return { diagnostics, verified, discharged }
}
