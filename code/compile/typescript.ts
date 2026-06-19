// The nice TypeScript emitter. Compile AST to clean, idiomatic, native TypeScript: real names (kebab to camel),
// native control flow, plain operators, native arithmetic, types from the checker, no runtime imports. Pure and
// browser-safe: returns a string. See note/research/vibe/computation/plans/07-codegen.md.

import type { BinaryOp, Expression, Program, Statement, Type } from '@/code/compile/node'
import { exhausted } from '@/code/compile/backend'

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
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum',
  'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'null',
  'return', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield',
  'let', 'static', 'await', 'async', 'implements', 'interface', 'package', 'private', 'protected', 'public',
])

// acronyms that the host APIs spell in all caps (randomUUID, toJSON, parseURL). A whole kebab segment matching one of
// these uppercases entirely instead of just its first letter, so FFI member names match the platform exactly. `id` is
// deliberately excluded (host convention is `Id`, e.g. userId).
const ACRONYMS = new Set(['uuid', 'url', 'uri', 'http', 'https', 'html', 'xml', 'json', 'css', 'api', 'sql', 'ascii', 'utf8', 'jwt'])

// the TypeScript identifier a seed name compiles to (kebab/snake to camelCase). Exported so the benchmark runner can
// map a seed function name to the exported symbol it must call in the emitted module. Plain camelCase: a user's own
// function `make-api` becomes `makeApi`, not `makeAPI`. Acronym uppercasing (for host FFI names) is reserved for
// member access (see `toMember`), where the emitted name must match the platform exactly.
export function toCamel(name: string): string {
  const parts = name.split(/[-_]/)
  const head = parts[0] ?? ''
  const camel = head + parts.slice(1).map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('')
  return RESERVED.has(camel) ? `${camel}_` : camel
}

// a member name a seed name compiles to, uppercasing whole-segment acronyms so a host FFI call matches the platform
// spelling exactly (`set-attribute` -> `setAttribute`, `to-json` -> `toJSON`, `inner-html` -> `innerHTML`). Used only
// for member access (`receiver.method(...)`), which is how bind's JS-`this`-style DOM methods are invoked.
function toMember(name: string): string {
  const parts = name.split(/[-_]/)
  const head = parts[0] ?? ''
  return head + parts.slice(1).map((p) => (ACRONYMS.has(p) ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1))).join('')
}

function toPascal(name: string): string {
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
      const result = type.effects?.includes('async') ? `Promise<${tsType(type.result)}>` : tsType(type.result)
      return `(${type.params.map((p, i) => `a${i}: ${tsType(p)}`).join(', ')}) => ${result}`
    }
    case 'number':
      return 'number'
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
function collectAssignedExpr(expr: Expression, into: Set<string>): void {
  switch (expr.form) {
    case 'closure':
      collectAssigned(expr.body, into)
      break
    case 'call':
      collectAssignedExpr(expr.callee, into)
      expr.args.forEach((a) => collectAssignedExpr(a, into))
      break
    case 'binary':
      collectAssignedExpr(expr.left, into)
      collectAssignedExpr(expr.right, into)
      break
    case 'unary':
      collectAssignedExpr(expr.operand, into)
      break
    case 'array':
      expr.items.forEach((i) => collectAssignedExpr(i, into))
      break
    case 'map':
      expr.entries.forEach((e) => {
        collectAssignedExpr(e.key, into)
        collectAssignedExpr(e.value, into)
      })
      break
    case 'record':
      expr.fields.forEach((f) => collectAssignedExpr(f.value, into))
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

function collectAssigned(statements: Array<Statement>, into: Set<string>): void {
  for (const statement of statements) {
    switch (statement.form) {
      case 'let':
        collectAssignedExpr(statement.init, into)
        break
      case 'assign':
        if (statement.target.form === 'variable') into.add(statement.target.name)
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
        for (const branch of statement.cases) collectAssigned(branch.body, into)
        if (statement.otherwise) collectAssigned(statement.otherwise, into)
        break
      case 'if':
        for (const branch of statement.branches) {
          collectAssignedExpr(branch.cond, into)
          collectAssigned(branch.body, into)
        }
        if (statement.otherwise) collectAssigned(statement.otherwise, into)
        break
      case 'function':
        collectAssigned(statement.body, into)
        break
      default:
        break
    }
  }
}

function makeEmitter(variants: Set<string>) {
  const pad = (depth: number) => '  '.repeat(depth)
  let assignedNames = new Set<string>()

  const expression = (node: Expression, parentPrecedence = 0): string => {
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
      case 'call':
        return `${expression(node.callee)}(${node.args.map((arg) => expression(arg)).join(', ')})`
      case 'array':
        return `[${node.items.map((item) => expression(item)).join(', ')}]`
      case 'map':
        return `new Map([${node.entries.map((e) => `[${expression(e.key)}, ${expression(e.value)}]`).join(', ')}])`
      case 'record': {
        const fields = node.fields.map((f) => `${f.name}: ${expression(f.value)}`)
        // an enum variant carries a discriminant tag; a struct is a plain object
        if (variants.has(node.name)) return `{ ${['form: ' + JSON.stringify(node.name), ...fields].join(', ')} }`
        return `{ ${fields.join(', ')} }`
      }
      case 'member':
        return `${expression(node.target)}.${toMember(node.name)}`
      case 'await':
        return `await ${expression(node.expr)}`
      case 'closure': {
        const params = node.params.map((p) => `${toCamel(p.name)}: ${tsType(p.type)}`).join(', ')
        const arrow = node.async ? `async (${params})` : `(${params})`
        // a single trailing `return X` becomes a concise arrow; the body is parenthesized so an object literal is
        // not mistaken for a block (`() => ({ ... })`)
        if (node.body.length === 1 && node.body[0]!.form === 'return' && node.body[0]!.value) {
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
      default:
        return exhausted(node)
    }
  }

  const block = (body: Array<Statement>, depth: number): string => {
    if (body.length === 0) return '{}'
    const inner = body.map((s) => `${pad(depth + 1)}${statement(s, depth + 1)}`).join('\n')
    return `{\n${inner}\n${pad(depth)}}`
  }

  const statement = (node: Statement, depth: number): string => {
    switch (node.form) {
      case 'let': {
        const keyword = assignedNames.has(node.name) ? 'let' : 'const'
        return `${keyword} ${toCamel(node.name)} = ${expression(node.init)}`
      }
      case 'assign': {
        const target = expression(node.target)
        return node.op === '=' ? `${target} = ${expression(node.value)}` : `${target} ${node.op} ${expression(node.value)}`
      }
      case 'expression':
        return expression(node.expr)
      case 'return':
        return node.value ? `return ${expression(node.value)}` : 'return'
      case 'throw':
        // a thrown string becomes an Error; any other value is thrown as-is
        return node.value.form === 'string' ? `throw new Error(${expression(node.value)})` : `throw ${expression(node.value)}`
      case 'while':
        return `while (${expression(node.cond)}) ${block(node.body, depth)}`
      case 'for-each':
        return `for (const ${toCamel(node.item)} of ${expression(node.iterable)}) ${block(node.body, depth)}`
      case 'match': {
        const subject = expression(node.subject)
        let out = ''
        node.cases.forEach((branch, i) => {
          out += `${i ? ' else ' : ''}if (${subject}.form === ${JSON.stringify(branch.label)}) ${block(branch.body, depth)}`
        })
        if (node.otherwise) out += ` else ${block(node.otherwise, depth)}`
        return out
      }
      case 'break':
        return 'break'
      case 'continue':
        return 'continue'
      case 'record-type': {
        // an enum becomes a discriminated union; a struct becomes an interface
        if (node.variants.length > 0) {
          const members = node.variants.map((v) => {
            const fields = v.fields.map((f) => `${f.name}: ${tsType(f.type)}`)
            return `{ ${['form: ' + JSON.stringify(v.name), ...fields].join('; ')} }`
          })
          return `type ${toPascal(node.name)} =\n${members.map((m) => `${pad(depth + 1)}| ${m}`).join('\n')}`
        }
        const fields = node.fields.map((f) => `${pad(depth + 1)}${f.name}: ${tsType(f.type)}`).join('\n')
        return `interface ${toPascal(node.name)} {\n${fields}\n${pad(depth)}}`
      }
      case 'if': {
        let out = ''
        node.branches.forEach((branch, i) => {
          out += `${i ? ' else ' : ''}if (${expression(branch.cond)}) ${block(branch.body, depth)}`
        })
        if (node.otherwise) out += ` else ${block(node.otherwise, depth)}`
        return out
      }
      case 'function': {
        const previous = assignedNames
        assignedNames = new Set<string>()
        collectAssigned(node.body, assignedNames)
        const params = node.params.map((p) => `${toCamel(p.name)}: ${tsType(p.type)}`).join(', ')
        const generics = node.generics.length ? `<${node.generics.map((g) => toPascal(g.name)).join(', ')}>` : ''
        const returnType = node.async ? `Promise<${tsType(node.result)}>` : tsType(node.result)
        const keyword = node.async ? 'async function' : 'function'
        const out = `${keyword} ${toCamel(node.name)}${generics}(${params}): ${returnType} ${block(node.body, depth)}`
        assignedNames = previous
        return out
      }
      case 'hold':
        return '// hold: verified at compile time'
      case 'mask': {
        // a trait becomes an interface of its method signatures
        const methods = node.methods.map((m) => `  ${toCamel(m)}(...args: Array<unknown>): unknown`).join('\n')
        return `interface ${toPascal(node.name)} {\n${methods}\n}`
      }
      case 'instance':
        // a trait implementation: the methods are emitted as their own functions; this records the dictionary
        return `// ${toPascal(node.target)} implements ${toPascal(node.mask)} { ${node.methods.map(toCamel).join(', ')} }`
      case 'native':
        // a `dock load` native binding: emitted as a host import at the top of the module, not inline here
        return ''
      case 'zone':
      case 'dock':
        // view (zone) and routing/CLI (dock) DSLs are lowered by the dedicated zone compiler (code/zone), not here
        return ''
      default:
        return exhausted(node)
    }
  }

  return { statement, expression }
}

export function emitTypeScript(program: Program): string {
  const variants = new Set<string>()
  for (const node of program) if (node.form === 'record-type') for (const v of node.variants) variants.add(v.name)
  const emitter = makeEmitter(variants)
  // native module bindings (`dock load`) become host imports at the top. A `<global:X>` binding refers to a host
  // global (console, process, ...) — no import; alias it to the global (unless the alias already is the global name).
  const natives = program.filter((node): node is Extract<typeof node, { form: 'native' }> => node.form === 'native')
  const imports = natives
    .filter((node) => !node.module.startsWith('global:'))
    .map((node) => `import * as ${toCamel(node.alias)} from "${node.module}"`)
  for (const node of natives.filter((n) => n.module.startsWith('global:'))) {
    const globalName = node.module.slice('global:'.length)
    if (toCamel(node.alias) !== globalName) imports.push(`const ${toCamel(node.alias)} = ${globalName}`)
  }
  const lines = program
    .filter((node) => node.form !== 'native')
    .map((node) => {
      const text = emitter.statement(node, 0)
      const exported = node.form === 'function' || node.form === 'record-type' || node.form === 'mask'
      return exported ? `export ${text}` : text
    })
  const body = `${lines.join('\n\n')}\n`
  return imports.length > 0 ? `${imports.join('\n')}\n\n${body}` : body
}
