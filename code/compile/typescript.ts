// The nice TypeScript emitter. Compile AST to clean, idiomatic, native TypeScript: real names (kebab to camel),
// native control flow, plain operators, native arithmetic, types from the checker, no runtime imports. Pure and
// browser-safe: returns a string. See note/research/vibe/computation/plans/07-codegen.md.

import type {
  BinaryOp,
  Expression,
  Program,
  Statement,
  Type,
  ZoneNode,
} from '@/code/compile/node'
import { exhausted, mapCollect } from '@/code/compile/backend'
import {
  collectBinds,
  renderBind,
  bindGap,
  referencedBinds,
} from '@/code/compile/bind'
import type { Bind } from '@/code/compile/bind'

const PRECEDENCE: Record<BinaryOp, number> = {
  '||': 1,
  '&&': 2,
  '==': 3,
  '!=': 3,
  '<': 3,
  '<=': 3,
  '>': 3,
  '>=': 3,
  '+': 4,
  '-': 4,
  '*': 5,
  '/': 5,
  '%': 5,
}

// JavaScript reserved words that cannot be bare identifiers; a seed name colliding with one is suffixed with `_`.
// Applied uniformly (definitions and uses), so a field/param named `new` stays consistent across the module.
const RESERVED = new Set([
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'import',
  'in',
  'instanceof',
  'new',
  'null',
  'return',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',
  'let',
  'static',
  'await',
  'async',
  'implements',
  'interface',
  'package',
  'private',
  'protected',
  'public',
  // not keywords, but illegal as binding names in an ES module / strict mode
  'eval',
  'arguments',
])

// acronyms that the host APIs spell in all caps (randomUUID, toJSON, parseURL). A whole kebab segment matching one of
// these uppercases entirely instead of just its first letter, so FFI member names match the platform exactly. `id` is
// deliberately excluded (host convention is `Id`, e.g. userId).
const ACRONYMS = new Set([
  'uuid',
  'url',
  'uri',
  'http',
  'https',
  'html',
  'xml',
  'json',
  'css',
  'api',
  'sql',
  'ascii',
  'utf8',
  'jwt',
])

// the TypeScript identifier a seed name compiles to (kebab/snake to camelCase). Exported so the benchmark runner can
// map a seed function name to the exported symbol it must call in the emitted module. Plain camelCase: a user's own
// function `make-api` becomes `makeApi`, not `makeAPI`. Acronym uppercasing (for host FFI names) is reserved for
// member access (see `toMember`), where the emitted name must match the platform exactly.
export function toCamel(name: string): string {
  const parts = name.split(/[-_]/)
  const head = parts[0] ?? ''
  const camel =
    head +
    parts
      .slice(1)
      .map(p => p.charAt(0).toUpperCase() + p.slice(1))
      .join('')
  return RESERVED.has(camel) ? `${camel}_` : camel
}

// a kebab / snake name to a SCREAMING_SNAKE constant (`database-url` -> `DATABASE_URL`), for environment variable names
export function toConstant(name: string): string {
  return name
    .split(/[-_]/)
    .map(p => p.toUpperCase())
    .join('_')
}

// a member name a seed name compiles to, uppercasing whole-segment acronyms so a host FFI call matches the platform
// spelling exactly (`set-attribute` -> `setAttribute`, `to-json` -> `toJSON`, `inner-html` -> `innerHTML`). Used only
// for member access (`receiver.method(...)`), which is how bind's JS-`this`-style DOM methods are invoked.
function toMember(name: string): string {
  const parts = name.split(/[-_]/)
  const head = parts[0] ?? ''
  return (
    head +
    parts
      .slice(1)
      .map(p =>
        ACRONYMS.has(p)
          ? p.toUpperCase()
          : p.charAt(0).toUpperCase() + p.slice(1),
      )
      .join('')
  )
}

export function toPascal(name: string): string {
  const camel = toCamel(name)
  return camel.charAt(0).toUpperCase() + camel.slice(1)
}

// a checked type to a TypeScript type
function tsType(type: Type | undefined): string {
  switch (type?.kind) {
    case 'boolean':
      return 'boolean'
    case 'string':
      return 'string'
    case 'unit':
      return 'void'
    case 'array':
      return `${tsType(type.element)}[]`
    case 'map':
      return `Map<${tsType(type.key)}, ${tsType(type.value)}>`
    case 'named':
      return toPascal(type.name)
    case 'function': {
      const result = type.effects?.includes('async')
        ? `Promise<${tsType(type.result)}>`
        : tsType(type.result)
      return `(${type.params
        .map((p, i) => `a${i}: ${tsType(p)}`)
        .join(', ')}) => ${result}`
    }
    case 'number':
    case 'float':
      return 'number'
    case 'dynamic':
      return 'any'
    case 'bytes':
      return 'Uint8Array'
    case 'variable':
    case 'unknown':
    case undefined:
    default:
      // an unconstrained binding in a numeric program: default to number
      return 'number'
  }
}

// find expressions reassigned to a name, so the binding emits as `let` not `const`. Crucially this descends into
// closure bodies: a variable declared in an outer scope but reassigned inside a callback (e.g. an effect) must be a
// `let`. Without this, the reassignment would target a `const` and throw.
function collectAssignedExpr(
  expr: Expression,
  into: Set<string>,
): void {
  switch (expr.form) {
    case 'closure':
      collectAssigned(expr.body, into)
      break
    case 'call':
      collectAssignedExpr(expr.callee, into)
      expr.args.forEach(a => collectAssignedExpr(a, into))
      break
    case 'binary':
      collectAssignedExpr(expr.left, into)
      collectAssignedExpr(expr.right, into)
      break
    case 'unary':
      collectAssignedExpr(expr.operand, into)
      break
    case 'array':
      expr.items.forEach(i => collectAssignedExpr(i, into))
      break
    case 'map':
      expr.entries.forEach(e => {
        collectAssignedExpr(e.key, into)
        collectAssignedExpr(e.value, into)
      })
      break
    case 'record':
      expr.fields.forEach(f => collectAssignedExpr(f.value, into))
      break
    case 'member':
      collectAssignedExpr(expr.target, into)
      break
    case 'await':
      collectAssignedExpr(expr.expr, into)
      break
    default:
      break
  }
}

function collectAssigned(
  statements: Array<Statement>,
  into: Set<string>,
): void {
  for (const statement of statements) {
    switch (statement.form) {
      case 'let':
        collectAssignedExpr(statement.init, into)
        break
      case 'assign':
        if (statement.target.form === 'variable')
          into.add(statement.target.name)
        collectAssignedExpr(statement.value, into)
        break
      case 'expression':
        collectAssignedExpr(statement.expr, into)
        break
      case 'return':
        if (statement.value) collectAssignedExpr(statement.value, into)
        break
      case 'throw':
        collectAssignedExpr(statement.value, into)
        break
      case 'hold':
        collectAssignedExpr(statement.expr, into)
        break
      case 'while':
        collectAssignedExpr(statement.cond, into)
        collectAssigned(statement.body, into)
        break
      case 'for-each':
        collectAssignedExpr(statement.iterable, into)
        collectAssigned(statement.body, into)
        break
      case 'match':
        collectAssignedExpr(statement.subject, into)
        for (const branch of statement.cases)
          collectAssigned(branch.body, into)
        if (statement.otherwise)
          collectAssigned(statement.otherwise, into)
        break
      case 'if':
        for (const branch of statement.branches) {
          collectAssignedExpr(branch.cond, into)
          collectAssigned(branch.body, into)
        }
        if (statement.otherwise)
          collectAssigned(statement.otherwise, into)
        break
      case 'function':
        collectAssigned(statement.body, into)
        break
      default:
        break
    }
  }
}

function makeEmitter(
  variants: Set<string>,
  hmr = false,
  binds: Map<string, Bind> = new Map(),
  env = 'node',
) {
  const pad = (depth: number) => '  '.repeat(depth)
  let assignedNames = new Set<string>()

  const expression = (
    node: Expression,
    parentPrecedence = 0,
  ): string => {
    switch (node.form) {
      case 'integer':
        return String(node.value)
      case 'float':
        return String(node.value)
      case 'boolean':
        return node.value ? 'true' : 'false'
      case 'string':
        return JSON.stringify(node.value)
      case 'unit':
        return 'undefined'
      case 'variable':
        return toCamel(node.name)
      case 'hole':
        return toCamel(node.name)
      case 'call': {
        // a declarative native binding renders its environment's template in place of a real call. The `javascript`
        // target covers both node and browser when no env-specific target is given.
        if (node.callee.form === 'variable' && binds.has(node.callee.name)) {
          const bind = binds.get(node.callee.name)!
          const args = node.args.map(arg => expression(arg))
          return (
            renderBind(bind, env, args) ??
            renderBind(bind, 'javascript', args) ??
            bindGap(bind.name)
          )
        }
        // keys / values on a map materialize to an array (a `Map` iterator is not the list the stdlib returns)
        const collected = mapCollect(node.callee)
        if (collected) {
          return `Array.from(${expression(collected.target)}.${collected.name}())`
        }

        return `${expression(node.callee)}(${node.args
          .map(arg => expression(arg))
          .join(', ')})`
      }
      case 'array':
        return `[${node.items
          .map(item => expression(item))
          .join(', ')}]`
      case 'map':
        return `new Map([${node.entries
          .map(e => `[${expression(e.key)}, ${expression(e.value)}]`)
          .join(', ')}])`
      case 'record': {
        const fields = node.fields.map(
          f => `${toMember(f.name)}: ${expression(f.value)}`,
        )
        // an enum variant carries a discriminant tag; a struct is a plain object
        if (variants.has(node.name))
          return `{ ${[
            'form: ' + JSON.stringify(node.name),
            ...fields,
          ].join(', ')} }`
        return `{ ${fields.join(', ')} }`
      }
      case 'member':
        // a binding field with a foreign `name <...>` (e.g. COLOR_BUFFER_BIT) emits that native name verbatim; other
        // members camelCase the seed name
        return `${expression(node.target)}.${node.nick ?? toMember(node.name)}`
      case 'await':
        return `await ${expression(node.expr)}`
      case 'closure': {
        const params = node.params
          .map(p => `${toCamel(p.name)}: ${tsType(p.type)}`)
          .join(', ')
        const arrow = node.async ? `async (${params})` : `(${params})`
        // a single trailing `return X` becomes a concise arrow; the body is parenthesized so an object literal is
        // not mistaken for a block (`() => ({ ... })`)
        if (
          node.body.length === 1 &&
          node.body[0]!.form === 'return' &&
          node.body[0]!.value
        ) {
          return `${arrow} => (${expression(node.body[0]!.value)})`
        }
        return `${arrow} => ${block(node.body, 0)}`
      }
      case 'unary':
        return `${node.op}${expression(node.operand, 6)}`
      case 'binary': {
        const precedence = PRECEDENCE[node.op]
        const left = expression(node.left, precedence)
        const right = expression(node.right, precedence + 1)
        const text = `${left} ${node.op} ${right}`
        return precedence < parentPrecedence ? `(${text})` : text
      }
      case 'conditional': {
        // a value-position conditional lowers to a ternary chain: cond0 ? value0 : cond1 ? value1 : otherwise
        const tail = node.otherwise
          ? expression(node.otherwise)
          : 'undefined'
        const text = node.branches.reduceRight(
          (rest, branch) =>
            `${expression(branch.cond)} ? ${expression(
              branch.value,
            )} : ${rest}`,
          tail,
        )
        return parentPrecedence > 0 ? `(${text})` : text
      }
      default:
        return exhausted(node)
    }
  }

  const block = (body: Array<Statement>, depth: number): string => {
    if (body.length === 0) return '{}'
    const inner = body
      .map(s => `${pad(depth + 1)}${statement(s, depth + 1)}`)
      .join('\n')
    return `{\n${inner}\n${pad(depth)}}`
  }

  // emit a zone (view component) to a function that builds its DOM via the render runtime: `save` declares state /
  // computeds, `element` / `text` make nodes, `read` makes a reactive text node (`dynamic`), attributes / events wire
  // them, and each top-level view node is attached under the host param. fork / walk lower to `show` / `each`. The
  // render runtime (element / text / dynamic / attribute / event / append / show / each) is imported by the zone's
  // own module. See note/seed/plan/zone-components.md.
  const emitZone = (
    node: Extract<Statement, { form: 'zone' }>,
  ): string => {
    let counter = 0
    const next = (): string => `view${counter++}`

    // build a node into `out`, returning its variable name. Render-runtime calls are positional, in the param order of
    // each task in code/zone/render.tree: element(tag), text(value), dynamic(source), attribute(node, name, value),
    // event(node, name, handler).
    const build = (zone: ZoneNode, out: Array<string>): string => {
      // a named element (`name x`) is emitted under that name, so handlers elsewhere in the zone can read it
      const ref =
        zone.form === 'element' && zone.ref ? toCamel(zone.ref) : next()
      if (zone.form === 'text')
        out.push(`const ${ref} = text(${JSON.stringify(zone.value)})`)
      else if (zone.form === 'read')
        out.push(`const ${ref} = dynamic(() => ${expression(zone.value)})`)
      else if (zone.form === 'element') {
        out.push(`const ${ref} = element(${JSON.stringify(zone.name)})`)
        for (const attribute of zone.attributes)
          out.push(
            attribute.event
              ? `event(${ref}, ${JSON.stringify(
                  attribute.name,
                )}, () => ${expression(attribute.value)})`
              : `attribute(${ref}, ${JSON.stringify(
                  attribute.name,
                )}, ${expression(attribute.value)})`,
          )
        for (const child of zone.children) attach(child, ref, out)
      } else out.push(`const ${ref} = text("")`)
      return ref
    }

    // the positional render calls for the control-flow nodes (host comes first)
    const showCall = (
      host: string,
      zone: Extract<ZoneNode, { form: 'fork' }>,
    ): string => {
      const branch = zone.branches[0]
      return `show(${host}, () => ${
        branch ? expression(branch.cond) : 'false'
      }, ${fragment([], branch ? branch.body : [])}, ${fragment(
        [],
        zone.otherwise ?? [],
      )})`
    }
    const eachCall = (
      host: string,
      zone: Extract<ZoneNode, { form: 'walk' }>,
    ): string =>
      // the iterable is passed as a getter so `each` can read it inside an effect (reactive list rendering)
      `each(${host}, () => ${expression(zone.iterable)}, ${fragment(
        [toCamel(zone.item)],
        zone.body,
      )})`

    // attach a child under `parent`: nodes are built + appended; fork / walk lower to show / each. When `collect` is
    // given (the top level under the host in HMR mode), record the single removable node per child: a built element /
    // text ref directly, a fork / walk wrapped in a container so its whole subtree can be removed on hot-swap.
    const attach = (
      zone: ZoneNode,
      parent: string,
      out: Array<string>,
      collect?: Array<string>,
    ): void => {
      if (zone.form === 'fork') {
        if (collect) {
          const part = next()
          out.push(`const ${part} = element("seed-part")`)
          out.push(showCall(part, zone))
          out.push(`append(${parent}, ${part})`)
          collect.push(part)
        } else out.push(showCall(parent, zone))
      } else if (zone.form === 'walk') {
        if (collect) {
          const part = next()
          out.push(`const ${part} = element("seed-part")`)
          out.push(eachCall(part, zone))
          out.push(`append(${parent}, ${part})`)
          collect.push(part)
        } else out.push(eachCall(parent, zone))
      } else if (zone.form !== 'slot') {
        const ref = build(zone, out)
        out.push(`append(${parent}, ${ref})`)
        if (collect) collect.push(ref)
      }
    }

    // a body list as a thunk `(params) => view` returning one node (children attached under a fragment element).
    // Not an IIFE: it is the `then` / `other` / `build` callback the render runtime invokes.
    const fragment = (
      params: Array<string>,
      body: Array<ZoneNode>,
    ): string => {
      const out: Array<string> = []
      const only = body[0]
      // a single static node is returned directly (no wrapper); anything else (0 or 2+ nodes, or control flow) goes
      // under a `seed-fragment` so the callback always returns exactly one node
      if (
        body.length === 1 &&
        only &&
        (only.form === 'element' ||
          only.form === 'text' ||
          only.form === 'read')
      ) {
        const ref = build(only, out)
        out.push(`return ${ref}`)
      } else {
        out.push(`const frag = element("seed-fragment")`)
        for (const child of body) attach(child, 'frag', out)
        out.push('return frag')
      }
      return `(${params.join(', ')}) => { ${out.join('; ')} }`
    }

    // a top-level `save` whose value creates a signal (`save count / call make-signal / ...`). Its value is preserved
    // across a hot-swap, so in HMR mode it is seeded from the snapshot kept by the dev client.
    const isSignalSave = (
      child: Extract<ZoneNode, { form: 'save' }>,
    ): boolean =>
      child.value.form === 'call' &&
      child.value.callee.form === 'variable' &&
      child.value.callee.name === 'make-signal'

    const params = node.params
      .map(p => `${toCamel(p.name)}: ${tsType(p.type)}`)
      .join(', ')
    const host = node.params[0] ? toCamel(node.params[0].name) : 'host'
    // the zone's key in the hot snapshot / remount map is its exported (camelCase) name, so the accept callback can
    // look the component up on the fresh module namespace by the same key
    const name = JSON.stringify(toCamel(node.name))
    const lines: Array<string> = []
    const signals: Array<string> = []

    // HMR: read the saved signal snapshot for this zone (if the dev client kept one), and open an ownership scope so
    // every effect created while building the view can be torn down together on the next hot-swap.
    if (hmr) {
      lines.push(
        `const __seed = (hot && hot.data.signals && hot.data.signals[${name}]) || {}`,
      )
      lines.push(`const __scope = openScope()`)
    }

    for (const child of node.body)
      if (child.form === 'save') {
        if (hmr && isSignalSave(child)) {
          signals.push(child.name)
          const key = JSON.stringify(child.name)
          const init =
            child.value.form === 'call' && child.value.args[0]
              ? expression(child.value.args[0])
              : 'undefined'
          lines.push(
            `const ${toCamel(
              child.name,
            )} = makeSignal(${key} in __seed ? __seed[${key}] : ${init})`,
          )
        } else
          lines.push(
            `const ${toCamel(child.name)} = ${expression(child.value)}`,
          )
      }

    const roots: Array<string> = []
    for (const child of node.body)
      if (child.form !== 'save')
        attach(child, host, lines, hmr ? roots : undefined)

    // HMR: close the scope and register this instance (host, live signals, scope, root nodes) so the dev client can
    // snapshot its state, tear it down, and re-mount it from the fresh module on the next change.
    if (hmr) {
      lines.push(`closeScope()`)
      const sigObject = signals
        .map(s => `${JSON.stringify(s)}: ${toCamel(s)}`)
        .join(', ')
      lines.push(
        `if (hot) (hot.data.instances || (hot.data.instances = [])).push(` +
          `{ zone: ${name}, host: ${host}, signals: { ${sigObject} }, ` +
          `scope: __scope, nodes: [${roots.join(', ')}] })`,
      )
    }

    return `export function ${toCamel(
      node.name,
    )}(${params}) {\n  ${lines.join('\n  ')}\n}`
  }

  const statement = (node: Statement, depth: number): string => {
    switch (node.form) {
      case 'let': {
        // a host global (`host document, name <document>`): alias the seed name to the foreign global, or emit nothing
        // when the seed name already spells the global (so `document` resolves to the real `document`). Never bind it
        // to `undefined`.
        if (node.foreign) {
          const alias = toCamel(node.name)
          return alias === node.foreign
            ? ''
            : `const ${alias} = ${node.foreign}`
        }
        const keyword = assignedNames.has(node.name) ? 'let' : 'const'
        return `${keyword} ${toCamel(node.name)} = ${expression(
          node.init,
        )}`
      }
      case 'assign': {
        const target = expression(node.target)
        return node.op === '='
          ? `${target} = ${expression(node.value)}`
          : `${target} ${node.op} ${expression(node.value)}`
      }
      case 'expression':
        return expression(node.expr)
      case 'return':
        return node.value
          ? `return ${expression(node.value)}`
          : 'return'
      case 'throw':
        // a thrown string becomes an Error; any other value is thrown as-is
        return node.value.form === 'string'
          ? `throw new Error(${expression(node.value)})`
          : `throw ${expression(node.value)}`
      case 'while':
        return `while (${expression(node.cond)}) ${block(
          node.body,
          depth,
        )}`
      case 'for-each':
        return `for (const ${toCamel(node.item)} of ${expression(
          node.iterable,
        )}) ${block(node.body, depth)}`
      case 'match': {
        const subject = expression(node.subject)
        let out = ''
        node.cases.forEach((branch, i) => {
          out += `${
            i ? ' else ' : ''
          }if (${subject}.form === ${JSON.stringify(
            branch.label,
          )}) ${block(branch.body, depth)}`
        })
        if (node.otherwise)
          out += ` else ${block(node.otherwise, depth)}`
        return out
      }
      case 'break':
        return 'break'
      case 'continue':
        return 'continue'
      case 'record-type': {
        // an enum becomes a discriminated union; a struct becomes an interface
        if (node.variants.length > 0) {
          const members = node.variants.map(v => {
            const fields = v.fields.map(
              f => `${toMember(f.name)}: ${tsType(f.type)}`,
            )
            return `{ ${[
              'form: ' + JSON.stringify(v.name),
              ...fields,
            ].join('; ')} }`
          })
          return `type ${toPascal(node.name)} =\n${members
            .map(m => `${pad(depth + 1)}| ${m}`)
            .join('\n')}`
        }
        const fields = node.fields
          .map(
            f =>
              `${pad(depth + 1)}${toMember(f.name)}: ${tsType(f.type)}`,
          )
          .join('\n')
        return `interface ${toPascal(node.name)} {\n${fields}\n${pad(
          depth,
        )}}`
      }
      case 'if': {
        let out = ''
        node.branches.forEach((branch, i) => {
          out += `${i ? ' else ' : ''}if (${expression(
            branch.cond,
          )}) ${block(branch.body, depth)}`
        })
        if (node.otherwise)
          out += ` else ${block(node.otherwise, depth)}`
        return out
      }
      case 'function': {
        const previous = assignedNames
        assignedNames = new Set<string>()
        collectAssigned(node.body, assignedNames)
        const params = node.params
          .map(p => `${toCamel(p.name)}: ${tsType(p.type)}`)
          .join(', ')
        const generics = node.generics.length
          ? `<${node.generics.map(g => toPascal(g.name)).join(', ')}>`
          : ''
        const returnType = node.async
          ? `Promise<${tsType(node.result)}>`
          : tsType(node.result)
        const keyword = node.async ? 'async function' : 'function'
        const out = `${keyword} ${toCamel(
          node.name,
        )}${generics}(${params}): ${returnType} ${block(
          node.body,
          depth,
        )}`
        assignedNames = previous
        return out
      }
      case 'hold':
        return '// hold: verified at compile time'
      case 'mask': {
        // a trait becomes an interface of its method signatures
        const methods = node.methods
          .map(m => `  ${toCamel(m)}(...args: Array<unknown>): unknown`)
          .join('\n')
        return `interface ${toPascal(node.name)} {\n${methods}\n}`
      }
      case 'instance':
        // a trait implementation: the methods are emitted as their own functions; this records the dictionary
        return `// ${toPascal(node.target)} implements ${toPascal(
          node.mask,
        )} { ${node.methods.map(toCamel).join(', ')} }`
      case 'native':
        // a `dock load` native binding: emitted as a host import at the top of the module, not inline here
        return ''
      case 'bind':
        // a declarative native binding: no declaration is emitted; it renders inline at each call site
        return ''
      case 'zone':
        // a view component: emit a builder over the render runtime (element / text / dynamic / show / each)
        return emitZone(node)
      case 'dock':
        // routing/CLI (dock) DSL is lowered elsewhere, not here
        return ''
      default:
        return exhausted(node)
    }
  }

  return { statement, expression }
}

export function emitTypeScript(
  program: Program,
  // `variants` carries the enum variant names defined across the WHOLE program. In per-module mode a module that builds
  // `make some` may not itself define `maybe`, so without this its variant constructors would lose their `form` tag.
  options?: { hmr?: boolean; variants?: Set<string>; env?: string },
): string {
  const variants = new Set<string>(options?.variants)
  for (const node of program)
    if (node.form === 'record-type')
      for (const v of node.variants) variants.add(v.name)
  const env = options?.env ?? 'node'
  const binds = collectBinds(program)
  const emitter = makeEmitter(variants, options?.hmr ?? false, binds, env)
  // native module bindings (`dock load`) become host imports at the top. A `<global:X>` binding refers to a host
  // global (console, process, ...) — no import; alias it to the global (unless the alias already is the global name).
  const natives = program.filter(
    (node): node is Extract<typeof node, { form: 'native' }> =>
      node.form === 'native',
  )
  const imports = natives
    .filter(node => !node.module.startsWith('global:'))
    .map(
      node =>
        `import * as ${toCamel(node.alias)} from "${node.module}"`,
    )
  for (const node of natives.filter(n =>
    n.module.startsWith('global:'),
  )) {
    const globalName = node.module.slice('global:'.length)
    if (toCamel(node.alias) !== globalName)
      imports.push(`const ${toCamel(node.alias)} = ${globalName}`)
  }
  // a declarative binding's env target may name imports its rendered expression needs (dedup against the natives). Only
  // binds actually called contribute, so an unused alternative does not pull in an import the program never references.
  for (const bind of referencedBinds(program, binds).values()) {
    const target =
      bind.targets.find(t => t.env === env) ??
      bind.targets.find(t => t.env === 'javascript')
    for (const need of target?.imports ?? []) {
      const line = need.alias
        ? `import * as ${toCamel(need.alias)} from "${need.module}"`
        : `import "${need.module}"`
      if (!imports.includes(line)) imports.push(line)
    }
  }
  // dedupe top-level named declarations: a generated binding has overloaded methods that collapse to one name (three
  // `create-element` overloads -> one `documentCreateElement`), and an interface can recur across merged modules.
  // Emitting each twice is a JS redeclaration error, so keep the LAST of each (form, name): it matches the signature
  // the type checker kept (last registration wins), and a native impl loaded after the abstract signature it imports
  // (its dependency) wins over that empty signature.
  const declares = (
    node: Statement,
  ): node is Extract<
    Statement,
    { form: 'function' | 'record-type' | 'mask' }
  > =>
    node.form === 'function' ||
    node.form === 'record-type' ||
    node.form === 'mask'
  const emittable = program.filter(node => node.form !== 'native')
  const lastIndex = new Map<string, number>()
  emittable.forEach((node, i) => {
    if (declares(node)) lastIndex.set(`${node.form}:${node.name}`, i)
  })
  const lines = emittable
    .filter(
      (node, i) =>
        !declares(node) ||
        lastIndex.get(`${node.form}:${node.name}`) === i,
    )
    .map(node => {
      const text = emitter.statement(node, 0)
      const exported =
        node.form === 'function' ||
        node.form === 'record-type' ||
        node.form === 'mask'
      return exported ? `export ${text}` : text
    })
    // an ambient host global whose seed name already spells the global emits nothing; drop the blank line
    .filter(line => line.length > 0)
  const body = `${lines.join('\n\n')}\n`
  return imports.length > 0 ? `${imports.join('\n')}\n\n${body}` : body
}
