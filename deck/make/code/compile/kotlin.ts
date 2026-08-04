// The Kotlin backend: emit the language as idiomatic, type-static Kotlin. Parity with the TypeScript backend across
// every AST form. Algebraic data types lower to NATIVE sealed-class hierarchies (`sealed class Maybe<out T>` with a
// subclass per variant), `match` to an exhaustive `when (subject) { is MaybeSome -> ... }` whose smart-casts make a
// variant's fields directly accessible (no rewrite needed), and struct forms to `data class`es. A variant subclass
// carries only the generics its own fields use, filling the rest with `Nothing` (valid under `out` variance), so
// construction infers cleanly. Pure, browser-safe. See note/research/vibe/computation/plans/07-codegen.md.

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
} from '@term/make/code/compile/backend'
import type { CollectionOp } from '@term/make/code/compile/backend'
import {
  collectBinds,
  renderBind,
  bindGap,
} from '@term/make/code/compile/bind'

function camel(name: string): string {
  // strip every hyphen, including one before a digit (`sha-256` -> `sha256`), so the result is a valid identifier
  return name.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())
}

function pascal(name: string): string {
  const c = camel(name)

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

export function emitKotlin(program: Program): string {
  const pad = (d: number) => '    '.repeat(d)
  // opaque per-backend handle types (`dock type / load <java.lang.Process>, name child-handle`): seed name -> concrete
  // kotlin type, so a `like child-handle` field emits the real handle type rather than a nonexistent class.
  const opaqueTypes = new Map<string, string>(
    program
      .filter(
        (n): n is Extract<Statement, { form: 'native' }> =>
          n.form === 'native' && n.kind === 'type',
      )
      .map(n => [n.alias, n.module]),
  )

  // declarative native bindings render their `case kotlin` template at call sites
  const binds = collectBinds(program)
  // the Kotlin subclass for a variant label, and each variant's field names (for construction / smart-cast access)
  const variantClass = new Map<string, string>()
  const variantFieldNames = new Map<string, string[]>()

  for (const node of program) {
    if (node.form !== 'record-type') {
      continue
    }

    for (const v of node.variants) {
      variantClass.set(v.name, `${pascal(node.name)}${pascal(v.name)}`)
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

        return type.args && type.args.length > 0
          ? `${pascal(type.name)}<${type.args
              .map(kotlinType)
              .join(', ')}>`
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
        return 'Long'
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
      fresh.push(letter)
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

        return `${expr(node.callee)}(${node.args.map(expr).join(', ')})`
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
        const cls = variantClass.get(node.name)

        if (cls) {
          return node.fields.length > 0
            ? `${cls}(${node.fields
                .map(f => `${camel(f.name)} = ${expr(f.value)}`)
                .join(', ')})`
            : cls
        }

        // a generic struct built from empty collections cannot infer its parameters; pin them from the checked type
        const args =
          node.type?.kind === 'named' && node.type.args?.length
            ? `<${node.type.args.map(kotlinType).join(', ')}>`
            : ''

        return `${pascal(node.name)}${args}(${node.fields
          .map(f => `${camel(f.name)} = ${expr(f.value)}`)
          .join(', ')})`
      }

      case 'member': {
        // `map.size` / `array.length` lower to the platform's count property (as a Long, the seed number type)
        const read = collectionRead(node)

        if (read) {
          return `${expr(read.target)}.size.toLong()`
        }

        if (node.index) {
          return `${expr(node.target)}[${expr(node.index)}]`
        }

        return `${expr(node.target)}.${camel(node.name)}`
      }

      case 'await':
        return expr(node.expr)

      case 'closure': {
        // a function literal as a Kotlin lambda. A lambda's value is its last expression, so the trailing `send back X`
        // becomes a bare `X` (an explicit `return` inside a lambda would non-locally return from the enclosing function).
        const params = node.params.map(p => camel(p.name)).join(', ')
        const last = node.body[node.body.length - 1]
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
        return `${target}[(${arg[0]}).toInt()]`
      case 'includes':
        return `${target}.contains(${arg[0]})`
      case 'indexOf':
        return `${target}.indexOf(${arg[0]}).toLong()`
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

  const block = (body: Statement[], d: number): string =>
    body
      .map(s => `${pad(d)}${stmt(s, d)}`)
      .filter(Boolean)
      .join('\n')

  const stmt = (node: Statement, d: number): string => {
    switch (node.form) {
      case 'let': {
        // a suspend lambda only becomes suspend when its expected type says so: annotate an async-closure binding with
        // the `suspend (..) -> R` function type, otherwise Kotlin infers an ordinary (non-suspending) lambda.
        const ann =
          node.init.form === 'closure' && node.init.async
            ? `: ${kotlinType({
                kind: 'function',
                params: node.init.params.map(
                  (p): Type => p.type ?? { kind: 'unknown' },
                ),
                result: node.init.result ?? { kind: 'unknown' },
                effects: ['async'],
              })}`
            : ''

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
      case 'return':
        return node.value ? `return ${expr(node.value)}` : 'return'
      case 'throw':
        return `throw SeedError(${
          node.value.form === 'string'
            ? expr(node.value)
            : `(${expr(node.value)}).toString()`
        })`
      case 'while':
        return `while (${expr(node.cond)}) {\n${block(
          node.body,
          d + 1,
        )}\n${pad(d)}}`
      case 'for-each':
        return `for (${camel(node.item)} in ${expr(
          node.iterable,
        )}) {\n${block(node.body, d + 1)}\n${pad(d)}}`

      case 'match': {
        // an exhaustive `when` on the sealed type: each `is` arm smart-casts the subject, so its fields are directly
        // accessible in the body with no rewrite. A return-position match becomes `return when (...)`.
        const subject = expr(node.subject)
        const arms = node.cases.map(b => {
          const cls = variantClass.get(b.label) ?? pascal(b.label)

          return `${pad(d + 1)}is ${cls} -> {\n${block(
            b.body,
            d + 2,
          )}\n${pad(d + 1)}}`
        })

        if (node.otherwise) {
          arms.push(
            `${pad(d + 1)}else -> {\n${block(
              node.otherwise,
              d + 2,
            )}\n${pad(d + 1)}}`,
          )
        }

        return `when (${subject}) {\n${arms.join('\n')}\n${pad(d)}}`
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

        const bodyText = [...shadows, block(node.body, d + 1)]
          .filter(Boolean)
          .join('\n')

        return `${suspend}fun ${generics}${camel(
          node.name,
        )}(${params}): ${kotlinType(node.result)} {\n${bodyText}\n${pad(
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
            const cls = `${pascal(node.name)}${pascal(v.name)}`
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
          .map(f => `val ${camel(f.name)}: ${kotlinType(f.type)}`)
          .join(', ')

        const generics = node.params.length
          ? `<${node.params.map(p => p.toUpperCase()).join(', ')}>`
          : ''

        const decl = `data class ${pascal(node.name)}${generics}(${fields})`
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
      case 'zone':
      case 'dock':
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

  const body = program
    .filter(n => n.form !== 'native')
    .map(n => stmt(n, 0))
    .filter(Boolean)

  const prelude = body.some(b => b.includes('SeedError('))
    ? ['class SeedError(message: String) : RuntimeException(message)']
    : []

  return [...imports, ...prelude, ...body].join('\n\n') + '\n'
}

// the names reassigned anywhere in a body (Kotlin parameters are immutable, so a reassigned one needs a var shadow)
function reassigned(body: Statement[], into: Set<string>): void {
  for (const s of body) {
    switch (s.form) {
      case 'assign':
        if (s.target.form === 'variable') {
          into.add(s.target.name)
        }

        break
      case 'if':
        s.branches.forEach(b => reassigned(b.body, into))

        if (s.otherwise) {
          reassigned(s.otherwise, into)
        }

        break
      case 'match':
        s.cases.forEach(c => reassigned(c.body, into))

        if (s.otherwise) {
          reassigned(s.otherwise, into)
        }

        break
      case 'while':
      case 'for-each':
        reassigned(s.body, into)
        break
      default:
        break
    }
  }
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
