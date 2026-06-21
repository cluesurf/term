// The type checker: gradual, bidirectional inference over the compile AST. Type variables are inference holes,
// solved by unification. `unknown` is the gradual any: consistent with everything, never an error. Concrete
// mismatches are reported with spans. This is the formal type-checking pass that runs after resolution. See
// note/research/vibe/computation/plans/04-typecheck.md and 11-elaboration.md.

import type {
  Diagnostic,
  Span,
} from '@cluesurf/make/code/parser/diagnostic'
import { diagnose } from '@cluesurf/make/code/parser/diagnostic'
import { Substitution } from '@cluesurf/make/code/check/substitution'
import { instantiate } from '@cluesurf/make/code/check/signature'
import type { Signature } from '@cluesurf/make/code/check/signature'
import { makeSeedType } from '@cluesurf/make/code/check/type-seed'
import { zonkGeneric as zonkGenericType } from '@cluesurf/make/code/check/zonk'
import {
  instantiateScheme as instantiateSchemeImpl,
  freeTypeVars as freeTypeVarsImpl,
  generalize as generalizeImpl,
  isValueExpression,
} from '@cluesurf/make/code/check/scheme'
import type { Scheme, Env } from '@cluesurf/make/code/check/scheme'
import { makeExpect } from '@cluesurf/make/code/check/expect'
import type {
  Expression,
  Program,
  Statement,
  Type,
  ZoneNode,
} from '@cluesurf/make/code/compile/node'
import {
  BOOLEAN,
  DYNAMIC,
  FLOAT,
  NUMBER,
  STRING,
  UNIT,
  UNKNOWN,
  showType,
} from '@cluesurf/make/code/compile/node'

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
  // a record-type field's foreign `name <...>` (its exact native name), so the emitter uses it verbatim
  const fieldNick = new Map<string, Map<string, string>>()
  // enum variant sets (for exhaustiveness) and variant -> enum (so `make red` is typed as its enum)
  const enums = new Map<string, Set<string>>()
  const variantEnum = new Map<string, string>()
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

        if (field.nick) {nicks.set(field.name, field.nick)}
      }

      records.set(statement.name, fields)

      if (nicks.size) {fieldNick.set(statement.name, nicks)}

      if (statement.variants.length > 0) {
        const set = new Set<string>()

        for (const variant of statement.variants) {
          set.add(variant.name)
          variantEnum.set(variant.name, statement.name)

          const own = new Map<string, Type>()

          for (const field of variant.fields)
            {own.set(field.name, field.type)}

          variantFields.set(variant.name, own)
        }

        enums.set(statement.name, set)
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

  for (const statement of program)
    {if (
      statement.form === 'record-type' &&
      statement.alias &&
      statement.fields.length === 0 &&
      statement.variants.length === 0 &&
      statement.params.length === 0
    )
      {transparentAlias.set(statement.name, statement.alias)}}

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
  const seedType = makeSeedType(sub, records, formGenerics)

  // trait instances available: `${mask}:${type}` (for call-site instance resolution)
  const instances = new Set<string>()

  for (const statement of program)
    {if (statement.form === 'instance')
      {instances.add(`${statement.mask}:${statement.target}`)}}

  // trait-method names (every method any mask declares). A trait-method call whose receiver is a concrete form
  // dispatches to that form's instance method here; one whose receiver is a trait-bounded generic is left unresolved
  // so the dictionary-passing IR pass can thread the instance. So the single-owner dispatch guess below must NOT fire
  // for a trait method -- guessing the lone instance would wrongly hard-wire a generic call to one concrete type.
  const maskMethods = new Set<string>()

  for (const statement of program)
    {if (statement.form === 'mask')
      {for (const method of statement.methods) {maskMethods.add(method)}}}

  // function name -> its signature: generic variable ids, their names, their trait bounds, and param/result types
  const functions = new Map<string, Signature>()

  for (const statement of program) {
    if (statement.form !== 'function') {continue}

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

        if (g.need) {bounds.set(variable.id, g.need)}
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
    })
  }

  // a declarative native binding registers a function-shaped signature (no generics, no body to check): calls resolve
  // and type-check against it, and each backend renders the env's native template in place of a real call.
  for (const statement of program) {
    if (statement.form !== 'bind') {continue}

    if (functions.has(statement.name)) {continue}

    const noGenerics = new Map<string, Type>()
    functions.set(statement.name, {
      generics: new Set<number>(),
      genericNames: new Map<number, string>(),
      bounds: new Map<number, string>(),
      params: statement.params.map(p => seedType(p.type, noGenerics)),
      result: seedType(statement.result, noGenerics),
      minArgs: statement.params.filter(p => !p.optional).length,
    })
  }

  // receiver dispatch: a form's mangled method (`maybe_unwrap-or`) indexed by form name then bare method name, so a
  // bare `call unwrap-or / <receiver>` resolves to the method of the receiver's form. `methodNames` is the set of
  // every bare method name, used to recognise a call site as a method call before dispatching.
  const methodTable = new Map<string, Map<string, string>>()
  const methodNames = new Set<string>()

  for (const statement of program) {
    if (statement.form !== 'function' || !statement.method) {continue}

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

        for (const item of node.items)
          {expect(
            inferExpression(item, env),
            element,
            item.span,
            'array element',
          )}

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
          if (fieldType)
            {expect(
              valueType,
              seedType(fieldType, argMap),
              field.value.span,
              'field value',
            )}
        }

        type = { kind: 'named', name: enumName, args }
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

        if (node.otherwise)
          {unify(
            result,
            inferExpression(node.otherwise, env),
            node.otherwise.span,
          )}

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

            if (subject.kind === 'named' && subject.args)
              {params.forEach(
                (p, i) =>
                  subject.args![i] && argMap.set(p, subject.args![i]),
              )}

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

            if (nick) {node.nick = nick}

            // substitute the target's type arguments for the form's generics (pair<a,b> -> first : a); seedType (not
            // substGenerics) so a `like list` / `like hash` field reads as array / map, matching its values
            const params = formGenerics.get(target.name) ?? []
            const argMap = new Map<string, Type>()

            if (target.args)
              {params.forEach(
                (p, i) =>
                  target.args![i] && argMap.set(p, target.args![i]),
              )}

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
        const args = node.args.map(arg => inferExpression(arg, env))

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

          for (const arg of args) {
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

            if (owners.length === 1) {mangled = owners[0]!.get(method)}
          }

          if (mangled && functions.has(mangled))
            {node.callee.name = mangled}
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

          if (args.length !== signature.params.length) {
            diagnostics.push(
              diagnose('type-mismatch', {
                file: currentFile,
                span: node.span,
                message: `"${node.callee.name}" expects ${signature.params.length} arguments, found ${args.length}`,
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
                if (b.mask !== bound.mask) {return false}

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

        if (node.async) {fn.effects = ['async']}

        type = fn
        break
      }
    }

    node.type = type

    return type
  }

  function checkBody(
    body: Statement[],
    env: Env,
    result: Type,
  ): void {
    for (const statement of body) {checkStatement(statement, env, result)}
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
          // an ambient declaration (`host document, name <document> / like document`) has no initializer; the mill
          // synthesizes a unit placeholder, so do not check it against the declared type. A real initializer (a
          // re-type like `host el, like element / read x`, where the opaque field is gradual `unknown`) is checked.
          if (node.init.form !== 'unit')
            {expect(initType, node.type, node.span, 'binding')}

          env.set(node.name, { vars: [], type: node.type })
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
        if (node.value)
          {expect(
            inferExpression(node.value, env),
            result,
            node.span,
            'return value',
          )}

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

        if (node.otherwise) {checkBody(node.otherwise, env, result)}

        break

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
            const missing = [...variants].filter(v => !covered.has(v))

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

          if (subjectVar) {narrowing.set(subjectVar, branch.label)}

          checkBody(branch.body, env, result)

          if (subjectVar) {
            if (previous === undefined) {narrowing.delete(subjectVar)}
            else {narrowing.set(subjectVar, previous)}
          }
        }

        if (node.otherwise) {checkBody(node.otherwise, env, result)}

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

  // module-scope bindings (top-level `host`/`save` lets): typed once, then visible in every function body so a method
  // call on one (`call get / read running`, where `running` is a module-level list) can dispatch on its real type.
  const moduleEnv: Env = new Map()

  function checkFunction(
    node: Extract<Statement, { form: 'function' }>,
  ): void {
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

    for (const param of node.params)
      {env.set(param.name, {
        vars: [],
        type: seedType(param.type, new Map()),
      })}

    // element refs (`zone input / name x`) are `view`-typed locals, pre-declared so a handler can read any of them
    const refs: string[] = []

    const walkRefs = (list: ZoneNode[]): void => {
      for (const member of list) {
        if (member.form === 'element') {
          if (member.ref) {refs.push(member.ref)}

          walkRefs(member.children)
        } else if (member.form === 'fork') {
          for (const branch of member.branches) {walkRefs(branch.body)}

          if (member.otherwise) {walkRefs(member.otherwise)}
        } else if (member.form === 'walk') {walkRefs(member.body)}
      }
    }

    walkRefs(node.body)

    for (const ref of refs)
      {env.set(ref, { vars: [], type: { kind: 'named', name: 'view' } })}

    checkZoneNodes(node.body, env)
  }

  function checkZoneNodes(nodes: ZoneNode[], env: Env): void {
    for (const node of nodes) {
      switch (node.form) {
        case 'element':
          for (const attribute of node.attributes)
            {inferExpression(attribute.value, env)}

          for (const prop of node.props)
            {inferExpression(prop.value, env)}

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

          if (node.otherwise)
            {checkZoneNodes(node.otherwise, new Map(env))}

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
    )
      {continue}

    if (
      statement.form === 'let' &&
      statement.foreign !== undefined &&
      functions.has(statement.name)
    )
      {continue}

    checkStatement(statement, moduleEnv, UNKNOWN)
  }

  for (const statement of program) {
    currentFile = fileOrigin?.get(statement) ?? file

    if (
      statement.form === 'function' &&
      (only === undefined || statement.name === only)
    )
      {checkFunction(statement)}
    // zones are type-checked whole-program (not part of the per-definition incremental path yet)
    else if (statement.form === 'zone' && only === undefined)
      {checkZone(statement)}
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
  }

  return diagnostics

  // walk a body, replacing each expression's `type` with its fully resolved form
  function zonkBody(
    body: Statement[],
    names: Map<number, string>,
  ): void {
    const visitExpression = (node: Expression): void => {
      if (node.type) {node.type = zonkGeneric(node.type, names)}

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
          if (statement.value) {visitExpression(statement.value)}

          break
        case 'throw':
          visitExpression(statement.value)
          break
        case 'while':
          visitExpression(statement.cond)
          zonkBody(statement.body, names)
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

          if (statement.otherwise) {zonkBody(statement.otherwise, names)}

          break
        case 'match':
          visitExpression(statement.subject)
          statement.cases.forEach(c => zonkBody(c.body, names))

          if (statement.otherwise) {zonkBody(statement.otherwise, names)}

          break
        default:
          break
      }
    }
  }
}
