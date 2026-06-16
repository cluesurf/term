// The nice TypeScript emitter. Compile AST to clean, idiomatic, native TypeScript: real names (kebab to camel),
// native control flow, plain operators, native arithmetic, types from the checker, no runtime imports. Pure and
// browser-safe: returns a string. See note/research/vibe/computation/plans/07-codegen.md.

import type { BinaryOp, Expression, Program, Statement, Type } from '@/code/compile/node'

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

function toCamel(name: string): string {
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
    case 'named':
      return toPascal(type.name)
    case 'function':
      return `(${type.params.map((p, i) => `a${i}: ${tsType(p)}`).join(', ')}) => ${tsType(type.result)}`
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

function makeEmitter() {
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
      case 'record':
        return `{ ${node.fields.map((f) => `${f.name}: ${expression(f.value)}`).join(', ')} }`
      case 'member':
        return `${expression(node.target)}.${node.name}`
      case 'unary':
        return `${node.op}${expression(node.operand, 6)}`
      case 'binary': {
        const precedence = PRECEDENCE[node.op]
        const left = expression(node.left, precedence)
        const right = expression(node.right, precedence + 1)
        const text = `${left} ${node.op} ${right}`
        return precedence < parentPrecedence ? `(${text})` : text
      }
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
      case 'while':
        return `while (${expression(node.cond)}) ${block(node.body, depth)}`
      case 'for-each':
        return `for (const ${toCamel(node.item)} of ${expression(node.iterable)}) ${block(node.body, depth)}`
      case 'break':
        return 'break'
      case 'continue':
        return 'continue'
      case 'record-type': {
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
        const out = `function ${toCamel(node.name)}(${params}): ${tsType(node.result)} ${block(node.body, depth)}`
        assignedNames = previous
        return out
      }
    }
  }

  return { statement, expression }
}

export function emitTypeScript(program: Program): string {
  const emitter = makeEmitter()
  const lines = program.map((node) => {
    const text = emitter.statement(node, 0)
    return node.form === 'function' || node.form === 'record-type' ? `export ${text}` : text
  })
  return `${lines.join('\n\n')}\n`
}
