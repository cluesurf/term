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

// the TypeScript identifier a seed name compiles to (kebab/snake to camelCase). Exported so the benchmark runner can
// map a seed function name to the exported symbol it must call in the emitted module.
export function toCamel(name: string): string {
  return name.replace(/[-_](.)/g, (_, c: string) => c.toUpperCase())
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

function collectAssigned(statements: Array<Statement>, into: Set<string>): void {
  for (const statement of statements) {
    switch (statement.form) {
      case 'assign':
        if (statement.target.form === 'variable') into.add(statement.target.name)
        break
      case 'while':
        collectAssigned(statement.body, into)
        break
      case 'for-each':
        collectAssigned(statement.body, into)
        break
      case 'match':
        for (const branch of statement.cases) collectAssigned(branch.body, into)
        if (statement.otherwise) collectAssigned(statement.otherwise, into)
        break
      case 'if':
        for (const branch of statement.branches) collectAssigned(branch.body, into)
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
        return `${expression(node.target)}.${toCamel(node.name)}`
      case 'await':
        return `await ${expression(node.expr)}`
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
  // native module bindings (`dock load`) become host imports at the top
  const imports = program
    .filter((node): node is Extract<typeof node, { form: 'native' }> => node.form === 'native')
    .map((node) => `import * as ${toCamel(node.alias)} from "${node.module}"`)
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
