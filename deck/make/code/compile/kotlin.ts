// The Kotlin backend: emit the language as idiomatic, type-static Kotlin. Parity with the TypeScript backend across
// every AST form. Algebraic data types lower to NATIVE sealed-class hierarchies (`sealed class Maybe<out T>` with a
// subclass per variant), `match` to an exhaustive `when (subject) { is MaybeSome -> ... }` whose smart-casts make a
// variant's fields directly accessible (no rewrite needed), and struct forms to `data class`es. A variant subclass
// carries only the generics its own fields use, filling the rest with `Nothing` (valid under `out` variance), so
// construction infers cleanly. Pure, browser-safe. See note/research/vibe/computation/plans/07-codegen.md.

import { armLocals } from '@term/make/code/check/arm'
import type {
  Expression,
  Program,
  Statement,
  Type,
} from '@term/make/code/compile/node'
import {
  collectionCall,
  collectionRead,
  exhausted,
  reassigned,
  stringCall,
  stringRead,
} from '@term/make/code/compile/backend'
import type { CollectionOp, FormKind, FormSpec } from '@term/make/code/compile/backend'
import { formSpec, hasValuedReturn, refuseAny, specForms } from '@term/make/code/compile/backend'
import {
  collectBinds,
  renderBind,
  bindGap,
  bindImports,
  referencedBinds,
} from '@term/make/code/compile/bind'

// Kotlin hard keywords: one used as an identifier (a local named `continue`, a param named `object`) is
// backtick-escaped, in the declaration and every reference alike
const KOTLIN_KEYWORDS = new Set([
  'as', 'break', 'class', 'continue', 'do', 'else', 'false', 'for', 'fun', 'if', 'in', 'interface', 'is',
  'null', 'object', 'package', 'return', 'super', 'this', 'throw', 'true', 'try', 'typealias', 'typeof',
  'val', 'var', 'when', 'while',
])

function rawCamel(name: string): string {
  // strip every hyphen, including one before a digit (`sha-256` -> `sha256`), so the result is a valid identifier
  return name.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())
}

function camel(name: string): string {
  const spelled = rawCamel(name)

  return KOTLIN_KEYWORDS.has(spelled) ? `\`${spelled}\`` : spelled
}

function pascal(name: string): string {
  const c = rawCamel(name)

  return c.charAt(0).toUpperCase() + c.slice(1)
}

// gather the inference-variable ids appearing in a type (each an implicit generic parameter of its function)
function collectVars(type: Type | undefined, into: Set<number>): void {
  switch (type?.kind) {
    case 'variable':
      into.add(type.id)
      break
    case 'array':
      collectVars(type.element, into)
      break
    case 'map':
      collectVars(type.key, into)
      collectVars(type.value, into)
      break
    case 'function':
      type.params.forEach(p => collectVars(p, into))
      collectVars(type.result, into)
      break
    case 'named':
      type.args?.forEach(a => collectVars(a, into))
      break
    default:
      break
  }
}

const OP: Record<string, string> = {
  '&&': '&&',
  '||': '||',
  '==': '==',
  '!=': '!=',
  '<': '<',
  '<=': '<=',
  '>': '>',
  '>=': '>=',
  '+': '+',
  '-': '-',
  '*': '*',
  '/': '/',
  '%': '%',
}

// Kotlin requires every `import` at the top of the file, but a built program concatenates the runtime prelude (one or
// more shim files, each with its own imports) with the emitted program (which may also emit imports). Hoist every
// `import` line to the top, deduplicated and order-preserved, so the assembled source is valid. Apply this to the FINAL
// `prelude + program` string for the kotlin target.
export function hoistKotlinImports(source: string): string {
  const imports: string[] = []
  const seen = new Set<string>()
  const body: string[] = []

  for (const line of source.split('\n')) {
    if (/^\s*import\s+\S/.test(line)) {
      const trimmed = line.trim()

      if (!seen.has(trimmed)) {
        seen.add(trimmed)
        imports.push(trimmed)
      }
    } else {
      body.push(line)
    }
  }

  return imports.length > 0
    ? `${imports.join('\n')}\n${body.join('\n')}`
    : source
}

// the seed primitive forms by name, for a `named` reference the checker did not seed
const KOTLIN_PRIMITIVES: Record<string, string> = {
  text: 'String',
  boolean: 'Boolean',
  number: 'Long',
  integer: 'Long',
  decimal: 'Double',
}

// the roll grouped by deck, for the generated wake chain (the same shape emitTypeScript takes)
export type WakeGroup = {
  deck: string
  entries: Record<string, unknown>[]
}

export function emitKotlin(
  program: Program,
  options?: { wake?: WakeGroup[] },
): string {
  // when the stdlib hive is in the program, every new raise tells it (the throw lowering), and the compiler can
  // emit the wake chain (`wakeHive`) from the roll the driver hands over
  const hasHiveTell = program.some(
    n => n.form === 'function' && n.name === 'hive-tell',
  )

  const pad = (d: number) => '    '.repeat(d)
  // opaque per-backend handle types (`dock type / load <java.lang.Process>, name child-handle`): seed name -> concrete
  // kotlin type, so a `like child-handle` field emits the real handle type rather than a nonexistent class.
  const opaqueTypes = new Map<string, string>(
    program
      .filter(
        (n): n is Extract<Statement, { form: 'native' }> =>
          n.form === 'native' && n.kind === 'type',
      )
      .map(n => [n.alias, n.module === 'any' ? 'Any' : n.module]),
  )

  // how many type parameters each generic form declares, for a reference that names the form without them
  const genericArity = new Map<string, number>(
    program
      .filter((n): n is Extract<Statement, { form: 'record-type' }> => n.form === 'record-type')
      .map(n => [n.name, n.params?.length ?? 0]),
  )

  // every known function's declared parameter types, for filling a left-out trailing `need false` argument
  const functionParams = new Map<string, (Type | undefined)[]>(
    program
      .filter(
        (n): n is Extract<Statement, { form: 'function' }> =>
          n.form === 'function',
      )
      .map(n => [n.name, n.params.map(p => p.type)]),
  )

  // declarative native bindings render their `case kotlin` template at call sites
  const binds = collectBinds(program)

  // the Kotlin subclass for a variant label, and each variant's field names (for construction / smart-cast access)
  const variantClass = new Map<string, string>()
  const variantFieldNames = new Map<string, string[]>()
  // a counter for the locals a `when` binds its subject to
  let matchCount = 0
  // the enclosing function's declared result, so a `return <unknown-typed value>` can cast at the gradual
  // boundary (`read mock/dock` returned as `like mock-data`)
  let currentResult: Type | undefined
  // the forms a `fill` / `melt` with a form walks, gathered while the bodies are emitted
  const fillSpecs = new Map<string, FormSpec>()
  const meltSpecs = new Map<string, FormSpec>()
  // every struct form's declared fields, for a construction that leaves some out
  const recordFields = new Map<string, { name: string; type: Type }[]>(
    program
      .filter((n): n is Extract<Statement, { form: 'record-type' }> => n.form === 'record-type' && n.variants.length === 0)
      .map(n => [n.name, n.fields]),
  )

  // the empty value of a type: what a left-out field holds
  const emptyOf = (type: Type | undefined): string => {
    switch (type?.kind) {
      case 'string':
        return '""'
      case 'boolean':
        return 'false'
      case 'number':
        return '0L'
      case 'float':
        return '0.0'
      case 'bytes':
        return 'ByteArray(0)'
      case 'array':
        return 'mutableListOf()'
      case 'map':
        return 'mutableMapOf()'
      case 'named':
        if (type.name === 'text') {
          return '""'
        }

        if (type.name === 'boolean') {
          return 'false'
        }

        if (type.name === 'number' || type.name === 'integer') {
          return '0L'
        }

        if (type.name === 'decimal') {
          return '0.0'
        }

        if (type.name === 'maybe') {
          return 'MaybeNone'
        }

        if (type.name === 'list') {
          return 'mutableListOf()'
        }

        if (type.name === 'hash') {
          return 'mutableMapOf()'
        }

        return '0L'
      default:
        return '0L'
    }
  }
  // a label several enums share (`text` on both `token` and `data`): the class by owner, steered by the checked type
  const variantClassOf = new Map<string, Map<string, string>>()
  const classFor = (label: string, type: Type | undefined): string | undefined =>
    (type?.kind === 'named' ? variantClassOf.get(label)?.get(type.name) : undefined) ?? variantClass.get(label)

  // every form name's pascal spelling: a variant subclass (`Seed` + `text` -> `SeedText`) that lands on a
  // REAL form's name (`seed-text` -> `SeedText`) gets a `Case` suffix, or kotlin refuses the redeclaration
  const formPascals = new Set(
    program
      .filter((n): n is Extract<Statement, { form: 'record-type' }> => n.form === 'record-type')
      .map(n => pascal(n.name)),
  )

  for (const node of program) {
    if (node.form !== 'record-type') {
      continue
    }

    for (const v of node.variants) {
      const plain = `${pascal(node.name)}${pascal(v.name)}`
      const cls = formPascals.has(plain) ? `${plain}Case` : plain
      variantClass.set(v.name, cls)
      variantClassOf.set(
        v.name,
        (variantClassOf.get(v.name) ?? new Map<string, string>()).set(node.name, cls),
      )
      variantFieldNames.set(
        v.name,
        v.fields.map(f => f.name),
      )
    }
  }

  // traits (masks) emit as interfaces; a form that implements one declares it on its `data class` with override methods
  // that delegate to the free implementation functions; and a trait-bounded generic gains an interface bound so a
  // generic trait-method call lowers to `x.method(..)`. Kotlin has no `Self` type, so a method parameter or result
  // that is the receiver type is widened to the interface (with a downcast in the override, valid because trait
  // dispatch only reaches a method through the right instance). See note/seed/compiler/trait-dictionary-passing.md.
  const maskMethods = new Set<string>()

  for (const node of program) {
    if (node.form === 'mask') {
      for (const m of node.methods) {
        maskMethods.add(m)
      }
    }
  }

  type Instance = Extract<Statement, { form: 'instance' }>
  const conformances = new Map<string, Instance[]>()
  const instanceTargets = new Map<string, string[]>()

  for (const node of program) {
    if (node.form === 'instance') {
      const list = conformances.get(node.target) ?? []
      list.push(node)
      conformances.set(node.target, list)

      const targets = instanceTargets.get(node.mask) ?? []
      targets.push(node.target)
      instanceTargets.set(node.mask, targets)
    }
  }

  type Fn = Extract<Statement, { form: 'function' }>
  const implFn = new Map<string, Fn>()

  for (const node of program) {
    if (node.form === 'function' && node.method) {
      implFn.set(`${node.method.form}:${node.method.name}`, node)
    }
  }

  let varNames = new Map<number, string>()

  const kotlinType = (type: Type | undefined): string => {
    switch (type?.kind) {
      case 'boolean':
        return 'Boolean'
      case 'string':
        return 'String'
      case 'unit':
      case undefined:
        return 'Unit'
      case 'array':
        // the stdlib list mutates in place (push / pop), so it lowers to a mutable, reference-typed collection
        return `MutableList<${kotlinType(type.element)}>`
      case 'map':
        return `MutableMap<${kotlinType(type.key)}, ${kotlinType(
          type.value,
        )}>`

      case 'named': {
        const opaque = opaqueTypes.get(type.name)

        if (opaque) {
          return opaque
        }

        // the seed primitives written by name (`like text` on a module-level binding reaches here unseeded)
        const primitive = KOTLIN_PRIMITIVES[type.name]

        if (primitive) {
          return primitive
        }

        if (type.args && type.args.length > 0) {
          return `${pascal(type.name)}<${type.args.map(kotlinType).join(', ')}>`
        }

        // a generic form named without its arguments (`like maybe`): kotlin needs every parameter, so each is Any
        const arity = genericArity.get(type.name) ?? 0

        return arity > 0
          ? `${pascal(type.name)}<${Array.from({ length: arity }, () => 'Any').join(', ')}>`
          : pascal(type.name)
      }

      case 'function': {
        // an async function value is a `suspend` function type; calling it is a suspending call (no `.await`).
        const suspend = type.effects?.includes('async') ? 'suspend ' : ''

        return `${suspend}(${type.params
          .map(kotlinType)
          .join(', ')}) -> ${kotlinType(type.result)}`
      }
      case 'number':
        return 'Long'
      case 'float':
        return 'Double'
      case 'dynamic':
        return 'Any'
      case 'bytes':
        return 'ByteArray'
      case 'variable':
        return varNames.get(type.id) ?? 'Long'
      case 'unknown':
        // the declared dynamic (`like unknown` / `like any`): any value, so a hive entry's `base` can carry a record
        return 'Any'
      default:
        return 'Long'
    }
  }

  // the receiver type widened to the trait interface (Kotlin has no `Self`)
  const subSelfK = (
    t: Type | undefined,
    target: string,
    mask: string,
  ): Type | undefined => {
    if (!t) {
      return t
    }

    if (t.kind === 'named') {
      return t.name === target
        ? { kind: 'named', name: mask }
        : t.args
          ? { ...t, args: t.args.map(a => subSelfK(a, target, mask)!) }
          : t
    }

    if (t.kind === 'array') {
      return {
        kind: 'array',
        element: subSelfK(t.element, target, mask)!,
      }
    }

    if (t.kind === 'map') {
      return {
        kind: 'map',
        key: subSelfK(t.key, target, mask)!,
        value: subSelfK(t.value, target, mask)!,
      }
    }

    if (t.kind === 'function') {
      return {
        kind: 'function',
        params: t.params.map(p => subSelfK(p, target, mask)!),
        result: subSelfK(t.result, target, mask)!,
        effects: t.effects,
      }
    }

    return t
  }

  // an interface method requirement: `fun measure(): Long` (the receiver is the implicit `this`, so the first parameter
  // is dropped; remaining parameters keep their types, the receiver type widened to the interface)
  const interfaceMethod = (
    fn: Fn | undefined,
    target: string,
    mask: string,
  ): string => {
    if (!fn) {
      return ''
    }

    const rest = fn.params
      .slice(1)
      .map(
        p =>
          `${camel(p.name)}: ${kotlinType(subSelfK(p.type, target, mask))}`,
      )

    return `fun ${camel(fn.method!.name)}(${rest.join(', ')}): ${kotlinType(
      subSelfK(fn.result, target, mask),
    )}`
  }

  // an override that delegates to the free implementation function, downcasting any receiver-typed parameter back to
  // the concrete type the free function expects
  const overrideMethod = (
    fn: Fn | undefined,
    target: string,
    mask: string,
  ): string => {
    if (!fn) {
      return ''
    }

    const rest = fn.params
      .slice(1)
      .map(
        p =>
          `${camel(p.name)}: ${kotlinType(subSelfK(p.type, target, mask))}`,
      )

    const callArgs = [
      'this',
      ...fn.params
        .slice(1)
        .map(p =>
          p.type?.kind === 'named' && p.type.name === target
            ? `${camel(p.name)} as ${pascal(target)}`
            : camel(p.name),
        ),
    ]

    return `override fun ${camel(fn.method!.name)}(${rest.join(
      ', ',
    )}): ${kotlinType(subSelfK(fn.result, target, mask))} { return ${camel(
      fn.name,
    )}(${callArgs.join(', ')}) }`
  }

  const genericClause = (
    node: Extract<Statement, { form: 'function' }>,
  ): string => {
    const ids = new Set<number>()
    node.params.forEach(p => collectVars(p.type, ids))
    collectVars(node.result, ids)

    const declared = node.generics.map(g => g.name.toUpperCase())
    const pool = ['T', 'U', 'V', 'W', 'X', 'Y', 'Z', 'A', 'B', 'C']
    const used = new Set(declared)
    varNames = new Map()

    const fresh: string[] = []

    for (const id of ids) {
      const letter = pool.find(l => !used.has(l)) ?? `T${id}`
      used.add(letter)
      varNames.set(id, letter)
      // bounded `: Any`, so the letter is non-null and passes where a dynamic (Any) parameter is declared
      fresh.push(`${letter} : Any`)
    }

    const namedInSig = new Set<string>()

    const scan = (t: Type | undefined): void => {
      if (!t) {
        return
      }

      if (t.kind === 'named') {
        namedInSig.add(t.name.toUpperCase())
        t.args?.forEach(scan)
      } else if (t.kind === 'array') {
        scan(t.element)
      } else if (t.kind === 'map') {
        scan(t.key)
        scan(t.value)
      } else if (t.kind === 'function') {
        t.params.forEach(scan)
        scan(t.result)
      }
    }

    node.params.forEach(p => scan(p.type))
    scan(node.result)

    // a trait-bounded generic (`head t, need sizer`) adds its interface as a Kotlin upper bound (`T : Sizer`), so the
    // body's `x.measure()` resolves through it
    const needTrait = new Map<string, string>()

    for (const g of node.generics) {
      if (g.need) {
        needTrait.set(g.name.toUpperCase(), pascal(g.need))
      }
    }

    const kept = declared
      .filter(d => namedInSig.has(d))
      .map(d => (needTrait.has(d) ? `${d} : ${needTrait.get(d)}` : d))

    const all = [...kept, ...fresh]

    return all.length ? `<${all.join(', ')}> ` : ''
  }

  const expr = (node: Expression): string => {
    switch (node.form) {
      case 'integer':
        return `${node.value}L`
      case 'float':
        // a float literal needs a decimal point so it is a Double, not a Long
        return Number.isInteger(node.value)
          ? `${node.value}.0`
          : String(node.value)
      case 'boolean':
        return node.value ? 'true' : 'false'
      case 'string':
        return JSON.stringify(node.value)
      case 'template':
        // `"a${x}b"`: chunks escaped as a Kotlin string with `$` escaped, expressions interpolated
        return `"${node.parts
          .map(part => (typeof part === 'string' ? JSON.stringify(part).slice(1, -1).replace(/\$/g, '\\$') : `\${${expr(part)}}`))
          .join('')}"`
      case 'unit':
        return 'Unit'
      case 'null':
        return 'null'
      case 'variable':
      case 'hole':
        return camel(node.name)
      case 'unary':
        return `${node.op}${expr(node.operand)}`
      case 'binary':
        return `(${expr(node.left)} ${OP[node.op]} ${expr(node.right)})`

      case 'call': {
        // `call fill / <data> / like <form>` and `call melt / <value> / like <form>`: a function per form, generated
        // from the form's fields at the end of the module (see kotlinFormWalk below)
        if (
          node.callee.form === 'variable' &&
          (node.callee.name === 'fill-form' || node.callee.name === 'melt-form') &&
          node.into
        ) {
          const spec = formSpec(node.into, recordFields)
          refuseAny(spec, 'Kotlin')
          const into = node.callee.name === 'fill-form' ? fillSpecs : meltSpecs
          specForms(spec, into)

          return node.callee.name === 'fill-form'
            ? `__fill${pascal(spec.form)}(${expr(node.args[0]!)}, "")`
            : `__melt${pascal(spec.form)}(${expr(node.args[0]!)})`
        }

        // a declarative native binding renders its `case kotlin` template
        if (
          node.callee.form === 'variable' &&
          binds.has(node.callee.name)
        ) {
          const bind = binds.get(node.callee.name)!

          return (
            renderBind(bind, 'kotlin', node.args.map(expr)) ??
            bindGap(bind.name)
          )
        }

        // a native map / list operation lowers to kotlin's collection API
        const operation = collectionCall(node.callee)

        if (operation) {
          return collectionExpr(operation, node.args)
        }

        // a host string method (what `text.tree` delegates to) lowers to kotlin's String API
        const text = stringCall(node.callee)

        if (text) {
          return stringExpr(text.op, expr(text.target), node.args.map(a => expr(a)))
        }

        // a generic trait-method call lowers to an interface method call on the receiver: `x.measure(..)`. The receiver
        // is the first argument; concrete trait calls were already resolved to the free function by the checker.
        if (
          node.callee.form === 'variable' &&
          maskMethods.has(node.callee.name) &&
          node.args.length >= 1
        ) {
          const rest = node.args.slice(1).map(expr)

          return `${expr(node.args[0]!)}.${camel(node.callee.name)}(${rest.join(
            ', ',
          )})`
        }

        // a trailing `need false` parameter left out at the call site still exists in the native signature:
        // fill it with its type's empty value (Unit for an unknown)
        const rendered = node.args.map(expr)
        const declaredParams =
          node.callee.form === 'variable'
            ? functionParams.get(node.callee.name)
            : undefined

        if (declaredParams && declaredParams.length > rendered.length) {
          for (let i = rendered.length; i < declaredParams.length; i++) {
            const missing = declaredParams[i]

            rendered.push(
              missing === undefined || missing.kind === 'unknown'
                ? 'Unit'
                : emptyOf(missing),
            )
          }
        }

        return `${expr(node.callee)}(${rendered.join(', ')})`
      }

      case 'array': {
        // an empty collection literal gives kotlin nothing to infer from, so emit the element type explicitly
        const args =
          node.type?.kind === 'array'
            ? `<${kotlinType(node.type.element)}>`
            : ''

        return `mutableListOf${args}(${node.items.map(expr).join(', ')})`
      }

      case 'map': {
        const args =
          node.type?.kind === 'map'
            ? `<${kotlinType(node.type.key)}, ${kotlinType(
                node.type.value,
              )}>`
            : ''

        return `mutableMapOf${args}(${node.entries
          .map(e => `${expr(e.key)} to ${expr(e.value)}`)
          .join(', ')})`
      }

      case 'record': {
        // `make hash` / `make list` with no binds are the native collections, not record constructions; the
        // checked type pins the element parameters where kotlin cannot infer them (a generic function body)
        if (node.name === 'hash' && node.fields.length === 0) {
          const args =
            node.type?.kind === 'map' &&
            node.type.key.kind !== 'variable' &&
            node.type.value.kind !== 'variable'
              ? `<${kotlinType(node.type.key)}, ${kotlinType(node.type.value)}>`
              : ''

          return `mutableMapOf${args}()`
        }

        if (node.name === 'list' && node.fields.length === 0) {
          // a still-FREE element stays unspelled, so kotlin infers it from the expected type at the use site
          const args =
            node.type?.kind === 'array' &&
            node.type.element.kind !== 'variable'
              ? `<${kotlinType(node.type.element)}>`
              : ''

          return `mutableListOf${args}()`
        }

        // `make void` is the absent value: kotlin's Unit, which an Any slot holds and `==` recognizes
        if (node.name === 'void' && node.fields.length === 0) {
          return 'Unit'
        }

        // an empty `make list` / `make hash` field value spells the DECLARED element type, since the
        // checker's gradual unify leaves it free and kotlin cannot infer it from a named argument
        const fieldValue = (name: string, value: Expression): string => {
          // only for a non-generic form: a generic form's declared element is its own type parameter, which
          // the construction instantiates (spelling the letter literally would not resolve)
          if ((genericArity.get(node.name) ?? 0) > 0) {
            return expr(value)
          }

          const declaredType = recordFields
            .get(node.name)
            ?.find(f => f.name === name)?.type

          if (
            ((value.form === 'record' &&
              value.fields.length === 0 &&
              value.name === 'list') ||
              (value.form === 'array' && value.items.length === 0)) &&
            declaredType?.kind === 'array'
          ) {
            return `mutableListOf<${kotlinType(declaredType.element)}>()`
          }

          if (
            value.form === 'record' &&
            value.fields.length === 0 &&
            value.name === 'hash' &&
            declaredType?.kind === 'map'
          ) {
            return `mutableMapOf<${kotlinType(declaredType.key)}, ${kotlinType(declaredType.value)}>()`
          }

          return expr(value)
        }

        const cls = classFor(node.name, node.type)

        if (cls) {
          return node.fields.length > 0
            ? `${cls}(${node.fields
                .map(f => `${camel(f.name)} = ${fieldValue(f.name, f.value)}`)
                .join(', ')})`
            : cls
        }

        // a struct: a field the construction leaves out takes its type's empty value, so the data class is whole
        const declared = recordFields.get(node.name)

        if (declared) {
          const given = new Set(node.fields.map(f => f.name))
          const missing = declared.filter(f => !given.has(f.name)).map(f => `${camel(f.name)} = ${emptyOf(f.type)}`)
          const all = [...node.fields.map(f => `${camel(f.name)} = ${fieldValue(f.name, f.value)}`), ...missing]

          if (missing.length > 0) {
            return `${pascal(node.name)}(${all.join(', ')})`
          }
        }

        // a generic struct built from empty collections cannot infer its parameters; pin them from the checked type
        const args =
          node.type?.kind === 'named' && node.type.args?.length
            ? `<${node.type.args.map(kotlinType).join(', ')}>`
            : ''

        return `${pascal(node.name)}${args}(${node.fields
          .map(f => `${camel(f.name)} = ${fieldValue(f.name, f.value)}`)
          .join(', ')})`
      }

      case 'member': {
        // `map.size` / `array.length` lower to the platform's count property (as a Long, the seed number type)
        const read = collectionRead(node)

        if (read) {
          return `${expr(read.target)}.size.toLong()`
        }

        const textLength = stringRead(node)

        if (textLength) {
          return `${expr(textLength.target)}.length.toLong()`
        }

        if (node.index) {
          // a list subscript takes Int, and seed numbers are Long: an ARRAY target's index narrows; a map key
          // passes through as it is
          const narrowed =
            node.target.type?.kind === 'array'
              ? `(${expr(node.index)}).toInt()`
              : expr(node.index)

          return `${expr(node.target)}[${narrowed}]`
        }

        // a LITERAL index segment (`read parts/0`) on an array target subscripts it: `.0` is not a member
        if (/^\d+$/.test(node.name) && node.target.type?.kind === 'array') {
          return `${expr(node.target)}[${node.name}]`
        }

        return `${expr(node.target)}.${camel(node.name)}`
      }

      case 'await':
        return expr(node.expr)

      case 'closure': {
        // a function literal as a Kotlin lambda. A lambda's value is its last expression, so the trailing `send back X`
        // becomes a bare `X` (an explicit `return` inside a lambda would non-locally return from the enclosing function).
        // A body with a return anywhere ELSE (inside a when arm, a loop) cannot be a lambda at all: Kotlin
        // prohibits non-local returns, so that closure lowers to an anonymous function, where return is legal.
        const deepReturn = (value: unknown): boolean => {
          if (!value || typeof value !== 'object') {
            return false
          }
          if (Array.isArray(value)) {
            return value.some(deepReturn)
          }
          const record = value as Record<string, unknown>
          if (record.form === 'closure') {
            return false
          }
          if (record.form === 'return') {
            return true
          }
          return Object.values(record).some(deepReturn)
        }
        const last = node.body[node.body.length - 1]
        const nonTailReturn =
          node.body.slice(0, -1).some(deepReturn) ||
          (last !== undefined && last.form !== 'return' && deepReturn(last))
        if (nonTailReturn) {
          const typed = node.params
            .map(p => `${camel(p.name)}: ${kotlinType(p.type)}`)
            .join(', ')
          const result =
            node.result ??
            (node.type?.kind === 'function' ? node.type.result : undefined)
          const resultText = result ? `: ${kotlinType(result)}` : ''
          const body = node.body.map(s => stmt(s, 1)).filter(Boolean)

          return `fun(${typed})${resultText} {\n${body.join('\n')}\n${'  '.repeat(0)}}`
        }
        const params = node.params.map(p => camel(p.name)).join(', ')
        const lead = node.body
          .slice(0, -1)
          .map(s => stmt(s, 0))
          .filter(Boolean)

        const tail =
          last?.form === 'return' && last.value
            ? expr(last.value)
            : last
              ? stmt(last, 0)
              : ''

        return `{ ${params} -> ${[...lead, tail]
          .filter(Boolean)
          .join('; ')} }`
      }

      case 'conditional': {
        // a value-position conditional lowers to a Kotlin if / else-if / else expression chain
        const tail = node.otherwise ? expr(node.otherwise) : 'Unit'

        return node.branches.reduceRight(
          (rest, branch) =>
            `if (${expr(branch.cond)}) ${expr(branch.value)} else ${rest}`,
          tail,
        )
      }

      default:
        return exhausted(node)
    }
  }

  // lower a native map / list operation to kotlin. The return shapes match the JS collection API the stdlib forms
  // expect: `set` yields the map, `delete` / `push` yield a boolean / the new length, sizes are Long (the number type).
  const collectionExpr = (
    op: CollectionOp,
    args: Expression[],
  ): string => {
    const target = expr(op.target)
    const arg = args.map(expr)

    if (op.kind === 'map') {
      switch (op.op) {
        case 'has':
          return `${target}.containsKey(${arg[0]})`
        case 'get':
          return `${target}.getValue(${arg[0]})`
        case 'set':
          return `${target}.apply { put(${arg[0]}, ${arg[1]}) }`
        case 'delete':
          return `(${target}.remove(${arg[0]}) != null)`
        case 'keys':
          return `${target}.keys.toMutableList()`
        case 'values':
          return `${target}.values.toMutableList()`
        default:
          return ''
      }
    }

    switch (op.op) {
      case 'push':
        return `${target}.apply { add(${arg[0]}) }.size.toLong()`
      case 'pop':
        return `${target}.removeLast()`
      case 'at':
      case 'get':
        return `${target}[(${arg[0]}).toInt()]`
      case 'set':
        return `run { ${target}[(${arg[0]}).toInt()] = ${arg[1]} }`
      case 'includes':
        return `${target}.contains(${arg[0]})`
      case 'indexOf':
        return `${target}.indexOf(${arg[0]}).toLong()`
      case 'lastIndexOf':
        return `${target}.lastIndexOf(${arg[0]}).toLong()`
      case 'concat':
        return `(${target} + ${arg[0]}).toMutableList()`
      case 'slice':
        return arg[1] !== undefined
          ? `${target}.subList((${arg[0]}).toInt(), (${arg[1]}).toInt()).toMutableList()`
          : `${target}.subList((${arg[0]}).toInt(), ${target}.size).toMutableList()`
      case 'toReversed':
        return `${target}.reversed().toMutableList()`
      case 'join':
        return `${target}.joinToString(${arg[0]})`
      case 'map':
        return `${target}.map(${arg[0]}).toMutableList()`
      case 'filter':
        return `${target}.filter(${arg[0]}).toMutableList()`
      case 'some':
        return `${target}.any(${arg[0]})`
      case 'every':
        return `${target}.all(${arg[0]})`
      case 'reduce':
        return `${target}.fold(${arg[1]}, ${arg[0]})`
      case 'findIndex':
        return `${target}.indexOfFirst(${arg[0]}).toLong()`
      case 'flat':
        // flattening a non-nested list is a shallow copy (JS `[1,2,3].flat()` is `[1,2,3]`)
        return `${target}.toMutableList()`
      case 'unshift':
        return `${target}.apply { add(0, ${arg[0]}) }.size.toLong()`
      case 'shift':
        return `${target}.removeAt(0)`
      case 'splice':
        // JS `splice(start, deleteCount, ...items)`: remove the range, insert the items, in place
        return `${target}.apply { subList((${arg[0]}).toInt(), (${arg[0]}).toInt() + (${arg[1]}).toInt()).clear(); addAll((${arg[0]}).toInt(), listOf(${arg.slice(2).join(', ')})) }.let { 0L }`
      default:
        return ''
    }
  }

  // JavaScript's string methods over kotlin's String (see backend.ts, STRING_METHODS). Indexes are Long in seed
  // and Int in kotlin; a read past the end is empty (charAt) or 0 (charCodeAt), never an exception.
  const stringExpr = (op: string, t: string, a: string[]): string => {
    switch (op) {
      case 'charAt':
      case 'at':
        return `(${t}.getOrNull((${a[0]}).toInt())?.toString() ?: "")`
      case 'charCodeAt':
        return `(${t}.getOrNull((${a[0]}).toInt())?.code ?: 0).toLong()`
      case 'indexOf':
        return a[1] !== undefined
          ? `${t}.indexOf(${a[0]}, (${a[1]}).toInt()).toLong()`
          : `${t}.indexOf(${a[0]}).toLong()`
      case 'lastIndexOf':
        return `${t}.lastIndexOf(${a[0]}).toLong()`
      case 'split':
        return `(${a[0]}).let { d -> if (d.isEmpty()) ${t}.map { it.toString() }.toMutableList() else ${t}.split(d).toMutableList() }`
      case 'substring':
      case 'slice':
        return a[1] !== undefined
          ? `${t}.let { s -> s.substring((${a[0]}).toInt().coerceIn(0, s.length), (${a[1]}).toInt().coerceIn(0, s.length)) }`
          : `${t}.let { s -> s.substring((${a[0]}).toInt().coerceIn(0, s.length)) }`
      case 'toLowerCase':
        return `${t}.lowercase()`
      case 'toUpperCase':
        return `${t}.uppercase()`
      case 'startsWith':
        return `${t}.startsWith(${a[0]})`
      case 'endsWith':
        return `${t}.endsWith(${a[0]})`
      case 'trim':
        return `${t}.trim()`
      case 'trimStart':
        return `${t}.trimStart()`
      case 'trimEnd':
        return `${t}.trimEnd()`
      case 'padStart':
        return `${t}.let { s -> var o = s; val f = ${a[1]}; while (o.length < (${a[0]}).toInt() && f.isNotEmpty()) { o = f + o }; o }`
      case 'padEnd':
        return `${t}.let { s -> var o = s; val f = ${a[1]}; while (o.length < (${a[0]}).toInt() && f.isNotEmpty()) { o = o + f }; o }`
      case 'replace':
        return `${t}.replaceFirst(${a[0]}, ${a[1]})`
      case 'replaceAll':
        return `${t}.replace(${a[0]}, ${a[1]})`
      case 'includes':
        return `${t}.contains(${a[0]})`
      case 'concat':
        return `(${t} + ${a[0]})`
      case 'repeat':
        return `${t}.repeat((${a[0]}).toInt())`
      default:
        return ''
    }
  }

  // the forms that are exceptions: a raise of one carries the record whole
  const exceptionForms = new Set(
    program
      .filter((n): n is Extract<Statement, { form: 'record-type' }> => n.form === 'record-type' && Boolean(n.chain?.includes('exception')))
      .map(n => n.name),
  )

  const block = (body: Statement[], d: number): string =>
    body
      .map(s => `${pad(d)}${stmt(s, d)}`)
      .filter(Boolean)
      .join('\n')

  const stmt = (node: Statement, d: number): string => {
    switch (node.form) {
      case 'let': {
        // a lambda binding is annotated with its full function type: Kotlin cannot infer a lambda's parameter types
        // without an expected type, and a suspend lambda only becomes suspend when the expected type says so.
        const ann =
          node.init.form === 'closure'
            ? `: ${kotlinType({
                kind: 'function',
                params: node.init.params.map(
                  (p): Type => p.type ?? { kind: 'unknown' },
                ),
                result: node.init.result ?? { kind: 'unknown' },
                ...(node.init.async ? { effects: ['async'] } : {}),
              })}`
            : node.init.form === 'record' &&
                node.init.type?.kind === 'named' &&
                variantClassOf.has(node.init.name)
              ? // a variant construction is bound as its sealed type, so the binding can later hold another variant
                `: ${kotlinType(node.init.type)}`
              : ''

        // a valueless typed module slot (`host current, like context`, filled later by a `save`): kotlin's
        // lateinit var, so reads get the declared class type rather than Unit
        if (node.init.form === 'unit' && node.type?.kind === 'named') {
          return `lateinit var ${camel(node.name)}: ${kotlinType(node.type)}`
        }

        // the gradual boundary on a binding: a boxed dynamic re-typed at a declared FORM casts
        if (
          node.type?.kind === 'named' &&
          node.init.form === 'member' &&
          recordFields.has(node.type.name) &&
          (node.init.type?.kind === 'unknown' ||
            node.init.type?.kind === 'dynamic')
        ) {
          return `${node.mutable ? 'var' : 'val'} ${camel(node.name)} = ${expr(node.init)} as ${kotlinType(node.type)}`
        }

        return `${node.mutable ? 'var' : 'val'} ${camel(
          node.name,
        )}${ann} = ${expr(node.init)}`
      }
      case 'assign':
        return node.op === '='
          ? `${expr(node.target)} = ${expr(node.value)}`
          : `${expr(node.target)} ${node.op} ${expr(node.value)}`
      case 'expression':
        return expr(node.expr)
      case 'return': {
        if (!node.value) {
          return currentResult?.kind === 'unknown' ? 'return Unit' : 'return'
        }

        // the gradual boundary: an unknown-typed value returned at a DECLARED FORM type casts explicitly.
        // Only for a form the program declares: a generic letter (`like t`) is not a cast target.
        const valueKind = node.value.type?.kind
        const cast =
          node.value.form === 'member' &&
          (valueKind === 'unknown' || valueKind === 'dynamic') &&
          currentResult?.kind === 'named' &&
          recordFields.has(currentResult.name)
            ? ` as ${kotlinType(currentResult)}`
            : ''

        return `return ${expr(node.value)}${cast}`
      }
      case 'throw': {
        // a raise carries the exception record whole in a TermException (the shared fields, the props as `link`, the
        // record as `base`), so a handler reads `note`, `form`, `code` the way it does on TypeScript. A text raises
        // `failure`; a value already caught is passed on as it is. When the program has the stdlib hive, a NEW
        // carrier tells it before unwinding (a pass-on re-raise does not re-tell).
        const tell = (built: string): string =>
          hasHiveTell
            ? `throw run { val told = ${built}; hiveTell(HiveEntry(host = told.host, kind = "exception", name = told.form, site = "", base = told)); told }`
            : `throw ${built}`

        return node.value.form === 'string'
          ? tell(`TermException("", "failure", ${expr(node.value)}, "", 0L, null, null)`)
          : node.value.form === 'record' && exceptionForms.has(node.value.name)
            ? tell(`run { val raised = ${expr(node.value)}; TermException(raised.host, raised.form, raised.note, raised.code, raised.time, raised.link, raised) }`)
            : `throw termException(${expr(node.value)})`
      }
      case 'while':
        return `while (${expr(node.cond)}) {\n${block(
          node.body,
          d + 1,
        )}\n${pad(d)}}`
      case 'guard': {
        // the caught value is a TermException: a raise passes through, and a foreign throw (a Kotlin runtime error) is
        // wrapped as `failure`, so the handler sees one shape on every path
        const handler = node.catch
          ? `catch (thrown: Throwable) {\n${pad(d + 1)}val ${camel(node.catch.name)} = termException(thrown)\n${block(
              node.catch.body,
              d + 1,
            )}\n${pad(d)}}`
          : 'catch (_: Throwable) {}'

        return `try {\n${block(node.body, d + 1)}\n${pad(d)}} ${handler}`
      }
      case 'for-each':
        return `for (${camel(node.item)} in ${expr(
          node.iterable,
        )}) {\n${block(node.body, d + 1)}\n${pad(d)}}`

      case 'match': {
        // a match whose labels are only true/false is a match over a NATIVE Boolean (booleans lower to `Boolean`
        // here, not a sealed class), so the arms are the literal conditions `true` / `false`, not `is` patterns.
        // a fork case over a caught TermException: `when` on `form`, the record recovered from `base` by its form
        if (node.exceptionArms) {
          const carrier = expr(node.subject)
          const arms = node.cases.map(b => {
            const arm = node.exceptionArms![b.label]!
            const bodyText = block(b.body, d + 2)
            const locals = armLocals([...arm.shared, ...arm.link], b.binds)
              .filter(({ local }) => new RegExp(`\\b${camel(local).replace(/[^\w$]/g, '\\$&')}\\b`).test(bodyText))
              .map(({ field, local }) =>
                arm.link.includes(field)
                  ? `${pad(d + 2)}val ${camel(local)} = (${carrier}.base as ${pascal(b.label)}).link.${camel(field)}`
                  : `${pad(d + 2)}val ${camel(local)} = ${carrier}.${camel(field)}`,
              )

            return `${pad(d + 1)}${JSON.stringify(b.label)} -> {\n${[...locals, bodyText].join('\n')}\n${pad(d + 1)}}`
          })
          // the checker holds the arms to the guarded body's raise set, so a form none matches cannot happen; the
          // else passes the carrier on, which also tells Kotlin every path answers
          arms.push(`${pad(d + 1)}else -> {${node.otherwise ? `\n${block(node.otherwise, d + 2)}\n${pad(d + 1)}` : ` throw ${carrier} `}}`)

          return `when (${carrier}.form) {\n${arms.join('\n')}\n${pad(d)}}`
        }

        const labels = node.cases.map(branch => branch.label)
        const booleans =
          labels.length > 0 &&
          labels.every(label => label === 'true' || label === 'false')

        // a `fork case` over a TEXT subject (`fork case, read kind` with `case home` arms): the labels are
        // string values, matched by literal
        if (node.subject.type?.kind === 'string') {
          const arms = node.cases.map(
            b =>
              `${pad(d + 1)}${JSON.stringify(b.label)} -> {\n${block(
                b.body,
                d + 2,
              )}\n${pad(d + 1)}}`,
          )

          arms.push(
            `${pad(d + 1)}else -> {${
              node.otherwise
                ? `\n${block(node.otherwise, d + 2)}\n${pad(d + 1)}`
                : ''
            }}`,
          )

          return `when (${expr(node.subject)}) {\n${arms.join('\n')}\n${pad(d)}}`
        }

        // an exhaustive `when` on the sealed type: each `is` arm smart-casts the subject, so its fields are directly
        // accessible in the body with no rewrite. A return-position match becomes `return when (...)`.
        // the subject is bound to a local first: a smart cast needs a stable value, and a `var` property (a field
        // read like `entry.base`) is not one
        const subjectExpr = expr(node.subject)
        const stable = node.subject.form === 'variable'
        const subject = stable ? subjectExpr : `subject${++matchCount}`
        const arms = node.cases.map(b => {
          if (booleans) {
            return `${pad(d + 1)}${b.label} -> {\n${block(
              b.body,
              d + 2,
            )}\n${pad(d + 1)}}`
          }

          const cls = classFor(b.label, node.subject.type) ?? pascal(b.label)
          // the arm's fields (renamed or not, see check/arm.ts) become locals read off the smart-cast subject, the
          // ones the body reads
          const bodyText = block(b.body, d + 2)
          const locals = armLocals(variantFieldNames.get(b.label) ?? [], b.binds)
            .filter(({ local }) => new RegExp(`\\b${camel(local).replace(/[^\w$]/g, '\\$&')}\\b`).test(bodyText))
            .map(({ field, local }) => `${pad(d + 2)}val ${camel(local)} = ${subject}.${camel(field)}`)

          return `${pad(d + 1)}is ${cls} -> {\n${[...locals, bodyText].join('\n')}\n${pad(d + 1)}}`
        })

        if (node.otherwise) {
          arms.push(
            `${pad(d + 1)}else -> {\n${block(
              node.otherwise,
              d + 2,
            )}\n${pad(d + 1)}}`,
          )
        }

        const when = `when (${subject}) {\n${arms.join('\n')}\n${pad(d)}}`

        return stable ? when : `val ${subject} = ${subjectExpr}\n${pad(d)}${when}`
      }

      case 'if': {
        let out = ''
        node.branches.forEach((b, i) => {
          out += `${i ? ' else ' : ''}if (${expr(b.cond)}) {\n${block(
            b.body,
            d + 1,
          )}\n${pad(d)}}`
        })

        if (node.otherwise) {
          out += ` else {\n${block(node.otherwise, d + 1)}\n${pad(d)}}`
        }

        return out
      }

      case 'break':
        return 'break'
      case 'continue':
        return 'continue'
      case 'exit':
        return 'kotlin.system.exitProcess(0)'
      case 'debug':
        return '// breakpoint'

      case 'function': {
        const generics = genericClause(node)
        const params = node.params
          .map(p => `${camel(p.name)}: ${kotlinType(p.type)}`)
          .join(', ')

        const suspend = node.async ? 'suspend ' : ''
        // a reassigned parameter is shadowed by a mutable local (Kotlin parameters are immutable)
        const mutated = new Set<string>()
        reassigned(node.body, mutated)

        const shadows = node.params
          .filter(p => mutated.has(p.name))
          .map(
            p => `${pad(d + 1)}var ${camel(p.name)} = ${camel(p.name)}`,
          )

        // a task with no declared result but a valued `send back` (a dock forward) is Any, not Unit
        const result =
          node.result && node.result.kind !== 'unit'
            ? node.result
            : hasValuedReturn(node.body)
              ? ({ kind: 'unknown' } as Type)
              : node.result

        currentResult = result

        // a valued task whose body ends in branching that returns from every live path: kotlin cannot always
        // see the coverage (an if chain with no else), so the fall-through throws
        const last = node.body[node.body.length - 1]
        const unreachable =
          (last?.form === 'if' ||
            last?.form === 'while' ||
            last?.form === 'match') &&
          node.result &&
          node.result.kind !== 'unit'
            ? `${pad(d + 1)}throw IllegalStateException("unreachable")`
            : ''

        // a signature-only stub (a public module whose impl arrives from the platform module in a fuller closure)
        // still compiles: its body is the not-implemented panic
        const bodyText =
          node.body.length === 0
            ? `${pad(d + 1)}TODO(${JSON.stringify(`stub: ${node.name}`)})`
            : [...shadows, block(node.body, d + 1), unreachable]
                .filter(Boolean)
                .join('\n')

        return `${suspend}fun ${generics}${camel(
          node.name,
        )}(${params}): ${kotlinType(result)} {\n${bodyText}\n${pad(
          d,
        )}}`
      }

      case 'record-type': {
        if (node.variants.length > 0) {
          const generics = node.params.length
            ? `<${node.params
                .map(p => `out ${p.toUpperCase()}`)
                .join(', ')}>`
            : ''

          const head = `sealed class ${pascal(node.name)}${generics}`
          const subclasses = node.variants.map(v => {
            const cls =
              variantClassOf.get(v.name)?.get(node.name) ??
              `${pascal(node.name)}${pascal(v.name)}`
            // the variant carries only the generics its own fields mention; the rest of the type's params are Nothing
            const usesGeneric = (name: string) =>
              v.fields.some(f => mentions(f.type, name))

            const ownGenerics = node.params.filter(usesGeneric)
            const genericDecl = ownGenerics.length
              ? `<${ownGenerics
                  .map(p => `out ${p.toUpperCase()}`)
                  .join(', ')}>`
              : ''

            const superArgs = node.params.length
              ? `<${node.params
                  .map(p =>
                    usesGeneric(p) ? p.toUpperCase() : 'Nothing',
                  )
                  .join(', ')}>`
              : ''

            if (v.fields.length > 0) {
              const fields = v.fields
                .map(f => `val ${camel(f.name)}: ${kotlinType(f.type)}`)
                .join(', ')

              return `data class ${cls}${genericDecl}(${fields}) : ${pascal(
                node.name,
              )}${superArgs}()`
            }

            const objectSuper = node.params.length
              ? `<${node.params.map(() => 'Nothing').join(', ')}>`
              : ''

            return `object ${cls} : ${pascal(
              node.name,
            )}${objectSuper}()`
          })

          return [`${head}`, ...subclasses].join('\n')
        }

        const fields = node.fields
          .map(f => `var ${camel(f.name)}: ${kotlinType(f.type)}`)
          .join(', ')

        const generics = node.params.length
          ? `<${node.params.map(p => p.toUpperCase()).join(', ')}>`
          : ''

        // a data class needs a constructor parameter; a form with no fields (a method-only interface form) is a
        // plain class
        const decl = node.fields.length > 0
          ? `data class ${pascal(node.name)}${generics}(${fields})`
          : `class ${pascal(node.name)}${generics}`
        // a form that implements traits declares them on the data class with overrides delegating to the free functions
        const impls = conformances.get(node.name) ?? []

        if (impls.length === 0) {
          return decl
        }

        const supers = impls.map(i => pascal(i.mask)).join(', ')
        const overrides = impls.flatMap(i =>
          i.methods
            .map(m =>
              overrideMethod(
                implFn.get(`${node.name}:${m}`),
                node.name,
                i.mask,
              ),
            )
            .filter(Boolean)
            .map(line => `${pad(d + 1)}${line}`),
        )

        return `${decl} : ${supers} {\n${overrides.join('\n')}\n${pad(d)}}`
      }

      case 'mask': {
        // an interface whose method requirements are derived from any implementing instance's signature
        const target = instanceTargets.get(node.name)?.[0]
        const methods = target
          ? node.methods
              .map(
                m =>
                  `${pad(d + 1)}${interfaceMethod(
                    implFn.get(`${target}:${m}`),
                    target,
                    node.name,
                  )}`,
              )
              .filter(line => line.trim())
          : []

        return `interface ${pascal(node.name)} {${
          methods.length ? `\n${methods.join('\n')}\n${pad(d)}` : ''
        }}`
      }

      case 'instance':
        // conformance is declared on the data class (see record-type), so nothing is emitted here
        return ''
      case 'hold':
        return '// hold: verified at compile time'
      case 'native':
        return ''
      case 'bind':
      case 'view':
      case 'dock':
      case 'tell':
      case 'roll':
        return '' // view / routing DSLs are lowered by the dedicated zone compiler, not this backend
      default:
        return exhausted(node)
    }
  }

  // a `<global:X>` binding (e.g. the linked `io` runtime object) needs no import: it is already in scope. A `type` dock
  // is an inline type reference (a fully-qualified handle type), not an importable module.
  const imports = program
    .filter(
      (n): n is Extract<Statement, { form: 'native' }> =>
        n.form === 'native' &&
        n.kind !== 'type' &&
        !n.module.startsWith('global:'),
    )
    .map(
      n =>
        `import ${n.module
          .replace(/^[a-z]+:/, '')
          .replace(/\//g, '.')}`,
    )

  // plus the import each rendered `bind` needs (e.g. `import kotlin.math.pow` for a `case kotlin` that calls `pow`).
  // Only binds actually called contribute, matching the other backends.
  for (const need of bindImports(
    referencedBinds(program, binds),
    'kotlin',
  )) {
    const path = need.module.replace(/^[a-z]+:/, '').replace(/\//g, '.')
    const line = need.alias
      ? `import ${path} as ${camel(need.alias)}`
      : `import ${path}`

    if (!imports.includes(line)) {
      imports.push(line)
    }
  }

  // a module-level `host` data tree is an ANONYMOUS nested record: with no form to name it the construction
  // has nothing to reference. Synthesize one data class per record node, named by the binding and the field
  // path (HostRange, HostRangeH), and rename the record nodes so the construction uses it.
  const hostClassDefs: string[] = []
  const kotlinHostLeaf = (v: Expression): string =>
    v.form === 'integer'
      ? 'Long'
      : v.form === 'float'
        ? 'Double'
        : v.form === 'text'
          ? 'String'
          : v.form === 'boolean'
            ? 'Boolean'
            : 'Long'
  const nameHostRecord = (
    node: Extract<Expression, { form: 'record' }>,
    base: string,
  ): string => {
    node.name = base

    const fields = node.fields.map(f => {
      const type =
        f.value.form === 'record' && f.value.name === ''
          ? nameHostRecord(f.value, `${base}${pascal(f.name)}`)
          : kotlinHostLeaf(f.value)

      return `val ${camel(f.name)}: ${type}`
    })

    hostClassDefs.push(`data class ${base}(${fields.join(', ')})`)

    return base
  }

  for (const node of program) {
    if (
      node.form === 'let' &&
      node.init.form === 'record' &&
      node.init.name === ''
    ) {
      nameHostRecord(node.init, `Host${pascal(node.name)}`)
    }
  }

  // an abstract module's signature-only declaration and the platform module's implementation share a name by
  // design (platform dispatch): the stub yields to the implementation instead of redeclaring it
  const implemented = new Set(
    program
      .filter(
        (n): n is Extract<Statement, { form: 'function' }> =>
          n.form === 'function' && n.body.length > 0,
      )
      .map(n => n.name),
  )


  // a form declared in an abstract module AND its platform module lands twice in the closure: the empty
  // declaration yields to the full one, and an exact repeat keeps only its first appearance
  const fullForms = new Set(
    program
      .filter(
        (n): n is Extract<Statement, { form: 'record-type' }> =>
          n.form === 'record-type' &&
          (n.fields.length > 0 || n.variants.length > 0),
      )
      .map(n => n.name),
  )
  const seenForms = new Set<string>()
  // a module collected twice (two import spellings of one file) emits its functions twice: keep the first
  const seenFns = new Set<string>()
  const keepStatement = (n: Statement): boolean => {
    if (n.form === 'function') {
      const key = `${n.name}/${n.params.length}`

      if (seenFns.has(key)) {
        return false
      }

      seenFns.add(key)
    }

    if (n.form !== 'record-type') {
      return true
    }

    if (
      n.fields.length === 0 &&
      n.variants.length === 0 &&
      fullForms.has(n.name)
    ) {
      return false
    }

    if (seenForms.has(n.name)) {
      return false
    }

    seenForms.add(n.name)

    return true
  }

  const body = [
    ...hostClassDefs,
    ...program
      .filter(n => n.form !== 'native')
      .filter(
        n =>
          !(
            n.form === 'function' &&
            n.body.length === 0 &&
            implemented.has(n.name)
          ),
      )
      .filter(keepStatement)
      .map(n => stmt(n, 0))
      .filter(Boolean),
    ...kotlinFormWalk(fillSpecs, meltSpecs),
  ]

  const prelude = [
    ...(body.some(b => b.includes('SeedError(')) ? ['class SeedError(message: String) : RuntimeException(message)'] : []),
    // the one exception value of a Term program on this backend (note/term/hive/11-native-exceptions.md): the shared
    // fields of every exception, the props as `link`, the raised record as `base`. `termException` is the boundary
    // that makes a foreign throw a `failure`.
    ...(body.some(b => b.includes('TermException(') || b.includes('termException('))
      ? [
          'class TermException(val host: String, val form: String, val note: String, val code: String, val time: Long, val link: Any?, val base: Any?) : RuntimeException(form + ": " + note)',
          'fun termException(thrown: Any?): TermException = if (thrown is TermException) thrown else TermException("", "failure", thrown?.toString() ?: "", "", 0L, null, thrown)',
        ]
      : []),
  ]

  // the wake chain: one `hiveWake` per deck with its static entries, when the program has the stdlib hive and
  // the compile driver handed over the roll. A static entry's `base` is the declaration as JSON text; an entry
  // with a `ref` (a declared kind's constant) binds the live module constant. See note/term/hive/05-hive.md.
  const wake: string[] = []

  if (
    options?.wake?.length &&
    program.some(n => n.form === 'function' && n.name === 'hive-wake')
  ) {
    const entryText = (entry: Record<string, unknown>): string => {
      const { ref, base, ...own } = entry
      const boxed =
        typeof ref === 'string'
          ? camel(ref)
          : JSON.stringify(JSON.stringify(base ?? {}))

      return `HiveEntry(host = ${JSON.stringify(String(own.host ?? ''))}, kind = ${JSON.stringify(String(own.kind ?? ''))}, name = ${JSON.stringify(String(own.name ?? ''))}, site = ${JSON.stringify(String(own.site ?? ''))}, base = ${boxed})`
    }

    const calls = options.wake
      .map(
        group =>
          `    hiveWake(${JSON.stringify(group.deck)}, mutableListOf(${group.entries.map(entryText).join(', ')}))`,
      )
      .join('\n')

    wake.push(`fun wakeHive(): Unit {\n${calls}\n}`)
  }

  return [...imports, ...prelude, ...body, ...wake].join('\n\n') + '\n'
}

// does a type mention a given generic parameter name?
function mentions(type: Type | undefined, name: string): boolean {
  switch (type?.kind) {
    case 'named':
      return (
        type.name === name ||
        (type.args?.some(a => mentions(a, name)) ?? false)
      )
    case 'array':
      return mentions(type.element, name)
    case 'map':
      return mentions(type.key, name) || mentions(type.value, name)
    case 'function':
      return (
        type.params.some(p => mentions(p, name)) ||
        mentions(type.result, name)
      )
    default:
      return false
  }
}

// ---- filling a form from data on kotlin ----

// the walkers a module's `fill` / `melt` with a form need: helpers over the package's `Data` sealed class, then a
// function per form. A value that does not fit throws, the way a raise does on this backend, with the path and
// reason of the package's `data-mismatch`.
function kotlinFormWalk(fills: Map<string, FormSpec>, melts: Map<string, FormSpec>): string[] {
  if (fills.size === 0 && melts.size === 0) {
    return []
  }

  const out: string[] = [KOTLIN_FORM_HELPERS]

  const fillOf = (kind: FormKind, value: string, path: string, optional: boolean): string => {
    switch (kind.kind) {
      case 'text':
        return `__termText(${value}, ${path}, ${optional})`
      case 'number':
        return `__termNumber(${value}, ${path}, ${optional})`
      case 'decimal':
        return `__termDecimal(${value}, ${path}, ${optional})`
      case 'flag':
        return `__termFlag(${value}, ${path}, ${optional})`
      case 'data':
        return `__termData(${value}, ${path}, ${optional})`
      case 'list':
        return `__termList(${value}, ${path}, ${optional}) { d, p -> ${fillOf(kind.item, 'd', 'p', false)} }`
      case 'form':
        return `__fill${pascal(kind.spec.form)}(__termData(${value}, ${path}, ${optional}), ${path})`
      default:
        return '0L'
    }
  }

  for (const spec of fills.values()) {
    const known = spec.fields.map(f => JSON.stringify(f.name)).join(', ')
    const fields = spec.fields
      .map(f => `${camel(f.name)} = ${fillOf(f.kind, `find(${JSON.stringify(f.name)})`, `__termPath(path, ${JSON.stringify(f.name)})`, f.optional)}`)
      .join(', ')

    out.push(
      `fun __fill${pascal(spec.form)}(value: Data, path: String): ${pascal(spec.form)} {\n` +
        `    val entries = __termEntries(value, path)\n` +
        `    val known = setOf(${known})\n` +
        `    for (e in entries) { if (!known.contains(e.name)) __termMismatch(__termPath(path, e.name), "is not in the form") }\n` +
        `    fun find(name: String): Data? = entries.firstOrNull { it.name == name }?.base\n` +
        `    return ${pascal(spec.form)}(${fields})\n}`,
    )
  }

  const meltOf = (kind: FormKind, value: string): string => {
    switch (kind.kind) {
      case 'text':
        return `DataText(value = ${value})`
      case 'number':
        return `DataNumber(value = ${value})`
      case 'decimal':
        return `DataDecimal(value = ${value})`
      case 'flag':
        return `DataFlag(value = ${value})`
      case 'data':
        return value
      case 'list':
        return `DataArray(list = (${value}).map { x -> ${meltOf(kind.item, 'x')} }.toMutableList())`
      case 'form':
        return `__melt${pascal(kind.spec.form)}(${value})`
      default:
        return 'DataBlank'
    }
  }

  const emptyTest = (kind: FormKind, value: string): string | undefined => {
    switch (kind.kind) {
      case 'text':
        return `(${value}).isEmpty()`
      case 'list':
        return `(${value}).isEmpty()`
      case 'data':
        return `(${value} is DataBlank)`
      default:
        return undefined
    }
  }

  for (const spec of melts.values()) {
    const lines = spec.fields.map(f => {
      const value = `value.${camel(f.name)}`
      const entry = `list.add(DataEntry(name = ${JSON.stringify(f.name)}, base = ${meltOf(f.kind, value)}))`
      const empty = f.optional ? emptyTest(f.kind, value) : undefined

      return empty ? `    if (!${empty}) { ${entry} }` : `    ${entry}`
    })

    out.push(
      `fun __melt${pascal(spec.form)}(value: ${pascal(spec.form)}): Data {\n    val list = mutableListOf<DataEntry>()\n${lines.join('\n')}\n    return DataHash(list = list)\n}`,
    )
  }

  return out
}

const KOTLIN_FORM_HELPERS = `fun __termMismatch(path: String, reason: String): Nothing =
    throw SeedError("data-mismatch: Data does not fit the shape: " + (if (path.isEmpty()) "." else path) + " " + reason)
fun __termPath(path: String, key: String): String = if (path.isEmpty()) key else path + "/" + key
fun __termKind(value: Data): String = when (value) {
    is DataHash -> "a map"; is DataArray -> "a list"; is DataBlank -> "void"; is DataText -> "text"; is DataNumber -> "number"; is DataDecimal -> "decimal"; is DataFlag -> "flag"; is DataGraft -> "a fuse"
}
fun __termEntries(value: Data, path: String): MutableList<DataEntry> = when (value) {
    is DataHash -> value.list
    else -> __termMismatch(path, "is " + __termKind(value) + " where a map belongs")
}
fun __termText(value: Data?, path: String, optional: Boolean): String = when (value) {
    is DataText -> value.value
    null, is DataBlank -> if (optional) "" else __termMismatch(path, "is missing")
    else -> __termMismatch(path, "is " + __termKind(value) + " where text belongs")
}
fun __termNumber(value: Data?, path: String, optional: Boolean): Long = when (value) {
    is DataNumber -> value.value
    null, is DataBlank -> if (optional) 0L else __termMismatch(path, "is missing")
    else -> __termMismatch(path, "is " + __termKind(value) + " where number belongs")
}
fun __termDecimal(value: Data?, path: String, optional: Boolean): Double = when (value) {
    is DataDecimal -> value.value
    is DataNumber -> value.value.toDouble()
    null, is DataBlank -> if (optional) 0.0 else __termMismatch(path, "is missing")
    else -> __termMismatch(path, "is " + __termKind(value) + " where decimal belongs")
}
fun __termFlag(value: Data?, path: String, optional: Boolean): Boolean = when (value) {
    is DataFlag -> value.value
    null, is DataBlank -> if (optional) false else __termMismatch(path, "is missing")
    else -> __termMismatch(path, "is " + __termKind(value) + " where flag belongs")
}
fun __termData(value: Data?, path: String, optional: Boolean): Data = value ?: (if (optional) DataBlank else __termMismatch(path, "is missing"))
fun <T> __termList(value: Data?, path: String, optional: Boolean, item: (Data, String) -> T): MutableList<T> = when (value) {
    is DataArray -> value.list.mapIndexed { i, d -> item(d, __termPath(path, i.toString())) }.toMutableList()
    null, is DataBlank -> if (optional) mutableListOf() else __termMismatch(path, "is missing")
    else -> __termMismatch(path, "is " + __termKind(value) + " where a list belongs")
}`
