// The code mill: recognizes tree groups by their head keyword (the mine) and mints compile-AST records (the
// mint). Organized as a registry of per-keyword mills, mirroring deck/seed/deck/term.tree/code. Each record
// carries a source span. Unresolved names are left as `variable` nodes for the resolver to bind or turn into
// holes. See note/research/vibe/computation/plans/03-build-mill.md and 11-elaboration.md.

import type { Diagnostic, Span } from '@/code/parser/diagnostic'
import { diagnose } from '@/code/parser/diagnostic'
import type { GroupNode, NameNode, Node, RootNode } from '@/code/parser/tree'
import type { BinaryOp, Expression, Program, Statement, Type } from '@/code/compile/node'
import { BOOLEAN, NUMBER, STRING, UNIT, UNKNOWN } from '@/code/compile/node'

// like-type names to surface types
const TYPE_NAME: Record<string, Type> = {
  u8: NUMBER, u16: NUMBER, u32: NUMBER, u64: NUMBER,
  i8: NUMBER, i16: NUMBER, i32: NUMBER, i64: NUMBER,
  'natural-number': NUMBER, integer: NUMBER, number: NUMBER, decimal: NUMBER,
  text: STRING, boolean: BOOLEAN, void: UNIT, unit: UNIT,
}

// a path string like `item/x` to a variable plus member chain
function pathExpression(raw: string, span: Span): Expression {
  const parts = raw.split('/').filter((p) => p.length > 0)
  let expr: Expression = { form: 'variable', name: parts[0] ?? '', span }
  for (let i = 1; i < parts.length; i++) expr = { form: 'member', target: expr, name: parts[i]!, span }
  return expr
}

// a `like <type>` node to a surface type
function parseType(node: Node): Type {
  if (node.kind !== 'group') return UNKNOWN
  const name = headName(node)
  if (!name) return UNKNOWN
  return TYPE_NAME[name] ?? { kind: 'named', name }
}

const BINARY_BUILTIN: Record<string, BinaryOp> = {
  add: '+',
  subtract: '-',
  multiply: '*',
  divide: '/',
  modulo: '%',
  'is-above': '>',
  'is-below': '<',
  'is-equal': '==',
  'is-unequal': '!=',
  'is-minimum': '>=',
  'is-maximum': '<=',
  and: '&&',
  or: '||',
}

export type MillResult =
  | { ok: true; program: Program }
  | { ok: false; diagnostics: Array<Diagnostic> }

const ZERO_SPAN: Span = { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } }

function nameText(name: NameNode): string {
  return name.parts.map((part) => (part.kind === 'chunk' ? part.text : '')).join('')
}

function headName(group: GroupNode): string | undefined {
  const first = group.nodes[0]
  return first && first.kind === 'name' ? nameText(first) : undefined
}

function rest(group: GroupNode): Array<Node> {
  return group.nodes.slice(1)
}

// the source span of any node
function spanOf(node: Node): Span {
  switch (node.kind) {
    case 'integer':
    case 'decimal':
    case 'radix':
      return node.token.span
    case 'name': {
      const first = node.parts[0]
      return first && first.kind === 'chunk' ? first.token.span : ZERO_SPAN
    }
    case 'group': {
      const head = node.nodes[0]
      return head ? spanOf(head) : ZERO_SPAN
    }
    default:
      return ZERO_SPAN
  }
}

export function mill(tree: RootNode, file: string): MillResult {
  const diagnostics: Array<Diagnostic> = []

  function fail(node: Node, message: string) {
    diagnostics.push(diagnose('unexpected-node', { file, span: spanOf(node), message }))
  }

  // mine: resolve a node to an expression
  function toExpression(node: Node, scope: Set<string>): Expression {
    const span = spanOf(node)
    switch (node.kind) {
      case 'integer':
        return { form: 'integer', value: node.value, span }
      case 'decimal':
        return { form: 'float', value: node.value, span }
      case 'radix':
        return { form: 'integer', value: node.value, span }
      case 'text':
        return { form: 'string', value: node.parts.map((p) => (p.kind === 'chunk' ? p.text : '')).join(''), span }
      case 'group':
        return groupExpression(node, scope)
      default:
        fail(node, 'this is not a valid expression')
        return { form: 'unit', span }
    }
  }

  function groupExpression(group: GroupNode, scope: Set<string>): Expression {
    const keyword = headName(group)
    const args = rest(group)
    const span = spanOf(group)

    switch (keyword) {
      case 'mark':
        return args[0] ? toExpression(args[0], scope) : { form: 'integer', value: 0, span }
      case 'text': {
        const value = args[0]
        if (value && value.kind === 'text') return toExpression(value, scope)
        if (value && value.kind === 'integer') return { form: 'string', value: String(value.value), span }
        return { form: 'string', value: '', span }
      }
      case 'loan':
      case 'move':
      case 'read': {
        const target = args[0]
        const name = target && target.kind === 'group' ? headName(target) : undefined
        return pathExpression(name ?? '', span)
      }
      case 'wave': {
        const value = args[0]
        const flag = value && value.kind === 'group' ? headName(value) : undefined
        return { form: 'boolean', value: flag === 'true', span }
      }
      case 'make':
        return makeExpression(group, scope)
      case 'call':
        return callExpression(group, scope)
      case 'bind': {
        const value = args[1]
        return value ? toExpression(value, scope) : { form: 'unit', span }
      }
      default: {
        if (keyword !== undefined && args.length === 0) return { form: 'variable', name: keyword, span }
        if (keyword !== undefined) {
          return { form: 'call', callee: { form: 'variable', name: keyword, span }, args: args.map((a) => toExpression(a, scope)), span }
        }
        fail(group, 'this is not a valid expression')
        return { form: 'unit', span }
      }
    }
  }

  function callExpression(group: GroupNode, scope: Set<string>): Expression {
    const parts = rest(group)
    const target = parts[0]
    const calleeName = target && target.kind === 'group' ? headName(target) : undefined
    const span = spanOf(group)
    const callArgs = parts.slice(1).map((a) => toExpression(a, scope))

    if (calleeName && calleeName in BINARY_BUILTIN && callArgs.length === 2) {
      return { form: 'binary', op: BINARY_BUILTIN[calleeName]!, left: callArgs[0]!, right: callArgs[1]!, span }
    }
    if (calleeName === 'decrement' && callArgs.length === 1) {
      return { form: 'binary', op: '-', left: callArgs[0]!, right: { form: 'integer', value: 1, span }, span }
    }
    if (calleeName === 'increment' && callArgs.length === 1) {
      return { form: 'binary', op: '+', left: callArgs[0]!, right: { form: 'integer', value: 1, span }, span }
    }
    return { form: 'call', callee: { form: 'variable', name: calleeName ?? '', span }, args: callArgs, span }
  }

  // make list / make find / make <form>
  function makeExpression(group: GroupNode, scope: Set<string>): Expression {
    const parts = rest(group)
    const kindNode = parts[0]
    const kind = kindNode && kindNode.kind === 'group' ? headName(kindNode) : undefined
    const span = spanOf(group)
    const items = parts.slice(1)

    if (kind === 'list') {
      return { form: 'array', items: items.map((it) => itemValue(it, scope)), span }
    }
    if (kind === 'find') {
      const entries = items
        .filter((it): it is GroupNode => it.kind === 'group' && headName(it) === 'save')
        .map((it) => {
          const inner = rest(it)
          const keyNode = inner[0]
          const key = keyNode && keyNode.kind === 'group' ? headName(keyNode) : ''
          const valueNode = inner[1]
          return {
            key: { form: 'string', value: key ?? '', span } as Expression,
            value: valueNode ? toExpression(valueNode, scope) : ({ form: 'unit', span } as Expression),
          }
        })
      return { form: 'map', entries, span }
    }
    // make <form>: a record from bind fields
    const fields = items
      .filter((it): it is GroupNode => it.kind === 'group' && headName(it) === 'bind')
      .map((it) => {
        const inner = rest(it)
        const fieldNode = inner[0]
        const fieldName = fieldNode && fieldNode.kind === 'group' ? headName(fieldNode) : ''
        const valueNode = inner[1]
        return {
          name: fieldName ?? '',
          value: valueNode ? toExpression(valueNode, scope) : ({ form: 'unit', span } as Expression),
        }
      })
    return { form: 'record', name: kind ?? '', fields, span }
  }

  // a collection item: either a bare value or a `save item, <value>` wrapper
  function itemValue(node: Node, scope: Set<string>): Expression {
    if (node.kind === 'group' && headName(node) === 'save') {
      const inner = rest(node)
      const valueNode = inner[1] ?? inner[0]
      return valueNode ? toExpression(valueNode, scope) : { form: 'unit', span: spanOf(node) }
    }
    return toExpression(node, scope)
  }

  // collect hook bodies (hook test, hook hold, hook miss, hook step)
  function hooks(group: GroupNode): Map<string, Array<Node>> {
    const map = new Map<string, Array<Node>>()
    for (const child of rest(group)) {
      if (child.kind !== 'group' || headName(child) !== 'hook') continue
      const inner = rest(child)
      const variant = inner[0]
      const hookName = variant && variant.kind === 'group' ? headName(variant) : undefined
      if (hookName) map.set(hookName, inner.slice(1))
    }
    return map
  }

  // mint: build statements from a list of groups
  function toStatements(nodes: Array<Node>, scope: Set<string>): Array<Statement> {
    const out: Array<Statement> = []
    for (const node of nodes) {
      if (node.kind !== 'group') {
        out.push({ form: 'expression', expr: toExpression(node, scope), span: spanOf(node) })
        continue
      }
      const span = spanOf(node)
      const keyword = headName(node)
      switch (keyword) {
        case 'take':
        case 'like':
        case 'flex':
          break
        case 'save': {
          const args = rest(node).filter((a) => !(a.kind === 'group' && headName(a) === 'flex'))
          const target = args[0]
          const name = target && target.kind === 'group' ? headName(target) : undefined
          if (!name) {
            fail(node, 'save needs a name')
            break
          }
          const valueNode = args[1]
          const value: Expression = valueNode ? toExpression(valueNode, scope) : { form: 'integer', value: 0, span }
          if (scope.has(name)) {
            out.push({ form: 'assign', target: { form: 'variable', name, span }, op: '=', value, span })
          } else {
            scope.add(name)
            out.push({ form: 'let', name, init: value, mutable: true, span })
          }
          break
        }
        case 'back': {
          const value = rest(node)[0]
          out.push({ form: 'return', value: value ? toExpression(value, scope) : undefined, span })
          break
        }
        case 'send': {
          const backGroup = rest(node)[0]
          if (backGroup && backGroup.kind === 'group' && headName(backGroup) === 'back') {
            const value = rest(backGroup)[0]
            out.push({ form: 'return', value: value ? toExpression(value, scope) : undefined, span })
          } else {
            fail(node, 'send must be followed by back')
          }
          break
        }
        case 'host': {
          const hostArgs = rest(node).filter((a) => !(a.kind === 'group' && headName(a) === 'flex'))
          const target = hostArgs[0]
          const name = target && target.kind === 'group' ? headName(target) : undefined
          if (!name) {
            fail(node, 'host needs a name')
            break
          }
          const valueNode = hostArgs[1]
          const value: Expression = valueNode ? toExpression(valueNode, scope) : { form: 'unit', span }
          scope.add(name)
          out.push({ form: 'let', name, init: value, mutable: false, span })
          break
        }
        case 'turn':
          out.push({ form: 'continue', span })
          break
        case 'halt':
          out.push({ form: 'break', span })
          break
        case 'walk': {
          const parts = rest(node)
          const variant = parts[0] && parts[0].kind === 'group' ? headName(parts[0]) : undefined
          if (variant === 'list') {
            const iterable: Expression = parts[1] ? toExpression(parts[1], scope) : { form: 'unit', span }
            const nextBody = hooks(node).get('next') ?? []
            let item = 'item'
            let bodyNodes = nextBody
            const first = nextBody[0]
            if (first && first.kind === 'group' && headName(first) === 'take') {
              const nameGroup = rest(first)[1]
              if (nameGroup && nameGroup.kind === 'group' && headName(nameGroup) === 'name') {
                const itemGroup = rest(nameGroup)[0]
                if (itemGroup && itemGroup.kind === 'group') item = headName(itemGroup) ?? 'item'
              }
              bodyNodes = nextBody.slice(1)
            }
            scope.add(item)
            out.push({ form: 'for-each', item, iterable, body: toStatements(bodyNodes, scope), span })
            break
          }
          const hookMap = hooks(node)
          const condNodes = hookMap.get('test')
          const bodyNodes = hookMap.get('step') ?? hookMap.get('tick') ?? hookMap.get('hold') ?? []
          const cond: Expression = condNodes && condNodes[0] ? toExpression(condNodes[0], scope) : { form: 'boolean', value: false, span }
          out.push({ form: 'while', cond, body: toStatements(bodyNodes, scope), span })
          break
        }
        case 'fork': {
          const hookMap = hooks(node)
          const condNodes = hookMap.get('test')
          const cond: Expression = condNodes && condNodes[0] ? toExpression(condNodes[0], scope) : { form: 'boolean', value: false, span }
          const thenNodes = hookMap.get('hold') ?? []
          const elseNodes = hookMap.get('miss')
          out.push({
            form: 'if',
            branches: [{ cond, body: toStatements(thenNodes, scope) }],
            otherwise: elseNodes ? toStatements(elseNodes, scope) : undefined,
            span,
          })
          break
        }
        default:
          out.push({ form: 'expression', expr: toExpression(node, scope), span })
      }
    }
    return out
  }

  function buildFunction(group: GroupNode): Statement | undefined {
    const parts = rest(group)
    const nameGroup = parts[0]
    const name = nameGroup && nameGroup.kind === 'group' ? headName(nameGroup) : undefined
    const span = spanOf(group)
    if (!name) {
      fail(group, 'task needs a name')
      return undefined
    }
    const body = parts.slice(1)
    const params: Array<{ name: string }> = []
    for (const statement of body) {
      if (statement.kind === 'group' && headName(statement) === 'take') {
        const varGroup = rest(statement)[0]
        const paramName = varGroup && varGroup.kind === 'group' ? headName(varGroup) : undefined
        if (paramName) params.push({ name: paramName })
      }
    }
    const scope = new Set<string>(params.map((p) => p.name))
    return { form: 'function', name, params, body: toStatements(body, scope), span }
  }

  function buildRecordType(group: GroupNode): Statement | undefined {
    const parts = rest(group)
    const nameGroup = parts[0]
    const name = nameGroup && nameGroup.kind === 'group' ? headName(nameGroup) : undefined
    const span = spanOf(group)
    if (!name) {
      fail(group, 'form needs a name')
      return undefined
    }
    const fields: Array<{ name: string; type: Type }> = []
    for (const child of parts.slice(1)) {
      if (child.kind !== 'group' || headName(child) !== 'link') continue
      const inner = rest(child)
      const fieldNode = inner[0]
      const fieldName = fieldNode && fieldNode.kind === 'group' ? headName(fieldNode) : undefined
      const likeGroup = inner[1]
      let type: Type = UNKNOWN
      if (likeGroup && likeGroup.kind === 'group' && headName(likeGroup) === 'like') {
        const typeNode = rest(likeGroup)[0]
        type = typeNode ? parseType(typeNode) : UNKNOWN
      }
      if (fieldName) fields.push({ name: fieldName, type })
    }
    return { form: 'record-type', name, params: [], fields, span }
  }

  const program: Program = []
  for (const group of tree.nodes) {
    const keyword = headName(group)
    if (keyword === 'task') {
      const fn = buildFunction(group)
      if (fn) program.push(fn)
    } else if (keyword === 'form') {
      const rt = buildRecordType(group)
      if (rt) program.push(rt)
    } else {
      program.push(...toStatements([group], new Set<string>()))
    }
  }

  if (diagnostics.length) return { ok: false, diagnostics }
  return { ok: true, program }
}
