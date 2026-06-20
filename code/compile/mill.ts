// The code mill: recognizes tree groups by their head keyword (the mine) and mints compile-AST records (the
// mint). Organized as a registry of per-keyword mills, mirroring deck/seed/deck/term.tree/code. Each record
// carries a source span. Unresolved names are left as `variable` nodes for the resolver to bind or turn into
// holes. See note/research/vibe/computation/plans/03-build-mill.md and 11-elaboration.md.

import type { Diagnostic, Span } from '@/code/parser/diagnostic'
import { diagnose } from '@/code/parser/diagnostic'
import type {
  GroupNode,
  NameNode,
  Node,
  RootNode,
} from '@/code/parser/tree'
import type {
  BinaryOp,
  DockArgument,
  DockCall,
  DockMethod,
  DockRoute,
  DockTake,
  Expression,
  Program,
  Proof,
  Statement,
  Type,
  ZoneAttribute,
  ZoneNode,
} from '@/code/compile/node'
import {
  BOOLEAN,
  BYTES,
  DYNAMIC,
  FLOAT,
  NUMBER,
  STRING,
  UNIT,
  UNKNOWN,
} from '@/code/compile/node'

// like-type names to surface types
const TYPE_NAME: Record<string, Type> = {
  u8: NUMBER,
  u16: NUMBER,
  u32: NUMBER,
  u64: NUMBER,
  i8: NUMBER,
  i16: NUMBER,
  i32: NUMBER,
  i64: NUMBER,
  'natural-number': NUMBER,
  integer: NUMBER,
  number: NUMBER,
  // floating point: `decimal` / `float` and the sized floats are the distinct float type
  decimal: FLOAT,
  float: FLOAT,
  f32: FLOAT,
  f64: FLOAT,
  // the host's dynamic value (the opaque result of json parse)
  dynamic: DYNAMIC,
  json: DYNAMIC,
  // a raw byte buffer (Uint8Array / Vec<u8> / Data / ByteArray), the zero-copy currency for crypto and IO
  bytes: BYTES,
  'byte-array': BYTES,
  buffer: BYTES,
  text: STRING,
  boolean: BOOLEAN,
  void: UNIT,
  unit: UNIT,
  // bind's native primitives ARE seed's primitives (a JS string is seed's `string`, etc.): map them to the same
  // surface type so a seed value passes to a bind method param and vice versa, with no subtyping needed.
  'native-string': STRING,
  'native-number': NUMBER,
  'native-boolean': BOOLEAN,
  'native-bigint': NUMBER,
  'native-void': UNIT,
  'native-null': UNIT,
  'native-undefined': UNIT,
  // `any` is the gradual type: consistent with everything (an opaque bind type, a callback union, etc.)
  any: UNKNOWN,
}

// signature annotation keywords that decorate a `host`/`save` declaration rather than supplying its value:
// `name <X>` (foreign / display name), `like <T>` (type), `flex` (variadic), `rank` (receiver type), plus the
// generic / output markers. Filtered out so an annotation is never mistaken for the assigned value expression.
// `mark` is deliberately absent: it is the integer-literal keyword (`mark 42`), so `save total, mark 0` assigns 0.
const HOST_ANNOTATION = new Set([
  'name',
  'like',
  'flex',
  'rank',
  'head',
  'note',
  'free',
])

// a path string like `item/x` to a variable plus member chain
function pathExpression(raw: string, span: Span): Expression {
  const parts = raw.split('/').filter(p => p.length > 0)
  let expr: Expression = {
    form: 'variable',
    name: parts[0] ?? '',
    span,
  }
  for (let i = 1; i < parts.length; i++)
    expr = { form: 'member', target: expr, name: parts[i]!, span }
  return expr
}

// parse a node of an explicit proof tree: head word, an optional bare-word arg (the paired one-word name), and
// nested sub-proofs. Follows the two-words-per-line convention from libraries/06-hold.md.
function parseProof(node: GroupNode): Proof {
  const head = headName(node) ?? ''
  const parts = rest(node).filter(
    (n): n is GroupNode => n.kind === 'group',
  )
  let arg: string | undefined
  const children: Array<Proof> = []
  for (const part of parts) {
    if (arg === undefined && rest(part).length === 0)
      arg = headName(part)
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
  return (
    arg !== undefined &&
    arg.kind === 'group' &&
    headName(arg) === 'true'
  )
}

// is this node an annotation `note <name>` (or the retired `mark <name>`)? Tags / markers like `note async`,
// `note private`, `note stable` are written under `note`; `mark` is the old spelling kept working during migration.
function isAnnotation(node: Node, name: string): boolean {
  if (node.kind !== 'group') return false
  const head = headName(node)
  if (head !== 'note' && head !== 'mark') return false
  const arg = rest(node)[0]
  return arg?.kind === 'group' && headName(arg) === name
}

// a `like <type>` node to a surface type
function parseType(node: Node): Type {
  if (node.kind !== 'group') return UNKNOWN
  const name = headName(node)
  if (!name) return UNKNOWN
  // `list` is the native array; an inner `like <t>` gives the element type, else it is unconstrained
  if (name === 'list') {
    const elementLike = rest(node).find(
      (n): n is GroupNode =>
        n.kind === 'group' && headName(n) === 'like',
    )
    return {
      kind: 'array',
      element: elementLike ? parseLikeType(elementLike) : UNKNOWN,
    }
  }
  // `hash` is the native map; optional inner `like <k>` / `like <v>` give the key / value types
  if (name === 'hash') {
    const likes = rest(node).filter(
      (n): n is GroupNode =>
        n.kind === 'group' && headName(n) === 'like',
    )
    return {
      kind: 'map',
      key: likes[0] ? parseLikeType(likes[0]) : UNKNOWN,
      value: likes[1] ? parseLikeType(likes[1]) : UNKNOWN,
    }
  }
  return TYPE_NAME[name] ?? { kind: 'named', name }
}

// the type written by a `like` group. Usually `like <name>`, but for a first-class function it is `like task` with
// `take` params and a `like` result as further children of the SAME like group (siblings of the `task` node).
function parseLikeType(likeGroup: GroupNode): Type {
  const children = rest(likeGroup)
  const first = children[0]
  if (first && first.kind === 'group' && headName(first) === 'task') {
    const params = children
      .filter(
        (c): c is GroupNode =>
          c.kind === 'group' && headName(c) === 'take',
      )
      .map(take => {
        const inner = rest(take).find(
          (n): n is GroupNode =>
            n.kind === 'group' && headName(n) === 'like',
        )
        return inner ? parseLikeType(inner) : UNKNOWN
      })
    const resultLike = children.find(
      (c): c is GroupNode =>
        c.kind === 'group' && headName(c) === 'like',
    )
    const result = resultLike ? parseLikeType(resultLike) : UNIT
    // effect annotations on the callback: `wait true` marks it async, `bust` marks it throwing
    const effects: Array<string> = []
    if (children.some(isWaitTrue)) effects.push('async')
    if (
      children.some(c => c.kind === 'group' && headName(c) === 'bust')
    )
      effects.push('throw')
    const type: Type = { kind: 'function', params, result }
    if (effects.length > 0) type.effects = effects
    return type
  }
  // `like list` (with an optional inner `like <t>` for the element) is the native array
  if (first && first.kind === 'group' && headName(first) === 'list') {
    const elementLike =
      children
        .slice(1)
        .find(
          (c): c is GroupNode =>
            c.kind === 'group' && headName(c) === 'like',
        ) ??
      rest(first).find(
        (n): n is GroupNode =>
          n.kind === 'group' && headName(n) === 'like',
      )
    return {
      kind: 'array',
      element: elementLike ? parseLikeType(elementLike) : UNKNOWN,
    }
  }
  // `like hash` (with optional `like <k>` / `like <v>` siblings) is the native map
  if (first && first.kind === 'group' && headName(first) === 'hash') {
    const likes = children
      .slice(1)
      .filter(
        (c): c is GroupNode =>
          c.kind === 'group' && headName(c) === 'like',
      )
    return {
      kind: 'map',
      key: likes[0] ? parseLikeType(likes[0]) : UNKNOWN,
      value: likes[1] ? parseLikeType(likes[1]) : UNKNOWN,
    }
  }
  // a parameterized named type: `like maybe / like t` -> maybe<t>, `like result / like ok / like err` -> result<ok, err>.
  // The type arguments are the sibling `like` children of the SAME like group.
  if (first && first.kind === 'group') {
    const base = parseType(first)
    if (base.kind === 'named') {
      const args = children
        .slice(1)
        .filter(
          (c): c is GroupNode =>
            c.kind === 'group' && headName(c) === 'like',
        )
        .map(parseLikeType)
      if (args.length > 0)
        return { kind: 'named', name: base.name, args }
    }
    return base
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

const ZERO_SPAN: Span = {
  start: { line: 0, column: 0 },
  end: { line: 0, column: 0 },
}

function nameText(name: NameNode): string {
  return name.parts
    .map(part => (part.kind === 'chunk' ? part.text : ''))
    .join('')
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
      const chunk = node.parts.find(p => p.kind === 'chunk')
      return chunk && chunk.kind === 'chunk'
        ? chunk.token.span
        : ZERO_SPAN
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
    diagnostics.push(
      diagnose('unexpected-node', {
        file,
        span: spanOf(node),
        message,
      }),
    )
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
        return {
          form: 'string',
          // unescape the literal's escape sequences (`\<` `\>` `\{` `\}`): the lexer keeps the backslash in the chunk so
          // the bracket is content, not a delimiter; the semantic string is the unescaped form. This lets a native bind
          // expression carry an arrow (`=>` / `->`) or a stray `>` as `\>` without closing the `text <...>` literal.
          value: node.parts
            .map(p => (p.kind === 'chunk' ? p.text : ''))
            .join('')
            .replace(/\\([<>{}])/g, '$1'),
          span,
        }
      case 'group':
        return groupExpression(node, scope)
      default:
        fail(node, 'this is not a valid expression')
        return { form: 'unit', span }
    }
  }

  function groupExpression(
    group: GroupNode,
    scope: Set<string>,
  ): Expression {
    const keyword = headName(group)
    const args = rest(group)
    const span = spanOf(group)

    switch (keyword) {
      // `code` is the literal keyword (`code 1`, hex `code 0xaa12`); `mark` is the retired spelling kept working for
      // now so the existing stdlib and tests still compile while sources migrate to `code`.
      case 'code':
      case 'mark':
        return args[0]
          ? toExpression(args[0], scope)
          : { form: 'integer', value: 0, span }
      // the host null literal: `null`, for the dynamic / host boundary
      case 'null':
        return { form: 'null', span }
      case 'text': {
        const value = args[0]
        if (value && value.kind === 'text')
          return toExpression(value, scope)
        if (value && value.kind === 'integer')
          return { form: 'string', value: String(value.value), span }
        return { form: 'string', value: '', span }
      }
      case 'term': {
        // an atom / symbol literal: `term infinity` is the symbol "infinity" (represented as a string)
        const atom =
          args[0] && args[0].kind === 'group'
            ? headName(args[0] as GroupNode)
            : undefined
        return { form: 'string', value: atom ?? '', span }
      }
      case 'loan':
      case 'move':
      case 'read': {
        const target = args[0]
        const name =
          target && target.kind === 'group'
            ? headName(target)
            : undefined
        return pathExpression(name ?? '', span)
      }
      case 'wave': {
        const value = args[0]
        const flag =
          value && value.kind === 'group' ? headName(value) : undefined
        return { form: 'boolean', value: flag === 'true', span }
      }
      case 'make':
        return makeExpression(group, scope)
      case 'task': {
        // a function literal / callback value: `task <name> / take ... / like ... / <body>`. The name is cosmetic
        // for a value position; params come from `take`, the body from the remaining statements.
        const decl = args.slice(1)
        const params: Array<{ name: string; type?: Type }> = []
        for (const child of decl) {
          if (child.kind !== 'group' || headName(child) !== 'take')
            continue
          const varGroup = rest(child)[0]
          const paramName =
            varGroup && varGroup.kind === 'group'
              ? headName(varGroup)
              : undefined
          if (!paramName) continue
          const likeGroup = rest(child).find(
            (n): n is GroupNode =>
              n.kind === 'group' && headName(n) === 'like',
          )
          params.push(
            likeGroup
              ? { name: paramName, type: parseLikeType(likeGroup) }
              : { name: paramName },
          )
        }
        const inner = new Set(scope)
        for (const p of params) inner.add(p.name)
        const SIGNATURE = new Set([
          'take',
          'like',
          'head',
          'mark',
          'note',
          'wait',
        ])
        const bodyNodes = decl.filter(
          n =>
            !(n.kind === 'group' && SIGNATURE.has(headName(n) ?? '')),
        )
        const resultLike = decl.find(
          (n): n is GroupNode =>
            n.kind === 'group' && headName(n) === 'like',
        )
        const closure: Expression = {
          form: 'closure',
          params,
          body: toStatements(bodyNodes, inner),
          span,
        }
        if (resultLike) closure.result = parseLikeType(resultLike)
        // async is marked by `note async` (or retired `mark async`) or a direct `wait true` (mirrors the task rule)
        const closureMarkedAsync = decl.some(n => isAnnotation(n, 'async'))
        if (closureMarkedAsync || decl.some(isWaitTrue)) closure.async = true
        return closure
      }
      case 'fork': {
        // a conditional in value position: `fork test / hook test <cond> / hook hold <value> / hook miss <else>`.
        // `fork case` (a match) is not yet supported as a value, so it falls through to the generic call path below.
        const variant =
          args[0] && args[0].kind === 'group'
            ? headName(args[0] as GroupNode)
            : undefined
        // `fork lack / <bool>` is boolean negation: it sits in the fork family next to `fork test` and `fork case`,
        // and lowers to a unary `!` of its operand. The operand is the expression after the `lack` marker.
        if (variant === 'lack') {
          const operand = args[1]
            ? toExpression(args[1], scope)
            : { form: 'boolean' as const, value: false, span }
          return { form: 'unary', op: '!', operand, span }
        }
        if (variant !== 'case') {
          const branches: Array<{ cond: Expression; value: Expression }> =
            []
          let otherwise: Expression | undefined
          let pendingCond: Expression | undefined
          const valueOf = (nodes: Array<Node>): Expression =>
            nodes[0] ? toExpression(nodes[0], scope) : { form: 'unit', span }
          for (const child of args) {
            if (child.kind !== 'group' || headName(child) !== 'hook')
              continue
            const inner = rest(child)
            const variantName =
              inner[0] && inner[0].kind === 'group'
                ? headName(inner[0])
                : undefined
            const bodyNodes = inner.slice(1)
            if (variantName === 'test') {
              if (pendingCond)
                branches.push({ cond: pendingCond, value: { form: 'unit', span } })
              pendingCond = bodyNodes[0]
                ? toExpression(bodyNodes[0], scope)
                : { form: 'boolean', value: false, span }
            } else if (variantName === 'hold') {
              branches.push({
                cond: pendingCond ?? { form: 'boolean', value: true, span },
                value: valueOf(bodyNodes),
              })
              pendingCond = undefined
            } else if (variantName === 'miss') {
              if (pendingCond) {
                branches.push({ cond: pendingCond, value: { form: 'unit', span } })
                pendingCond = undefined
              }
              otherwise = valueOf(bodyNodes)
            }
          }
          if (pendingCond)
            branches.push({ cond: pendingCond, value: { form: 'unit', span } })
          return { form: 'conditional', branches, otherwise, span }
        }
        // fall through to the generic keyword path for `fork case`
        return {
          form: 'call',
          callee: { form: 'variable', name: 'fork', span },
          args: args.map(a => toExpression(a, scope)),
          span,
        }
      }
      case 'call':
        return callExpression(group, scope)
      case 'bind': {
        const value = args[1]
        return value
          ? toExpression(value, scope)
          : { form: 'unit', span }
      }
      default: {
        if (keyword !== undefined && args.length === 0)
          return { form: 'variable', name: keyword, span }
        if (keyword !== undefined) {
          return {
            form: 'call',
            callee: { form: 'variable', name: keyword, span },
            args: args.map(a => toExpression(a, scope)),
            span,
          }
        }
        fail(group, 'this is not a valid expression')
        return { form: 'unit', span }
      }
    }
  }

  function callExpression(
    group: GroupNode,
    scope: Set<string>,
  ): Expression {
    const parts = rest(group)
    const target = parts[0]
    const calleeName =
      target && target.kind === 'group' ? headName(target) : undefined
    const span = spanOf(group)
    // `wait true` marks the call to be awaited; it is not an argument
    const awaited = parts.slice(1).some(isWaitTrue)
    const callArgs = parts
      .slice(1)
      .filter(a => !isWaitTrue(a))
      .map(a => toExpression(a, scope))

    let result: Expression
    if (
      calleeName &&
      calleeName in BINARY_BUILTIN &&
      callArgs.length === 2
    ) {
      result = {
        form: 'binary',
        op: BINARY_BUILTIN[calleeName]!,
        left: callArgs[0]!,
        right: callArgs[1]!,
        span,
      }
    } else if (calleeName === 'decrement' && callArgs.length === 1) {
      result = {
        form: 'binary',
        op: '-',
        left: callArgs[0]!,
        right: { form: 'integer', value: 1, span },
        span,
      }
    } else if (calleeName === 'increment' && callArgs.length === 1) {
      result = {
        form: 'binary',
        op: '+',
        left: callArgs[0]!,
        right: { form: 'integer', value: 1, span },
        span,
      }
    } else {
      // a slashed callee (`fs/read-file`) is a member path: the native-module FFI or a qualified function
      const callee: Expression =
        calleeName && calleeName.includes('/')
          ? pathExpression(calleeName, span)
          : { form: 'variable', name: calleeName ?? '', span }
      result = { form: 'call', callee, args: callArgs, span }
    }
    return awaited ? { form: 'await', expr: result, span } : result
  }

  // make list / make find / make <form>
  function makeExpression(
    group: GroupNode,
    scope: Set<string>,
  ): Expression {
    const parts = rest(group)
    const kindNode = parts[0]
    const kind =
      kindNode && kindNode.kind === 'group'
        ? headName(kindNode)
        : undefined
    const span = spanOf(group)
    const items = parts.slice(1)

    if (kind === 'list') {
      return {
        form: 'array',
        items: items.map(it => itemValue(it, scope)),
        span,
      }
    }
    if (kind === 'find') {
      const entries = items
        .filter(
          (it): it is GroupNode =>
            it.kind === 'group' && headName(it) === 'save',
        )
        .map(it => {
          const inner = rest(it)
          const keyNode = inner[0]
          const key =
            keyNode && keyNode.kind === 'group' ? headName(keyNode) : ''
          const valueNode = inner[1]
          return {
            key: {
              form: 'string',
              value: key ?? '',
              span,
            } as Expression,
            value: valueNode
              ? toExpression(valueNode, scope)
              : ({ form: 'unit', span } as Expression),
          }
        })
      return { form: 'map', entries, span }
    }
    // make <form>: a record from bind fields
    const fields = items
      .filter(
        (it): it is GroupNode =>
          it.kind === 'group' && headName(it) === 'bind',
      )
      .map(it => {
        const inner = rest(it)
        const fieldNode = inner[0]
        const fieldName =
          fieldNode && fieldNode.kind === 'group'
            ? headName(fieldNode)
            : ''
        const valueNode = inner[1]
        return {
          name: fieldName ?? '',
          value: valueNode
            ? toExpression(valueNode, scope)
            : ({ form: 'unit', span } as Expression),
        }
      })
    return { form: 'record', name: kind ?? '', fields, span }
  }

  // a collection item: either a bare value or a `save item, <value>` wrapper
  function itemValue(node: Node, scope: Set<string>): Expression {
    if (node.kind === 'group' && headName(node) === 'save') {
      const inner = rest(node)
      const valueNode = inner[1] ?? inner[0]
      return valueNode
        ? toExpression(valueNode, scope)
        : { form: 'unit', span: spanOf(node) }
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
      const hookName =
        variant && variant.kind === 'group'
          ? headName(variant)
          : undefined
      if (hookName) map.set(hookName, inner.slice(1))
    }
    return map
  }

  // mint: build statements from a list of groups
  function toStatements(
    nodes: Array<Node>,
    scope: Set<string>,
  ): Array<Statement> {
    const out: Array<Statement> = []
    for (const node of nodes) {
      if (node.kind !== 'group') {
        out.push({
          form: 'expression',
          expr: toExpression(node, scope),
          span: spanOf(node),
        })
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
        // `name <X>` is a foreign / display-name annotation (the JS name a binding maps to), never an executable
        // statement. Without this it would fall to the default case and mill as a bare `name` variable reference.
        // `rank` likewise annotates a receiver's type and is not executable.
        case 'name':
        case 'rank':
          break
        case 'save': {
          const args = rest(node)
          const target = args[0]
          const name =
            target && target.kind === 'group'
              ? headName(target)
              : undefined
          if (!name) {
            fail(node, 'save needs a name')
            break
          }
          // skip signature annotations after the target when locating the assigned value (see `host` above)
          const valueNode = args
            .slice(1)
            .find(
              a =>
                !(
                  a.kind === 'group' &&
                  HOST_ANNOTATION.has(headName(a) ?? '')
                ),
            )
          const value: Expression = valueNode
            ? toExpression(valueNode, scope)
            : { form: 'integer', value: 0, span }
          if (name.includes('/')) {
            // `save self/field, X` mutates a member, not a binding: emit an assignment to the member path
            out.push({
              form: 'assign',
              target: pathExpression(name, span),
              op: '=',
              value,
              span,
            })
          } else if (scope.has(name)) {
            out.push({
              form: 'assign',
              target: { form: 'variable', name, span },
              op: '=',
              value,
              span,
            })
          } else {
            scope.add(name)
            const saveLike = args
              .slice(1)
              .find(
                (a): a is GroupNode =>
                  a.kind === 'group' && headName(a) === 'like',
              )
            const saveLet: Statement = {
              form: 'let',
              name,
              init: value,
              mutable: true,
              span,
            }
            if (saveLike) saveLet.type = parseLikeType(saveLike)
            out.push(saveLet)
          }
          break
        }
        case 'back': {
          const value = rest(node)[0]
          out.push({
            form: 'return',
            value: value ? toExpression(value, scope) : undefined,
            span,
          })
          break
        }
        case 'hold': {
          const parts = rest(node)
          // optional inline name (`hold <name>`): a bare word with siblings after it makes the hold a citable lemma
          let nameValue: string | undefined
          let propIndex = 0
          const first = parts[0]
          if (
            parts.length > 1 &&
            first &&
            first.kind === 'group' &&
            rest(first).length === 0
          ) {
            nameValue = headName(first)
            propIndex = 1
          }
          const condition = parts[propIndex]
          if (condition) {
            const proof = parts
              .slice(propIndex + 1)
              .filter((n): n is GroupNode => n.kind === 'group')
              .map(parseProof)
            const holdStatement: Statement = {
              form: 'hold',
              expr: toExpression(condition, scope),
              span,
            }
            if (nameValue) holdStatement.name = nameValue
            if (proof.length > 0) holdStatement.proof = proof
            out.push(holdStatement)
          }
          break
        }
        case 'bust': {
          const valueNode = rest(node)[0]
          out.push({
            form: 'throw',
            value: valueNode
              ? toExpression(valueNode, scope)
              : { form: 'unit', span },
            span,
          })
          break
        }
        case 'send': {
          // `send back, X` and multiline `send back` / `<X>` parse as send > [back, X] (value is send's second
          // child). `send back X` on one line parses as send > [back > [X]] (value nested under back). Accept both.
          const backGroup = rest(node)[0]
          if (
            backGroup &&
            backGroup.kind === 'group' &&
            headName(backGroup) === 'back'
          ) {
            const value = rest(node)[1] ?? rest(backGroup)[0]
            out.push({
              form: 'return',
              value: value ? toExpression(value, scope) : undefined,
              span,
            })
          } else {
            fail(node, 'send must be followed by back')
          }
          break
        }
        case 'host': {
          const hostArgs = rest(node)
          const target = hostArgs[0]
          const name =
            target && target.kind === 'group'
              ? headName(target)
              : undefined
          if (!name) {
            fail(node, 'host needs a name')
            break
          }
          // signature annotations (`name <X>` foreign name, `like <T>` type, `flex`) are not the value. A generated
          // ambient binding like `host na-n, name <NaN> / like native-number` has no value at all; without skipping
          // these the `name <NaN>` annotation would be milled as a bare `name` variable reference. Only the target
          // (first node) is exempt, since a binding can legitimately be named `name` (`host name, name <name>`).
          const valueNode = hostArgs
            .slice(1)
            .find(
              a =>
                !(
                  a.kind === 'group' &&
                  HOST_ANNOTATION.has(headName(a) ?? '')
                ),
            )
          const value: Expression = valueNode
            ? toExpression(valueNode, scope)
            : { form: 'unit', span }
          scope.add(name)
          // an explicit `like <T>` annotation types the binding (`host el, like element / read x`): it lets a value
          // read from an opaque field be re-typed to a concrete form so receiver dispatch can route its methods.
          const hostLike = hostArgs
            .slice(1)
            .find(
              (a): a is GroupNode =>
                a.kind === 'group' && headName(a) === 'like',
            )
          const hostLet: Statement = {
            form: 'let',
            name,
            init: value,
            mutable: false,
            span,
          }
          if (hostLike) hostLet.type = parseLikeType(hostLike)
          // a value-less `host x, name <Y>` is a host global (`host document, name <document>`): record the foreign
          // name Y so the emitter aliases it to the host global instead of binding it to `undefined`.
          if (!valueNode) {
            const nameGroup = hostArgs
              .slice(1)
              .find(
                (a): a is GroupNode =>
                  a.kind === 'group' && headName(a) === 'name',
              )
            const foreignNode = nameGroup
              ? rest(nameGroup)[0]
              : undefined
            if (foreignNode && foreignNode.kind === 'text') {
              hostLet.foreign = foreignNode.parts
                .map(p => (p.kind === 'chunk' ? p.text : ''))
                .join('')
            }
          }
          out.push(hostLet)
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
          const variant =
            parts[0] && parts[0].kind === 'group'
              ? headName(parts[0])
              : undefined
          if (variant === 'list') {
            const iterable: Expression = parts[1]
              ? toExpression(parts[1], scope)
              : { form: 'unit', span }
            const nextBody = hooks(node).get('next') ?? []
            let item = 'item'
            let bodyNodes = nextBody
            const first = nextBody[0]
            if (
              first &&
              first.kind === 'group' &&
              headName(first) === 'take'
            ) {
              const nameGroup = rest(first)[1]
              if (
                nameGroup &&
                nameGroup.kind === 'group' &&
                headName(nameGroup) === 'name'
              ) {
                const itemGroup = rest(nameGroup)[0]
                if (itemGroup && itemGroup.kind === 'group')
                  item = headName(itemGroup) ?? 'item'
              }
              bodyNodes = nextBody.slice(1)
            }
            // the loop body gets a fresh child scope (so a `save` inside the loop is local and does not leak), with
            // the item name bound in it
            const forScope = new Set(scope)
            forScope.add(item)
            out.push({
              form: 'for-each',
              item,
              iterable,
              body: toStatements(bodyNodes, forScope),
              span,
            })
            break
          }
          const hookMap = hooks(node)
          const condNodes = hookMap.get('test')
          const bodyNodes =
            hookMap.get('step') ??
            hookMap.get('tick') ??
            hookMap.get('hold') ??
            []
          const cond: Expression =
            condNodes && condNodes[0]
              ? toExpression(condNodes[0], scope)
              : { form: 'boolean', value: false, span }
          out.push({
            form: 'while',
            cond,
            body: toStatements(bodyNodes, new Set(scope)),
            span,
          })
          break
        }
        case 'fork': {
          const parts = rest(node)
          const variant =
            parts[0] && parts[0].kind === 'group'
              ? headName(parts[0])
              : undefined
          if (variant === 'case') {
            // `fork case, <subject>` with `case <label>` arms: a pattern match on an enum
            const subject: Expression = parts[1]
              ? toExpression(parts[1], scope)
              : { form: 'unit', span }
            const cases: Array<{
              label: string
              body: Array<Statement>
            }> = []
            let otherwise: Array<Statement> | undefined
            for (const arm of parts.slice(2)) {
              if (arm.kind !== 'group' || headName(arm) !== 'case')
                continue
              const labelGroup = rest(arm)[0]
              const label =
                labelGroup && labelGroup.kind === 'group'
                  ? headName(labelGroup)
                  : undefined
              if (label === 'else')
                otherwise = toStatements(
                  rest(arm).slice(1),
                  new Set(scope),
                )
              else if (label)
                cases.push({
                  label,
                  body: toStatements(
                    rest(arm).slice(1),
                    new Set(scope),
                  ),
                })
            }
            out.push({ form: 'match', subject, cases, otherwise, span })
            break
          }
          // walk the hooks in order, pairing each `hook test` with the `hook hold` that follows it. This builds the
          // full if / else-if chain (multiple test/hold pairs), with `hook miss` as the final else. A lone `hook hold`
          // (no preceding test) defaults to an always-true branch.
          const branches: Array<{
            cond: Expression
            body: Array<Statement>
          }> = []
          let otherwise: Array<Statement> | undefined
          let pendingCond: Expression | undefined
          for (const child of rest(node)) {
            if (child.kind !== 'group' || headName(child) !== 'hook')
              continue
            const inner = rest(child)
            const variantName =
              inner[0] && inner[0].kind === 'group'
                ? headName(inner[0])
                : undefined
            const bodyNodes = inner.slice(1)
            if (variantName === 'test') {
              // a `hook test` with no following `hook hold` still becomes a branch (with an empty body), so a bare
              // `test` + `miss` lowers to `if (cond) {} else {...}` rather than an invalid otherwise-only `if`
              if (pendingCond)
                branches.push({ cond: pendingCond, body: [] })
              pendingCond = bodyNodes[0]
                ? toExpression(bodyNodes[0], scope)
                : { form: 'boolean', value: false, span }
            } else if (variantName === 'hold') {
              branches.push({
                cond: pendingCond ?? {
                  form: 'boolean',
                  value: true,
                  span,
                },
                body: toStatements(bodyNodes, new Set(scope)),
              })
              pendingCond = undefined
            } else if (variantName === 'miss') {
              if (pendingCond) {
                branches.push({ cond: pendingCond, body: [] })
                pendingCond = undefined
              }
              otherwise = toStatements(bodyNodes, new Set(scope))
            }
          }
          if (pendingCond)
            branches.push({ cond: pendingCond, body: [] })
          out.push({ form: 'if', branches, otherwise, span })
          break
        }
        default:
          out.push({
            form: 'expression',
            expr: toExpression(node, scope),
            span,
          })
      }
    }
    return out
  }

  // the parameter list of a task or bind: every `take <name>, like <type>` child, honoring `need false` (optional) and
  // the `natural-number` refinement. Shared by buildFunction and buildBind.
  function parseTaskParams(body: Array<Node>): Array<{
    name: string
    type?: Type
    refine?: 'natural'
    optional?: boolean
  }> {
    const params: Array<{
      name: string
      type?: Type
      refine?: 'natural'
      optional?: boolean
    }> = []
    for (const statement of body) {
      if (
        statement.kind === 'group' &&
        headName(statement) === 'take'
      ) {
        const varGroup = rest(statement)[0]
        const paramName =
          varGroup && varGroup.kind === 'group'
            ? headName(varGroup)
            : undefined
        if (!paramName) continue
        const likeGroup = rest(statement).find(
          (n): n is GroupNode =>
            n.kind === 'group' && headName(n) === 'like',
        )
        const typeNode = likeGroup ? rest(likeGroup)[0] : undefined
        // honor the declared type (a first-class task type is parsed structurally), and detect a natural refinement
        const type = likeGroup ? parseLikeType(likeGroup) : undefined
        const refine =
          typeNode &&
          typeNode.kind === 'group' &&
          headName(typeNode) === 'natural-number'
            ? 'natural'
            : undefined
        // `need false` marks the parameter optional. In the comma form (`take x, like t, need false`) the parser
        // nests `need` inside the `like` group; in the indented form it sits at the take level. Check both.
        const needGroup =
          rest(statement).find(
            (n): n is GroupNode =>
              n.kind === 'group' && headName(n) === 'need',
          ) ??
          (likeGroup
            ? rest(likeGroup).find(
                (n): n is GroupNode =>
                  n.kind === 'group' && headName(n) === 'need',
              )
            : undefined)
        const needArg = needGroup ? rest(needGroup)[0] : undefined
        const optional =
          needArg != null &&
          needArg.kind === 'group' &&
          headName(needArg) === 'false'
        const param: {
          name: string
          type?: Type
          refine?: 'natural'
          optional?: boolean
        } = { name: paramName }
        if (type) param.type = type
        if (refine) param.refine = refine
        if (optional) param.optional = true
        params.push(param)
      }
    }
    return params
  }

  // the return type of a task or bind: a bare `like <type>`, or a named output `free <name>, like <type>`. The bare
  // `like` wins if both are present. Shared by buildFunction and buildBind.
  function parseTaskResult(body: Array<Node>): Type | undefined {
    const resultLike = body.find(
      (n): n is GroupNode =>
        n.kind === 'group' && headName(n) === 'like',
    )
    let resultType = resultLike ? parseLikeType(resultLike) : undefined
    if (!resultType) {
      const freeNode = body.find(
        (n): n is GroupNode =>
          n.kind === 'group' && headName(n) === 'free',
      )
      const likeInFree =
        freeNode &&
        rest(freeNode).find(
          (n): n is GroupNode =>
            n.kind === 'group' && headName(n) === 'like',
        )
      if (likeInFree) resultType = parseLikeType(likeInFree)
    }
    return resultType
  }

  function buildFunction(group: GroupNode): Statement | undefined {
    const parts = rest(group)
    const nameGroup = parts[0]
    const name =
      nameGroup && nameGroup.kind === 'group'
        ? headName(nameGroup)
        : undefined
    const span = spanOf(group)
    if (!name) {
      // a computed / symbol-keyed method (e.g. `task {symbol/iterator}` from `[Symbol.iterator]()` in a generated
      // binding) has no plain identifier name; it is not callable by name in seed, so skip it silently. Only a
      // genuinely empty `task` (no head at all) is an error.
      if (nameGroup) return undefined
      fail(group, 'task needs a name')
      return undefined
    }
    const body = parts.slice(1)
    // generic type parameters: `head t` or `head t, need <mask>`
    const generics: Array<{ name: string; need?: string }> = []
    for (const statement of body) {
      if (
        statement.kind === 'group' &&
        headName(statement) === 'head'
      ) {
        const inner = rest(statement)
        const gName =
          inner[0] && inner[0].kind === 'group'
            ? headName(inner[0])
            : undefined
        if (!gName) continue
        const needGroup = inner.find(
          (n): n is GroupNode =>
            n.kind === 'group' && headName(n) === 'need',
        )
        const need = needGroup
          ? rest(needGroup)[0] && rest(needGroup)[0]!.kind === 'group'
            ? headName(rest(needGroup)[0] as GroupNode)
            : undefined
          : undefined
        generics.push(need ? { name: gName, need } : { name: gName })
      }
    }
    const params = parseTaskParams(body)
    const resultType = parseTaskResult(body)
    const scope = new Set<string>(params.map(p => p.name))
    // signature nodes describe the task; they are not executable body statements. `head` (generics), `take` (params),
    // the bare `like` (result type), `free` (named output), `mark` (modifiers like `mark async`/`mark private`), and
    // `note` (documentation) are all consumed here, so only real statements (send back, save, call, fork, ...) remain.
    // `name <X>` is the task's foreign / display name (the JS method name a generated binding maps to), not an
    // executable statement. `flex` marks a variadic / optional parameter. `rank` annotates a receiver's type
    // (`rank self / like array / like s`). All are signature annotations, never executable.
    const SIGNATURE = new Set([
      'head',
      'take',
      'like',
      'free',
      'mark',
      'note',
      'name',
      'flex',
      'rank',
    ])
    const executable = body.filter(
      n => !(n.kind === 'group' && SIGNATURE.has(headName(n) ?? '')),
    )
    const fn: Statement = {
      form: 'function',
      name,
      params,
      body: toStatements(executable, scope),
      generics,
      span,
    }
    if (resultType) fn.result = resultType
    // async is marked by `wait true` or `note async` (or retired `mark async`)
    const markedAsync = body.some(n => isAnnotation(n, 'async'))
    if (markedAsync || body.some(isWaitTrue)) fn.async = true
    return fn
  }

  // a declarative native binding: `bind <name>` with `take`/`like` signature lines and one `case <env>` block per
  // backend, each holding a `text <native expression>` (with `$param` placeholders) and optional `load` imports. The
  // checker registers the signature like a function; each backend renders the matching env's template at call sites.
  function buildBind(group: GroupNode): Statement | undefined {
    const parts = rest(group)
    const nameGroup = parts[0]
    const name =
      nameGroup && nameGroup.kind === 'group'
        ? headName(nameGroup)
        : undefined
    const span = spanOf(group)
    if (!name) {
      fail(group, 'bind needs a name')
      return undefined
    }
    const body = parts.slice(1)
    const params = parseTaskParams(body)
    const result = parseTaskResult(body)
    const targets: Array<{
      env: string
      expression: string
      imports: Array<{ module: string; alias?: string }>
    }> = []
    for (const child of body) {
      if (child.kind !== 'group' || headName(child) !== 'case') continue
      const envGroup = rest(child)[0]
      const env =
        envGroup && envGroup.kind === 'group'
          ? headName(envGroup)
          : undefined
      if (!env) continue
      // the native expression: a `text <...>` child whose chunks hold the raw target syntax
      let expression: string | undefined
      const imports: Array<{ module: string; alias?: string }> = []
      for (const node of rest(child).slice(1)) {
        if (node.kind !== 'group') continue
        const head = headName(node)
        if (head === 'text') {
          const value = toExpression(node, new Set())
          if (value.form === 'string') expression = value.value
        } else if (head === 'load') {
          // `load <node:module>, name alias`: an import the rendered expression needs
          const moduleNode = rest(node)[0]
          const module =
            moduleNode && moduleNode.kind === 'text'
              ? moduleNode.parts
                  .map(p => (p.kind === 'chunk' ? p.text : ''))
                  .join('')
              : undefined
          if (!module) continue
          const nameChild = rest(node).find(
            (n): n is GroupNode =>
              n.kind === 'group' && headName(n) === 'name',
          )
          const aliasGroup = nameChild ? rest(nameChild)[0] : undefined
          const alias =
            aliasGroup && aliasGroup.kind === 'group'
              ? headName(aliasGroup)
              : undefined
          imports.push(alias ? { module, alias } : { module })
        }
      }
      if (expression === undefined) {
        fail(child, `bind case "${env}" needs a text expression`)
        continue
      }
      targets.push({ env, expression, imports })
    }
    const bind: Statement = {
      form: 'bind',
      name,
      params,
      targets,
      span,
    }
    if (result) bind.result = result
    return bind
  }

  // a mask defines a trait: the names of the method signatures it declares
  function methodNames(group: GroupNode): Array<string> {
    const names: Array<string> = []
    for (const child of rest(group)) {
      if (child.kind === 'group' && headName(child) === 'task') {
        const nameGroup = rest(child)[0]
        const m =
          nameGroup && nameGroup.kind === 'group'
            ? headName(nameGroup)
            : undefined
        if (m) names.push(m)
      }
    }
    return names
  }

  function buildMask(group: GroupNode): Statement | undefined {
    const nameGroup = rest(group)[0]
    const name =
      nameGroup && nameGroup.kind === 'group'
        ? headName(nameGroup)
        : undefined
    if (!name) {
      fail(group, 'mask needs a name')
      return undefined
    }
    return {
      form: 'mask',
      name,
      methods: methodNames(group),
      span: spanOf(group),
    }
  }

  // extract trait instances from `wear <mask>` children, implemented for `target`
  function wearInstances(
    group: GroupNode,
    target: string,
  ): Array<Statement> {
    const out: Array<Statement> = []
    for (const child of rest(group)) {
      if (child.kind !== 'group' || headName(child) !== 'wear') continue
      const maskGroup = rest(child)[0]
      const mask =
        maskGroup && maskGroup.kind === 'group'
          ? headName(maskGroup)
          : undefined
      if (mask)
        out.push({
          form: 'instance',
          mask,
          target,
          methods: methodNames(child),
          span: spanOf(child),
        })
    }
    return out
  }

  function buildSuit(group: GroupNode): Array<Statement> {
    const targetGroup = rest(group)[0]
    const target =
      targetGroup && targetGroup.kind === 'group'
        ? headName(targetGroup)
        : undefined
    if (!target) {
      fail(group, 'suit needs a target form')
      return []
    }
    return wearInstances(group, target)
  }

  function buildRecordType(group: GroupNode): Statement | undefined {
    const parts = rest(group)
    const nameGroup = parts[0]
    const name =
      nameGroup && nameGroup.kind === 'group'
        ? headName(nameGroup)
        : undefined
    const span = spanOf(group)
    if (!name) {
      fail(group, 'form needs a name')
      return undefined
    }
    const linkFields = (
      g: GroupNode,
    ): Array<{ name: string; type: Type; nick?: string }> => {
      const out: Array<{ name: string; type: Type; nick?: string }> = []
      for (const child of rest(g)) {
        if (
          child.kind !== 'group' ||
          (headName(child) !== 'link' && headName(child) !== 'free')
        )
          continue
        const inner = rest(child)
        const fieldNode = inner[0]
        const fieldName =
          fieldNode && fieldNode.kind === 'group'
            ? headName(fieldNode)
            : undefined
        const likeGroup = inner[1]
        let type: Type = UNKNOWN
        // parse the field type with the function-aware parser so `like task` fields are callable function types and
        // `like list` fields are native arrays, not opaque named types
        if (
          likeGroup &&
          likeGroup.kind === 'group' &&
          headName(likeGroup) === 'like'
        ) {
          type = parseLikeType(likeGroup)
        }
        // a field's foreign `name <X>` (binding fields carry the exact native name, e.g. COLOR_BUFFER_BIT), so the
        // emitter can use it verbatim instead of camelCasing the seed name. The `<X>` is a text node (see the host
        // foreign-name reader above).
        let nick: string | undefined
        for (const c of inner) {
          if (c.kind === 'group' && headName(c) === 'name') {
            const valNode = rest(c)[0]
            if (valNode && valNode.kind === 'text')
              nick = valNode.parts
                .map(p => (p.kind === 'chunk' ? p.text : ''))
                .join('')
            break
          }
        }
        if (fieldName) out.push({ name: fieldName, type, nick })
      }
      return out
    }

    const fields = linkFields(group)
    // enum variants: `case <name>` children, each with its own fields
    const variants: Array<{
      name: string
      fields: Array<{ name: string; type: Type }>
    }> = []
    for (const child of parts.slice(1)) {
      if (child.kind !== 'group' || headName(child) !== 'case') continue
      const vNameGroup = rest(child)[0]
      const vName =
        vNameGroup && vNameGroup.kind === 'group'
          ? headName(vNameGroup)
          : undefined
      if (vName)
        variants.push({ name: vName, fields: linkFields(child) })
    }
    // `head <name>` children are the form's generic parameters (e.g. `form maybe / head t`)
    const params: Array<string> = []
    for (const child of parts.slice(1)) {
      if (child.kind !== 'group' || headName(child) !== 'head') continue
      const gNameGroup = rest(child)[0]
      const gName =
        gNameGroup && gNameGroup.kind === 'group'
          ? headName(gNameGroup)
          : undefined
      if (gName) params.push(gName)
    }
    // a transparent alias: `form X, like <type>` carries its base so the checker can unify X with that base. The bind
    // primitive aliases use this (`form g-luint, like native-number`). Only meaningful when the form has no own
    // fields or variants; the checker treats such a form as interchangeable with its base.
    let alias: Type | undefined
    for (const child of parts.slice(1)) {
      if (child.kind === 'group' && headName(child) === 'like') {
        alias = parseLikeType(child)
        break
      }
    }
    return { form: 'record-type', name, params, fields, variants, alias, span }
  }

  // a form's nested `task` children are methods: desugared to free functions over the form, with `self` typed as
  // the form (parameterized by the form's generics) and the form's generics in scope. `read(file)`, not file.read().
  // `selfOverride` types `self` as a primitive kind, for a primitive type's stdlib form (boolean, number, text).
  function formMethods(
    group: GroupNode,
    formName: string,
    formParams: Array<string>,
    selfOverride?: Type,
  ): Array<Statement> {
    const out: Array<Statement> = []
    const selfType: Type = selfOverride ?? {
      kind: 'named',
      name: formName,
      args: formParams.map(name => ({ kind: 'named', name })),
    }
    for (const child of rest(group)) {
      if (child.kind !== 'group' || headName(child) !== 'task') continue
      const fn = buildFunction(child)
      if (!fn || fn.form !== 'function') continue
      fn.generics = [
        ...formParams.map(name => ({ name })),
        ...fn.generics,
      ]
      fn.params = fn.params.map(p =>
        p.name === 'self' && !p.type ? { ...p, type: selfType } : p,
      )
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
        if (part.kind === 'text')
          module = part.parts
            .map(p => (p.kind === 'chunk' ? p.text : ''))
            .join('')
        else if (part.kind === 'group' && headName(part) === 'name') {
          const a = rest(part)[0]
          alias = a && a.kind === 'group' ? headName(a) : undefined
        }
      }
      if (module && alias)
        out.push({
          form: 'native',
          alias,
          module,
          span: spanOf(child),
          file,
        })
    }
    return out
  }

  // `bind <name>, <value>` arguments under a group (component props, call args)
  function buildBindArgs(
    group: GroupNode,
    scope: Set<string>,
  ): Array<DockArgument> {
    const args: Array<DockArgument> = []
    for (const child of rest(group)) {
      if (child.kind !== 'group' || headName(child) !== 'bind') continue
      const nameGroup = rest(child)[0]
      const name =
        nameGroup && nameGroup.kind === 'group'
          ? headName(nameGroup)
          : undefined
      const valueNode = rest(child)[1]
      if (name)
        args.push({
          name,
          value: valueNode
            ? toExpression(valueNode, scope)
            : { form: 'unit', span: spanOf(child) },
        })
    }
    return args
  }

  // `call <name> / bind ...` handlers under a group
  function buildDockCalls(
    group: GroupNode,
    scope: Set<string>,
  ): Array<DockCall> {
    const calls: Array<DockCall> = []
    for (const child of rest(group)) {
      if (child.kind !== 'group' || headName(child) !== 'call') continue
      const nameGroup = rest(child)[0]
      const name =
        nameGroup && nameGroup.kind === 'group'
          ? headName(nameGroup)
          : undefined
      if (name)
        calls.push({
          name,
          args: buildBindArgs(child, scope),
          span: spanOf(child),
        })
    }
    return calls
  }

  // `take <name> / like <type> / need true` options/params. A `take path|query|body|head` is a section whose nested
  // takes/links are the real params, so descend into it.
  const TAKE_SECTION = new Set(['path', 'query', 'body', 'head'])
  function buildDockTakes(group: GroupNode): Array<DockTake> {
    const takes: Array<DockTake> = []
    for (const child of rest(group)) {
      if (child.kind !== 'group') continue
      const headKw = headName(child)
      if (headKw === 'take') {
        const varGroup = rest(child)[0]
        const name =
          varGroup && varGroup.kind === 'group'
            ? headName(varGroup)
            : undefined
        if (!name) continue
        if (TAKE_SECTION.has(name)) {
          takes.push(...buildDockTakes(child))
          continue
        }
        const likeGroup = rest(child).find(
          (n): n is GroupNode =>
            n.kind === 'group' && headName(n) === 'like',
        )
        const required = rest(child).some(
          n => n.kind === 'group' && headName(n) === 'need',
        )
        const take: DockTake = { name, required, span: spanOf(child) }
        if (likeGroup) take.type = parseLikeType(likeGroup)
        takes.push(take)
      } else if (headKw === 'link') {
        const varGroup = rest(child)[0]
        const name =
          varGroup && varGroup.kind === 'group'
            ? headName(varGroup)
            : undefined
        if (!name) continue
        const likeGroup = rest(child).find(
          (n): n is GroupNode =>
            n.kind === 'group' && headName(n) === 'like',
        )
        const take: DockTake = {
          name,
          required: false,
          span: spanOf(child),
        }
        if (likeGroup) take.type = parseLikeType(likeGroup)
        takes.push(take)
      }
    }
    return takes
  }

  // `send <name>, <value>` responses
  function buildDockSends(
    group: GroupNode,
    scope: Set<string>,
  ): Array<{ name: string; value?: Expression }> {
    const out: Array<{ name: string; value?: Expression }> = []
    for (const child of rest(group)) {
      if (child.kind !== 'group' || headName(child) !== 'send') continue
      const nameGroup = rest(child)[0]
      const name =
        nameGroup && nameGroup.kind === 'group'
          ? headName(nameGroup)
          : undefined
      if (!name) continue
      const valueNode = rest(child)[1]
      out.push(
        valueNode
          ? { name, value: toExpression(valueNode, scope) }
          : { name },
      )
    }
    return out
  }

  // build the zone (component) body: nested elements, text, reads, slots, forks, walks, computed saves
  function buildZoneNodes(
    nodes: Array<Node>,
    scope: Set<string>,
  ): Array<ZoneNode> {
    const out: Array<ZoneNode> = []
    for (const node of nodes) {
      if (node.kind === 'text') {
        out.push({
          form: 'text',
          value: node.parts
            .map(p => (p.kind === 'chunk' ? p.text : ''))
            .join(''),
          span: spanOf(node),
        })
        continue
      }
      if (node.kind !== 'group') continue
      const span = spanOf(node)
      switch (headName(node)) {
        case 'zone': {
          const nameGroup = rest(node)[0]
          const elName =
            nameGroup && nameGroup.kind === 'group'
              ? headName(nameGroup)
              : undefined
          if (!elName) break
          const attributes: Array<ZoneAttribute> = []
          const props: Array<{ name: string; value: Expression }> = []
          const children: Array<Node> = []
          let ref: string | undefined
          for (const child of rest(node).slice(1)) {
            if (child.kind === 'group' && headName(child) === 'name') {
              // `name <ref>`: bind this element to a local the rest of the zone can read
              const refGroup = rest(child)[0]
              if (refGroup && refGroup.kind === 'group')
                ref = headName(refGroup)
            } else if (child.kind === 'group' && headName(child) === 'seed') {
              const attrGroup = rest(child)[0]
              const attrName =
                attrGroup && attrGroup.kind === 'group'
                  ? headName(attrGroup)
                  : undefined
              const valueNode = rest(child)[1]
              if (attrName) {
                const value: Expression = valueNode
                  ? toExpression(valueNode, scope)
                  : { form: 'unit', span }
                const event =
                  valueNode != null &&
                  valueNode.kind === 'group' &&
                  headName(valueNode) === 'call'
                attributes.push({
                  name: attrName,
                  value,
                  event,
                  span: spanOf(child),
                })
              }
            } else if (
              child.kind === 'group' &&
              headName(child) === 'bind'
            ) {
              const bindGroup = rest(child)[0]
              const bindName =
                bindGroup && bindGroup.kind === 'group'
                  ? headName(bindGroup)
                  : undefined
              const valueNode = rest(child)[1]
              if (bindName)
                props.push({
                  name: bindName,
                  value: valueNode
                    ? toExpression(valueNode, scope)
                    : { form: 'unit', span },
                })
            } else {
              children.push(child)
            }
          }
          out.push({
            form: 'element',
            name: elName,
            attributes,
            props,
            children: buildZoneNodes(children, scope),
            ref,
            span,
          })
          break
        }
        case 'text': {
          const t = rest(node)[0]
          out.push({
            form: 'text',
            value:
              t && t.kind === 'text'
                ? t.parts
                    .map(p => (p.kind === 'chunk' ? p.text : ''))
                    .join('')
                : '',
            span,
          })
          break
        }
        case 'read': {
          // a dynamic text node. Its value is the expression of the read's child (`read count`, or
          // `read / call read-signal / bind self, read value`), not the `read` group itself (which would be
          // mis-read as accessing a variable literally named after the child's head, e.g. "call").
          const child = rest(node)[0]
          out.push({
            form: 'read',
            value:
              child && child.kind === 'group'
                ? toExpression(child, scope)
                : toExpression(node, scope),
            span,
          })
          break
        }
        case 'slot': {
          const n = rest(node)[0]
          const nm = n && n.kind === 'group' ? headName(n) : undefined
          out.push(
            nm
              ? { form: 'slot', name: nm, span }
              : { form: 'slot', span },
          )
          break
        }
        case 'fork': {
          const hookMap = hooks(node)
          const condNodes = hookMap.get('test')
          const cond: Expression =
            condNodes && condNodes[0]
              ? toExpression(condNodes[0], scope)
              : { form: 'boolean', value: false, span }
          const elseNodes = hookMap.get('miss')
          out.push({
            form: 'fork',
            branches: [
              {
                cond,
                body: buildZoneNodes(hookMap.get('hold') ?? [], scope),
              },
            ],
            otherwise: elseNodes
              ? buildZoneNodes(elseNodes, scope)
              : undefined,
            span,
          })
          break
        }
        case 'walk': {
          const parts = rest(node)
          const variant =
            parts[0] && parts[0].kind === 'group'
              ? headName(parts[0])
              : undefined
          if (variant !== 'list') break
          const iterable: Expression = parts[1]
            ? toExpression(parts[1], scope)
            : { form: 'unit', span }
          const nextBody = hooks(node).get('next') ?? []
          let item = 'item'
          let bodyNodes = nextBody
          const first = nextBody[0]
          if (
            first &&
            first.kind === 'group' &&
            headName(first) === 'take'
          ) {
            const nameGroup = rest(first)[1]
            if (
              nameGroup &&
              nameGroup.kind === 'group' &&
              headName(nameGroup) === 'name'
            ) {
              const itemGroup = rest(nameGroup)[0]
              if (itemGroup && itemGroup.kind === 'group')
                item = headName(itemGroup) ?? 'item'
            }
            bodyNodes = nextBody.slice(1)
          }
          const inner = new Set(scope)
          inner.add(item)
          out.push({
            form: 'walk',
            iterable,
            item,
            body: buildZoneNodes(bodyNodes, inner),
            span,
          })
          break
        }
        case 'save': {
          const args = rest(node)
          const target = args[0]
          const nm =
            target && target.kind === 'group'
              ? headName(target)
              : undefined
          const valueNode = args[1]
          if (nm) {
            scope.add(nm)
            out.push({
              form: 'save',
              name: nm,
              value: valueNode
                ? toExpression(valueNode, scope)
                : { form: 'unit', span },
              span,
            })
          }
          break
        }
        default:
          break
      }
    }
    return out
  }

  function buildZone(group: GroupNode): Statement | undefined {
    const nameGroup = rest(group)[0]
    const name =
      nameGroup && nameGroup.kind === 'group'
        ? headName(nameGroup)
        : undefined
    const span = spanOf(group)
    if (!name) {
      fail(group, 'zone needs a name')
      return undefined
    }
    const params: Array<{ name: string; type?: Type }> = []
    for (const child of rest(group)) {
      if (child.kind !== 'group' || headName(child) !== 'take') continue
      const varGroup = rest(child)[0]
      const paramName =
        varGroup && varGroup.kind === 'group'
          ? headName(varGroup)
          : undefined
      if (!paramName) continue
      const likeGroup = rest(child).find(
        (n): n is GroupNode =>
          n.kind === 'group' && headName(n) === 'like',
      )
      const param: { name: string; type?: Type } = { name: paramName }
      if (likeGroup) param.type = parseLikeType(likeGroup)
      params.push(param)
    }
    const scope = new Set<string>(params.map(p => p.name))
    const SIGNATURE = new Set(['take', 'like', 'head', 'note', 'mark'])
    const bodyNodes = rest(group)
      .slice(1)
      .filter(
        n => !(n.kind === 'group' && SIGNATURE.has(headName(n) ?? '')),
      )
    return {
      form: 'zone',
      name,
      params,
      body: buildZoneNodes(bodyNodes, scope),
      span,
    }
  }

  // build a routing / CLI dock (the non-FFI `dock`): path, params, method handlers, directives, nested docks.
  function buildDockRoute(group: GroupNode): DockRoute {
    const scope = new Set<string>()
    const span = spanOf(group)
    const pathGroup = rest(group)[0]
    const path =
      pathGroup && pathGroup.kind === 'group'
        ? headName(pathGroup) ?? ''
        : ''

    const methods: Array<DockMethod> = []
    for (const child of rest(group)) {
      if (child.kind !== 'group' || headName(child) !== 'task') continue
      const mNameGroup = rest(child)[0]
      const mName =
        mNameGroup && mNameGroup.kind === 'group'
          ? headName(mNameGroup)
          : undefined
      if (mName)
        methods.push({
          name: mName,
          takes: buildDockTakes(child),
          calls: buildDockCalls(child, scope),
          sends: buildDockSends(child, scope),
          span: spanOf(child),
        })
    }

    let component: DockRoute['component']
    const zoneChild = rest(group).find(
      (n): n is GroupNode =>
        n.kind === 'group' && headName(n) === 'zone',
    )
    if (zoneChild) {
      const zNameGroup = rest(zoneChild)[0]
      const zName =
        zNameGroup && zNameGroup.kind === 'group'
          ? headName(zNameGroup)
          : undefined
      if (zName)
        component = {
          name: zName,
          props: buildBindArgs(zoneChild, scope),
        }
    }

    const directives: Array<{ name: string; value?: Expression }> = []
    for (const child of rest(group)) {
      if (child.kind !== 'group' || headName(child) !== 'seed') continue
      const nameGroup = rest(child)[0]
      const dName =
        nameGroup && nameGroup.kind === 'group'
          ? headName(nameGroup)
          : undefined
      if (!dName) continue
      const valueNode = rest(child)[1]
      directives.push(
        valueNode
          ? { name: dName, value: toExpression(valueNode, scope) }
          : { name: dName },
      )
    }

    const dockHooks: Array<{ name: string; calls: Array<DockCall> }> =
      []
    for (const child of rest(group)) {
      if (child.kind !== 'group' || headName(child) !== 'hook') continue
      const nameGroup = rest(child)[0]
      const hName =
        nameGroup && nameGroup.kind === 'group'
          ? headName(nameGroup)
          : undefined
      if (hName)
        dockHooks.push({
          name: hName,
          calls: buildDockCalls(child, scope),
        })
    }

    const children = rest(group)
      .filter(
        (n): n is GroupNode =>
          n.kind === 'group' && headName(n) === 'dock',
      )
      .map(buildDockRoute)

    return {
      path,
      takes: buildDockTakes(group),
      methods,
      calls: buildDockCalls(group, scope),
      component,
      directives,
      sends: buildDockSends(group, scope),
      hooks: dockHooks,
      children,
      span,
    }
  }

  // distinguish the FFI form (`dock load / load <module>`) from a routing / CLI dock (`dock /path`, `dock make`)
  function isFfiDock(group: GroupNode): boolean {
    const first = rest(group)[0]
    return (
      first != null &&
      first.kind === 'group' &&
      headName(first) === 'load'
    )
  }

  const program: Program = []
  for (const group of tree.nodes) {
    const keyword = headName(group)
    if (keyword === 'zone') {
      const zone = buildZone(group)
      if (zone) program.push(zone)
      continue
    }
    if (keyword === 'task') {
      const fn = buildFunction(group)
      if (fn) program.push(fn)
    } else if (keyword === 'bind') {
      const bind = buildBind(group)
      if (bind) program.push(bind)
    } else if (keyword === 'form') {
      const nameGroup = rest(group)[0]
      const formName =
        nameGroup && nameGroup.kind === 'group'
          ? headName(nameGroup)
          : undefined
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
        const element: Type = {
          kind: 'array',
          element: { kind: 'named', name: params[0] ?? 't' },
        }
        program.push(...formMethods(group, formName, params, element))
      } else if (formName === 'hash') {
        // hash is the native map: its methods are typed over map<k, v> (the form's two generics); receiver dispatch
        // routes `call get / <map>` to the hash method
        const rt = buildRecordType(group)
        const params = rt && rt.form === 'record-type' ? rt.params : []
        const self: Type = {
          kind: 'map',
          key: { kind: 'named', name: params[0] ?? 'k' },
          value: { kind: 'named', name: params[1] ?? 'v' },
        }
        program.push(...formMethods(group, formName, params, self))
      } else {
        const rt = buildRecordType(group)
        if (rt) program.push(rt)
        // `wear <mask>` blocks inside the form are trait instances for it
        if (formName) program.push(...wearInstances(group, formName))
        if (formName && rt && rt.form === 'record-type')
          program.push(...formMethods(group, formName, rt.params))
      }
    } else if (keyword === 'mask') {
      const mask = buildMask(group)
      if (mask) program.push(mask)
    } else if (keyword === 'suit') {
      program.push(...buildSuit(group))
    } else if (keyword === 'dock') {
      // `dock load` is the native FFI binding; any other dock is a routing / CLI declaration
      if (isFfiDock(group)) program.push(...buildDock(group))
      else
        program.push({
          form: 'dock',
          route: buildDockRoute(group),
          span: spanOf(group),
        })
    } else if (
      keyword === 'load' ||
      keyword === 'bear' ||
      keyword === 'deck'
    ) {
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
