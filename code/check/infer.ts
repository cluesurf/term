// The type checker: gradual, bidirectional inference over the compile AST. Type variables are inference holes,
// solved by unification. `unknown` is the gradual any: consistent with everything, never an error. Concrete
// mismatches are reported with spans. This is the formal type-checking pass that runs after resolution. See
// note/research/vibe/computation/plans/04-typecheck.md and 11-elaboration.md.

import type { Diagnostic, Span } from '@/code/parser/diagnostic'
import { diagnose } from '@/code/parser/diagnostic'
import type { Expression, Program, Statement, Type } from '@/code/compile/node'
import { BOOLEAN, NUMBER, STRING, UNIT, UNKNOWN, showType } from '@/code/compile/node'

export function check(program: Program, file: string, fileOrigin?: WeakMap<Statement, string>): Array<Diagnostic> {
  const diagnostics: Array<Diagnostic> = []
  // the file currently being checked. With a merged multi-module program `file` is only the entry; `fileOrigin` maps
  // each top-level statement to its module, so a type error points at the real source rather than the entry.
  let currentFile = file
  const substitution = new Map<number, Type>()
  let nextVariable = 0
  const fresh = (): Type => ({ kind: 'variable', id: nextVariable++ })

  // follow variable bindings to the current best type, with union-find path compression so later lookups are O(1)
  function resolve(type: Type): Type {
    const chain: Array<number> = []
    let current = type
    while (current.kind === 'variable') {
      const bound = substitution.get(current.id)
      if (!bound) break
      chain.push(current.id)
      current = bound
    }
    for (const id of chain) substitution.set(id, current) // compress the path
    return current
  }

  function occurs(id: number, type: Type): boolean {
    const t = resolve(type)
    if (t.kind === 'variable') return t.id === id
    if (t.kind === 'function') return t.params.some((p) => occurs(id, p)) || occurs(id, t.result)
    if (t.kind === 'array') return occurs(id, t.element)
    if (t.kind === 'map') return occurs(id, t.key) || occurs(id, t.value)
    if (t.kind === 'named' && t.args) return t.args.some((a) => occurs(id, a))
    return false
  }

  // deeply resolve a type (so array<var> becomes array<concrete> for nice output)
  function zonk(type: Type): Type {
    const t = resolve(type)
    if (t.kind === 'array') return { kind: 'array', element: zonk(t.element) }
    if (t.kind === 'map') return { kind: 'map', key: zonk(t.key), value: zonk(t.value) }
    if (t.kind === 'function') return { kind: 'function', params: t.params.map(zonk), result: zonk(t.result), effects: t.effects }
    if (t.kind === 'named' && t.args) return { kind: 'named', name: t.name, args: t.args.map(zonk) }
    return t
  }

  // substitute a form's generic names with concrete types (e.g. maybe's `t` -> the subject's element type)
  function substGenerics(type: Type, map: Map<string, Type>): Type {
    if (type.kind === 'named') {
      const direct = map.get(type.name)
      if (direct && (!type.args || type.args.length === 0)) return direct
      return { kind: 'named', name: type.name, args: type.args?.map((a) => substGenerics(a, map)) }
    }
    if (type.kind === 'array') return { kind: 'array', element: substGenerics(type.element, map) }
    if (type.kind === 'map') return { kind: 'map', key: substGenerics(type.key, map), value: substGenerics(type.value, map) }
    if (type.kind === 'function') return { kind: 'function', params: type.params.map((p) => substGenerics(p, map)), result: substGenerics(type.result, map), effects: type.effects }
    return type
  }

  // record-type field maps, for member-access typing
  const records = new Map<string, Map<string, Type>>()
  // enum variant sets (for exhaustiveness) and variant -> enum (so `make red` is typed as its enum)
  const enums = new Map<string, Set<string>>()
  const variantEnum = new Map<string, string>()
  // each variant's own fields, exposed inside a matching `case` branch (so `self/value` works after a match)
  const variantFields = new Map<string, Map<string, Type>>()
  // a form's generic parameter names, e.g. maybe -> ["t"], for parameterized named types (maybe<t>)
  const formGenerics = new Map<string, Array<string>>()
  for (const statement of program) {
    if (statement.form === 'record-type') {
      formGenerics.set(statement.name, statement.params)
      const fields = new Map<string, Type>()
      for (const field of statement.fields) fields.set(field.name, field.type)
      records.set(statement.name, fields)
      if (statement.variants.length > 0) {
        const set = new Set<string>()
        for (const variant of statement.variants) {
          set.add(variant.name)
          variantEnum.set(variant.name, statement.name)
          const own = new Map<string, Type>()
          for (const field of variant.fields) own.set(field.name, field.type)
          variantFields.set(variant.name, own)
        }
        enums.set(statement.name, set)
      }
    }
  }

  // within a `case <variant>` branch, a subject variable is narrowed to that variant, so its fields are in scope
  const narrowing = new Map<string, string>()

  // where each inference variable was first fixed to a concrete type, for blame tracking
  const origin = new Map<number, { span: Span; type: Type }>()

  // unify two types. returns true on success. `unknown` (gradual) is consistent with anything. When a variable is
  // solved to a concrete type and a span is given, remember it (so a later conflict can point back here).
  function unify(a: Type, b: Type, span?: Span): boolean {
    const x = resolve(a)
    const y = resolve(b)
    if (x.kind === 'unknown' || y.kind === 'unknown') return true
    if (x.kind === 'variable') {
      if (y.kind === 'variable' && y.id === x.id) return true
      if (occurs(x.id, y)) return false
      substitution.set(x.id, y)
      if (span && y.kind !== 'variable') origin.set(x.id, { span, type: y })
      return true
    }
    if (y.kind === 'variable') {
      if (occurs(y.id, x)) return false
      substitution.set(y.id, x)
      // x is already known to be non-variable here (the variable case above returned), so just record the origin
      if (span) origin.set(y.id, { span, type: x })
      return true
    }
    if (x.kind === 'function' && y.kind === 'function') {
      if (x.params.length !== y.params.length) return false
      for (let i = 0; i < x.params.length; i++) if (!unify(x.params[i]!, y.params[i]!)) return false
      return unify(x.result, y.result)
    }
    if (x.kind === 'array' && y.kind === 'array') return unify(x.element, y.element)
    if (x.kind === 'map' && y.kind === 'map') return unify(x.key, y.key) && unify(x.value, y.value)
    if (x.kind === 'named' && y.kind === 'named') {
      if (x.name !== y.name) return false
      const xa = x.args ?? []
      const ya = y.args ?? []
      if (xa.length !== ya.length) return true // one side unparameterized: treat as compatible (gradual)
      return xa.every((a, i) => unify(a, ya[i]!))
    }
    return x.kind === y.kind
  }

  function expect(actual: Type, wanted: Type, span: Span, what: string): void {
    // remember which sides were still inference variables, so we can blame where they were first fixed
    const suspects: Array<number> = []
    if (actual.kind === 'variable') suspects.push(actual.id)
    if (wanted.kind === 'variable') suspects.push(wanted.id)
    if (!unify(actual, wanted, span)) {
      const markers: Array<{ span: Span; label?: string }> = [{ span }]
      for (const id of suspects) {
        const where = origin.get(id)
        if (where) markers.push({ span: where.span, label: `first used as ${showType(where.type)} here` })
      }
      diagnostics.push(
        diagnose('type-mismatch', {
          file: currentFile,          span,
          message: `${what}: expected ${showType(resolve(wanted))}, found ${showType(resolve(actual))}`,
          markers,
        }),
      )
    }
  }

  // a declared type, with generic names mapped to their variables and unknown names left to inference
  function seedType(type: Type | undefined, generics: Map<string, Type>): Type {
    if (!type) return fresh()
    if (type.kind === 'named') {
      const generic = generics.get(type.name)
      if (generic) return generic
      // `list` is the native array type: `like list` is array<unknown>, `like list<t>` is array<t>
      if (type.name === 'list') return { kind: 'array', element: type.args?.[0] ? seedType(type.args[0], generics) : UNKNOWN }
      // `hash` is the native map type: `like hash<k, v>` is map<k, v>, `like hash` is map<unknown, unknown>
      if (type.name === 'hash') return { kind: 'map', key: type.args?.[0] ? seedType(type.args[0], generics) : UNKNOWN, value: type.args?.[1] ? seedType(type.args[1], generics) : UNKNOWN }
      if (records.has(type.name)) {
        // a form: give it a fresh type argument per generic parameter (maybe -> maybe<?a>), inferred from usage
        const params = formGenerics.get(type.name) ?? []
        return { kind: 'named', name: type.name, args: params.map((_, i) => seedType(type.args?.[i], generics)) }
      }
      return fresh() // an unrecognized name: infer it from usage rather than forcing a mismatch
    }
    if (type.kind === 'array') return { kind: 'array', element: seedType(type.element, generics) }
    if (type.kind === 'map') return { kind: 'map', key: seedType(type.key, generics), value: seedType(type.value, generics) }
    if (type.kind === 'function') return { kind: 'function', params: type.params.map((p) => seedType(p, generics)), result: seedType(type.result, generics), effects: type.effects }
    return type
  }

  // trait instances available: `${mask}:${type}` (for call-site instance resolution)
  const instances = new Set<string>()
  for (const statement of program) if (statement.form === 'instance') instances.add(`${statement.mask}:${statement.target}`)

  // function name -> its signature: generic variable ids, their names, their trait bounds, and param/result types
  type Signature = { generics: Set<number>; genericNames: Map<number, string>; bounds: Map<number, string>; params: Array<Type>; result: Type; minArgs: number }
  const functions = new Map<string, Signature>()
  for (const statement of program) {
    if (statement.form !== 'function') continue
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
        if (g.need) bounds.set(variable.id, g.need)
      }
    }
    functions.set(statement.name, {
      generics: genericIds,
      genericNames,
      bounds,
      params: statement.params.map((p) => seedType(p.type, genericVars)),
      result: seedType(statement.result, genericVars),
      // the minimum call arity: trailing `need false` params may be omitted
      minArgs: statement.params.filter((p) => !p.optional).length,
    })
  }

  // receiver dispatch: a form's mangled method (`maybe_unwrap-or`) indexed by form name then bare method name, so a
  // bare `call unwrap-or / <receiver>` resolves to the method of the receiver's form. `methodNames` is the set of
  // every bare method name, used to recognise a call site as a method call before dispatching.
  const methodTable = new Map<string, Map<string, string>>()
  const methodNames = new Set<string>()
  for (const statement of program) {
    if (statement.form !== 'function' || !statement.method) continue
    const byName = methodTable.get(statement.method.form) ?? new Map<string, string>()
    byName.set(statement.method.name, statement.name)
    methodTable.set(statement.method.form, byName)
    methodNames.add(statement.method.name)
  }

  // instantiate a signature, freshening its generic variables (Hindley-Milner let-polymorphism), so a generic
  // function can be called at different types in the same program
  function instantiate(signature: Signature): { params: Array<Type>; result: Type; bounds: Array<{ variable: Type; mask: string }>; minArgs: number } {
    if (signature.generics.size === 0) return { params: signature.params, result: signature.result, bounds: [], minArgs: signature.minArgs }
    const map = new Map<number, Type>()
    for (const id of signature.generics) map.set(id, fresh())
    const subst = (type: Type): Type => {
      const r = resolve(type)
      if (r.kind === 'variable') return map.get(r.id) ?? r
      if (r.kind === 'array') return { kind: 'array', element: subst(r.element) }
      if (r.kind === 'function') return { kind: 'function', params: r.params.map(subst), result: subst(r.result), effects: r.effects }
      if (r.kind === 'named' && r.args) return { kind: 'named', name: r.name, args: r.args.map(subst) }
      return r
    }
    const bounds = [...signature.bounds].map(([id, mask]) => ({ variable: map.get(id)!, mask }))
    return { params: signature.params.map(subst), result: subst(signature.result), bounds, minArgs: signature.minArgs }
  }

  // a type scheme: a type with some inference variables generalized (quantified). Empty `vars` is a plain
  // monomorphic type. Let-generalization (value-restricted) gives an immutable binding a polymorphic scheme so it
  // can be used at several types; each use instantiates the scheme freshly.
  type Scheme = { vars: Array<number>; type: Type }
  type Env = Map<string, Scheme>

  function instantiateScheme(scheme: Scheme): Type {
    if (scheme.vars.length === 0) return scheme.type
    const map = new Map<number, Type>()
    for (const id of scheme.vars) map.set(id, fresh())
    const go = (t: Type): Type => {
      const r = resolve(t)
      if (r.kind === 'variable') return map.get(r.id) ?? r
      if (r.kind === 'array') return { kind: 'array', element: go(r.element) }
      if (r.kind === 'map') return { kind: 'map', key: go(r.key), value: go(r.value) }
      if (r.kind === 'function') return { kind: 'function', params: r.params.map(go), result: go(r.result), effects: r.effects }
      return r
    }
    return go(scheme.type)
  }

  function freeTypeVars(type: Type, into: Set<number>): void {
    const r = resolve(type)
    if (r.kind === 'variable') into.add(r.id)
    else if (r.kind === 'array') freeTypeVars(r.element, into)
    else if (r.kind === 'map') { freeTypeVars(r.key, into); freeTypeVars(r.value, into) }
    else if (r.kind === 'function') { r.params.forEach((p) => freeTypeVars(p, into)); freeTypeVars(r.result, into) }
  }

  // the variables free in `type` but not free anywhere in the environment: those may be generalized
  function generalize(type: Type, env: Env): Array<number> {
    const inType = new Set<number>()
    freeTypeVars(type, inType)
    const inEnv = new Set<number>()
    for (const scheme of env.values()) {
      const seen = new Set<number>()
      freeTypeVars(scheme.type, seen)
      for (const v of seen) if (!scheme.vars.includes(v)) inEnv.add(v)
    }
    return [...inType].filter((v) => !inEnv.has(v))
  }

  // the value restriction: only a syntactic value may be generalized (so a mutable reference is never over-generalized)
  function isValueExpression(node: Expression): boolean {
    switch (node.form) {
      case 'integer':
      case 'float':
      case 'boolean':
      case 'string':
      case 'unit':
      case 'array':
      case 'map':
      case 'record':
      case 'variable':
      case 'closure':
      case 'hole':
        return true
      default:
        return false
    }
  }

  // the trait bounds carried by the generics of the function currently being checked (each a generic type variable
  // with the mask it is bound by). Used to discharge a bounded call whose argument is still one of the enclosing
  // generics rather than a concrete type. Compared by resolved representative, since unification may have linked it.
  let currentBounds: Array<{ variable: Type; mask: string }> = []

  function inferExpression(node: Expression, env: Env): Type {
    let type: Type
    switch (node.form) {
      case 'integer':
      case 'float':
        type = NUMBER
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
      case 'hole':
        type = UNKNOWN
        break
      case 'variable': {
        const local = env.get(node.name)
        if (local) {
          type = instantiateScheme(local)
        } else if (functions.has(node.name)) {
          // a task referenced as a first-class value: its (freshly instantiated) function type
          const signature = instantiate(functions.get(node.name)!)
          type = { kind: 'function', params: signature.params, result: signature.result }
        } else {
          type = UNKNOWN
        }
        break
      }
      case 'unary':
        if (node.op === '-') {
          expect(inferExpression(node.operand, env), NUMBER, node.span, 'negation operand')
          type = NUMBER
        } else {
          expect(inferExpression(node.operand, env), BOOLEAN, node.span, 'not operand')
          type = BOOLEAN
        }
        break
      case 'binary': {
        const left = inferExpression(node.left, env)
        const right = inferExpression(node.right, env)
        if (node.op === '&&' || node.op === '||') {
          expect(left, BOOLEAN, node.left.span, 'logical operand')
          expect(right, BOOLEAN, node.right.span, 'logical operand')
          type = BOOLEAN
        } else if (node.op === '==' || node.op === '!=') {
          expect(right, left, node.right.span, 'comparison operands')
          type = BOOLEAN
        } else if (node.op === '<' || node.op === '<=' || node.op === '>' || node.op === '>=') {
          expect(left, NUMBER, node.left.span, 'comparison operand')
          expect(right, NUMBER, node.right.span, 'comparison operand')
          type = BOOLEAN
        } else if (node.op === '+' && resolve(left).kind === 'string') {
          // `+` is string concatenation when its left operand is a string (otherwise numeric addition)
          expect(right, STRING, node.right.span, 'string concatenation')
          type = STRING
        } else {
          expect(left, NUMBER, node.left.span, 'arithmetic operand')
          expect(right, NUMBER, node.right.span, 'arithmetic operand')
          type = NUMBER
        }
        break
      }
      case 'array': {
        const element = fresh()
        for (const item of node.items) expect(inferExpression(item, env), element, item.span, 'array element')
        type = { kind: 'array', element }
        break
      }
      case 'map': {
        const key = fresh()
        const value = fresh()
        for (const entry of node.entries) {
          expect(inferExpression(entry.key, env), key, entry.key.span, 'map key')
          expect(inferExpression(entry.value, env), value, entry.value.span, 'map value')
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
        const args = params.map((p) => {
          const v = fresh()
          argMap.set(p, v)
          return v
        })
        const declared = variantEnum.has(node.name) ? variantFields.get(node.name) : records.get(node.name)
        for (const field of node.fields) {
          const valueType = inferExpression(field.value, env)
          const fieldType = declared?.get(field.name)
          // seedType (not substGenerics) so a declared `like list` field becomes array<...>, matching how a list
          // value is typed; it also resolves the form's generics via argMap
          if (fieldType) expect(valueType, seedType(fieldType, argMap), field.value.span, 'field value')
        }
        type = { kind: 'named', name: enumName, args }
        break
      }
      case 'await':
        // await unwraps an async result; we model the result type as the inner type
        type = inferExpression(node.expr, env)
        break
      case 'member': {
        // variant-field access: inside a `case <v>` branch, the narrowed subject exposes that variant's fields,
        // with the subject's type arguments substituted for the enum's generics (maybe<number> -> value : number)
        if (node.target.form === 'variable' && narrowing.has(node.target.name)) {
          const variant = narrowing.get(node.target.name)!
          const field = variantFields.get(variant)?.get(node.name)
          if (field) {
            const subject = resolve(env.get(node.target.name)?.type ?? UNKNOWN)
            const params = formGenerics.get(variantEnum.get(variant) ?? '') ?? []
            const argMap = new Map<string, Type>()
            if (subject.kind === 'named' && subject.args) params.forEach((p, i) => subject.args![i] && argMap.set(p, subject.args![i]!))
            type = seedType(field, argMap)
            break
          }
        }
        const target = resolve(inferExpression(node.target, env))
        if (target.kind === 'named' && records.has(target.name)) {
          const field = records.get(target.name)!.get(node.name)
          if (field) {
            // substitute the target's type arguments for the form's generics (pair<a,b> -> first : a); seedType (not
            // substGenerics) so a `like list` / `like hash` field reads as array / map, matching its values
            const params = formGenerics.get(target.name) ?? []
            const argMap = new Map<string, Type>()
            if (target.args) params.forEach((p, i) => target.args![i] && argMap.set(p, target.args![i]!))
            type = seedType(field, argMap)
          } else {
            // not a field: a member access onto a form method (`document/create-element`) is a native method call.
            // Type it as the method's function (so the enclosing call checks its args). The receiver stays the member
            // target, and the emitter lowers `target.create-element(args)` to `target.createElement(args)`. This is
            // how a JS-`this`-style binding (bind's DOM methods take no `self`) is invoked from seed.
            const mangled = methodTable.get(target.name)?.get(node.name)
            if (mangled && functions.has(mangled)) {
              const signature = instantiate(functions.get(mangled)!)
              type = { kind: 'function', params: signature.params, result: signature.result }
            } else {
              diagnostics.push(diagnose('unknown-name', { file: currentFile, span: node.span, message: `"${target.name}" has no field "${node.name}"` }))
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
        const args = node.args.map((arg) => inferExpression(arg, env))
        // receiver dispatch: rewrite a bare method call (`call unwrap-or / <receiver>`) to the mangled method of the
        // receiver's form. The receiver is whichever argument is a form that owns this method (usually `self`, first).
        // A local binding of the same name (a parameter or let, e.g. maybe/filter's `test` task param) shadows both
        // method dispatch and any global function, so skip when the name is bound in the current environment. Dispatch
        // runs even when a global function shares the name (e.g. a `get`/`set` method alongside bind's global Reflect
        // `get`): an argument that pins a form owning the method wins, otherwise we fall through to the global below.
        if (node.callee.form === 'variable' && !env.has(node.callee.name) && methodNames.has(node.callee.name)) {
          const method = node.callee.name
          let mangled: string | undefined
          for (const arg of args) {
            const receiver = resolve(arg)
            // a named form dispatches to its own methods; an array receiver dispatches to `list`'s methods and a map
            // receiver to `hash`'s (those forms are the native array / map), so `call map / <array>` or `call get /
            // <map>` resolves even when other forms also define that method
            const owner = receiver.kind === 'named' ? receiver.name : receiver.kind === 'array' ? 'list' : receiver.kind === 'map' ? 'hash' : undefined
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
          if (!mangled && !functions.has(method)) {
            const owners = [...methodTable.values()].filter((m) => m.has(method))
            if (owners.length === 1) mangled = owners[0]!.get(method)
          }
          if (mangled && functions.has(mangled)) node.callee.name = mangled
        }
        if (node.callee.form === 'variable' && functions.has(node.callee.name) && !env.has(node.callee.name)) {
          // instantiate generics fresh for this call (let-polymorphism)
          const signature = instantiate(functions.get(node.callee.name)!)
          if (args.length !== signature.params.length) {
            diagnostics.push(
              diagnose('type-mismatch', {
                file: currentFile,                span: node.span,
                message: `"${node.callee.name}" expects ${signature.params.length} arguments, found ${args.length}`,
              }),
            )
          } else {
            args.forEach((arg, i) => expect(arg, signature.params[i]!, node.args[i]!.span, 'argument'))
          }
          // instance resolution: each trait bound must be satisfied for the type it resolved to. A concrete type
          // needs an instance; a type still equal to one of the enclosing function's generics needs that generic
          // to carry the same bound (bound propagation), otherwise the call is not justified.
          for (const bound of signature.bounds) {
            const concrete = resolve(bound.variable)
            if (concrete.kind === 'named' && !instances.has(`${bound.mask}:${concrete.name}`)) {
              diagnostics.push(diagnose('no-instance', { file: currentFile, span: node.span, message: `no "${bound.mask}" instance for "${concrete.name}"` }))
            } else if (concrete.kind === 'variable') {
              const satisfied = currentBounds.some((b) => {
                if (b.mask !== bound.mask) return false
                const enclosing = resolve(b.variable)
                return enclosing.kind === 'variable' && enclosing.id === concrete.id
              })
              if (!satisfied) {
                diagnostics.push(diagnose('no-instance', { file: currentFile, span: node.span, message: `the type variable here is not known to implement "${bound.mask}"; add a "need ${bound.mask}" bound` }))
              }
            }
          }
          type = signature.result
        } else {
          // calling a first-class function value (a local of function type, a parameter, etc.)
          const calleeType = resolve(inferExpression(node.callee, env))
          if (calleeType.kind === 'function') {
            if (args.length !== calleeType.params.length) {
              diagnostics.push(diagnose('type-mismatch', { file: currentFile, span: node.span, message: `this function expects ${calleeType.params.length} arguments, found ${args.length}` }))
            } else {
              args.forEach((arg, i) => expect(arg, calleeType.params[i]!, node.args[i]!.span, 'argument'))
            }
            type = calleeType.result
          } else if (calleeType.kind === 'unknown' || calleeType.kind === 'variable') {
            type = UNKNOWN // gradual: unknown callee
          } else {
            diagnostics.push(diagnose('type-mismatch', { file: currentFile, span: node.callee.span, message: `this value is not callable (it has type ${showType(calleeType)})` }))
            type = UNKNOWN
          }
        }
        break
      }
      case 'closure': {
        // a function literal: check its body with the params in scope, and yield a function type
        const inner: Env = new Map(env)
        const params = node.params.map((p) => p.type ?? UNKNOWN)
        node.params.forEach((p, i) => inner.set(p.name, { vars: [], type: params[i]! }))
        checkBody(node.body, inner, node.result ?? UNKNOWN)
        const fn: Type = { kind: 'function', params, result: node.result ?? UNKNOWN }
        if (node.async) fn.effects = ['async']
        type = fn
        break
      }
    }
    node.type = type
    return type
  }

  function checkBody(body: Array<Statement>, env: Env, result: Type): void {
    for (const statement of body) checkStatement(statement, env, result)
  }

  function checkStatement(node: Statement, env: Env, result: Type): void {
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
          if (node.init.form !== 'unit') expect(initType, node.type, node.span, 'binding')
          env.set(node.name, { vars: [], type: node.type })
        } else {
          // value-restricted let-generalization: an immutable binding to a syntactic value gets a polymorphic scheme
          const vars = !node.mutable && isValueExpression(node.init) ? generalize(initType, env) : []
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
        if (node.value) expect(inferExpression(node.value, env), result, node.span, 'return value')
        break
      case 'while':
        expect(inferExpression(node.cond, env), BOOLEAN, node.cond.span, 'loop condition')
        checkBody(node.body, env, result)
        break
      case 'if':
        for (const branch of node.branches) {
          expect(inferExpression(branch.cond, env), BOOLEAN, branch.cond.span, 'branch condition')
          checkBody(branch.body, env, result)
        }
        if (node.otherwise) checkBody(node.otherwise, env, result)
        break
      case 'for-each': {
        const element = fresh()
        expect(inferExpression(node.iterable, env), { kind: 'array', element }, node.iterable.span, 'iterable')
        const inner = new Map(env)
        inner.set(node.item, { vars: [], type: element })
        checkBody(node.body, inner, result)
        break
      }
      case 'match': {
        const subjectType = resolve(inferExpression(node.subject, env))
        if (subjectType.kind === 'named' && enums.has(subjectType.name)) {
          const variants = enums.get(subjectType.name)!
          const covered = new Set(node.cases.map((c) => c.label))
          for (const branch of node.cases) {
            if (!variants.has(branch.label)) {
              diagnostics.push(diagnose('unknown-name', { file: currentFile, span: node.span, message: `"${branch.label}" is not a variant of "${subjectType.name}"` }))
            }
          }
          if (!node.otherwise) {
            const missing = [...variants].filter((v) => !covered.has(v))
            if (missing.length > 0) {
              diagnostics.push(diagnose('non-exhaustive', { file: currentFile, span: node.span, message: `match on "${subjectType.name}" does not cover: ${missing.join(', ')}` }))
            }
          }
        }
        // narrow the subject variable to each branch's variant, so the branch can read that variant's fields
        const subjectVar = node.subject.form === 'variable' ? node.subject.name : undefined
        for (const branch of node.cases) {
          const previous = subjectVar ? narrowing.get(subjectVar) : undefined
          if (subjectVar) narrowing.set(subjectVar, branch.label)
          checkBody(branch.body, env, result)
          if (subjectVar) {
            if (previous === undefined) narrowing.delete(subjectVar)
            else narrowing.set(subjectVar, previous)
          }
        }
        if (node.otherwise) checkBody(node.otherwise, env, result)
        break
      }
      case 'hold':
        expect(inferExpression(node.expr, env), BOOLEAN, node.span, 'hold condition')
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

  function checkFunction(node: Extract<Statement, { form: 'function' }>): void {
    const signature = functions.get(node.name)!
    // the generics of this function carry their declared `need` bounds, available to discharge bounded calls
    currentBounds = [...signature.bounds].map(([id, mask]) => ({ variable: { kind: 'variable', id } as Type, mask }))
    const env: Env = new Map(moduleEnv)
    node.params.forEach((param, i) => env.set(param.name, { vars: [], type: signature.params[i]! }))
    checkBody(node.body, env, signature.result)
  }

  const topLevelSkip = new Set(['record-type', 'mask', 'instance', 'native'])
  // first pass: type module-level bindings into the shared module env, so functions (checked next) see their types.
  // A foreign host global (`host page, name <document>`) is seeded too, so an imported, centrally-declared global is
  // typed for dispatch in every consuming function. But one whose name collides with a function is skipped: bind's
  // `Element`/`Text` host globals must not shadow the framework's `element`/`text` render helpers.
  for (const statement of program) {
    currentFile = fileOrigin?.get(statement) ?? file
    if (statement.form === 'function' || topLevelSkip.has(statement.form)) continue
    if (statement.form === 'let' && statement.foreign !== undefined && functions.has(statement.name)) continue
    checkStatement(statement, moduleEnv, UNKNOWN)
  }
  for (const statement of program) {
    currentFile = fileOrigin?.get(statement) ?? file
    if (statement.form === 'function') checkFunction(statement)
  }

  // deeply resolve, mapping a function's still-unsolved generic variables back to their declared names (so a
  // generic function emits `<T>(x: T): T` rather than a defaulted concrete type)
  function zonkGeneric(type: Type, names: Map<number, string>): Type {
    const r = resolve(type)
    if (r.kind === 'variable') {
      const name = names.get(r.id)
      return name ? { kind: 'named', name } : r
    }
    if (r.kind === 'array') return { kind: 'array', element: zonkGeneric(r.element, names) }
    if (r.kind === 'map') return { kind: 'map', key: zonkGeneric(r.key, names), value: zonkGeneric(r.value, names) }
    if (r.kind === 'function') return { kind: 'function', params: r.params.map((t) => zonkGeneric(t, names)), result: zonkGeneric(r.result, names), effects: r.effects }
    if (r.kind === 'named' && r.args) return { kind: 'named', name: r.name, args: r.args.map((t) => zonkGeneric(t, names)) }
    return r
  }

  // final pass: record fully resolved types (cross-function constraints from call sites are now known)
  for (const statement of program) {
    currentFile = fileOrigin?.get(statement) ?? file
    if (statement.form === 'function') {
      const signature = functions.get(statement.name)!
      statement.result = zonkGeneric(signature.result, signature.genericNames)
      statement.params.forEach((param, i) => {
        // when a merged program holds two top-level functions of the same name (common across hundreds of generated
        // binding modules), `functions` keeps only the last, so its signature can have fewer params than this
        // statement. Fall back to the param's own milled type rather than crashing on a missing signature slot.
        const slot = signature.params[i]
        param.type = slot ? zonkGeneric(slot, signature.genericNames) : (param.type ?? UNKNOWN)
      })
      // deep-resolve every expression's inferred type, so later passes (monomorphization, native codegen) see
      // concrete types rather than unsolved inference variables. Free variables tied to a generic parameter resolve
      // to that parameter's name (so `make none` in a generic method types as maybe<s>, emittable as a native enum).
      zonkBody(statement.body, signature.genericNames)
    }
  }

  return diagnostics

  // walk a body, replacing each expression's `type` with its fully resolved form
  function zonkBody(body: Array<Statement>, names: Map<number, string>): void {
    const visitExpression = (node: Expression): void => {
      if (node.type) node.type = zonkGeneric(node.type, names)
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
          node.entries.forEach((e) => {
            visitExpression(e.key)
            visitExpression(e.value)
          })
          break
        case 'record':
          node.fields.forEach((f) => visitExpression(f.value))
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
          if (statement.value) visitExpression(statement.value)
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
          statement.branches.forEach((b) => {
            visitExpression(b.cond)
            zonkBody(b.body, names)
          })
          if (statement.otherwise) zonkBody(statement.otherwise, names)
          break
        case 'match':
          visitExpression(statement.subject)
          statement.cases.forEach((c) => zonkBody(c.body, names))
          if (statement.otherwise) zonkBody(statement.otherwise, names)
          break
        default:
          break
      }
    }
  }
}
