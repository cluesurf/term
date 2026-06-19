// The code mill: recognizes tree groups by their head keyword (the mine) and mints compile-AST records (the
// mint). Organized as a registry of per-keyword mills, mirroring deck/seed/deck/term.tree/code. Each record
// carries a source span. Unresolved names are left as `variable` nodes for the resolver to bind or turn into
// holes. See note/research/vibe/computation/plans/03-build-mill.md and 11-elaboration.md.

import type { Diagnostic, Span } from '@/code/parser/diagnostic'
import { diagnose } from '@/code/parser/diagnostic'
import type { GroupNode, NameNode, Node, RootNode } from '@/code/parser/tree'
import type { BinaryOp, Expression, Program, Proof, Statement, Type } from '@/code/compile/node'
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

// parse a node of an explicit proof tree: head word, an optional bare-word arg (the paired one-word name), and
// nested sub-proofs. Follows the two-words-per-line convention from libraries/06-hold.md.
function parseProof(node: GroupNode): Proof {
  const head = headName(node) ?? ''
  const parts = rest(node).filter((n): n is GroupNode => n.kind === 'group')
  let arg: string | undefined
  const children: Array<Proof> = []
  for (const part of parts) {
    if (arg === undefined && rest(part).length === 0) arg = headName(part)
    else children.push(parseProof(part))
  }
  const proof: Proof = { head, children, span: spanOf(node) }
  if (arg) proof.arg = arg
  return proof
}

// is this node `wait true` (the async marker)?
function isWaitTrue(node: Node): boolean {
  if (node.kind !== 'group' || headName(node) !== 'wait') return false
  const arg = node.nodes[1]
  return arg !== undefined && arg.kind === 'group' && headName(arg) === 'true'
}

// a `like <type>` node to a surface type
function parseType(node: Node): Type {
  if (node.kind !== 'group') return UNKNOWN
  const name = headName(node)
  if (!name) return UNKNOWN
  return TYPE_NAME[name] ?? { kind: 'named', name }
}

// the type written by a `like` group. Usually `like <name>`, but for a first-class function it is `like task` with
// `take` params and a `like` result as further children of the SAME like group (siblings of the `task` node).
function parseLikeType(likeGroup: GroupNode): Type {
  const children = rest(likeGroup)
  const first = children[0]
  if (first && first.kind === 'group' && headName(first) === 'task') {
    const params = children
      .filter((c): c is GroupNode => c.kind === 'group' && headName(c) === 'take')
      .map((take) => {
        const inner = rest(take).find((n): n is GroupNode => n.kind === 'group' && headName(n) === 'like')
        return inner ? parseLikeType(inner) : UNKNOWN
      })
    const resultLike = children.find((c): c is GroupNode => c.kind === 'group' && headName(c) === 'like')
    const result = resultLike ? parseLikeType(resultLike) : UNIT
    // effect annotations on the callback: `wait true` marks it async, `bust` marks it throwing
    const effects: Array<string> = []
    if (children.some(isWaitTrue)) effects.push('async')
    if (children.some((c) => c.kind === 'group' && headName(c) === 'bust')) effects.push('throw')
    const type: Type = { kind: 'function', params, result }
    if (effects.length > 0) type.effects = effects
    return type
  }
  return first ? parseType(first) : UNKNOWN
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
    case 'name':
    case 'text': {
      const chunk = node.parts.find((p) => p.kind === 'chunk')
      return chunk && chunk.kind === 'chunk' ? chunk.token.span : ZERO_SPAN
    }
    case 'chunk':
      return node.token.span
    case 'group': {
      const head = node.nodes[0]
      if (!head) return ZERO_SPAN
      // span the whole construct, head through the last child, so diagnostics underline the full term and
      // source-slice autofixes (the linter) capture the exact surface syntax, not just the head keyword.
      const last = node.nodes[node.nodes.length - 1]!
      return { start: spanOf(head).start, end: spanOf(last).end }
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
      case 'term': {
        // an atom / symbol literal: `term infinity` is the symbol "infinity" (represented as a string)
        const atom = args[0] && args[0].kind === 'group' ? headName(args[0] as GroupNode) : undefined
        return { form: 'string', value: atom ?? '', span }
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
    // `wait true` marks the call to be awaited; it is not an argument
    const awaited = parts.slice(1).some(isWaitTrue)
    const callArgs = parts.slice(1).filter((a) => !isWaitTrue(a)).map((a) => toExpression(a, scope))

    let result: Expression
    if (calleeName && calleeName in BINARY_BUILTIN && callArgs.length === 2) {
      result = { form: 'binary', op: BINARY_BUILTIN[calleeName]!, left: callArgs[0]!, right: callArgs[1]!, span }
    } else if (calleeName === 'decrement' && callArgs.length === 1) {
      result = { form: 'binary', op: '-', left: callArgs[0]!, right: { form: 'integer', value: 1, span }, span }
    } else if (calleeName === 'increment' && callArgs.length === 1) {
      result = { form: 'binary', op: '+', left: callArgs[0]!, right: { form: 'integer', value: 1, span }, span }
    } else {
      // a slashed callee (`fs/read-file`) is a member path: the native-module FFI or a qualified function
      const callee: Expression = calleeName && calleeName.includes('/') ? pathExpression(calleeName, span) : { form: 'variable', name: calleeName ?? '', span }
      result = { form: 'call', callee, args: callArgs, span }
    }
    return awaited ? { form: 'await', expr: result, span } : result
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
        case 'head':
        case 'wear':
        case 'wait':
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
        case 'hold': {
          const parts = rest(node)
          // optional inline name (`hold <name>`): a bare word with siblings after it makes the hold a citable lemma
          let nameValue: string | undefined
          let propIndex = 0
          const first = parts[0]
          if (parts.length > 1 && first && first.kind === 'group' && rest(first).length === 0) {
            nameValue = headName(first)
            propIndex = 1
          }
          const condition = parts[propIndex]
          if (condition) {
            const proof = parts
              .slice(propIndex + 1)
              .filter((n): n is GroupNode => n.kind === 'group')
              .map(parseProof)
            const holdStatement: Statement = { form: 'hold', expr: toExpression(condition, scope), span }
            if (nameValue) holdStatement.name = nameValue
            if (proof.length > 0) holdStatement.proof = proof
            out.push(holdStatement)
          }
          break
        }
        case 'bust': {
          const valueNode = rest(node)[0]
          out.push({ form: 'throw', value: valueNode ? toExpression(valueNode, scope) : { form: 'unit', span }, span })
          break
        }
        case 'send': {
          // `send back, X` parses as send > [back, X], so the value is send's second child
          const backGroup = rest(node)[0]
          if (backGroup && backGroup.kind === 'group' && headName(backGroup) === 'back') {
            const value = rest(node)[1]
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
          const parts = rest(node)
          const variant = parts[0] && parts[0].kind === 'group' ? headName(parts[0]) : undefined
          if (variant === 'case') {
            // `fork case, <subject>` with `case <label>` arms: a pattern match on an enum
            const subject: Expression = parts[1] ? toExpression(parts[1], scope) : { form: 'unit', span }
            const cases: Array<{ label: string; body: Array<Statement> }> = []
            let otherwise: Array<Statement> | undefined
            for (const arm of parts.slice(2)) {
              if (arm.kind !== 'group' || headName(arm) !== 'case') continue
              const labelGroup = rest(arm)[0]
              const label = labelGroup && labelGroup.kind === 'group' ? headName(labelGroup) : undefined
              if (label === 'else') otherwise = toStatements(rest(arm).slice(1), scope)
              else if (label) cases.push({ label, body: toStatements(rest(arm).slice(1), scope) })
            }
            out.push({ form: 'match', subject, cases, otherwise, span })
            break
          }
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
    // generic type parameters: `head t` or `head t, need <mask>`
    const generics: Array<{ name: string; need?: string }> = []
    for (const statement of body) {
      if (statement.kind === 'group' && headName(statement) === 'head') {
        const inner = rest(statement)
        const gName = inner[0] && inner[0].kind === 'group' ? headName(inner[0]) : undefined
        if (!gName) continue
        const needGroup = inner.find((n): n is GroupNode => n.kind === 'group' && headName(n) === 'need')
        const need = needGroup ? (rest(needGroup)[0] && rest(needGroup)[0]!.kind === 'group' ? headName(rest(needGroup)[0] as GroupNode) : undefined) : undefined
        generics.push(need ? { name: gName, need } : { name: gName })
      }
    }
    const params: Array<{ name: string; type?: Type; refine?: 'natural' }> = []
    for (const statement of body) {
      if (statement.kind === 'group' && headName(statement) === 'take') {
        const varGroup = rest(statement)[0]
        const paramName = varGroup && varGroup.kind === 'group' ? headName(varGroup) : undefined
        if (!paramName) continue
        const likeGroup = rest(statement).find((n): n is GroupNode => n.kind === 'group' && headName(n) === 'like')
        const typeNode = likeGroup ? rest(likeGroup)[0] : undefined
        // honor the declared type (a first-class task type is parsed structurally), and detect a natural refinement
        const type = likeGroup ? parseLikeType(likeGroup) : undefined
        const refine = typeNode && typeNode.kind === 'group' && headName(typeNode) === 'natural-number' ? 'natural' : undefined
        const param: { name: string; type?: Type; refine?: 'natural' } = { name: paramName }
        if (type) param.type = type
        if (refine) param.refine = refine
        params.push(param)
      }
    }
    // the function's return type: a bare `like <type>` statement in the body
    const resultLike = body.find((n): n is GroupNode => n.kind === 'group' && headName(n) === 'like')
    const resultType = resultLike ? parseLikeType(resultLike) : undefined
    const scope = new Set<string>(params.map((p) => p.name))
    // signature nodes describe the task; they are not executable body statements. `head` (generics), `take` (params),
    // the bare `like` (result type), `mark` (modifiers like `mark async`/`mark private`), and `note` (documentation)
    // are all consumed here, so only real statements (send back, save, call, fork, ...) reach the body.
    const SIGNATURE = new Set(['head', 'take', 'like', 'mark', 'note'])
    const executable = body.filter((n) => !(n.kind === 'group' && SIGNATURE.has(headName(n) ?? '')))
    const fn: Statement = { form: 'function', name, params, body: toStatements(executable, scope), generics, span }
    if (resultType) fn.result = resultType
    // async is marked by `wait true` or `mark async`
    const markedAsync = body.some((n) => n.kind === 'group' && headName(n) === 'mark' && rest(n)[0]?.kind === 'group' && headName(rest(n)[0] as GroupNode) === 'async')
    if (markedAsync || body.some(isWaitTrue)) fn.async = true
    return fn
  }

  // a mask defines a trait: the names of the method signatures it declares
  function methodNames(group: GroupNode): Array<string> {
    const names: Array<string> = []
    for (const child of rest(group)) {
      if (child.kind === 'group' && headName(child) === 'task') {
        const nameGroup = rest(child)[0]
        const m = nameGroup && nameGroup.kind === 'group' ? headName(nameGroup) : undefined
        if (m) names.push(m)
      }
    }
    return names
  }

  function buildMask(group: GroupNode): Statement | undefined {
    const nameGroup = rest(group)[0]
    const name = nameGroup && nameGroup.kind === 'group' ? headName(nameGroup) : undefined
    if (!name) {
      fail(group, 'mask needs a name')
      return undefined
    }
    return { form: 'mask', name, methods: methodNames(group), span: spanOf(group) }
  }

  // extract trait instances from `wear <mask>` children, implemented for `target`
  function wearInstances(group: GroupNode, target: string): Array<Statement> {
    const out: Array<Statement> = []
    for (const child of rest(group)) {
      if (child.kind !== 'group' || headName(child) !== 'wear') continue
      const maskGroup = rest(child)[0]
      const mask = maskGroup && maskGroup.kind === 'group' ? headName(maskGroup) : undefined
      if (mask) out.push({ form: 'instance', mask, target, methods: methodNames(child), span: spanOf(child) })
    }
    return out
  }

  function buildSuit(group: GroupNode): Array<Statement> {
    const targetGroup = rest(group)[0]
    const target = targetGroup && targetGroup.kind === 'group' ? headName(targetGroup) : undefined
    if (!target) {
      fail(group, 'suit needs a target form')
      return []
    }
    return wearInstances(group, target)
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
    const linkFields = (g: GroupNode): Array<{ name: string; type: Type }> => {
      const out: Array<{ name: string; type: Type }> = []
      for (const child of rest(g)) {
        if (child.kind !== 'group' || (headName(child) !== 'link' && headName(child) !== 'free')) continue
        const inner = rest(child)
        const fieldNode = inner[0]
        const fieldName = fieldNode && fieldNode.kind === 'group' ? headName(fieldNode) : undefined
        const likeGroup = inner[1]
        let type: Type = UNKNOWN
        if (likeGroup && likeGroup.kind === 'group' && headName(likeGroup) === 'like') {
          const typeNode = rest(likeGroup)[0]
          type = typeNode ? parseType(typeNode) : UNKNOWN
        }
        if (fieldName) out.push({ name: fieldName, type })
      }
      return out
    }

    const fields = linkFields(group)
    // enum variants: `case <name>` children, each with its own fields
    const variants: Array<{ name: string; fields: Array<{ name: string; type: Type }> }> = []
    for (const child of parts.slice(1)) {
      if (child.kind !== 'group' || headName(child) !== 'case') continue
      const vNameGroup = rest(child)[0]
      const vName = vNameGroup && vNameGroup.kind === 'group' ? headName(vNameGroup) : undefined
      if (vName) variants.push({ name: vName, fields: linkFields(child) })
    }
    // `head <name>` children are the form's generic parameters (e.g. `form maybe / head t`)
    const params: Array<string> = []
    for (const child of parts.slice(1)) {
      if (child.kind !== 'group' || headName(child) !== 'head') continue
      const gNameGroup = rest(child)[0]
      const gName = gNameGroup && gNameGroup.kind === 'group' ? headName(gNameGroup) : undefined
      if (gName) params.push(gName)
    }
    return { form: 'record-type', name, params, fields, variants, span }
  }

  // a form's nested `task` children are methods: desugared to free functions over the form, with `self` typed as
  // the form (parameterized by the form's generics) and the form's generics in scope. `read(file)`, not file.read().
  // `selfOverride` types `self` as a primitive kind, for a primitive type's stdlib form (boolean, number, text).
  function formMethods(group: GroupNode, formName: string, formParams: Array<string>, selfOverride?: Type): Array<Statement> {
    const out: Array<Statement> = []
    const selfType: Type = selfOverride ?? { kind: 'named', name: formName, args: formParams.map((name) => ({ kind: 'named', name })) }
    for (const child of rest(group)) {
      if (child.kind !== 'group' || headName(child) !== 'task') continue
      const fn = buildFunction(child)
      if (!fn || fn.form !== 'function') continue
      fn.generics = [...formParams.map((name) => ({ name })), ...fn.generics]
      fn.params = fn.params.map((p) => (p.name === 'self' && !p.type ? { ...p, type: selfType } : p))
      // mangle the emitted name so two forms can both define `map`/`unwrap-or` without clashing across modules.
      // the bare method name stays in `method` for receiver dispatch (a `call <method> / <receiver>` resolves by
      // the receiver's form). See note/research/vibe/computation/plans on the module system.
      fn.method = { form: formName, name: fn.name }
      fn.name = `${formName}_${fn.name}`
      out.push(fn)
    }
    return out
  }

  // `dock load / load <node:fs/promises>, name fs` declares native module bindings (the FFI). Each becomes a
  // native-import statement the emitter turns into a host import; `call fs/read-file` then lowers natively.
  function buildDock(group: GroupNode): Array<Statement> {
    const out: Array<Statement> = []
    for (const child of rest(group)) {
      if (child.kind !== 'group' || headName(child) !== 'load') continue
      let module: string | undefined
      let alias: string | undefined
      for (const part of rest(child)) {
        if (part.kind === 'text') module = part.parts.map((p) => (p.kind === 'chunk' ? p.text : '')).join('')
        else if (part.kind === 'group' && headName(part) === 'name') {
          const a = rest(part)[0]
          alias = a && a.kind === 'group' ? headName(a) : undefined
        }
      }
      if (module && alias) out.push({ form: 'native', alias, module, span: spanOf(child) })
    }
    return out
  }

  const program: Program = []
  for (const group of tree.nodes) {
    const keyword = headName(group)
    if (keyword === 'task') {
      const fn = buildFunction(group)
      if (fn) program.push(fn)
    } else if (keyword === 'form') {
      const nameGroup = rest(group)[0]
      const formName = nameGroup && nameGroup.kind === 'group' ? headName(nameGroup) : undefined
      const primitive = formName ? TYPE_NAME[formName] : undefined
      if (formName && primitive) {
        // a primitive type's definition lives in the stdlib (boolean, number, text): the compiler uses its native
        // representation, so it does not register a record-type (avoiding a clash with the primitive), but it does
        // desugar the form's methods over the primitive kind.
        program.push(...formMethods(group, formName, [], primitive))
      } else if (formName === 'list') {
        // list is the native array: its methods are typed over array<t> (t = the form's element generic), and no
        // record-type is registered. Receiver dispatch routes `call size / <array>` to the list method.
        const rt = buildRecordType(group)
        const params = rt && rt.form === 'record-type' ? rt.params : []
        const element: Type = { kind: 'array', element: { kind: 'named', name: params[0] ?? 't' } }
        program.push(...formMethods(group, formName, params, element))
      } else {
        const rt = buildRecordType(group)
        if (rt) program.push(rt)
        // `wear <mask>` blocks inside the form are trait instances for it
        if (formName) program.push(...wearInstances(group, formName))
        if (formName && rt && rt.form === 'record-type') program.push(...formMethods(group, formName, rt.params))
      }
    } else if (keyword === 'mask') {
      const mask = buildMask(group)
      if (mask) program.push(mask)
    } else if (keyword === 'suit') {
      program.push(...buildSuit(group))
    } else if (keyword === 'dock') {
      program.push(...buildDock(group))
    } else if (keyword === 'load' || keyword === 'bear' || keyword === 'deck') {
      // module directives: resolved by the loader (code/compile/load.ts), not statements
    } else if (keyword === 'note') {
      // top-level documentation: not a statement
    } else {
      program.push(...toStatements([group], new Set<string>()))
    }
  }

  if (diagnostics.length) return { ok: false, diagnostics }
  return { ok: true, program }
}
