// The type checker: gradual, bidirectional inference over the compile AST. Type variables are inference holes,
// solved by unification. `unknown` is the gradual any: consistent with everything, never an error. Concrete
// mismatches are reported with spans. This is the formal type-checking pass that runs after resolution. See
// note/research/vibe/computation/plans/04-typecheck.md and 11-elaboration.md.

import type {
  Diagnostic,
  Span,
} from '@term/make/code/parser/diagnostic'
import { armLocals } from '@term/make/code/check/arm'
import { raiseSets } from '@term/make/code/check/effects'
import { diagnose } from '@term/make/code/parser/diagnostic'
import { Substitution } from '@term/make/code/check/substitution'
import { instantiate } from '@term/make/code/check/signature'
import { overloadGroups } from '@term/make/code/check/overload'
import type { Signature } from '@term/make/code/check/signature'
import { makeSeedType } from '@term/make/code/check/type-seed'
import { zonkGeneric as zonkGenericType } from '@term/make/code/check/zonk'
import {
  instantiateScheme as instantiateSchemeImpl,
  freeTypeVars as freeTypeVarsImpl,
  generalize as generalizeImpl,
  isValueExpression,
} from '@term/make/code/check/scheme'
import type { Scheme, Env } from '@term/make/code/check/scheme'
import { makeExpect } from '@term/make/code/check/expect'
import type {
  Expression,
  Program,
  Statement,
  Type,
  ZoneNode,
} from '@term/make/code/compile/node'
import {
  BOOLEAN,
  DYNAMIC,
  FLOAT,
  NUMBER,
  STRING,
  UNIT,
  UNKNOWN,
  showType,
} from '@term/make/code/compile/node'

export function check(
  program: Program,
  file: string,
  fileOrigin?: WeakMap<Statement, string>,
  // when set, only this function's body is checked + zonked (signatures + module bindings are still built whole, which
  // is cheap). The incremental compiler uses this for per-definition type checking. Default (undefined) checks all,
  // so the whole-program behavior is unchanged. See code/compile/incremental.ts (Tier 2).
  only?: string,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = []

  // the file currently being checked. With a merged multi-module program `file` is only the entry; `fileOrigin` maps
  // each top-level statement to its module, so a type error points at the real source rather than the entry.
  let currentFile = file

  // the unification substitution, the atomic core of inference (code/check/substitution.ts). The local aliases keep
  // the rest of this pass reading naturally (`fresh()`, `resolve(t)`, `unify(a, b)`); the state and algorithms live in
  // the reusable class, the first extracted component of the modular checker.
  const sub = new Substitution()
  const fresh = (): Type => sub.fresh()
  const resolve = (type: Type): Type => sub.resolve(type)
  const occurs = (id: number, type: Type): boolean =>
    sub.occurs(id, type)

  // record-type field maps, for member-access typing
  const records = new Map<string, Map<string, Type>>()
  // exception form -> the name of its props record (undefined when it adds no props)
  const exceptionProps = new Map<string, string | undefined>()
  // the fields every exception carries, bound in a `case <form>` arm beside the form's own props
  const EXCEPTION_SHARED = ['host', 'form', 'note', 'code', 'time']
  // a caught exception's raise set (the guarded body's), for the exhaustiveness of a `fork case` over it
  const caughtRaises = new Map<string, Set<string>>()
  let programRaises: Map<string, Set<string>> | undefined
  // a record-type field's foreign `name <...>` (its exact native name), so the emitter uses it verbatim
  const fieldNick = new Map<string, Map<string, string>>()
  // enum variant sets (for exhaustiveness) and variant -> enum (so `make red` is typed as its enum)
  const enums = new Map<string, Set<string>>()
  // for an indexed family: enum name -> (variant -> the head name of its first output index, e.g. `vnil -> zero`,
  // `vcons -> succ`). Lets a match on a constructor-headed index omit the variants that cannot occur there.
  const familyVariantIndexHead = new Map<
    string,
    Map<string, (string | undefined)[]>
  >()
  const variantEnum = new Map<string, string>()
  // a variant's surface name -> every enum that declares it. An overloaded constructor (a name shared by two enums,
  // e.g. `minus` on both `pole` and `spin`) is typed leniently here (a fresh variable) and resolved by the kernel,
  // which is the authority on whether the construction matches its expected type.
  const variantOwners = new Map<string, string[]>()
  // each variant's own fields, exposed inside a matching `case` branch (so `self/value` works after a match)
  const variantFields = new Map<string, Map<string, Type>>()
  // a form's generic parameter names, e.g. maybe -> ["t"], for parameterized named types (maybe<t>)
  const formGenerics = new Map<string, string[]>()

  for (const statement of program) {
    if (statement.form === 'record-type') {
      formGenerics.set(statement.name, statement.params)

      const fields = new Map<string, Type>()
      const nicks = new Map<string, string>()

      for (const field of statement.fields) {
        fields.set(field.name, field.type)

        if (field.nick) {
          nicks.set(field.name, field.nick)
        }
      }

      records.set(statement.name, fields)

      if (nicks.size) {
        fieldNick.set(statement.name, nicks)
      }

      // an exception form: its props record (`<form>-link`), for a `fork case` over a caught exception
      if (statement.chain?.includes('exception')) {
        exceptionProps.set(statement.name, statement.props)
      }

      if (statement.variants.length > 0) {
        const set = new Set<string>()
        // one head PER INDEX POSITION, matching `familyVariantIndexHead` and the
        // position-wise comparison the inversion check does
        const indexHeads = new Map<string, (string | undefined)[]>()

        for (const variant of statement.variants) {
          set.add(variant.name)
          variantEnum.set(variant.name, statement.name)

          // record this variant's output-index head AT EVERY index position (for inversion's exhaustiveness relaxation).
          // A position is `undefined` when that index is not constructor-headed (a variable / computed); a variant is
          // impossible at a subject index only where BOTH sides are constructor-headed and the heads differ. Covering
          // every position (not just the first) makes a multi-index family like `lt a b` invertible (e.g. `lt m zero`
          // is empty, since both constructors' second index is `succ ..`).
          const heads = (variant.indexValues ?? []).map(iv =>
            iv?.form === 'record' ? iv.name : undefined,
          )

          if (heads.some(h => h !== undefined)) {
            indexHeads.set(variant.name, heads)
          }

          const owners = variantOwners.get(variant.name) ?? []
          owners.push(statement.name)
          variantOwners.set(variant.name, owners)

          const own = new Map<string, Type>()

          for (const field of variant.fields) {
            own.set(field.name, field.type)
          }

          variantFields.set(variant.name, own)
        }

        enums.set(statement.name, set)

        if (indexHeads.size > 0) {
          familyVariantIndexHead.set(statement.name, indexHeads)
        }
      }
    }
  }

  // within a `case <variant>` branch, a subject variable is narrowed to that variant, so its fields are in scope
  const narrowing = new Map<string, string>()

  // where each inference variable was first fixed to a concrete type, for blame tracking (owned by the substitution)
  const origin = sub.origin

  // transparent form-aliases: `form X, like <prim>` with no fields/variants. The checker unifies X with its base, so a
  // bind primitive alias (e.g. `g-luint = native-number`, `g-lclampf = native-number`) accepts the underlying value.
  // Built from the whole merged program. This is what lets a frontend pass a plain `number` where a binding declares a
  // `GLuint`, instead of every WebGL/DOM call rejecting primitives.
  const transparentAlias = new Map<string, Type>()

  for (const statement of program) {
    if (
      statement.form === 'record-type' &&
      statement.alias &&
      statement.fields.length === 0 &&
      statement.variants.length === 0 &&
      statement.params.length === 0
    ) {
      transparentAlias.set(statement.name, statement.alias)
    }
  }

  // unfold a transparent alias to its base, following a chain (guarded against cycles). Unification only.
  const unfoldAlias = (type: Type): Type => {
    let current = type

    const seen = new Set<string>()

    while (
      current.kind === 'named' &&
      transparentAlias.has(current.name) &&
      !seen.has(current.name)
    ) {
      seen.add(current.name)
      current = transparentAlias.get(current.name)!
    }

    return current
  }

  // unify two types. returns true on success. `unknown` (gradual) is consistent with anything. Transparent aliases are
  // unfolded to their base first. The core algorithm lives in the Substitution component.
  const unify = (a: Type, b: Type, span?: Span): boolean =>
    sub.unify(unfoldAlias(a), unfoldAlias(b), span)

  // unify-or-diagnose (component: code/check/expect.ts). `getFile` reads the live current file (mutated by the run loops).
  const expect = makeExpect({
    unify,
    resolve,
    origin: sub.origin,
    diagnostics,
    getFile: () => currentFile,
  })

  // a declared type, with generic names mapped to their variables and unknown names left to inference
  // build an inference type from a milled annotation (component: code/check/type-seed.ts). Captures the shared
  // `records` / `formGenerics` tables so the call sites stay `seedType(type, generics)`.
  // opaque per-backend handle types declared by `dock type` shims: kept as named types during inference
  const opaqueTypes = new Set<string>()

  for (const statement of program) {
    if (statement.form === 'native' && statement.kind === 'type') {
      opaqueTypes.add(statement.alias)
    }
  }

  const seedType = makeSeedType(sub, records, formGenerics, opaqueTypes)

  // every `like <name>` on a signature or a field names something: a form, an enum, a primitive, a generic of its
  // own declaration, a mask, a transparent alias or an opaque native type. One that names nothing used to compile
  // clean and emit a type the target has never heard of (compiler-hygiene-0010). It runs before the signatures are
  // built, while every `like <name>` is still the name as written (inference replaces an unknown one with a variable)
  const PRIMITIVE_TYPE_NAMES = new Set([
    'u8', 'u16', 'u32', 'u64', 'u128', 'i8', 'i16', 'i32', 'i64', 'i128', 'integer', 'number', 'decimal', 'float', 'f32', 'f64',
    'dynamic', 'json', 'bytes', 'buffer', 'text', 'boolean', 'void', 'unknown', 'any', 'unit', 'list', 'hash', 'task',
    'string', 'natural', 'self', 'type', 'size',
  ])
  const maskNames = new Set(program.filter(s => s.form === 'mask').map(s => s.name))

  const namedIn = (type: Type | undefined, into: Set<string>): void => {
    if (!type) {
      return
    }

    switch (type.kind) {
      case 'named':
        into.add(type.name)
        type.args?.forEach(a => namedIn(a, into))
        break
      case 'array':
        namedIn(type.element, into)
        break
      case 'map':
        namedIn(type.key, into)
        namedIn(type.value, into)
        break
      case 'function':
        type.params.forEach(p => namedIn(p, into))
        namedIn(type.result, into)
        break
      default:
        break
    }
  }

  const knownType = (name: string, own: Set<string>): boolean =>
    records.has(name) ||
    enums.has(name) ||
    PRIMITIVE_TYPE_NAMES.has(name) ||
    own.has(name) ||
    maskNames.has(name) ||
    opaqueTypes.has(name) ||
    transparentAlias.has(name)

  for (const statement of program) {
    // each module reports its own: an app compiling the stdlib in is not told about the stdlib's, the stdlib's own
    // build is
    if (fileOrigin && fileOrigin.get(statement) !== file) {
      continue
    }

    const names = new Set<string>()
    const own = new Set<string>()

    if (statement.form === 'function') {
      statement.generics.forEach(g => own.add(g.name))
      statement.params.forEach(p => namedIn(p.type, names))
      namedIn(statement.result, names)
    } else if (statement.form === 'record-type') {
      statement.params.forEach(p => own.add(p))
      statement.fields.forEach(f => namedIn(f.type, names))
      statement.variants.forEach(v => v.fields.forEach(f => namedIn(f.type, names)))
    } else {
      continue
    }

    for (const name of names) {
      if (!knownType(name, own)) {
        diagnostics.push(
          diagnose('unknown-type', {
            file: fileOrigin?.get(statement) ?? currentFile,
            span: statement.span,
            message: `"${name}" is not a type this build knows: no form, enum, primitive, generic, mask or alias declares it`,
          }),
        )
      }
    }
  }


  // trait instances available: `${mask}:${type}` (for call-site instance resolution)
  const instances = new Set<string>()

  for (const statement of program) {
    if (statement.form === 'instance') {
      instances.add(`${statement.mask}:${statement.target}`)
    }
  }

  // trait-method names (every method any mask declares). A trait-method call whose receiver is a concrete form
  // dispatches to that form's instance method here; one whose receiver is a trait-bounded generic is left unresolved
  // so the dictionary-passing IR pass can thread the instance. So the single-owner dispatch guess below must NOT fire
  // for a trait method -- guessing the lone instance would wrongly hard-wire a generic call to one concrete type.
  const maskMethods = new Set<string>()

  for (const statement of program) {
    if (statement.form === 'mask') {
      for (const method of statement.methods) {
        maskMethods.add(method)
      }
    }
  }

  // function name -> its signature: generic variable ids, their names, their trait bounds, and param/result types
  const functions = new Map<string, Signature>()

  for (const statement of program) {
    if (statement.form !== 'function') {
      continue
    }

    // a redefinition with a DIFFERENT arity corrupts the signature table (the body of one definition would be checked
    // against the other's parameters) and used to crash the checker. Flag it and keep the first. Same-arity
    // redefinitions are left as the existing last-wins behavior (template-generated term constants rely on it).
    const existing = functions.get(statement.name)

    if (existing) {
      // a different-arity redefinition is flagged only when it is in the entry module (the user's own code). Imported
      // packages legitimately carry same-name overloads (e.g. a generated binding's DOM method with several
      // signatures); those keep the first silently, and the emitter dedups them.
      if (
        existing.params.length !== statement.params.length &&
        (fileOrigin?.get(statement) ?? file) === file
      ) {
        diagnostics.push(
          diagnose('duplicate-definition', {
            file,
            span: statement.span,
            message: `"${statement.name}" is defined more than once, with a different number of parameters`,
          }),
        )
      }

      continue
    }

    const genericVars = new Map<string, Type>()
    const genericIds = new Set<number>()
    const genericNames = new Map<number, string>()
    const bounds = new Map<number, string>()

    for (const g of statement.generics) {
      const variable = fresh()
      genericVars.set(g.name, variable)

      if (variable.kind === 'variable') {
        genericIds.add(variable.id)
        genericNames.set(variable.id, g.name)

        if (g.need) {
          bounds.set(variable.id, g.need)
        }
      }
    }

    functions.set(statement.name, {
      generics: genericIds,
      genericNames,
      bounds,
      params: statement.params.map(p => seedType(p.type, genericVars)),
      result: seedType(statement.result, genericVars),
      // the minimum call arity: trailing `need false` params may be omitted
      minArgs: statement.params.filter(p => !p.optional).length,
      names: statement.params.map(p => p.name),
      fallbacks: statement.params.map(p => p.fallback),
      positional: statement.params.map(p => p.positional === true),
    })
  }

  // a declarative native binding registers a function-shaped signature (no generics, no body to check): calls resolve
  // and type-check against it, and each backend renders the env's native template in place of a real call.
  for (const statement of program) {
    if (statement.form !== 'bind') {
      continue
    }

    if (functions.has(statement.name)) {
      continue
    }

    const noGenerics = new Map<string, Type>()
    functions.set(statement.name, {
      generics: new Set<number>(),
      genericNames: new Map<number, string>(),
      bounds: new Map<number, string>(),
      params: statement.params.map(p => seedType(p.type, noGenerics)),
      result: seedType(statement.result, noGenerics),
      minArgs: statement.params.filter(p => !p.optional).length,
      names: statement.params.map(p => p.name),
      fallbacks: statement.params.map(() => undefined),
      positional: statement.params.map(() => false),
    })
  }

  // receiver dispatch: a form's mangled method (`maybe_unwrap-or`) indexed by form name then bare method name, so a
  // bare `call unwrap-or / <receiver>` resolves to the method of the receiver's form. `methodNames` is the set of
  // every bare method name, used to recognise a call site as a method call before dispatching.
  const methodTable = new Map<string, Map<string, string>>()
  const methodNames = new Set<string>()

  for (const statement of program) {
    if (statement.form !== 'function' || !statement.method) {
      continue
    }

    const byName =
      methodTable.get(statement.method.form) ??
      new Map<string, string>()

    byName.set(statement.method.name, statement.name)
    methodTable.set(statement.method.form, byName)
    methodNames.add(statement.method.name)
  }

  // type-scheme + environment operations (component: code/check/scheme.ts). Aliased to capture the substitution so the
  // core's call sites stay natural. `Scheme` / `Env` / `isValueExpression` are imported directly.
  const instantiateScheme = (scheme: Scheme): Type =>
    instantiateSchemeImpl(scheme, sub)

  const freeTypeVars = (type: Type, into: Set<number>): void =>
    freeTypeVarsImpl(type, into, sub)

  const generalize = (type: Type, env: Env): number[] =>
    generalizeImpl(type, env, sub)

  // the trait bounds carried by the generics of the function currently being checked (each a generic type variable
  // with the mask it is bound by). Used to discharge a bounded call whose argument is still one of the enclosing
  // generics rather than a concrete type. Compared by resolved representative, since unification may have linked it.
  let currentBounds: { variable: Type; mask: string }[] = []

  function inferExpression(node: Expression, env: Env): Type {
    let type: Type

    switch (node.form) {
      case 'integer':
        type = NUMBER
        break
      case 'float':
        type = FLOAT
        break
      case 'boolean':
        type = BOOLEAN
        break
      case 'string':
        type = STRING
        break
      case 'template':
        // every interpolated expression is inferred (a name it reads must exist and be typed); the whole is a text
        for (const part of node.parts) {
          if (typeof part !== 'string') {
            inferExpression(part, env)
          }
        }

        type = STRING
        break
      case 'unit':
        type = UNIT
        break
      case 'null':
        // the host null literal lives in the dynamic currency, consistent with any host value
        type = DYNAMIC
        break
      case 'hole':
        type = UNKNOWN
        break

      case 'variable': {
        const local = env.get(node.name)

        if (local) {
          type = instantiateScheme(local)
        } else if (functions.has(node.name)) {
          // a task referenced as a first-class value: its (freshly instantiated) function type
          const signature = instantiate(functions.get(node.name)!, sub)
          type = {
            kind: 'function',
            params: signature.params,
            result: signature.result,
          }
        } else {
          type = UNKNOWN
        }

        break
      }

      case 'unary':
        if (node.op === '-') {
          // negation preserves the operand's numeric kind (float stays float)
          const operand = inferExpression(node.operand, env)
          const numeric =
            resolve(operand).kind === 'float' ? FLOAT : NUMBER

          expect(operand, numeric, node.span, 'negation operand')
          type = numeric
        } else {
          expect(
            inferExpression(node.operand, env),
            BOOLEAN,
            node.span,
            'not operand',
          )
          type = BOOLEAN
        }

        break

      case 'binary': {
        const left = inferExpression(node.left, env)
        const right = inferExpression(node.right, env)
        // arithmetic and comparison are numeric-kind-preserving: float with float, integer with integer, no silent mix
        const numeric =
          resolve(left).kind === 'float' ||
          resolve(right).kind === 'float'
            ? FLOAT
            : NUMBER

        if (node.op === '&&' || node.op === '||') {
          expect(left, BOOLEAN, node.left.span, 'logical operand')
          expect(right, BOOLEAN, node.right.span, 'logical operand')
          type = BOOLEAN
        } else if (node.op === '==' || node.op === '!=') {
          expect(right, left, node.right.span, 'comparison operands')
          type = BOOLEAN
        } else if (
          node.op === '<' ||
          node.op === '<=' ||
          node.op === '>' ||
          node.op === '>='
        ) {
          expect(left, numeric, node.left.span, 'comparison operand')
          expect(right, numeric, node.right.span, 'comparison operand')
          type = BOOLEAN
        } else if (node.op === '+' && resolve(left).kind === 'string') {
          // `+` is string concatenation when its left operand is a string (otherwise numeric addition)
          expect(right, STRING, node.right.span, 'string concatenation')
          type = STRING
        } else {
          expect(left, numeric, node.left.span, 'arithmetic operand')
          expect(right, numeric, node.right.span, 'arithmetic operand')
          type = numeric
        }

        break
      }

      case 'array': {
        const element = fresh()

        for (const item of node.items) {
          expect(
            inferExpression(item, env),
            element,
            item.span,
            'array element',
          )
        }

        type = { kind: 'array', element }
        break
      }

      case 'map': {
        const key = fresh()
        const value = fresh()

        for (const entry of node.entries) {
          expect(
            inferExpression(entry.key, env),
            key,
            entry.key.span,
            'map key',
          )
          expect(
            inferExpression(entry.value, env),
            value,
            entry.value.span,
            'map value',
          )
        }

        type = { kind: 'map', key, value }
        break
      }

      case 'record': {
        // an OVERLOADED variant constructor (a surface name shared by more than one enum) cannot be typed to a single
        // enum here. Infer its field values for their own sake, then leave the construction's type flexible so it
        // unifies with whatever the position expects; the kernel resolves the owning enum and verifies the fields.
        if ((variantOwners.get(node.name)?.length ?? 0) > 1) {
          for (const field of node.fields) {
            inferExpression(field.value, env)
          }

          type = fresh()
          break
        }

        // a variant constructor is typed as its enum (`make red` : color); a struct as itself. The form's type
        // arguments are inferred by unifying the supplied field values against the declared (generic) field types.
        const enumName = variantEnum.get(node.name) ?? node.name
        const params = formGenerics.get(enumName) ?? []
        const argMap = new Map<string, Type>()
        const args = params.map(p => {
          const v = fresh()
          argMap.set(p, v)

          return v
        })

        const declared = variantEnum.has(node.name)
          ? variantFields.get(node.name)
          : records.get(node.name)

        for (const field of node.fields) {
          const valueType = inferExpression(field.value, env)
          const fieldType = declared?.get(field.name)

          // seedType (not substGenerics) so a declared `like list` field becomes array<...>, matching how a list
          // value is typed; it also resolves the form's generics via argMap
          if (fieldType) {
            expect(
              valueType,
              seedType(fieldType, argMap),
              field.value.span,
              'field value',
            )
          }
        }

        // `make hash` / `make list` build the native map / array, so they are typed as one, the same as a `like hash`
        // / `like list` annotation seeds to (a `make hash` beside a `read flags` typed map must unify)
        type =
          enumName === 'hash'
            ? { kind: 'map', key: fresh(), value: fresh() }
            : enumName === 'list'
              ? { kind: 'array', element: fresh() }
              : { kind: 'named', name: enumName, args }
        break
      }

      case 'await':
        // await unwraps an async result; we model the result type as the inner type
        type = inferExpression(node.expr, env)
        break

      case 'conditional': {
        // a value-position conditional: each branch's condition is a boolean and every branch (plus the otherwise)
        // yields the same result type, which is the type of the whole expression
        const result = fresh()

        for (const branch of node.branches) {
          expect(
            inferExpression(branch.cond, env),
            BOOLEAN,
            branch.cond.span,
            'conditional condition',
          )
          unify(
            result,
            inferExpression(branch.value, env),
            branch.value.span,
          )
        }

        if (node.otherwise) {
          unify(
            result,
            inferExpression(node.otherwise, env),
            node.otherwise.span,
          )
        }

        type = result
        break
      }

      case 'member': {
        // variant-field access: inside a `case <v>` branch, the narrowed subject exposes that variant's fields,
        // with the subject's type arguments substituted for the enum's generics (maybe<number> -> value : number)
        if (
          node.target.form === 'variable' &&
          narrowing.has(node.target.name)
        ) {
          const variant = narrowing.get(node.target.name)!
          const field = variantFields.get(variant)?.get(node.name)

          if (field) {
            const subject = resolve(
              env.get(node.target.name)?.type ?? UNKNOWN,
            )

            const params =
              formGenerics.get(variantEnum.get(variant) ?? '') ?? []

            const argMap = new Map<string, Type>()

            if (subject.kind === 'named' && subject.args) {
              params.forEach(
                (p, i) =>
                  subject.args![i] && argMap.set(p, subject.args![i]),
              )
            }

            type = seedType(field, argMap)
            break
          }
        }

        const target = resolve(inferExpression(node.target, env))

        if (target.kind === 'named' && records.has(target.name)) {
          const field = records.get(target.name)!.get(node.name)

          if (field) {
            // carry the field's foreign `name <...>` to the emitter, so a binding constant emits its native name
            const nick = fieldNick.get(target.name)?.get(node.name)

            if (nick) {
              node.nick = nick
            }

            // substitute the target's type arguments for the form's generics (pair<a,b> -> first : a); seedType (not
            // substGenerics) so a `like list` / `like hash` field reads as array / map, matching its values
            const params = formGenerics.get(target.name) ?? []
            const argMap = new Map<string, Type>()

            if (target.args) {
              params.forEach(
                (p, i) =>
                  target.args![i] && argMap.set(p, target.args![i]),
              )
            }

            type = seedType(field, argMap)
          } else {
            // not a field: a member access onto a form method (`document/create-element`) is a native method call.
            // Type it as the method's function (so the enclosing call checks its args). The receiver stays the member
            // target, and the emitter lowers `target.create-element(args)` to `target.createElement(args)`. This is
            // how a JS-`this`-style binding (bind's DOM methods take no `self`) is invoked from seed.
            const mangled = methodTable.get(target.name)?.get(node.name)

            if (mangled && functions.has(mangled)) {
              const signature = instantiate(
                functions.get(mangled)!,
                sub,
              )

              type = {
                kind: 'function',
                params: signature.params,
                result: signature.result,
              }
            } else {
              diagnostics.push(
                diagnose('unknown-name', {
                  file: currentFile,
                  span: node.span,
                  message: `"${target.name}" has no field "${node.name}"`,
                }),
              )
              type = UNKNOWN
            }
          }
        } else if (target.kind === 'array' && node.name === 'length') {
          type = NUMBER
        } else if (target.kind === 'map' && node.name === 'size') {
          type = NUMBER
        } else {
          type = UNKNOWN
        }

        break
      }

      case 'call': {
        // `call fill / <data> / like <form>` is the form; `call melt / <value> / like <form>` is data. The value
        // is inferred for its own sake (a `data` in, a value of the form in), the result comes from the `like`.
        if (
          node.into &&
          node.callee.form === 'variable' &&
          (node.callee.name === 'fill-form' || node.callee.name === 'melt-form')
        ) {
          const into = seedType(node.into, new Map())

          if (node.args.length !== 1) {
            diagnostics.push(
              diagnose('type-mismatch', {
                file: currentFile,
                span: node.span,
                message: `"${node.callee.name === 'fill-form' ? 'fill' : 'melt'}" with a form takes one value`,
              }),
            )
          }

          if (into.kind !== 'named' || !records.has(into.name)) {
            diagnostics.push(
              diagnose('type-mismatch', {
                file: currentFile,
                span: node.span,
                message: `"${node.callee.name === 'fill-form' ? 'fill' : 'melt'}" needs a form with fields after "like"`,
              }),
            )
          }

          const dataType = seedType({ kind: 'named', name: 'data' }, new Map())

          for (const arg of node.args) {
            const argType = inferExpression(arg, env)
            expect(argType, node.callee.name === 'fill-form' ? dataType : into, arg.span, 'argument')
          }

          type = node.callee.name === 'fill-form' ? into : dataType
          break
        }

        // named arguments and defaults: put each `bind <name>` value in the callee's declared position, refuse a
        // name on a `slot` parameter or one the callee does not have, and clone in the `fall` of any omitted
        // parameter, so every backend receives the full argument list. Only for a direct call of a known task.
        if (
          node.callee.form === 'variable' &&
          !env.has(node.callee.name) &&
          (node.names || functions.has(node.callee.name))
        ) {
          arrangeArguments(node)
        }

        // same-arity overloads: pick the one whose parameter types fit the arguments
        if (
          node.callee.form === 'variable' &&
          !env.has(node.callee.name) &&
          overloadGroups.has(node.callee.name)
        ) {
          chooseOverload(node, env)
        }

        // an argument already typed by chooseOverload is not inferred twice (that would double its diagnostics)
        const args = node.args.map(arg =>
          arg.type ? arg.type : inferExpression(arg, env),
        )

        // receiver dispatch: rewrite a bare method call (`call unwrap-or / <receiver>`) to the mangled method of the
        // receiver's form. The receiver is whichever argument is a form that owns this method (usually `self`, first).
        // A local binding of the same name (a parameter or let, e.g. maybe/filter's `test` task param) shadows both
        // method dispatch and any global function, so skip when the name is bound in the current environment. Dispatch
        // runs even when a global function shares the name (e.g. a `get`/`set` method alongside bind's global Reflect
        // `get`): an argument that pins a form owning the method wins, otherwise we fall through to the global below.
        if (
          node.callee.form === 'variable' &&
          !env.has(node.callee.name) &&
          methodNames.has(node.callee.name)
        ) {
          const method = node.callee.name

          let mangled: string | undefined

          // the receiver is the FIRST argument (a method takes `self` first): a map or a form in a later position is
          // an ordinary argument, so `call get / url / header` with a map header stays the global `get`
          for (const arg of args.slice(0, 1)) {
            const receiver = resolve(arg)
            // a named form dispatches to its own methods; an array receiver dispatches to `list`'s methods and a map
            // receiver to `hash`'s (those forms are the native array / map), so `call map / <array>` or `call get /
            // <map>` resolves even when other forms also define that method
            const owner =
              receiver.kind === 'named'
                ? receiver.name
                : receiver.kind === 'array'
                  ? 'list'
                  : receiver.kind === 'map'
                    ? 'hash'
                    : undefined

            if (owner) {
              const found = methodTable.get(owner)?.get(method)

              if (found) {
                mangled = found
                break
              }
            }
          }

          // if no argument pins the form but exactly one form owns this method name, it is unambiguous. Skip this guess
          // when a global function of the same name exists, since the call may target that global rather than a method.
          if (
            !mangled &&
            !functions.has(method) &&
            !maskMethods.has(method)
          ) {
            const owners = [...methodTable.values()].filter(m =>
              m.has(method),
            )

            if (owners.length === 1) {
              mangled = owners[0]!.get(method)
            }
          }

          if (mangled && functions.has(mangled)) {
            node.callee.name = mangled
          }
        }

        if (
          node.callee.form === 'variable' &&
          functions.has(node.callee.name) &&
          !env.has(node.callee.name)
        ) {
          // instantiate generics fresh for this call (let-polymorphism)
          const signature = instantiate(
            functions.get(node.callee.name)!,
            sub,
          )

          // trailing `need false` params may be omitted, so the accepted arity is a RANGE: at least `minArgs`,
          // at most one per declared param.
          if (
            args.length < signature.minArgs ||
            args.length > signature.params.length
          ) {
            const wanted =
              signature.minArgs === signature.params.length
                ? `${signature.params.length}`
                : `${signature.minArgs} to ${signature.params.length}`

            diagnostics.push(
              diagnose('type-mismatch', {
                file: currentFile,
                span: node.span,
                message: `"${node.callee.name}" expects ${wanted} arguments, found ${args.length}`,
              }),
            )
          } else {
            args.forEach((arg, i) =>
              expect(
                arg,
                signature.params[i]!,
                node.args[i]!.span,
                'argument',
              ),
            )
          }

          // instance resolution: each trait bound must be satisfied for the type it resolved to. A concrete type
          // needs an instance; a type still equal to one of the enclosing function's generics needs that generic
          // to carry the same bound (bound propagation), otherwise the call is not justified.
          for (const bound of signature.bounds) {
            const concrete = resolve(bound.variable)

            if (
              concrete.kind === 'named' &&
              !instances.has(`${bound.mask}:${concrete.name}`)
            ) {
              diagnostics.push(
                diagnose('no-instance', {
                  file: currentFile,
                  span: node.span,
                  message: `no "${bound.mask}" instance for "${concrete.name}"`,
                }),
              )
            } else if (concrete.kind === 'variable') {
              const satisfied = currentBounds.some(b => {
                if (b.mask !== bound.mask) {
                  return false
                }

                const enclosing = resolve(b.variable)

                return (
                  enclosing.kind === 'variable' &&
                  enclosing.id === concrete.id
                )
              })

              if (!satisfied) {
                diagnostics.push(
                  diagnose('no-instance', {
                    file: currentFile,
                    span: node.span,
                    message: `the type variable here is not known to implement "${bound.mask}"; add a "need ${bound.mask}" bound`,
                  }),
                )
              }
            }
          }

          type = signature.result
        } else {
          // calling a first-class function value (a local of function type, a parameter, etc.)
          const calleeType = resolve(inferExpression(node.callee, env))

          if (calleeType.kind === 'function') {
            if (args.length !== calleeType.params.length) {
              diagnostics.push(
                diagnose('type-mismatch', {
                  file: currentFile,
                  span: node.span,
                  message: `this function expects ${calleeType.params.length} arguments, found ${args.length}`,
                }),
              )
            } else {
              args.forEach((arg, i) =>
                expect(
                  arg,
                  calleeType.params[i]!,
                  node.args[i]!.span,
                  'argument',
                ),
              )
            }

            type = calleeType.result
          } else if (
            calleeType.kind === 'unknown' ||
            calleeType.kind === 'variable'
          ) {
            type = UNKNOWN // gradual: unknown callee
          } else {
            diagnostics.push(
              diagnose('type-mismatch', {
                file: currentFile,
                span: node.callee.span,
                message: `this value is not callable (it has type ${showType(
                  calleeType,
                )})`,
              }),
            )
            type = UNKNOWN
          }
        }

        break
      }

      case 'closure': {
        // a function literal: check its body with the params in scope, and yield a function type
        const inner: Env = new Map(env)
        const params = node.params.map(p => p.type ?? UNKNOWN)
        node.params.forEach((p, i) =>
          inner.set(p.name, { vars: [], type: params[i]! }),
        )
        checkBody(node.body, inner, node.result ?? UNKNOWN)

        const fn: Type = {
          kind: 'function',
          params,
          result: node.result ?? UNKNOWN,
        }

        if (node.async) {
          fn.effects = ['async']
        }

        type = fn
        break
      }
    }

    node.type = type

    return type
  }

  function checkBody(body: Statement[], env: Env, result: Type): void {
    for (const statement of body) {
      checkStatement(statement, env, result)
    }
  }

  function checkStatement(
    node: Statement,
    env: Env,
    result: Type,
  ): void {
    switch (node.form) {
      case 'let': {
        const initType = inferExpression(node.init, env)

        // an explicit annotation (`host el, like element / read x`) types the binding: check the initializer against it
        // (gradual `unknown` from an opaque field unifies freely) and bind the declared type so the value can be re-typed
        // to a concrete form for receiver dispatch. Otherwise infer the binding's type from its initializer.
        if (node.type) {
          // the annotation is a MILLED type and has to be seeded like any other before it can be compared: an
          // unrecognized name becomes a fresh variable rather than a named type that unifies with nothing. Without
          // this, `host x, text <...>` reports `expected text, found string`, because the mill records the annotation
          // as the named type `text` while a literal infers as the string primitive.
          const declared = seedType(node.type, new Map())

          // an ambient declaration (`host document, name <document> / like document`) has no initializer; the mill
          // synthesizes a unit placeholder, so do not check it against the declared type. A real initializer (a
          // re-type like `host el, like element / read x`, where the opaque field is gradual `unknown`) is checked.
          if (node.init.form !== 'unit') {
            expect(initType, declared, node.span, 'binding')
          }

          env.set(node.name, { vars: [], type: declared })
        } else {
          // value-restricted let-generalization: an immutable binding to a syntactic value gets a polymorphic scheme
          const vars =
            !node.mutable && isValueExpression(node.init)
              ? generalize(initType, env)
              : []

          env.set(node.name, { vars, type: initType })
          node.type = initType
        }

        break
      }

      case 'assign': {
        const valueType = inferExpression(node.value, env)
        const targetType = inferExpression(node.target, env)
        expect(valueType, targetType, node.span, 'assignment')
        break
      }

      case 'expression':
        inferExpression(node.expr, env)
        break
      case 'return':
        if (node.value) {
          expect(
            inferExpression(node.value, env),
            result,
            node.span,
            'return value',
          )
        } else if (resolve(result).kind === 'variable') {
          // a bare `send back` in a task that declares no result: the result is unit (a typed backend needs to
          // know). A declared result is left to the declaration.
          expect(UNIT, result, node.span, 'return value')
        }

        break
      case 'while':
        expect(
          inferExpression(node.cond, env),
          BOOLEAN,
          node.cond.span,
          'loop condition',
        )
        checkBody(node.body, env, result)
        break
      case 'if':
        for (const branch of node.branches) {
          expect(
            inferExpression(branch.cond, env),
            BOOLEAN,
            branch.cond.span,
            'branch condition',
          )
          checkBody(branch.body, env, result)
        }

        if (node.otherwise) {
          checkBody(node.otherwise, env, result)
        }

        break

      case 'guard': {
        checkBody(node.body, env, result)

        if (node.catch) {
          // the caught value is the shared exception form when the program has one, else left to inference
          const inner = new Map(env)
          inner.set(node.catch.name, {
            vars: [],
            type: records.has('exception')
              ? seedType({ kind: 'named', name: 'exception' }, new Map())
              : fresh(),
          })
          // what the guarded body can raise: its own raises and its callees' sets, so a `fork case` over the caught
          // value is checked for exhaustiveness against exactly that
          programRaises ??= raiseSets(program, new Set(exceptionProps.keys())).raises
          caughtRaises.set(node.catch.name, bodyRaises(node.body, programRaises))
          checkBody(node.catch.body, inner, result)
        }

        break
      }

      case 'for-each': {
        const element = fresh()
        expect(
          inferExpression(node.iterable, env),
          { kind: 'array', element },
          node.iterable.span,
          'iterable',
        )

        const inner = new Map(env)
        inner.set(node.item, { vars: [], type: element })
        checkBody(node.body, inner, result)
        break
      }

      case 'match': {
        const subjectType = resolve(inferExpression(node.subject, env))

        // a `fork case` over a caught exception: the labels are exception forms, each arm binds the shared fields and
        // the form's own props, and the arms must cover what the guarded body can raise (or carry an `otherwise`)
        if (subjectType.kind === 'named' && subjectType.name === 'exception' && node.cases.every(c => exceptionProps.has(c.label))) {
          node.exceptionArms = {}

          for (const branch of node.cases) {
            const props = exceptionProps.get(branch.label)
            const link = props ? [...(records.get(props)?.keys() ?? [])] : []
            node.exceptionArms[branch.label] = { shared: EXCEPTION_SHARED, link }
          }

          const caught = node.subject.form === 'variable' ? caughtRaises.get(node.subject.name) : undefined

          if (caught && !node.otherwise) {
            const covered = new Set(node.cases.map(c => c.label))
            const missing = [...caught].filter(e => !covered.has(e) && e !== 'exception').sort()

            if (missing.length > 0) {
              diagnostics.push(
                diagnose('non-exhaustive', {
                  file: currentFile,
                  span: node.span,
                  message: `the guarded body can also raise ${missing.join(', ')}, which this fork case does not cover`,
                  hint: 'add a case for each, or an otherwise',
                }),
              )
            }
          }

          if (caught) {
            for (const branch of node.cases) {
              if (!caught.has(branch.label)) {
                diagnostics.push(
                  diagnose('unknown-name', {
                    file: currentFile,
                    span: node.span,
                    message: `"${branch.label}" is not something the guarded body can raise`,
                  }),
                )
              }
            }
          }

          for (const branch of node.cases) {
            const inner = new Map(env)
            const arm = node.exceptionArms[branch.label]!
            const own = exceptionProps.get(branch.label)
            const linkFields = own ? records.get(own) : undefined
            const fields = new Map<string, Type>()
            arm.shared.forEach(name => fields.set(name, records.get('exception')?.get(name) ?? STRING))
            arm.link.forEach(name => fields.set(name, linkFields?.get(name) ?? STRING))

            for (const { field, local } of armLocals([...fields.keys()], branch.binds)) {
              inner.set(local, { vars: [], type: seedType(fields.get(field)!, new Map()) })
            }

            checkBody(branch.body, inner, result)
          }

          if (node.otherwise) {
            checkBody(node.otherwise, env, result)
          }

          break
        }

        if (
          subjectType.kind === 'named' &&
          enums.has(subjectType.name)
        ) {
          const variants = enums.get(subjectType.name)!
          const covered = new Set(node.cases.map(c => c.label))

          for (const branch of node.cases) {
            if (!variants.has(branch.label)) {
              diagnostics.push(
                diagnose('unknown-name', {
                  file: currentFile,
                  span: node.span,
                  message: `"${branch.label}" is not a variant of "${subjectType.name}"`,
                }),
              )
            }
          }

          if (!node.otherwise) {
            // INVERSION: when the subject is an indexed family at a CONSTRUCTOR-headed index (`vec (succ n)`), the
            // variants whose output-index head differs are IMPOSSIBLE there and may be omitted (the kernel fills them).
            const indexHeads = familyVariantIndexHead.get(subjectType.name)
            const subjectHeads = (subjectType.valueArgs ?? []).map(va =>
              va?.form === 'record' ? va.name : undefined,
            )

            const reachable = (v: string): boolean => {
              if (!indexHeads) {
                return true // not an inverted match: every variant is required
              }

              const heads = indexHeads.get(v)

              if (!heads) {
                return true
              }

              // impossible only where SOME index position is constructor-headed on both the variant's output and the
              // subject, and the two heads differ (no-confusion). Any other position imposes no constraint.
              for (let i = 0; i < heads.length; i++) {
                const variantHead = heads[i]
                const subjectHead = subjectHeads[i]

                if (
                  variantHead !== undefined &&
                  subjectHead !== undefined &&
                  variantHead !== subjectHead
                ) {
                  return false
                }
              }

              return true
            }

            const missing = [...variants].filter(
              v => !covered.has(v) && reachable(v),
            )

            if (missing.length > 0) {
              diagnostics.push(
                diagnose('non-exhaustive', {
                  file: currentFile,
                  span: node.span,
                  message: `match on "${
                    subjectType.name
                  }" does not cover: ${missing.join(', ')}`,
                }),
              )
            }
          }
        }

        // narrow the subject variable to each branch's variant, so the branch can read that variant's fields
        const subjectVar =
          node.subject.form === 'variable'
            ? node.subject.name
            : undefined

        for (const branch of node.cases) {
          const previous = subjectVar
            ? narrowing.get(subjectVar)
            : undefined

          if (subjectVar) {
            narrowing.set(subjectVar, branch.label)
          }

          // the arm's fields are locals of its body (`case group` / `link kids` binds `kids`, a leading `link <name>`
          // renaming in order), typed as the variant declares them with the subject's type arguments substituted, so
          // a bare `read kids` is a typed receiver and a method call on it dispatches to its form
          const fields = variantFields.get(branch.label)
          const inner = new Map(env)

          if (fields) {
            const params =
              formGenerics.get(variantEnum.get(branch.label) ?? '') ?? []
            const argMap = new Map<string, Type>()

            if (subjectType.kind === 'named' && subjectType.args) {
              params.forEach(
                (p, i) =>
                  subjectType.args![i] &&
                  argMap.set(p, subjectType.args![i]),
              )
            }

            // a `link` past the variant's last field binds nothing: in rename mode the names pair with the fields in
            // declaration order, so an extra one is a mistake the arm would otherwise accept silently
            const fieldNames = [...fields.keys()]
            const binds = branch.binds ?? []
            const selecting = binds.length > 0 && binds.every(name => fieldNames.includes(name))

            if (!selecting && binds.length > fieldNames.length) {
              const extra = binds.slice(fieldNames.length)

              diagnostics.push(
                diagnose('type-mismatch', {
                  file: currentFile,
                  span: node.span,
                  message: `"link ${extra.join('", "link "')}" under "case ${branch.label}" binds nothing: the variant has ${fieldNames.length} field${fieldNames.length === 1 ? '' : 's'}${fieldNames.length ? ` (${fieldNames.join(', ')})` : ''}, and a link either selects fields by name or renames them in order`,
                }),
              )
            }

            for (const { field, local } of armLocals(fieldNames, branch.binds)) {
              inner.set(local, {
                vars: [],
                type: seedType(fields.get(field)!, argMap),
              })
            }
          }

          checkBody(branch.body, inner, result)

          if (subjectVar) {
            if (previous === undefined) {
              narrowing.delete(subjectVar)
            } else {
              narrowing.set(subjectVar, previous)
            }
          }
        }

        if (node.otherwise) {
          checkBody(node.otherwise, env, result)
        }

        break
      }

      case 'hold':
        expect(
          inferExpression(node.expr, env),
          BOOLEAN,
          node.span,
          'hold condition',
        )
        break
      case 'throw':
        inferExpression(node.value, env) // a throw has no result type (it is bottom)
        break
      case 'break':
      case 'continue':
      case 'record-type':
      case 'mask':
      case 'instance':
      case 'native':
        break
      case 'function':
        checkFunction(node)
        break
    }
  }

  // put a call's arguments in the callee's declared order and fill its defaults. See the `call` case.
  function arrangeArguments(
    node: Extract<Expression, { form: 'call' }>,
  ): void {
    const callee = (node.callee as { name: string }).name
    const signature = functions.get(callee)

    // a receiver-dispatched method or an unknown callee: the labels are documentation and the call stays
    // positional, as it always was
    if (!signature) {
      delete node.names

      return
    }

    const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
    const names = node.names ?? node.args.map(() => undefined)
    const ordered: (Expression | undefined)[] = signature.params.map(
      () => undefined,
    )

    let at = 0
    let failed = false

    for (let i = 0; i < node.args.length; i++) {
      const name = names[i]
      const arg = node.args[i]!

      // a positional argument (`undefined` from the mill, `null` after a trip through the JSON compile cache)
      if (name === undefined || name === null) {
        // a positional argument takes the next unfilled position
        while (at < ordered.length && ordered[at] !== undefined) {
          at++
        }

        if (at >= ordered.length) {
          diagnostics.push(
            diagnose('type-mismatch', {
              file: currentFile,
              span: arg.span,
              message: `"${callee}" takes ${ordered.length} argument${
                ordered.length === 1 ? '' : 's'
              }, and this is one more`,
            }),
          )
          failed = true
          break
        }

        ordered[at++] = arg
        continue
      }

      const index = signature.names.indexOf(name)

      if (index < 0) {
        diagnostics.push(
          diagnose('type-mismatch', {
            file: currentFile,
            span: arg.span,
            message: `"${callee}" has no parameter "${name}" (it takes ${signature.names.join(', ') || 'nothing'})`,
          }),
        )
        failed = true
        continue
      }

      if (signature.positional[index]) {
        diagnostics.push(
          diagnose('type-mismatch', {
            file: currentFile,
            span: arg.span,
            message: `"${name}" is a slot of "${callee}" and is given by position, never by name`,
          }),
        )
        failed = true
        continue
      }

      if (ordered[index] !== undefined) {
        diagnostics.push(
          diagnose('type-mismatch', {
            file: currentFile,
            span: arg.span,
            message: `"${name}" is given twice`,
          }),
        )
        failed = true
        continue
      }

      ordered[index] = arg
    }

    if (failed) {
      delete node.names

      return
    }

    // fill omitted parameters from their defaults; an omitted parameter with no default must be trailing and optional
    let filled = ordered.length

    for (let i = ordered.length - 1; i >= 0; i--) {
      if (ordered[i] !== undefined) {
        break
      }

      filled = i
    }

    for (let i = 0; i < ordered.length; i++) {
      if (ordered[i] !== undefined) {
        continue
      }

      const fallback = signature.fallbacks[i]

      if (fallback) {
        ordered[i] = clone(fallback)
        ordered[i]!.span = node.span
      } else if (i < filled) {
        diagnostics.push(
          diagnose('type-mismatch', {
            file: currentFile,
            span: node.span,
            message: `"${callee}" needs "${signature.names[i]}", which this call leaves out`,
          }),
        )
        // keep the positions aligned for the rest of the check; the diagnostic already stops the build
        ordered[i] = { form: 'unit', span: node.span }
      }
    }

    // a trailing optional collection or text left out is its empty value (a map, a list, or text nothing reads
    // through), typed as the parameter, so every backend passes an argument the callee can use; a trailing optional
    // of any other type stays omitted (the arity range allows it, and the host's absent value is what it gets)
    for (let i = 0; i < ordered.length; i++) {
      if (ordered[i] !== undefined) {
        continue
      }

      const param = resolve(signature.params[i] ?? UNKNOWN)

      if (param.kind === 'map') {
        ordered[i] = { form: 'map', entries: [], span: node.span, type: param }
      } else if (param.kind === 'array') {
        ordered[i] = { form: 'array', items: [], span: node.span, type: param }
      } else if (param.kind === 'string') {
        ordered[i] = { form: 'string', value: '', span: node.span, type: param }
      }
    }

    let end = ordered.length

    while (end > 0 && ordered[end - 1] === undefined) {
      end--
    }

    node.args = ordered.slice(0, end).map(a => a!)
    delete node.names
  }

  // choose among same-arity overloads by the arguments' types. Each candidate's parameter types are compared
  // structurally with the arguments' resolved types, a type variable on either side fitting anything; the unique
  // fit wins, and none or several is a diagnostic. See code/check/overload.ts.
  function chooseOverload(
    node: Extract<Expression, { form: 'call' }>,
    env: Env,
  ): void {
    const callee = node.callee as { name: string }
    const candidates = overloadGroups.get(callee.name) ?? []
    const argTypes = node.args.map(arg => resolve(inferExpression(arg, env)))

    const fits = (arg: Type, param: Type): boolean => {
      const a = resolve(arg)
      const p = resolve(param)

      if (
        a.kind === 'variable' ||
        p.kind === 'variable' ||
        a.kind === 'unknown' ||
        p.kind === 'unknown'
      ) {
        return true
      }

      if (a.kind !== p.kind) {
        return false
      }

      if (a.kind === 'named' && p.kind === 'named') {
        return a.name === p.name
      }

      if (a.kind === 'array' && p.kind === 'array') {
        return fits(a.element, p.element)
      }

      if (a.kind === 'map' && p.kind === 'map') {
        return fits(a.key, p.key) && fits(a.value, p.value)
      }

      return true
    }

    const fitting = candidates.filter(name => {
      const signature = functions.get(name)

      if (
        !signature ||
        argTypes.length < signature.minArgs ||
        argTypes.length > signature.params.length
      ) {
        return false
      }

      const instance = instantiate(signature, sub)

      return argTypes.every((t, i) => fits(t, instance.params[i]!))
    })

    if (fitting.length === 1) {
      callee.name = fitting[0]!

      return
    }

    // several fit because an argument is still a type variable: prefer the candidates that fit with no wildcard at
    // all, and among what is left take the LAST definition, which is the per-environment shim that loads after the
    // shared signature it refines. That was the rule before overloads existed, so a program that built then still
    // builds; a genuinely ambiguous call is a lint for later.
    if (fitting.length > 1) {
      const exact = fitting.filter(name => {
        const signature = functions.get(name)!
        const instance = instantiate(signature, sub)

        return argTypes.every((t, i) => {
          const a = resolve(t)
          const p = resolve(instance.params[i]!)

          return (
            a.kind !== 'variable' &&
            a.kind !== 'unknown' &&
            p.kind !== 'variable' &&
            p.kind !== 'unknown'
          )
        })
      })

      callee.name = (exact.length > 0 ? exact : fitting)[
        (exact.length > 0 ? exact : fitting).length - 1
      ]!

      return
    }

    const shown = candidates
      .map(name => {
        const signature = functions.get(name)

        return signature
          ? `(${signature.params.map(showType).join(', ')})`
          : name
      })
      .join(', ')

    diagnostics.push(
      diagnose('type-mismatch', {
        file: currentFile,
        span: node.span,
        message: `no overload of "${callee.name.replace(/__\d+__\d+$/, '')}" takes (${argTypes
          .map(showType)
          .join(', ')}). It is defined for ${shown}`,
      }),
    )
  }

  // module-scope bindings (top-level `host`/`save` lets): typed once, then visible in every function body so a method
  // call on one (`call get / read running`, where `running` is a module-level list) can dispatch on its real type.
  const moduleEnv: Env = new Map()

  function checkFunction(
    node: Extract<Statement, { form: 'function' }>,
  ): void {
    // a separate-compilation stub carries only its signature: the body was checked in its owning unit
    if (node.stub) {
      return
    }

    const signature = functions.get(node.name)!
    // the generics of this function carry their declared `need` bounds, available to discharge bounded calls
    currentBounds = [...signature.bounds].map(([id, mask]) => ({
      variable: { kind: 'variable', id },
      mask,
    }))

    const env: Env = new Map(moduleEnv)
    node.params.forEach((param, i) =>
      env.set(param.name, { vars: [], type: signature.params[i]! }),
    )
    checkBody(node.body, env, signature.result)
  }

  // type-check a zone's view: infer each embedded expression with the zone's params in scope, threading `save` bindings
  function checkZone(node: Extract<Statement, { form: 'zone' }>): void {
    currentBounds = []

    const env: Env = new Map(moduleEnv)

    for (const param of node.params) {
      env.set(param.name, {
        vars: [],
        type: seedType(param.type, new Map()),
      })
    }

    // element refs (`zone input / name x`) are `view`-typed locals, pre-declared so a handler can read any of them
    const refs: string[] = []

    const walkRefs = (list: ZoneNode[]): void => {
      for (const member of list) {
        if (member.form === 'element') {
          if (member.ref) {
            refs.push(member.ref)
          }

          walkRefs(member.children)
        } else if (member.form === 'fork') {
          for (const branch of member.branches) {
            walkRefs(branch.body)
          }

          if (member.otherwise) {
            walkRefs(member.otherwise)
          }
        } else if (member.form === 'walk') {
          walkRefs(member.body)
        }
      }
    }

    walkRefs(node.body)

    for (const ref of refs) {
      env.set(ref, { vars: [], type: { kind: 'named', name: 'view' } })
    }

    checkZoneNodes(node.body, env)
  }

  function checkZoneNodes(nodes: ZoneNode[], env: Env): void {
    for (const node of nodes) {
      switch (node.form) {
        case 'element':
          for (const attribute of node.attributes) {
            inferExpression(attribute.value, env)
          }

          for (const prop of node.props) {
            inferExpression(prop.value, env)
          }

          checkZoneNodes(node.children, env)
          break
        case 'read':
          inferExpression(node.value, env)
          break
        case 'save':
          env.set(node.name, {
            vars: [],
            type: inferExpression(node.value, env),
          })
          break
        case 'fork':
          for (const branch of node.branches) {
            inferExpression(branch.cond, env)
            checkZoneNodes(branch.body, new Map(env))
          }

          if (node.otherwise) {
            checkZoneNodes(node.otherwise, new Map(env))
          }

          break

        case 'walk': {
          const iterable = resolve(inferExpression(node.iterable, env))
          const inner = new Map(env)
          inner.set(node.item, {
            vars: [],
            type:
              iterable.kind === 'array' ? iterable.element : fresh(),
          })
          checkZoneNodes(node.body, inner)
          break
        }

        case 'text':
        case 'slot':
          break
      }
    }
  }

  const topLevelSkip = new Set([
    'record-type',
    'mask',
    'instance',
    'native',
  ])

  // first pass: type module-level bindings into the shared module env, so functions (checked next) see their types.
  // A foreign host global (`host page, name <document>`) is seeded too, so an imported, centrally-declared global is
  // typed for dispatch in every consuming function. But one whose name collides with a function is skipped: bind's
  // `Element`/`Text` host globals must not shadow the framework's `element`/`text` render helpers.
  for (const statement of program) {
    currentFile = fileOrigin?.get(statement) ?? file

    if (
      statement.form === 'function' ||
      topLevelSkip.has(statement.form)
    ) {
      continue
    }

    if (
      statement.form === 'let' &&
      statement.foreign !== undefined &&
      functions.has(statement.name)
    ) {
      continue
    }

    checkStatement(statement, moduleEnv, UNKNOWN)
  }

  for (const statement of program) {
    currentFile = fileOrigin?.get(statement) ?? file

    if (
      statement.form === 'function' &&
      (only === undefined || statement.name === only)
    ) {
      checkFunction(statement)
    }
    // zones are type-checked whole-program (not part of the per-definition incremental path yet)
    else if (statement.form === 'zone' && only === undefined) {
      checkZone(statement)
    }
  }

  // a task that declares no result and whose body never fixed one (no valued `send back`, and no caller or callee
  // pinned it) is unit, so a typed backend does not read its result as a free type parameter. After every body,
  // so a forward reference to a task checked later still gets that task's real result.
  if (only === undefined) {
    for (const statement of program) {
      if (statement.form !== 'function' || statement.result || statement.stub) {
        continue
      }

      const signature = functions.get(statement.name)

      if (signature && resolve(signature.result).kind === 'variable') {
        currentFile = fileOrigin?.get(statement) ?? file
        expect(UNIT, signature.result, statement.span, 'result')
      }
    }
  }

  // deeply resolve, mapping unsolved generic variables back to their names (component: code/check/zonk.ts)
  const zonkGeneric = (type: Type, names: Map<number, string>): Type =>
    zonkGenericType(type, names, sub)

  // final pass: record fully resolved types (cross-function constraints from call sites are now known)
  for (const statement of program) {
    currentFile = fileOrigin?.get(statement) ?? file

    if (
      statement.form === 'function' &&
      (only === undefined || statement.name === only)
    ) {
      const signature = functions.get(statement.name)!
      statement.result = zonkGeneric(
        signature.result,
        signature.genericNames,
      )
      statement.params.forEach((param, i) => {
        // when a merged program holds two top-level functions of the same name (common across hundreds of generated
        // binding modules), `functions` keeps only the last, so its signature can have fewer params than this
        // statement. Fall back to the param's own milled type rather than crashing on a missing signature slot.
        const slot = signature.params[i]
        param.type = slot
          ? zonkGeneric(slot, signature.genericNames)
          : (param.type ?? UNKNOWN)
      })
      // deep-resolve every expression's inferred type, so later passes (monomorphization, native codegen) see
      // concrete types rather than unsolved inference variables. Free variables tied to a generic parameter resolve
      // to that parameter's name (so `make none` in a generic method types as maybe<s>, emittable as a native enum).
      zonkBody(statement.body, signature.genericNames)
    }
    // a module-level binding zonks too: `host hive` builds a record whose empty-list fields were unified with the
    // form's declared element types, and a native backend reads the literal's type to spell the collection
    // (`mutableListOf<HiveDeck>()`); without this the free element variable defaulted to a number
    else if (statement.form === 'let' && only === undefined) {
      zonkBody([statement], new Map())
    }
  }

  return diagnostics

  // walk a body, replacing each expression's `type` with its fully resolved form
  function zonkBody(
    body: Statement[],
    names: Map<number, string>,
  ): void {
    const visitExpression = (node: Expression): void => {
      if (node.type) {
        node.type = zonkGeneric(node.type, names)
      }

      switch (node.form) {
        case 'binary':
          visitExpression(node.left)
          visitExpression(node.right)
          break
        case 'unary':
          visitExpression(node.operand)
          break
        case 'call':
          visitExpression(node.callee)
          node.args.forEach(visitExpression)
          break
        case 'member':
          visitExpression(node.target)
          break
        case 'await':
          visitExpression(node.expr)
          break
        case 'array':
          node.items.forEach(visitExpression)
          break
        case 'map':
          node.entries.forEach(e => {
            visitExpression(e.key)
            visitExpression(e.value)
          })
          break
        case 'record':
          node.fields.forEach(f => visitExpression(f.value))
          break
        default:
          break
      }
    }

    for (const statement of body) {
      switch (statement.form) {
        case 'let':
          // the let's own annotation must zonk too: a local inferred at a generic's type keeps a raw inference
          // variable otherwise, and a backend rendering the annotation cannot map it to the declared generic name
          if (statement.type) {
            statement.type = zonkGeneric(statement.type, names)
          }

          visitExpression(statement.init)
          break
        case 'assign':
          visitExpression(statement.target)
          visitExpression(statement.value)
          break
        case 'expression':
        case 'hold':
          visitExpression(statement.expr)
          break
        case 'return':
          if (statement.value) {
            visitExpression(statement.value)
          }

          break
        case 'throw':
          visitExpression(statement.value)
          break
        case 'while':
          visitExpression(statement.cond)
          zonkBody(statement.body, names)
          break
        case 'guard':
          zonkBody(statement.body, names)

          if (statement.catch) {
            zonkBody(statement.catch.body, names)
          }

          break
        case 'for-each':
          visitExpression(statement.iterable)
          zonkBody(statement.body, names)
          break
        case 'if':
          statement.branches.forEach(b => {
            visitExpression(b.cond)
            zonkBody(b.body, names)
          })

          if (statement.otherwise) {
            zonkBody(statement.otherwise, names)
          }

          break
        case 'match':
          visitExpression(statement.subject)
          statement.cases.forEach(c => zonkBody(c.body, names))

          if (statement.otherwise) {
            zonkBody(statement.otherwise, names)
          }

          break
        default:
          break
      }
    }
  }
}

// the exceptions a guarded body can raise: its own `halt <form>`s (outside nested guards with handlers) and the raise
// sets of the tasks it calls, so a `fork case` over the caught value can be held exhaustive
function bodyRaises(body: Statement[], sets: Map<string, Set<string>>): Set<string> {
  const out = new Set<string>()

  const expr = (node: Expression): void => {
    switch (node.form) {
      case 'call':
        if (node.callee.form === 'variable') {
          for (const e of sets.get(node.callee.name) ?? []) {
            out.add(e)
          }
        }

        expr(node.callee)
        node.args.forEach(expr)
        break
      case 'binary':
        expr(node.left)
        expr(node.right)
        break
      case 'unary':
        expr(node.operand)
        break
      case 'member':
        expr(node.target)
        break
      case 'await':
        expr(node.expr)
        break
      case 'array':
        node.items.forEach(expr)
        break
      case 'record':
        node.fields.forEach(f => expr(f.value))
        break
      case 'template':
        node.parts.forEach(p => {
          if (typeof p !== 'string') {
            expr(p)
          }
        })
        break
      default:
        break
    }
  }

  const walk = (statements: Statement[]): void => {
    for (const s of statements) {
      switch (s.form) {
        case 'throw':
          if (s.raise) {
            out.add(s.raise)
          } else if (s.value.form === 'string') {
            out.add('failure')
          } else {
            out.add('exception')
          }

          break
        case 'let':
          expr(s.init)
          break
        case 'assign':
          expr(s.value)
          break
        case 'expression':
          expr(s.expr)
          break
        case 'return':
          if (s.value) {
            expr(s.value)
          }

          break
        case 'if':
          s.branches.forEach(b => {
            expr(b.cond)
            walk(b.body)
          })

          if (s.otherwise) {
            walk(s.otherwise)
          }

          break
        case 'while':
          expr(s.cond)
          walk(s.body)
          break
        case 'for-each':
          expr(s.iterable)
          walk(s.body)
          break
        case 'match':
          expr(s.subject)
          s.cases.forEach(c => walk(c.body))

          if (s.otherwise) {
            walk(s.otherwise)
          }

          break
        case 'guard':
          if (s.catch) {
            walk(s.catch.body)
          }

          break
        default:
          break
      }
    }
  }

  walk(body)

  return out
}
