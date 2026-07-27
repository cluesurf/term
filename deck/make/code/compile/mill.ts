// The code mill: recognizes tree groups by their head keyword (the mine) and mints compile-AST records (the
// mint). Organized as a registry of per-keyword mills, mirroring deck/seed/deck/term.tree/code. Each record
// carries a source span. Unresolved names are left as `variable` nodes for the resolver to bind or turn into
// holes. See note/research/vibe/computation/plans/03-build-mill.md and 11-elaboration.md.

import type {
  Diagnostic,
  Span,
} from '@cluesurf/make/code/parser/diagnostic'
import { diagnose } from '@cluesurf/make/code/parser/diagnostic'
import type {
  GroupNode,
  NameNode,
  Node,
  RootNode,
} from '@cluesurf/make/code/parser/tree'
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
} from '@cluesurf/make/code/compile/node'
import {
  BOOLEAN,
  BYTES,
  DYNAMIC,
  FLOAT,
  NUMBER,
  STRING,
  UNIT,
  UNKNOWN,
} from '@cluesurf/make/code/compile/node'

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
// `name <X>` (foreign / display name), `like <T>` (type), plus the generic / output markers. Filtered out so an
// annotation is never mistaken for the assigned value expression. `mark` is deliberately absent: it is a modifier
// keyword (`mark private`) and a rule binder, never a value, while `code` is, so `save total, code 0` assigns 0.
const HOST_ANNOTATION = new Set([
  'name',
  'like',
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

  for (let i = 1; i < parts.length; i++) {
    expr = { form: 'member', target: expr, name: parts[i]!, span }
  }

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

  const children: Proof[] = []

  for (const part of parts) {
    if (arg === undefined && rest(part).length === 0) {
      arg = headName(part)
    } else {
      children.push(parseProof(part))
    }
  }

  const proof: Proof = { head, children, span: spanOf(node) }

  if (arg) {
    proof.arg = arg
  }

  return proof
}

// is this node `wait true` (force await) or `wait false` (fire-and-forget, never await)?
function isWaitWith(node: Node, value: 'true' | 'false'): boolean {
  if (node.kind !== 'group' || headName(node) !== 'wait') {
    return false
  }

  const arg = node.nodes[1]

  return arg?.kind === 'group' && headName(arg) === value
}

function isWaitTrue(node: Node): boolean {
  return isWaitWith(node, 'true')
}

function isWaitFalse(node: Node): boolean {
  return isWaitWith(node, 'false')
}

// is this node an annotation `note <name>` (or the retired `mark <name>`)? Tags / markers like `note async`,
// `note private`, `note stable` are written under `note`; `mark` is the old spelling kept working during migration.
function isAnnotation(node: Node, name: string): boolean {
  if (node.kind !== 'group') {
    return false
  }

  const head = headName(node)

  if (head !== 'note' && head !== 'mark') {
    return false
  }

  const arg = rest(node)[0]

  return arg?.kind === 'group' && headName(arg) === name
}

// a `like <type>` node to a surface type
function parseType(node: Node): Type {
  if (node.kind !== 'group') {
    return UNKNOWN
  }

  const name = headName(node)

  if (!name) {
    return UNKNOWN
  }

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

  // `head <type>` children supply type arguments to a polymorphic named type, mirroring how `form x / head a` DECLARES
  // a type parameter: `like stack / head natural` is a stack of naturals. Order matches the declared parameters.
  const headArgs = rest(node)
    .filter(
      (n): n is GroupNode =>
        n.kind === 'group' &&
        headName(n) === 'head' &&
        rest(n)[0]?.kind === 'group',
    )
    .map(h => parseType(rest(h)[0]!))

  const base = TYPE_NAME[name] ?? { kind: 'named', name }

  if (base.kind === 'named' && headArgs.length > 0) {
    return { ...base, args: headArgs }
  }

  return base
}

// the type written by a `like` group. Usually `like <name>`, but for a first-class function it is `like task` with
// `take` params and a `like` result as further children of the SAME like group (siblings of the `task` node).
// a MODULE-LEVEL value-index expression parser for the `head <...>` arguments on a type (a function param / result, or
// the indented `like T / head / <expr>` form). Handles the index forms that reach the kernel's `indexTermAt`: a variable
// (`read n` -> `pathExpression`) and a constructor (`make zero`, `make succ / bind prior / <expr>` -> a `record`, fields
// parsed recursively). This mirrors the subset of the nested `toExpression` that indices use, at module scope.
function parseIndexHeadExpression(node: GroupNode): Expression | undefined {
  const head = headName(node)
  const span = spanOf(node)

  if (head === 'read') {
    const target = rest(node)[0]
    const name = target?.kind === 'group' ? headName(target) : undefined

    return name ? pathExpression(name, span) : undefined
  }

  if (head === 'make') {
    const target = rest(node)[0]
    const name = target?.kind === 'group' ? headName(target) : undefined

    if (!name) {
      return undefined
    }

    const fields: { name: string; value: Expression }[] = []

    for (const child of rest(node)) {
      if (child.kind !== 'group' || headName(child) !== 'bind') {
        continue
      }

      const fieldName =
        rest(child)[0]?.kind === 'group'
          ? headName(rest(child)[0] as GroupNode)
          : undefined
      const valueNode = rest(child)[1]

      if (fieldName && valueNode?.kind === 'group') {
        const value = parseIndexHeadExpression(valueNode)

        if (value) {
          fields.push({ name: fieldName, value })
        }
      }
    }

    return { form: 'record', name, fields, span }
  }

  return undefined
}

// attach `head <...>` groups to a NAMED type as value-index / type arguments. The fifth and final `head`->valueArgs
// site: a function type's parameter and result types. A value head (`head / read a`) is a VALUE index; a bare type name
// (`head a`) is a type argument. Without this an indexed type inside a function type loses its indices (a function
// `vecnat a -> vecnat b` parses as `vecnat -> vecnat`, where bare `vecnat` is `nat -> Type0`, not a type).
function attachHeadArgs(type: Type, headGroups: GroupNode[]): Type {
  if (type.kind !== 'named') {
    return type
  }

  const headTypeArgs: Type[] = []
  const headValueArgs: Expression[] = []

  for (const group of headGroups) {
    const arg = rest(group)[0]

    if (arg?.kind !== 'group') {
      continue
    }

    if (isValueExpressionHead(headName(arg))) {
      const expression = parseIndexHeadExpression(arg)

      if (expression) {
        headValueArgs.push(expression)
      }
    } else {
      headTypeArgs.push(parseType(arg))
    }
  }

  let out = type

  if (headTypeArgs.length > 0) {
    out = { ...out, args: [...(out.args ?? []), ...headTypeArgs] }
  }

  if (headValueArgs.length > 0) {
    out = {
      ...out,
      valueArgs: [...(out.valueArgs ?? []), ...headValueArgs],
    }
  }

  return out
}

function parseLikeType(likeGroup: GroupNode): Type {
  const children = rest(likeGroup)
  const first = children[0]

  if (first?.kind === 'group' && headName(first) === 'task') {
    const takes = children.filter(
      (c): c is GroupNode =>
        c.kind === 'group' && headName(c) === 'take',
    )

    const params = takes.map(take => {
      const inner = rest(take).find(
        (n): n is GroupNode =>
          n.kind === 'group' && headName(n) === 'like',
      )

      const paramType = inner ? parseLikeType(inner) : UNKNOWN

      // value-index `head <...>` siblings of this param's `like` group
      const heads = rest(take).filter(
        (n): n is GroupNode =>
          n.kind === 'group' && n !== inner && headName(n) === 'head',
      )

      return attachHeadArgs(paramType, heads)
    })

    // the parameters' surface names, so a DEPENDENT function type (`(m) -> lt m n -> acc`) can resolve a later
    // parameter that references an earlier one.
    const paramNames = takes.map(take => {
      const nameNode = rest(take)[0]

      return nameNode?.kind === 'group'
        ? headName(nameNode)
        : undefined
    })

    const resultLike = children.find(
      (c): c is GroupNode =>
        c.kind === 'group' && headName(c) === 'like',
    )

    // the result type's own `head` children (the indented `like vecnat / head / read b` form) are attached by the
    // recursive `parseLikeType(resultLike)` itself (the named-type path below), so no second attachment is needed here.
    const result = resultLike ? parseLikeType(resultLike) : UNIT
    // effect annotations on the callback: `wait true` marks it async, `bust` marks it throwing
    const effects: string[] = []

    if (children.some(isWaitTrue)) {
      effects.push('async')
    }

    if (
      children.some(c => c.kind === 'group' && headName(c) === 'bust')
    ) {
      effects.push('throw')
    }

    const type: Type = { kind: 'function', params, result }

    if (paramNames.some(n => n !== undefined)) {
      type.paramNames = paramNames
    }

    if (effects.length > 0) {
      type.effects = effects
    }

    return type
  }

  // `like list` (with an optional inner `like <t>` for the element) is the native array
  if (first?.kind === 'group' && headName(first) === 'list') {
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
  if (first?.kind === 'group' && headName(first) === 'hash') {
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
  if (first?.kind === 'group') {
    const base = parseType(first)

    if (base.kind === 'named') {
      const args = children
        .slice(1)
        .filter(
          (c): c is GroupNode =>
            c.kind === 'group' && headName(c) === 'like',
        )
        .map(parseLikeType)

      let named: Type =
        args.length > 0 ? { kind: 'named', name: base.name, args } : base

      // value-index / type `head <...>` CHILDREN of this like group (the indented form `like lt / head / read m /
      // head / make zero` makes `lt m zero`). The comma form attaches them at the take/field level; this covers the
      // indented form for every parseLikeType caller (function params, closure params, nested types).
      const heads = children
        .slice(1)
        .filter(
          (c): c is GroupNode =>
            c.kind === 'group' && headName(c) === 'head',
        )

      named = attachHeadArgs(named, heads)

      return named
    }

    return base
  }

  return first ? parseType(first) : UNKNOWN
}

export const BINARY_BUILTIN: Record<string, BinaryOp> = {
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
  | { ok: false; diagnostics: Diagnostic[] }

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

  return first?.kind === 'name' ? nameText(first) : undefined
}

// does this head introduce a VALUE expression (rather than a type)? Used to tell a value-index argument (`head / read
// count`, `head / make zero`) from a type argument (`head a`) under a parameterized type's `head` children.
const VALUE_EXPRESSION_HEADS = new Set([
  'read',
  'make',
  'call',
  'code',
  'true',
  'false',
])

function isValueExpressionHead(name: string | undefined): boolean {
  return name !== undefined && VALUE_EXPRESSION_HEADS.has(name)
}

// the literal text inside a `<...>` node
function textOf(node: {
  parts: { kind: string; text?: string }[]
}): string {
  return node.parts
    .map(p => (p.kind === 'chunk' ? (p.text ?? '') : ''))
    .join('')
}

// turn a free-text phrase into a slug name (`<two is below five>` -> `two-is-below-five`), so a hold or rule can be
// named with a readable phrase instead of a kebab identifier
function slugify(phrase: string): string {
  return (
    phrase
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'hold'
  )
}

function rest(group: GroupNode): Node[] {
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

      return chunk?.kind === 'chunk' ? chunk.token.span : ZERO_SPAN
    }

    case 'chunk':
      return node.token.span

    case 'group': {
      const head = node.nodes[0]

      if (!head) {
        return ZERO_SPAN
      }

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
  const diagnostics: Diagnostic[] = []

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
          // unescape the literal's escape sequences: the delimiters (`\<` `\>` `\{` `\}`, kept in the chunk so the
          // bracket is content, not a delimiter) and the standard characters (`\n` `\r` `\t` `\\`). This lets a
          // native bind expression carry an arrow (`=>` / `->`) or a stray `>` as `\>` without closing the
          // `text <...>` literal, and a plain program build newlines and tabs without a native helper.
          value: node.parts
            .map(p => (p.kind === 'chunk' ? p.text : ''))
            .join('')
            .replace(/\\([<>{}nrt\\])/g, (_, ch: string) =>
              ch === 'n'
                ? '\n'
                : ch === 'r'
                  ? '\r'
                  : ch === 't'
                    ? '\t'
                    : ch,
            ),
          span,
        }
      case 'group':
        return groupExpression(node, scope)
      default:
        fail(node, 'this is not a valid expression')

        return { form: 'unit', span }
    }
  }

  // `link` CHAINING: a value expression may carry `link <fn>` children, each piping the running value in as the first
  // argument of <fn> (with any extra `bind`/positional args following). `call f, x / link g / link h` reads top-down as
  // h(g(f(x))), flattening nested calls. The links are stripped before the base is built, then folded back on in order.
  function groupExpression(
    group: GroupNode,
    scope: Set<string>,
  ): Expression {
    // chain `link`s follow the base's primary argument, so they never sit at rest[0]. Skipping rest[0] leaves a `link`
    // CONSTRUCTOR (`make link ...`, where `link` names a variant) alone, since there it is the head argument, not a pipe.
    const links = rest(group)
      .slice(1)
      .filter(
        (n): n is GroupNode =>
          n.kind === 'group' && headName(n) === 'link',
      )

    if (links.length === 0) {
      return groupExpressionCore(group, scope)
    }

    const baseGroup: GroupNode = {
      ...group,
      nodes: group.nodes.filter(n => !links.includes(n as GroupNode)),
    }

    let value = groupExpressionCore(baseGroup, scope)

    for (const linkGroup of links) {
      value = applyLink(value, linkGroup, scope)
    }

    return value
  }

  // fold one `link <fn>[, extra...]` onto the running value: fn(value, ...extra). Extra args are positional, or the
  // values of any `bind <name>, <value>` children (the name is documentation; the call itself is positional).
  function applyLink(
    value: Expression,
    linkGroup: GroupNode,
    scope: Set<string>,
  ): Expression {
    const parts = rest(linkGroup)
    const fnNode = parts[0]
    const fnName =
      fnNode?.kind === 'group' ? headName(fnNode) ?? '' : ''
    const span = spanOf(linkGroup)

    const extra = parts.slice(1).map((part): Expression => {
      if (part.kind === 'group' && headName(part) === 'bind') {
        const bound = rest(part)[1]

        return bound
          ? toExpression(bound, scope)
          : ({ form: 'unit', span: spanOf(part) })
      }

      return toExpression(part, scope)
    })

    return {
      form: 'call',
      callee: {
        form: 'variable',
        name: fnName,
        span: fnNode ? spanOf(fnNode) : span,
      },
      args: [value, ...extra],
      span,
    }
  }

  function groupExpressionCore(
    group: GroupNode,
    scope: Set<string>,
  ): Expression {
    const keyword = headName(group)
    const args = rest(group)
    const span = spanOf(group)

    switch (keyword) {
      // `code` is the universal literal: numbers (`code 1`, `code -1.2`, hex `code 0xaa12`, binary `code 0b1010`,
      // octal `code 0o17`, unicode `code 0u1234`) and the booleans `code true` / `code false`.
      case 'code': {
        const arg = args[0]

        if (arg?.kind === 'group') {
          const word = headName(arg)

          if (word === 'true' || word === 'false') {
            return { form: 'boolean', value: word === 'true', span }
          }
        }

        return arg
          ? toExpression(arg, scope)
          : { form: 'integer', value: 0, span }
      }

      // bare boolean literals: `true` / `false` (and the equivalent `code true` / `code false`)
      case 'true':
        return { form: 'boolean', value: true, span }
      case 'false':
        return { form: 'boolean', value: false, span }
      // the host null literal: `null`, for the dynamic / host boundary
      case 'null':
        return { form: 'null', span }

      case 'text': {
        const value = args[0]

        if (value?.kind === 'text') {
          return toExpression(value, scope)
        }

        if (value?.kind === 'integer') {
          return { form: 'string', value: String(value.value), span }
        }

        return { form: 'string', value: '', span }
      }

      case 'term': {
        // an atom / symbol literal: `term infinity` is the symbol "infinity" (represented as a string)
        const atom =
          args[0]?.kind === 'group' ? headName(args[0]) : undefined

        return { form: 'string', value: atom ?? '', span }
      }

      case 'loan':
      case 'move':

      case 'read': {
        const target = args[0]
        const name =
          target?.kind === 'group' ? headName(target) : undefined

        return pathExpression(name ?? '', span)
      }


      // boolean conjunction / disjunction: `meet and / <a> / <b> / ...` folds its operands with `&&`, `meet or` with
      // `||`. The operands are the children after the `and` / `or` marker. (The `call and` / `call or` builtin forms
      // still work; `meet` is the clean keyword surface.)
      case 'meet': {
        const variant =
          args[0]?.kind === 'group' ? headName(args[0]) : undefined

        const op: BinaryOp = variant === 'or' ? '||' : '&&'
        const operands = args
          .slice(1)
          .map(node => toExpression(node, scope))

        if (operands.length === 0) {
          return { form: 'boolean', value: variant !== 'or', span }
        }

        return operands.reduce((left, right) => ({
          form: 'binary',
          op,
          left,
          right,
          span,
        }))
      }

      case 'make':
        return makeExpression(group, scope)

      case 'task': {
        // a function literal / callback value: `task <name> / take ... / like ... / <body>`. The name is cosmetic
        // for a value position; params come from `take`, the body from the remaining statements.
        const decl = args.slice(1)
        const params: { name: string; type?: Type }[] = []

        for (const child of decl) {
          if (child.kind !== 'group' || headName(child) !== 'take') {
            continue
          }

          const varGroup = rest(child)[0]
          const paramName =
            varGroup?.kind === 'group' ? headName(varGroup) : undefined

          if (!paramName) {
            continue
          }

          const likeGroup = rest(child).find(
            (n): n is GroupNode =>
              n.kind === 'group' && headName(n) === 'like',
          )

          let paramType = likeGroup ? parseLikeType(likeGroup) : undefined

          // value-index / type arguments given as `head <...>` siblings of the `like` group, as the task-param and rule
          // binder parsers do: `take pf, like lt / head / read m / head / make zero` makes `pf : lt m zero`. Without this
          // a dependent closure parameter loses its indices, so an indexed-family match in the body cannot invert.
          if (paramType && paramType.kind === 'named') {
            const headChildren = rest(child).filter(
              (n): n is GroupNode =>
                n.kind === 'group' &&
                n !== likeGroup &&
                headName(n) === 'head' &&
                rest(n)[0]?.kind === 'group',
            )

            const headTypeArgs: Type[] = []
            const headValueArgs: Expression[] = []

            for (const n of headChildren) {
              const arg = rest(n)[0] as GroupNode

              if (isValueExpressionHead(headName(arg))) {
                headValueArgs.push(toExpression(arg, new Set<string>()))
              } else {
                headTypeArgs.push(parseType(arg))
              }
            }

            if (headTypeArgs.length > 0) {
              paramType = {
                ...paramType,
                args: [...(paramType.args ?? []), ...headTypeArgs],
              }
            }

            if (headValueArgs.length > 0) {
              paramType = {
                ...paramType,
                valueArgs: [
                  ...(paramType.valueArgs ?? []),
                  ...headValueArgs,
                ],
              }
            }
          }

          params.push(
            paramType
              ? { name: paramName, type: paramType }
              : { name: paramName },
          )
        }

        const inner = new Set(scope)

        for (const p of params) {
          inner.add(p.name)
        }

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

        if (resultLike) {
          closure.result = parseLikeType(resultLike)
        }

        // async is marked by `note async` (or retired `mark async`) or a direct `wait true` (mirrors the task rule)
        const closureMarkedAsync = decl.some(n =>
          isAnnotation(n, 'async'),
        )

        if (closureMarkedAsync || decl.some(isWaitTrue)) {
          closure.async = true
        }

        return closure
      }

      case 'fork': {
        // a conditional in value position: `fork test / hook test <cond> / hook hold <value> / hook miss <else>`.
        // `fork case` (a match) is not yet supported as a value, so it falls through to the generic call path below.
        const variant =
          args[0]?.kind === 'group' ? headName(args[0]) : undefined

        // `fork lack / <bool>` is boolean negation: it sits in the fork family next to `fork test` and `fork case`,
        // and lowers to a unary `!` of its operand. The operand is the expression after the `lack` marker.
        if (variant === 'lack') {
          const operand = args[1]
            ? toExpression(args[1], scope)
            : { form: 'boolean' as const, value: false, span }

          return { form: 'unary', op: '!', operand, span }
        }

        if (variant !== 'case') {
          const branches: {
            cond: Expression
            value: Expression
          }[] = []

          let otherwise: Expression | undefined
          let pendingCond: Expression | undefined

          const valueOf = (nodes: Node[]): Expression =>
            nodes[0]
              ? toExpression(nodes[0], scope)
              : { form: 'unit', span }

          for (const child of args) {
            if (child.kind !== 'group' || headName(child) !== 'hook') {
              continue
            }

            const inner = rest(child)
            const variantName =
              inner[0]?.kind === 'group'
                ? headName(inner[0])
                : undefined

            const bodyNodes = inner.slice(1)

            if (variantName === 'test') {
              if (pendingCond) {
                branches.push({
                  cond: pendingCond,
                  value: { form: 'unit', span },
                })
              }

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
                value: valueOf(bodyNodes),
              })
              pendingCond = undefined
            } else if (variantName === 'miss') {
              if (pendingCond) {
                branches.push({
                  cond: pendingCond,
                  value: { form: 'unit', span },
                })
                pendingCond = undefined
              }

              otherwise = valueOf(bodyNodes)
            }
          }

          if (pendingCond) {
            branches.push({
              cond: pendingCond,
              value: { form: 'unit', span },
            })
          }

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
        if (keyword !== undefined && args.length === 0) {
          return { form: 'variable', name: keyword, span }
        }

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
      target?.kind === 'group' ? headName(target) : undefined

    const span = spanOf(group)
    // `wait true` forces an await; `wait false` is fire-and-forget (never awaited). Neither is an argument. A bare call
    // is auto-awaited later by async resolution when the callee turns out to be async.
    const awaited = parts.slice(1).some(isWaitTrue)
    const background = parts.slice(1).some(isWaitFalse)
    const callArgs = parts
      .slice(1)
      .filter(a => !isWaitTrue(a) && !isWaitFalse(a))
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
      const callee: Expression = calleeName?.includes('/')
        ? pathExpression(calleeName, span)
        : { form: 'variable', name: calleeName ?? '', span }

      result = {
        form: 'call',
        callee,
        args: callArgs,
        span,
        ...(background ? { background: true } : {}),
      }
    }

    return awaited ? { form: 'await', expr: result, span } : result
  }

  // build a relation expression from a flat list of parts: the first is the relation (callee), the rest its structured
  // arguments. Used by the `rule` DSL for a `take` hypothesis (`take h, twin, bond a b, bond e f`), where the
  // proposition is the parts after the binder name. Mirrors callExpression but over a list, not a group.
  function callExpressionFrom(
    parts: Node[],
    scope: Set<string>,
    span: Span,
  ): Expression {
    const target = parts[0]
    const calleeName =
      target?.kind === 'group' ? headName(target) : undefined

    const callArgs = parts.slice(1).map(a => toExpression(a, scope))

    if (
      calleeName &&
      calleeName in BINARY_BUILTIN &&
      callArgs.length === 2
    ) {
      return {
        form: 'binary',
        op: BINARY_BUILTIN[calleeName]!,
        left: callArgs[0]!,
        right: callArgs[1]!,
        span,
      }
    }

    const callee: Expression = calleeName?.includes('/')
      ? pathExpression(calleeName, span)
      : { form: 'variable', name: calleeName ?? '', span }

    return { form: 'call', callee, args: callArgs, span }
  }

  // negate a goal for `show miss` (prove the claim FALSE): flip an order comparison to its exact negation, otherwise
  // wrap the whole claim in a logical not. The order flips are not(a > b) = a <= b, not(a < b) = a >= b, and so on, so
  // a refuted order comparison stays inside the decidable linear fragment the prover handles.
  function negateGoal(claim: Expression, span: Span): Expression {
    if (claim.form === 'binary') {
      const flip: Partial<Record<BinaryOp, BinaryOp>> = {
        '>': '<=',
        '<': '>=',
        '>=': '<',
        '<=': '>',
      }

      const flipped = flip[claim.op]

      if (flipped) {
        return { ...claim, op: flipped }
      }
    }

    return { form: 'unary', op: '!', operand: claim, span }
  }

  // make list / make find / make <form>
  function makeExpression(
    group: GroupNode,
    scope: Set<string>,
  ): Expression {
    const parts = rest(group)
    const kindNode = parts[0]
    const kind =
      kindNode?.kind === 'group' ? headName(kindNode) : undefined

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
          const key = keyNode?.kind === 'group' ? headName(keyNode) : ''

          const valueNode = inner[1]

          return {
            key: {
              form: 'string' as const,
              value: key ?? '',
              span,
            },
            value: valueNode
              ? toExpression(valueNode, scope)
              : { form: 'unit' as const, span },
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
          fieldNode?.kind === 'group' ? headName(fieldNode) : ''

        const valueNode = inner[1]

        return {
          name: fieldName ?? '',
          value: valueNode
            ? toExpression(valueNode, scope)
            : { form: 'unit' as const, span },
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
  function hooks(group: GroupNode): Map<string, Node[]> {
    const map = new Map<string, Node[]>()

    for (const child of rest(group)) {
      if (child.kind !== 'group' || headName(child) !== 'hook') {
        continue
      }

      const inner = rest(child)
      const variant = inner[0]
      const hookName =
        variant?.kind === 'group' ? headName(variant) : undefined

      if (hookName) {
        map.set(hookName, inner.slice(1))
      }
    }

    return map
  }

  // mint: build statements from a list of groups
  function toStatements(
    nodes: Node[],
    scope: Set<string>,
  ): Statement[] {
    const out: Statement[] = []

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
        case 'head':
        case 'wear':
        case 'wait':
        // `name <X>` is a foreign / display-name annotation (the JS name a binding maps to), never an executable
        // statement. Without this it would fall to the default case and mill as a bare `name` variable reference.
        case 'name':
          break

        case 'save': {
          const args = rest(node)
          const target = args[0]
          const name =
            target?.kind === 'group' ? headName(target) : undefined

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

            if (saveLike) {
              saveLet.type = parseLikeType(saveLike)
            }

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

          // optional inline name, either a bare word (`hold double-fact`) or a readable phrase (`hold <double is
          // add>`); both make the hold a citable lemma, with the phrase slugified to an identifier.
          let nameValue: string | undefined
          let propIndex = 0

          const first = parts[0]

          if (parts.length > 1 && first?.kind === 'text') {
            nameValue = slugify(textOf(first))
            propIndex = 1
          } else if (
            parts.length > 1 &&
            first?.kind === 'group' &&
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

            if (nameValue) {
              holdStatement.name = nameValue
            }

            if (proof.length > 0) {
              holdStatement.proof = proof
            }

            out.push(holdStatement)
          }

          break
        }

        // a `rule` is a named theorem or axiom, the structured proof DSL (note/library/seed/proof-checking/
        // 08-structured-rule-dsl.md). Its body is `mark` (universal binders), `take` (hypotheses), `show` (the goal as a
        // 4-letter relation applied to structured terms), and either `base true` (an AXIOM, postulated) or a proof body
        // (`fold` / `case` / `calm` / `melt` / `cite` / `find` / `have`). It desugars to a function whose parameters are
        // the binders, so the goal is checked as a universal law over them by the same prover stack `hold` uses: a
        // theorem becomes a checked `hold`, an axiom becomes a `host` binding of the (postulated) claim, keeping every
        // detail in code with no arbitrary strings.
        case 'rule': {
          const ruleParts = rest(node)

          let ruleName = 'rule'
          let startIndex = 0

          const ruleFirst = ruleParts[0]

          if (ruleFirst?.kind === 'text') {
            ruleName = slugify(textOf(ruleFirst))
            startIndex = 1
          } else if (
            ruleFirst?.kind === 'group' &&
            rest(ruleFirst).length === 0
          ) {
            ruleName = headName(ruleFirst) ?? 'rule'
            startIndex = 1
          }

          const ruleBody = ruleParts
            .slice(startIndex)
            .filter((n): n is GroupNode => n.kind === 'group')

          const PROOF_HEADS = new Set([
            'fold',
            'case',
            'calm',
            'melt',
            'cite',
            'meet',
            'fork',
            'hint',
            'turn',
            'auto',
          ])

          const ruleParams: {
            name: string
            type?: Type
            refine?: 'natural'
          }[] = []

          const ruleScope = new Set(scope)
          const hypotheses: { name?: string; expr: Expression }[] = []
          // existential witnesses: `find x, like T` / <witness> binds x to the supplied witness, so the goal P(x) is
          // checked at that concrete value. This is the backwards-E (there exists) to `mark`'s upside-down-A (for all).
          const witnesses: { name: string; value: Expression }[] = []

          let goal: Expression | undefined
          let isAxiom = false

          const ruleProof: Proof[] = []

          // pull a `mark x, like T` / `take h, ...` binder name and optional `like` type from a child
          const binderOf = (
            part: GroupNode,
          ):
            | {
                name: string
                type?: Type
                refine?: 'natural'
              }
            | undefined => {
            const varGroup = rest(part)[0]
            const pname =
              varGroup?.kind === 'group'
                ? headName(varGroup)
                : undefined

            if (!pname) {
              return undefined
            }

            const likeGroup = rest(part).find(
              (n): n is GroupNode =>
                n.kind === 'group' && headName(n) === 'like',
            )

            if (!likeGroup) {
              return { name: pname }
            }

            // detect the `natural-number` refinement from the RAW type node (parseLikeType maps it to the plain number
            // type, losing the name), exactly as the task-param parser does, so the n >= 0 bound reaches the prover.
            const typeNode = rest(likeGroup)[0]
            const refine =
              typeNode?.kind === 'group' &&
              headName(typeNode) === 'natural-number'
                ? ('natural' as const)
                : undefined

            let type = parseLikeType(likeGroup)

            // value-index / type arguments given as `head <...>` siblings of the `like` group, exactly as the task-param
            // parser does: `mark v, like vecnat / head / read n` makes `v : vecnat n`. Without this the index is dropped
            // and `fold v` cannot refine it (the general indexed-family / vector laws).
            if (type && type.kind === 'named') {
              const headChildren = rest(part).filter(
                (n): n is GroupNode =>
                  n.kind === 'group' &&
                  n !== likeGroup &&
                  headName(n) === 'head' &&
                  rest(n)[0]?.kind === 'group',
              )

              const headTypeArgs: Type[] = []
              const headValueArgs: Expression[] = []

              for (const n of headChildren) {
                const arg = rest(n)[0] as GroupNode

                if (isValueExpressionHead(headName(arg))) {
                  headValueArgs.push(toExpression(arg, new Set<string>()))
                } else {
                  headTypeArgs.push(parseType(arg))
                }
              }

              if (headTypeArgs.length > 0) {
                type = { ...type, args: [...(type.args ?? []), ...headTypeArgs] }
              }

              if (headValueArgs.length > 0) {
                type = {
                  ...type,
                  valueArgs: [...(type.valueArgs ?? []), ...headValueArgs],
                }
              }
            }

            return {
              name: pname,
              type,
              ...(refine ? { refine } : {}),
            }
          }

          for (const part of ruleBody) {
            const partHead = headName(part)

            if (partHead === 'mark') {
              const binder = binderOf(part)

              if (binder) {
                const param: {
                  name: string
                  type?: Type
                  refine?: 'natural'
                } = { name: binder.name }

                if (binder.type) {
                  param.type = binder.type
                }

                if (binder.refine) {
                  param.refine = binder.refine
                }

                ruleParams.push(param)
                ruleScope.add(binder.name)
              }
            } else if (partHead === 'have' || partHead === 'take') {
              // a HYPOTHESIS (an antecedent / assumption). `have h` reads "we have h", the assumption named h; `take` is
              // kept as an alias. The name is a label, not a universal variable (those are `mark`). The proposition is
              // the parts after the name: a single nested child is an expression (`have h` / `call twin` / ...), several
              // parts on one line are a relation applied to terms (`have h, twin, bond a b, bond c d`).
              const binder = binderOf(part)
              const propParts = rest(part)
                .slice(1)
                .filter((n): n is GroupNode => n.kind === 'group')

              let prop: Expression | undefined

              if (propParts.length === 1) {
                prop = toExpression(propParts[0]!, ruleScope)
              } else if (propParts.length > 1) {
                prop = callExpressionFrom(
                  propParts,
                  ruleScope,
                  spanOf(part),
                )
              }

              if (prop) {
                hypotheses.push(
                  binder
                    ? { name: binder.name, expr: prop }
                    : { expr: prop },
                )
              }
            } else if (partHead === 'show') {
              let showKids = rest(part).filter(
                (n): n is GroupNode => n.kind === 'group',
              )

              // `show` carries a MODE second term: `show hold` (prove the claim true) or `show miss` (prove it false),
              // mirroring `want hold` / `want miss`. The mode is the first child; the claim is the rest. A bare `show`
              // (no mode) defaults to `hold`.
              const firstHead = showKids[0]
                ? headName(showKids[0])
                : undefined

              const showMode =
                firstHead === 'miss'
                  ? 'miss'
                  : firstHead === 'hold'
                    ? 'hold'
                    : undefined

              if (showMode) {
                showKids = showKids.slice(1)
              }

              // the claim itself: a single nested expression, or a relation applied to args on one line
              const claim =
                showKids.length === 1
                  ? toExpression(showKids[0]!, ruleScope)
                  : callExpressionFrom(
                      showKids,
                      ruleScope,
                      spanOf(part),
                    )

              // `miss` proves the claim FALSE: flip an order comparison to its negation, else logical-not it
              goal =
                showMode === 'miss'
                  ? negateGoal(claim, spanOf(part))
                  : claim
            } else if (partHead === 'find') {
              // an EXISTENTIAL witness: `find x, like T` plus a witness expression. Binds x to the witness, so the goal
              // P(x) is checked at that concrete value (proving "there exists x such that P").
              const binder = binderOf(part)

              if (binder) {
                const likeGroup = rest(part).find(
                  (n): n is GroupNode =>
                    n.kind === 'group' && headName(n) === 'like',
                )

                const witnessNode = rest(part)
                  .slice(1)
                  .find(
                    (n): n is GroupNode =>
                      n.kind === 'group' && n !== likeGroup,
                  )

                if (witnessNode) {
                  witnesses.push({
                    name: binder.name,
                    value: toExpression(witnessNode, ruleScope),
                  })
                  ruleScope.add(binder.name)
                }
              }
            } else if (partHead === 'base') {
              isAxiom = true
            } else if (PROOF_HEADS.has(partHead ?? '')) {
              ruleProof.push(parseProof(part))
            }
          }

          // bind every existential witness first, so the goal can reference it
          const witnessStatements: Statement[] = witnesses.map(w => ({
            form: 'let',
            mutable: false,
            name: w.name,
            init: w.value,
            span,
          }))

          const ruleStatements: Statement[] = [...witnessStatements]

          if (goal) {
            if (isAxiom) {
              // an AXIOM: postulated, not proved. Bind each hypothesis and the claim (kept in code, type-checked
              // against the relation layer) so the antecedents and conclusion are real and structured.
              hypotheses.forEach((hyp, i) => {
                ruleStatements.push({
                  form: 'let',
                  mutable: false,
                  name: hyp.name ?? `claim_${i}`,
                  init: hyp.expr,
                  span,
                })
              })
              ruleStatements.push({
                form: 'let',
                mutable: false,
                name: 'claim',
                init: goal,
                span,
              })
            } else {
              // a THEOREM: the goal is checked as a universal law over the binders. Each `have` hypothesis becomes a
              // path assumption: the goal `hold` is wrapped in nested `if (hyp)` guards, so the prover assumes every
              // antecedent when discharging the conclusion (this is how an implication is proved).
              const holdStatement: Statement = {
                form: 'hold',
                name: ruleName,
                expr: goal,
                span,
              }

              if (ruleProof.length > 0) {
                holdStatement.proof = ruleProof
              }

              let body: Statement[] = [holdStatement]

              for (let i = hypotheses.length - 1; i >= 0; i--) {
                body = [
                  {
                    form: 'if',
                    branches: [{ cond: hypotheses[i]!.expr, body }],
                    span,
                  },
                ]
              }

              ruleStatements.push(...body)
            }
          }

          ruleStatements.push({
            form: 'return',
            value: ruleParams[0]
              ? pathExpression(ruleParams[0].name, span)
              : { form: 'unit', span },
            span,
          })

          out.push({
            form: 'function',
            name: ruleName,
            params: ruleParams,
            body: ruleStatements,
            generics: [],
            span,
          })

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
          const sendVariant =
            backGroup?.kind === 'group'
              ? headName(backGroup)
              : undefined

          if (sendVariant === 'back') {
            const value =
              rest(node)[1] ?? rest(backGroup as GroupNode)[0]

            out.push({
              form: 'return',
              value: value ? toExpression(value, scope) : undefined,
              span,
            })
          } else if (sendVariant === 'kink') {
            // `send kink <kink>`: raise a recoverable error. The error-channel counterpart to `send back` -- it
            // returns the result's `error` arm wrapping the kink the user constructed. The enclosing task must return
            // a `result`. See note/library/seed/error-model.md.
            const value =
              rest(node)[1] ?? rest(backGroup as GroupNode)[0]

            out.push({
              form: 'return',
              value: {
                form: 'record',
                name: 'error',
                fields: [
                  {
                    name: 'value',
                    value: value
                      ? toExpression(value, scope)
                      : { form: 'unit', span },
                  },
                ],
                span,
              },
              span,
            })
          } else {
            fail(node, 'send must be followed by back or kink')
          }

          break
        }

        case 'host': {
          const hostArgs = rest(node)
          const target = hostArgs[0]
          const name =
            target?.kind === 'group' ? headName(target) : undefined

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

          if (hostLike) {
            hostLet.type = parseLikeType(hostLike)
          }

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

            if (foreignNode?.kind === 'text') {
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

        // `move next` is continue. A bare `move <ref>` statement (a reference move used for effect) stays an
        // expression statement, so only `move next` is intercepted here.
        case 'move': {
          const arg = rest(node)[0]

          if (arg?.kind === 'group' && headName(arg) === 'next') {
            out.push({ form: 'continue', span })
            break
          }

          out.push({
            form: 'expression',
            expr: toExpression(node, scope),
            span,
          })
          break
        }

        // `halt` (and `halt fork`) break the current loop or block. `halt flow` (program exit) and `halt code`
        // (debugger) are distinguished by their argument.
        case 'halt': {
          const arg = rest(node)[0]
          const which =
            arg?.kind === 'group' ? headName(arg) : undefined

          if (which === 'flow') {
            out.push({ form: 'exit', span })
          } else if (which === 'code') {
            out.push({ form: 'debug', span })
          } else {
            out.push({ form: 'break', span })
          }

          break
        }

        case 'walk': {
          const parts = rest(node)
          const variant =
            parts[0]?.kind === 'group' ? headName(parts[0]) : undefined

          if (variant === 'list') {
            const iterable: Expression = parts[1]
              ? toExpression(parts[1], scope)
              : { form: 'unit', span }

            const nextBody = hooks(node).get('next') ?? []

            let item = 'item'
            let bodyNodes = nextBody

            const first = nextBody[0]

            if (first?.kind === 'group' && headName(first) === 'take') {
              const nameGroup = rest(first)[1]

              if (
                nameGroup?.kind === 'group' &&
                headName(nameGroup) === 'name'
              ) {
                const itemGroup = rest(nameGroup)[0]

                if (itemGroup?.kind === 'group') {
                  item = headName(itemGroup) ?? 'item'
                }
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

          const cond: Expression = condNodes?.[0]
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
            parts[0]?.kind === 'group' ? headName(parts[0]) : undefined

          if (variant === 'case') {
            // `fork case, <subject>` with `case <label>` arms: a pattern match on an enum
            const subject: Expression = parts[1]
              ? toExpression(parts[1], scope)
              : { form: 'unit', span }

            const cases: {
              label: string
              body: Statement[]
            }[] = []

            let otherwise: Statement[] | undefined

            for (const arm of parts.slice(2)) {
              if (arm.kind !== 'group' || headName(arm) !== 'case') {
                continue
              }

              const labelGroup = rest(arm)[0]
              const label =
                labelGroup?.kind === 'group'
                  ? headName(labelGroup)
                  : undefined

              if (label === 'else') {
                otherwise = toStatements(
                  rest(arm).slice(1),
                  new Set(scope),
                )
              } else if (label) {
                // leading `link <name>` groups rename the variant's fields (in order), so a nested match on the same
                // enum can bind both without the field names colliding. The rest after them is the branch body.
                const armParts = rest(arm).slice(1)
                const binds: string[] = []

                let bodyStart = 0

                for (const part of armParts) {
                  if (
                    part.kind === 'group' &&
                    headName(part) === 'link'
                  ) {
                    const nameGroup = rest(part)[0]
                    const bindName =
                      nameGroup?.kind === 'group'
                        ? headName(nameGroup)
                        : undefined

                    if (bindName) {
                      binds.push(bindName)
                      bodyStart++
                      continue
                    }
                  }

                  break
                }

                const branchScope = new Set(scope)

                for (const bindName of binds) {
                  branchScope.add(bindName)
                }

                const branch: {
                  label: string
                  body: Statement[]
                  binds?: string[]
                } = {
                  label,
                  body: toStatements(
                    armParts.slice(bodyStart),
                    branchScope,
                  ),
                }

                if (binds.length > 0) {
                  branch.binds = binds
                }

                cases.push(branch)
              }
            }

            out.push({ form: 'match', subject, cases, otherwise, span })
            break
          }

          // walk the hooks in order, pairing each `hook test` with the `hook hold` that follows it. This builds the
          // full if / else-if chain (multiple test/hold pairs), with `hook miss` as the final else. A lone `hook hold`
          // (no preceding test) defaults to an always-true branch.
          const branches: {
            cond: Expression
            body: Statement[]
          }[] = []

          let otherwise: Statement[] | undefined
          let pendingCond: Expression | undefined

          for (const child of rest(node)) {
            if (child.kind !== 'group' || headName(child) !== 'hook') {
              continue
            }

            const inner = rest(child)
            const variantName =
              inner[0]?.kind === 'group'
                ? headName(inner[0])
                : undefined

            const bodyNodes = inner.slice(1)

            if (variantName === 'test') {
              // a `hook test` with no following `hook hold` still becomes a branch (with an empty body), so a bare
              // `test` + `miss` lowers to `if (cond) {} else {...}` rather than an invalid otherwise-only `if`
              if (pendingCond) {
                branches.push({ cond: pendingCond, body: [] })
              }

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

          if (pendingCond) {
            branches.push({ cond: pendingCond, body: [] })
          }

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
  function parseTaskParams(body: Node[]): {
    name: string
    type?: Type
    refine?: 'natural'
    optional?: boolean
  }[] {
    const params: {
      name: string
      type?: Type
      refine?: 'natural'
      optional?: boolean
    }[] = []

    for (const statement of body) {
      if (
        statement.kind === 'group' &&
        headName(statement) === 'take'
      ) {
        const varGroup = rest(statement)[0]
        const paramName =
          varGroup?.kind === 'group' ? headName(varGroup) : undefined

        if (!paramName) {
          continue
        }

        const likeGroup = rest(statement).find(
          (n): n is GroupNode =>
            n.kind === 'group' && headName(n) === 'like',
        )

        const typeNode = likeGroup ? rest(likeGroup)[0] : undefined
        // honor the declared type (a first-class task type is parsed structurally), and detect a natural refinement
        let type = likeGroup ? parseLikeType(likeGroup) : undefined

        // type arguments to a polymorphic parameter given as `head <type>` children of the TAKE (siblings of the `like`
        // group): `take s, like stack / head natural` makes `s` a `stack natural`. `parseLikeType` only sees the `like`
        // group, so these take-level siblings are attached here, mirroring the `form x / head a` declaration.
        if (type && type.kind === 'named') {
          const headChildren = rest(statement).filter(
            (n): n is GroupNode =>
              n.kind === 'group' &&
              n !== likeGroup &&
              headName(n) === 'head' &&
              rest(n)[0]?.kind === 'group',
          )

          const headTypeArgs: Type[] = []
          const headValueArgs: Expression[] = []

          for (const n of headChildren) {
            const arg = rest(n)[0] as GroupNode

            // a value expression (`head / make succ ..`, `head / read n`) is a VALUE-INDEX argument (`take v, like vec /
            // head a / head / make succ ..` makes `v : vec a (succ ..)`); a bare type name is a type argument.
            if (isValueExpressionHead(headName(arg))) {
              headValueArgs.push(toExpression(arg, new Set<string>()))
            } else {
              headTypeArgs.push(parseType(arg))
            }
          }

          if (headTypeArgs.length > 0) {
            type = { ...type, args: [...(type.args ?? []), ...headTypeArgs] }
          }

          if (headValueArgs.length > 0) {
            type = {
              ...type,
              valueArgs: [...(type.valueArgs ?? []), ...headValueArgs],
            }
          }
        }

        // a function-typed parameter written in the COMMA form (`take f, like task` then indented `take x, like nat` /
        // `like nat`) puts the callback's own params/result at the TAKE level, as siblings of the `like task` group,
        // rather than inside it -- so `parseLikeType` sees a param-less `() -> unit`. Reattach those siblings here,
        // mirroring the `head <type>` reattachment above, so the comma form matches the indented form. Guarded on an
        // empty param list, the indented form (where `parseLikeType` already found them) is left untouched.
        if (
          type &&
          type.kind === 'function' &&
          type.params.length === 0
        ) {
          const siblings = rest(statement).filter(
            (n): n is GroupNode => n.kind === 'group' && n !== likeGroup,
          )

          const fnParams = siblings
            .filter(n => headName(n) === 'take')
            .map(take => {
              const inner = rest(take).find(
                (n): n is GroupNode =>
                  n.kind === 'group' && headName(n) === 'like',
              )

              return inner ? parseLikeType(inner) : UNKNOWN
            })

          const resultLike = siblings.find(n => headName(n) === 'like')

          if (fnParams.length > 0 || resultLike) {
            type = {
              ...type,
              params: fnParams,
              result: resultLike
                ? parseLikeType(resultLike)
                : type.result,
            }
          }
        }
        const refine =
          typeNode?.kind === 'group' &&
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
          needArg?.kind === 'group' && headName(needArg) === 'false'

        const param: {
          name: string
          type?: Type
          refine?: 'natural'
          optional?: boolean
        } = { name: paramName }

        if (type) {
          param.type = type
        }

        if (refine) {
          param.refine = refine
        }

        if (optional) {
          param.optional = true
        }

        params.push(param)
      }
    }

    return params
  }

  // the return type of a task or bind: a bare `like <type>`, or a named output `free <name>, like <type>`. The bare
  // `like` wins if both are present. Shared by buildFunction and buildBind.
  function parseTaskResult(body: Node[]): Type | undefined {
    const resultLike = body.find(
      (n): n is GroupNode =>
        n.kind === 'group' && headName(n) === 'like',
    )

    // the result type's own `head <...>` value-index children (the indented `like eq / head / read a / head / read b`
    // form) are now attached by `parseLikeType` itself, so a task returning an indexed `eq n n` / `vecnat n` is typed
    // correctly without a second attachment here (which would DOUBLE the indices).
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

      if (likeInFree) {
        resultType = parseLikeType(likeInFree)
      }
    }

    return resultType
  }

  // a TOP-LEVEL `host <name>, <value>` is a named constant, sugar for a nullary function that returns the value. It is
  // far terser than the `task <name> / like <T> / send back / <value>` it expands to, and unlike a top-level `let` it is
  // a real definition that computes in proofs and reads as a value. The result type comes from an optional `like <T>`,
  // else it is inferred from a literal value. Returns undefined for a value-less foreign host global (`host x, name <Y>`),
  // which stays an ambient binding handled by the body builder.
  function buildHostConstant(group: GroupNode): Statement | undefined {
    const args = rest(group)
    const target = args[0]
    const name = target?.kind === 'group' ? headName(target) : undefined

    if (!name) {
      return undefined
    }

    const valueNode = args
      .slice(1)
      .find(
        a =>
          !(
            a.kind === 'group' && HOST_ANNOTATION.has(headName(a) ?? '')
          ),
      )

    // no value: a foreign host global, not a constant. Let the body builder handle it as an ambient binding.
    if (!valueNode) {
      return undefined
    }

    const value = toExpression(valueNode, new Set<string>())

    const likeNode = args
      .slice(1)
      .find(
        (a): a is GroupNode =>
          a.kind === 'group' && headName(a) === 'like',
      )

    let result: Type | undefined

    if (likeNode) {
      result = parseLikeType(likeNode)
    } else if (value.form === 'integer') {
      result = { kind: 'named', name: 'integer' }
    } else if (value.form === 'float') {
      result = { kind: 'named', name: 'number' }
    } else if (value.form === 'string') {
      result = { kind: 'named', name: 'text' }
    } else if (value.form === 'boolean') {
      result = { kind: 'named', name: 'boolean' }
    }

    // a named constant binds the term `name` directly to the value `value` (a number, string, list, record, function
    // value -- anything). It is an immutable top-level `let` (`const name = value`), NOT a nullary function: `read name`
    // then yields the value itself, and a `make list` / `make <record>` constant is a single shared singleton evaluated
    // once (so a module-level stack / cell is one cell, not a fresh one per read).
    return {
      form: 'let',
      name,
      init: value,
      mutable: false,
      span: spanOf(group),
      ...(result ? { type: result } : {}),
    }
  }

  function buildFunction(group: GroupNode): Statement | undefined {
    const parts = rest(group)
    const nameGroup = parts[0]
    const name =
      nameGroup?.kind === 'group' ? headName(nameGroup) : undefined

    const span = spanOf(group)

    if (!name) {
      // a computed / symbol-keyed method (e.g. `task {symbol/iterator}` from `[Symbol.iterator]()` in a generated
      // binding) has no plain identifier name; it is not callable by name in seed, so skip it silently. Only a
      // genuinely empty `task` (no head at all) is an error.
      if (nameGroup) {
        return undefined
      }

      fail(group, 'task needs a name')

      return undefined
    }

    const body = parts.slice(1)
    // generic type parameters: `head t` or `head t, need <mask>`
    const generics: { name: string; need?: string }[] = []

    for (const statement of body) {
      if (
        statement.kind === 'group' &&
        headName(statement) === 'head'
      ) {
        const inner = rest(statement)
        const gName =
          inner[0]?.kind === 'group' ? headName(inner[0]) : undefined

        if (!gName) {
          continue
        }

        const needGroup = inner.find(
          (n): n is GroupNode =>
            n.kind === 'group' && headName(n) === 'need',
        )

        const need = needGroup
          ? rest(needGroup)[0]?.kind === 'group'
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
    // the bare `like` (result type), `free` (named output), `mark` (modifiers like `mark private`), and `note`
    // (`note async` / `note private` / documentation) are all consumed here, so only real statements (send back,
    // save, call, fork, ...) remain. `name <X>` is the task's foreign / display name (the JS method name a generated
    // binding maps to), not an executable statement. All are signature annotations, never executable.
    const SIGNATURE = new Set([
      'head',
      'take',
      'like',
      'free',
      'mark',
      'note',
      'name',
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

    if (resultType) {
      fn.result = resultType
    }

    // async is marked by `wait true` or `note async` (or retired `mark async`)
    const markedAsync = body.some(n => isAnnotation(n, 'async'))

    if (markedAsync || body.some(isWaitTrue)) {
      fn.async = true
    }

    // visibility: `note private` (or retired `mark private`) makes the definition module-internal
    if (body.some(n => isAnnotation(n, 'private'))) {
      fn.private = true
    }

    return fn
  }

  // a declarative native binding: `bind <name>` with `take`/`like` signature lines and one `case <env>` block per
  // backend, each holding a `text <native expression>` (with `$param` placeholders) and optional `load` imports. The
  // checker registers the signature like a function; each backend renders the matching env's template at call sites.
  function buildBind(group: GroupNode): Statement | undefined {
    const parts = rest(group)
    const nameGroup = parts[0]
    const name =
      nameGroup?.kind === 'group' ? headName(nameGroup) : undefined

    const span = spanOf(group)

    if (!name) {
      fail(group, 'bind needs a name')

      return undefined
    }

    const body = parts.slice(1)
    const params = parseTaskParams(body)
    const result = parseTaskResult(body)
    const targets: {
      env: string
      expression: string
      imports: { module: string; alias?: string }[]
    }[] = []

    for (const child of body) {
      if (child.kind !== 'group' || headName(child) !== 'case') {
        continue
      }

      const envGroup = rest(child)[0]
      const env =
        envGroup?.kind === 'group' ? headName(envGroup) : undefined

      if (!env) {
        continue
      }

      // the native expression: a `text <...>` child whose chunks hold the raw target syntax
      let expression: string | undefined

      const imports: { module: string; alias?: string }[] = []

      for (const node of rest(child).slice(1)) {
        if (node.kind !== 'group') {
          continue
        }

        const head = headName(node)

        if (head === 'text') {
          const value = toExpression(node, new Set())

          if (value.form === 'string') {
            expression = value.value
          }
        } else if (head === 'load') {
          // `load <node:module>, name alias`: an import the rendered expression needs
          const moduleNode = rest(node)[0]
          const module =
            moduleNode?.kind === 'text'
              ? moduleNode.parts
                  .map(p => (p.kind === 'chunk' ? p.text : ''))
                  .join('')
              : undefined

          if (!module) {
            continue
          }

          const nameChild = rest(node).find(
            (n): n is GroupNode =>
              n.kind === 'group' && headName(n) === 'name',
          )

          const aliasGroup = nameChild ? rest(nameChild)[0] : undefined
          const alias =
            aliasGroup?.kind === 'group'
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

    if (result) {
      bind.result = result
    }

    return bind
  }

  // a mask defines a trait: the names of the method signatures it declares
  function methodNames(group: GroupNode): string[] {
    const names: string[] = []

    for (const child of rest(group)) {
      if (child.kind === 'group' && headName(child) === 'task') {
        const nameGroup = rest(child)[0]
        const m =
          nameGroup?.kind === 'group' ? headName(nameGroup) : undefined

        if (m) {
          names.push(m)
        }
      }
    }

    return names
  }

  function buildMask(group: GroupNode): Statement | undefined {
    const nameGroup = rest(group)[0]
    const name =
      nameGroup?.kind === 'group' ? headName(nameGroup) : undefined

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

  // extract trait instances from `wear <mask>` children, implemented for `target`. Besides recording the instance, the
  // method bodies are desugared the SAME way as a form's own methods (free functions `<target>_<method>` with `self`
  // typed as the target and a `method` tag for receiver dispatch), so a trait method call dispatches exactly like a
  // form method -- no separate dictionary machinery needed.
  function wearInstances(
    group: GroupNode,
    target: string,
    formParams: string[] = [],
  ): Statement[] {
    const out: Statement[] = []

    for (const child of rest(group)) {
      if (child.kind !== 'group' || headName(child) !== 'wear') {
        continue
      }

      const maskGroup = rest(child)[0]
      const mask =
        maskGroup?.kind === 'group' ? headName(maskGroup) : undefined

      if (mask) {
        out.push({
          form: 'instance',
          mask,
          target,
          methods: methodNames(child),
          span: spanOf(child),
        })
        // the implementations: methods over `target`, dispatched like the form's own methods
        out.push(...formMethods(child, target, formParams))
      }
    }

    return out
  }

  function buildSuit(group: GroupNode): Statement[] {
    const targetGroup = rest(group)[0]
    const target =
      targetGroup?.kind === 'group' ? headName(targetGroup) : undefined

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
      nameGroup?.kind === 'group' ? headName(nameGroup) : undefined

    const span = spanOf(group)

    if (!name) {
      fail(group, 'form needs a name')

      return undefined
    }

    const linkFields = (
      g: GroupNode,
    ): { name: string; type: Type; nick?: string }[] => {
      const out: { name: string; type: Type; nick?: string }[] = []

      // the field names in scope, so a value-index argument in one field's type can reference a sibling field (the
      // recursive `link rest, like vec / head a / head / read count` refers to the field `count`).
      const fieldScope = new Set<string>()

      for (const child of rest(g)) {
        if (
          child.kind === 'group' &&
          (headName(child) === 'link' || headName(child) === 'free')
        ) {
          const fieldNode = rest(child)[0]

          if (fieldNode?.kind === 'group') {
            const fieldName = headName(fieldNode)

            if (fieldName) {
              fieldScope.add(fieldName)
            }
          }
        }
      }

      for (const child of rest(g)) {
        if (
          child.kind !== 'group' ||
          (headName(child) !== 'link' && headName(child) !== 'free')
        ) {
          continue
        }

        const inner = rest(child)
        const fieldNode = inner[0]
        const fieldName =
          fieldNode?.kind === 'group' ? headName(fieldNode) : undefined

        const likeGroup = inner[1]

        let type: Type = UNKNOWN

        // parse the field type with the function-aware parser so `like task` fields are callable function types and
        // `like list` fields are native arrays, not opaque named types
        if (
          likeGroup?.kind === 'group' &&
          headName(likeGroup) === 'like'
        ) {
          type = parseLikeType(likeGroup)
        }

        // `head <arg>` siblings of the `like` group supply arguments to a parameterized field type. A bare type name
        // (`head a`) is a TYPE argument; a value expression (`head / read count`, `head / make zero`, recognised by a
        // value head) is a VALUE-INDEX argument, making a recursive `link rest, like vec / head a / head / read count`
        // mean `rest : vec a count`. Mirrors `take s, like vec / head a / head / read count`.
        if (type.kind === 'named') {
          const typeArgs: Type[] = []
          const valueArgs: Expression[] = []

          for (const c of inner) {
            if (
              c.kind !== 'group' ||
              headName(c) !== 'head' ||
              rest(c)[0]?.kind !== 'group'
            ) {
              continue
            }

            const arg = rest(c)[0] as GroupNode

            if (isValueExpressionHead(headName(arg))) {
              valueArgs.push(toExpression(arg, fieldScope))
            } else {
              typeArgs.push(parseType(arg))
            }
          }

          if (typeArgs.length > 0) {
            type = { ...type, args: [...(type.args ?? []), ...typeArgs] }
          }

          if (valueArgs.length > 0) {
            type = {
              ...type,
              valueArgs: [...(type.valueArgs ?? []), ...valueArgs],
            }
          }
        }

        // a FUNCTION-typed field written in the comma form (`link step, like task` then indented `take m / take pf /
        // like acc`) puts the function's own params + result as SIBLINGS of the `like task` group, so `parseLikeType`
        // sees a param-less `() -> unit`. Reattach them, mirroring the task-param comma-form handling, so a higher-order
        // constructor field (the `step` of an accessibility proof) has its real `(nat, lt) -> acc` type.
        if (type.kind === 'function' && type.params.length === 0) {
          const siblings = inner.filter(
            (n): n is GroupNode =>
              n.kind === 'group' &&
              n !== likeGroup &&
              n !== fieldNode,
          )

          const fnParams = siblings
            .filter(n => headName(n) === 'take')
            .map(take => {
              const innerLike = rest(take).find(
                (n): n is GroupNode =>
                  n.kind === 'group' && headName(n) === 'like',
              )

              return innerLike ? parseLikeType(innerLike) : UNKNOWN
            })

          const resultLike = siblings.find(n => headName(n) === 'like')

          if (fnParams.length > 0 || resultLike) {
            type = {
              ...type,
              params: fnParams,
              result: resultLike
                ? parseLikeType(resultLike)
                : type.result,
            }
          }
        }

        // a field's foreign `name <X>` (binding fields carry the exact native name, e.g. COLOR_BUFFER_BIT), so the
        // emitter can use it verbatim instead of camelCasing the seed name. The `<X>` is a text node (see the host
        // foreign-name reader above).
        let nick: string | undefined

        for (const c of inner) {
          if (c.kind === 'group' && headName(c) === 'name') {
            const valNode = rest(c)[0]

            if (valNode?.kind === 'text') {
              nick = valNode.parts
                .map(p => (p.kind === 'chunk' ? p.text : ''))
                .join('')
            }

            break
          }
        }

        if (fieldName) {
          out.push({ name: fieldName, type, nick })
        }
      }

      return out
    }

    const fields = linkFields(group)

    // `head <name>` children are the form's generic TYPE parameters (`form maybe / head t`); a `head <name>, like
    // <type>` (carrying a `like`) is instead a relevant VALUE INDEX (`form vec / head n, like natural-number`), making
    // this an indexed family. Type params stay erased; value indices appear in constructor result types.
    const params: string[] = []
    const indices: { name: string; type: Type }[] = []

    for (const child of parts.slice(1)) {
      if (child.kind !== 'group' || headName(child) !== 'head') {
        continue
      }

      const gNameGroup = rest(child)[0]
      const gName =
        gNameGroup?.kind === 'group' ? headName(gNameGroup) : undefined

      if (!gName) {
        continue
      }

      const likeGroup = rest(child).find(
        (n): n is GroupNode =>
          n.kind === 'group' && headName(n) === 'like',
      )

      if (likeGroup) {
        indices.push({ name: gName, type: parseLikeType(likeGroup) })
      } else {
        params.push(gName)
      }
    }

    // enum variants: `case <name>` children, each with its own fields and, for an indexed family, its output index
    // expressions (the `head <value>` children of the case, in declared-index order). The index expressions are scoped
    // over the variant's own field names (`succ count` references the field `count`).
    const variants: {
      name: string
      fields: { name: string; type: Type }[]
      indexValues?: Expression[]
    }[] = []

    for (const child of parts.slice(1)) {
      if (child.kind !== 'group' || headName(child) !== 'case') {
        continue
      }

      const vNameGroup = rest(child)[0]
      const vName =
        vNameGroup?.kind === 'group' ? headName(vNameGroup) : undefined

      if (!vName) {
        continue
      }

      const variantFields = linkFields(child)
      const variant: {
        name: string
        fields: { name: string; type: Type }[]
        indexValues?: Expression[]
      } = { name: vName, fields: variantFields }

      if (indices.length > 0) {
        const fieldScope = new Set(variantFields.map(f => f.name))
        const indexValues = rest(child)
          .filter(
            (n): n is GroupNode =>
              n.kind === 'group' && headName(n) === 'head',
          )
          .map(n => rest(n)[0])
          .filter((n): n is Node => n !== undefined)
          .map(n => toExpression(n, fieldScope))

        if (indexValues.length > 0) {
          variant.indexValues = indexValues
        }
      }

      variants.push(variant)
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

    // `mark prop` declares a PROPOSITIONAL TRUNCATION (hProp): any two inhabitants are equal (proof irrelevance).
    const truncation = parts
      .slice(1)
      .some(
        child =>
          child.kind === 'group' &&
          headName(child) === 'mark' &&
          rest(child)[0]?.kind === 'group' &&
          headName(rest(child)[0] as GroupNode) === 'prop',
      )

    return {
      form: 'record-type',
      name,
      params,
      indices: indices.length > 0 ? indices : undefined,
      fields,
      variants,
      alias,
      truncation,
      span,
    }
  }

  // a form's nested `task` children are methods: desugared to free functions over the form, with `self` typed as
  // the form (parameterized by the form's generics) and the form's generics in scope. `read(file)`, not file.read().
  // `selfOverride` types `self` as a primitive kind, for a primitive type's stdlib form (boolean, number, text).
  function formMethods(
    group: GroupNode,
    formName: string,
    formParams: string[],
    selfOverride?: Type,
  ): Statement[] {
    const out: Statement[] = []
    const selfType: Type = selfOverride ?? {
      kind: 'named',
      name: formName,
      args: formParams.map(name => ({ kind: 'named', name })),
    }

    for (const child of rest(group)) {
      if (child.kind !== 'group' || headName(child) !== 'task') {
        continue
      }

      const fn = buildFunction(child)

      if (fn?.form !== 'function') {
        continue
      }

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
  // `dock load / load <node:fs>, name fs` -> a native module binding. `dock type / load <tokio::net::TcpStream>, name
  // tcp-handle` (asType) -> an opaque per-backend handle type: `module` carries the concrete native type, `alias` the
  // seed-side name a backend resolves it to.
  function buildDock(group: GroupNode, asType = false): Statement[] {
    const out: Statement[] = []

    for (const child of rest(group)) {
      if (child.kind !== 'group' || headName(child) !== 'load') {
        continue
      }

      let module: string | undefined
      let alias: string | undefined

      for (const part of rest(child)) {
        if (part.kind === 'text') {
          module = part.parts
            .map(p => (p.kind === 'chunk' ? p.text : ''))
            .join('')
        } else if (part.kind === 'group' && headName(part) === 'name') {
          const a = rest(part)[0]
          alias = a?.kind === 'group' ? headName(a) : undefined
        }
      }

      if (module && alias) {
        out.push({
          form: 'native',
          alias,
          module,
          kind: asType ? 'type' : 'module',
          span: spanOf(child),
          file,
        })
      }
    }

    return out
  }

  // `bind <name>, <value>` arguments under a group (component props, call args)
  function buildBindArgs(
    group: GroupNode,
    scope: Set<string>,
  ): DockArgument[] {
    const args: DockArgument[] = []

    for (const child of rest(group)) {
      if (child.kind !== 'group' || headName(child) !== 'bind') {
        continue
      }

      const nameGroup = rest(child)[0]
      const name =
        nameGroup?.kind === 'group' ? headName(nameGroup) : undefined

      const valueNode = rest(child)[1]

      if (name) {
        args.push({
          name,
          value: valueNode
            ? toExpression(valueNode, scope)
            : { form: 'unit', span: spanOf(child) },
        })
      }
    }

    return args
  }

  // `call <name> / bind ...` handlers under a group
  function buildDockCalls(
    group: GroupNode,
    scope: Set<string>,
  ): DockCall[] {
    const calls: DockCall[] = []

    for (const child of rest(group)) {
      if (child.kind !== 'group' || headName(child) !== 'call') {
        continue
      }

      const nameGroup = rest(child)[0]
      const name =
        nameGroup?.kind === 'group' ? headName(nameGroup) : undefined

      if (name) {
        calls.push({
          name,
          args: buildBindArgs(child, scope),
          span: spanOf(child),
        })
      }
    }

    return calls
  }

  // `take <name> / like <type> / need true` options/params. A `take path|query|body|head` is a section whose nested
  // takes/links are the real params, so descend into it.
  const TAKE_SECTION = new Set(['path', 'query', 'body', 'head'])

  function buildDockTakes(group: GroupNode): DockTake[] {
    const takes: DockTake[] = []

    for (const child of rest(group)) {
      if (child.kind !== 'group') {
        continue
      }

      const headKw = headName(child)

      if (headKw === 'take') {
        const varGroup = rest(child)[0]
        const name =
          varGroup?.kind === 'group' ? headName(varGroup) : undefined

        if (!name) {
          continue
        }

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

        if (likeGroup) {
          take.type = parseLikeType(likeGroup)
        }

        // a CLI short flag: `code <letter>` (e.g. `take title / code t` -> `-t`)
        const codeGroup = rest(child).find(
          (n): n is GroupNode =>
            n.kind === 'group' && headName(n) === 'code',
        )

        if (codeGroup) {
          const letter = rest(codeGroup)[0]

          if (letter?.kind === 'group') {
            take.short = headName(letter)
          }
        }

        // masked input: `wait rise` reads a secret without echoing
        if (
          rest(child).some(
            n =>
              n.kind === 'group' &&
              headName(n) === 'wait' &&
              rest(n)[0]?.kind === 'group' &&
              headName(rest(n)[0] as GroupNode) === 'rise',
          )
        ) {
          take.masked = true
        }

        // help text: `note <Directory to hunt>`
        const noteGroup = rest(child).find(
          (n): n is GroupNode =>
            n.kind === 'group' && headName(n) === 'note',
        )

        if (noteGroup) {
          const textNode = rest(noteGroup)[0]

          if (textNode?.kind === 'text') {
            take.note = textOf(textNode)
          }
        }

        // default value: `bind 3000` / `bind <hello>` / `bind true` / `bind code false`
        const bindGroup = rest(child).find(
          (n): n is GroupNode =>
            n.kind === 'group' && headName(n) === 'bind',
        )

        if (bindGroup) {
          const valNode = rest(bindGroup)[0]

          if (valNode?.kind === 'integer') {
            take.fallback = valNode.value
          } else if (valNode?.kind === 'text') {
            take.fallback = textOf(valNode)
          } else if (valNode?.kind === 'group') {
            const word = headName(valNode)

            if (word === 'true' || word === 'false') {
              take.fallback = word === 'true'
            } else if (word === 'code') {
              take.fallback =
                headName(rest(valNode)[0] as GroupNode) === 'true'
            }
          }
        }

        // variadic / rest positional: `many`
        if (
          rest(child).some(
            n => n.kind === 'group' && headName(n) === 'many',
          )
        ) {
          take.variadic = true
        }

        // choices / enum: one or more `pick <value>`
        const picks = rest(child)
          .filter(
            (n): n is GroupNode =>
              n.kind === 'group' && headName(n) === 'pick',
          )
          .map(p => {
            const v = rest(p)[0]

            return v?.kind === 'text'
              ? textOf(v)
              : v?.kind === 'group'
                ? headName(v)
                : undefined
          })
          .filter((x): x is string => x !== undefined)

        if (picks.length > 0) {
          take.choices = picks
        }

        takes.push(take)
      } else if (headKw === 'link') {
        const varGroup = rest(child)[0]
        const name =
          varGroup?.kind === 'group' ? headName(varGroup) : undefined

        if (!name) {
          continue
        }

        const likeGroup = rest(child).find(
          (n): n is GroupNode =>
            n.kind === 'group' && headName(n) === 'like',
        )

        const take: DockTake = {
          name,
          required: false,
          span: spanOf(child),
        }

        if (likeGroup) {
          take.type = parseLikeType(likeGroup)
        }

        takes.push(take)
      }
    }

    return takes
  }

  // `send <name>, <value>` responses
  function buildDockSends(
    group: GroupNode,
    scope: Set<string>,
  ): { name: string; value?: Expression }[] {
    const out: { name: string; value?: Expression }[] = []

    for (const child of rest(group)) {
      if (child.kind !== 'group' || headName(child) !== 'send') {
        continue
      }

      const nameGroup = rest(child)[0]
      const name =
        nameGroup?.kind === 'group' ? headName(nameGroup) : undefined

      if (!name) {
        continue
      }

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
    nodes: Node[],
    scope: Set<string>,
  ): ZoneNode[] {
    const out: ZoneNode[] = []

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

      if (node.kind !== 'group') {
        continue
      }

      const span = spanOf(node)

      switch (headName(node)) {
        // `node <tag>` is `zone <tag>` that forces an html element even when `<tag>` is also a component name (the
        // escape hatch for rendering a real `<select>` inside a same-named component, e.g. native-select).
        case 'node':

        case 'zone': {
          const forced = headName(node) === 'node'
          const nameGroup = rest(node)[0]
          const elName =
            nameGroup?.kind === 'group'
              ? headName(nameGroup)
              : undefined

          if (!elName) {
            break
          }

          const attributes: ZoneAttribute[] = []
          const props: { name: string; value: Expression }[] = []
          const children: Node[] = []

          let ref: string | undefined

          for (const child of rest(node).slice(1)) {
            if (child.kind === 'group' && headName(child) === 'name') {
              // `name <ref>`: bind this element to a local the rest of the zone can read
              const refGroup = rest(child)[0]

              if (refGroup?.kind === 'group') {
                ref = headName(refGroup)
              }
            } else if (
              child.kind === 'group' &&
              headName(child) === 'seed'
            ) {
              const attrGroup = rest(child)[0]
              const attrName =
                attrGroup?.kind === 'group'
                  ? headName(attrGroup)
                  : undefined

              const valueNode = rest(child)[1]

              if (attrName) {
                const value: Expression = valueNode
                  ? toExpression(valueNode, scope)
                  : { form: 'unit', span }

                const event =
                  valueNode?.kind === 'group' &&
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
                bindGroup?.kind === 'group'
                  ? headName(bindGroup)
                  : undefined

              const valueNode = rest(child)[1]

              if (bindName) {
                props.push({
                  name: bindName,
                  value: valueNode
                    ? toExpression(valueNode, scope)
                    : { form: 'unit', span },
                })
              }
            } else if (
              child.kind === 'group' &&
              headName(child) === 'hook'
            ) {
              // `hook click, call submit`: an event handler on the element.
              // (fork / walk also use `hook`, but those are their own child
              // groups, not direct `hook` children of an element.)
              const eventGroup = rest(child)[0]
              const eventName =
                eventGroup?.kind === 'group'
                  ? headName(eventGroup)
                  : undefined

              const handlerNode = rest(child)[1]

              if (eventName && handlerNode) {
                attributes.push({
                  name: eventName,
                  value: toExpression(handlerNode, scope),
                  event: true,
                  span: spanOf(child),
                })
              }
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
            forced,
            span,
          })
          break
        }

        case 'text': {
          const t = rest(node)[0]
          out.push({
            form: 'text',
            value:
              t?.kind === 'text'
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
              child?.kind === 'group'
                ? toExpression(child, scope)
                : toExpression(node, scope),
            span,
          })
          break
        }

        case 'slot': {
          const n = rest(node)[0]
          const nm = n?.kind === 'group' ? headName(n) : undefined
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
          const cond: Expression = condNodes?.[0]
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
            parts[0]?.kind === 'group' ? headName(parts[0]) : undefined

          if (variant !== 'list') {
            break
          }

          const iterable: Expression = parts[1]
            ? toExpression(parts[1], scope)
            : { form: 'unit', span }

          const nextBody = hooks(node).get('next') ?? []

          let item = 'item'
          let bodyNodes = nextBody

          const first = nextBody[0]

          if (first?.kind === 'group' && headName(first) === 'take') {
            const nameGroup = rest(first)[1]

            if (
              nameGroup?.kind === 'group' &&
              headName(nameGroup) === 'name'
            ) {
              const itemGroup = rest(nameGroup)[0]

              if (itemGroup?.kind === 'group') {
                item = headName(itemGroup) ?? 'item'
              }
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
            target?.kind === 'group' ? headName(target) : undefined

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
      nameGroup?.kind === 'group' ? headName(nameGroup) : undefined

    const span = spanOf(group)

    if (!name) {
      fail(group, 'zone needs a name')

      return undefined
    }

    const params: { name: string; type?: Type }[] = []

    for (const child of rest(group)) {
      if (child.kind !== 'group' || headName(child) !== 'take') {
        continue
      }

      const varGroup = rest(child)[0]
      const paramName =
        varGroup?.kind === 'group' ? headName(varGroup) : undefined

      if (!paramName) {
        continue
      }

      const likeGroup = rest(child).find(
        (n): n is GroupNode =>
          n.kind === 'group' && headName(n) === 'like',
      )

      const param: { name: string; type?: Type } = { name: paramName }

      if (likeGroup) {
        param.type = parseLikeType(likeGroup)
      }

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
    // a route path is a text literal (`hook </vibe/intro>`, slashes need it) or a bare name (`hook build`, a CLI command)
    const path =
      pathGroup?.kind === 'text'
        ? textOf(pathGroup)
        : pathGroup?.kind === 'group'
          ? (headName(pathGroup) ?? '')
          : ''

    const methods: DockMethod[] = []

    for (const child of rest(group)) {
      if (child.kind !== 'group' || headName(child) !== 'task') {
        continue
      }

      const mNameGroup = rest(child)[0]
      const mName =
        mNameGroup?.kind === 'group' ? headName(mNameGroup) : undefined

      if (mName) {
        methods.push({
          name: mName,
          takes: buildDockTakes(child),
          calls: buildDockCalls(child, scope),
          sends: buildDockSends(child, scope),
          span: spanOf(child),
        })
      }
    }

    let component: DockRoute['component']

    const zoneChild = rest(group).find(
      (n): n is GroupNode =>
        n.kind === 'group' && headName(n) === 'zone',
    )

    if (zoneChild) {
      const zNameGroup = rest(zoneChild)[0]
      const zName =
        zNameGroup?.kind === 'group' ? headName(zNameGroup) : undefined

      if (zName) {
        component = {
          name: zName,
          props: buildBindArgs(zoneChild, scope),
        }
      }
    }

    const directives: { name: string; value?: Expression }[] = []

    for (const child of rest(group)) {
      if (child.kind !== 'group' || headName(child) !== 'seed') {
        continue
      }

      const nameGroup = rest(child)[0]
      const dName =
        nameGroup?.kind === 'group' ? headName(nameGroup) : undefined

      if (!dName) {
        continue
      }

      const valueNode = rest(child)[1]
      directives.push(
        valueNode
          ? { name: dName, value: toExpression(valueNode, scope) }
          : { name: dName },
      )
    }

    const dockHooks: { name: string; calls: DockCall[] }[] = []

    for (const child of rest(group)) {
      if (child.kind !== 'group' || headName(child) !== 'hook') {
        continue
      }

      const nameGroup = rest(child)[0]
      const hName =
        nameGroup?.kind === 'group' ? headName(nameGroup) : undefined

      if (hName) {
        dockHooks.push({
          name: hName,
          calls: buildDockCalls(child, scope),
        })
      }
    }

    const children = rest(group)
      .filter(
        (n): n is GroupNode =>
          n.kind === 'group' &&
          (headName(n) === 'hook' || headName(n) === 'dock'),
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

  // a top-level CLI command tree: `hook <command> / take <arg> / task <impl> / hook <subcommand> ...`. This is the CLI
  // DSL (replacing the routing dock for command-line tools): each `hook` is a command, its `take`s are arguments /
  // flags, its `task` binds the implementation that runs it, and nested `hook`s are subcommands. Reuses the route
  // structure (a CLI command is a route whose `path` is the command name and whose `calls` is the bound task).
  function buildHookCommand(group: GroupNode): DockRoute {
    const span = spanOf(group)
    const nameGroup = rest(group)[0]
    const path =
      nameGroup?.kind === 'group' ? (headName(nameGroup) ?? '') : ''

    // the implementation: a `task <impl>` child binds the function that runs this command
    const calls: DockCall[] = []

    for (const child of rest(group)) {
      if (child.kind !== 'group' || headName(child) !== 'task') {
        continue
      }

      const implGroup = rest(child)[0]
      const impl =
        implGroup?.kind === 'group' ? headName(implGroup) : undefined

      if (impl) {
        calls.push({ name: impl, args: [], span: spanOf(child) })
      }
    }

    // nested `hook`s are subcommands
    const children = rest(group)
      .filter(
        (n): n is GroupNode =>
          n.kind === 'group' && headName(n) === 'hook',
      )
      .map(buildHookCommand)

    // command help text: a direct `note <text>` child of the hook
    let note: string | undefined

    const cmdNote = rest(group).find(
      (n): n is GroupNode =>
        n.kind === 'group' && headName(n) === 'note',
    )

    if (cmdNote) {
      const textNode = rest(cmdNote)[0]

      if (textNode?.kind === 'text') {
        note = textOf(textNode)
      }
    }

    return {
      path,
      note,
      takes: buildDockTakes(group),
      methods: [],
      calls,
      directives: [],
      sends: [],
      hooks: [],
      children,
      span,
    }
  }

  // distinguish the FFI form (`dock load / load <module>`) from a routing / CLI dock (`dock /path`, `dock make`)
  function isFfiDock(group: GroupNode): boolean {
    const first = rest(group)[0]

    return first?.kind === 'group' && headName(first) === 'load'
  }

  const program: Program = []

  // import aliases: `load @m / find X, name Y` makes Y a local synonym for X in THIS file. The alias is rewritten to X
  // before the module merge, so a flat-namespace collision is never introduced (Y never reaches the merged program).
  const aliases = new Map<string, string>()

  for (const group of tree.nodes) {
    const keyword = headName(group)

    if (keyword === 'zone') {
      const zone = buildZone(group)

      if (zone) {
        program.push(zone)
      }

      continue
    }

    if (keyword === 'task') {
      const fn = buildFunction(group)

      if (fn) {
        program.push(fn)
      }
    } else if (keyword === 'host') {
      // `host <name>, <value>` at the top level is a named constant: an immutable binding to the value (any type). A
      // value-less foreign global falls through to the body builder, which records it as an ambient binding.
      const constant = buildHostConstant(group)

      if (constant) {
        program.push(constant)
      } else {
        program.push(...toStatements([group], new Set<string>()))
      }
    } else if (keyword === 'bind') {
      const bind = buildBind(group)

      if (bind) {
        program.push(bind)
      }
    } else if (keyword === 'form') {
      const nameGroup = rest(group)[0]
      const formName =
        nameGroup?.kind === 'group' ? headName(nameGroup) : undefined

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
        const params = rt?.form === 'record-type' ? rt.params : []
        const element: Type = {
          kind: 'array',
          element: { kind: 'named', name: params[0] ?? 't' },
        }

        program.push(...formMethods(group, formName, params, element))
      } else if (formName === 'hash') {
        // hash is the native map: its methods are typed over map<k, v> (the form's two generics); receiver dispatch
        // routes `call get / <map>` to the hash method
        const rt = buildRecordType(group)
        const params = rt?.form === 'record-type' ? rt.params : []
        const self: Type = {
          kind: 'map',
          key: { kind: 'named', name: params[0] ?? 'k' },
          value: { kind: 'named', name: params[1] ?? 'v' },
        }

        program.push(...formMethods(group, formName, params, self))
      } else {
        const rt = buildRecordType(group)

        if (rt) {
          program.push(rt)
        }

        // `wear <mask>` blocks inside the form are trait instances for it (methods carry the form's generics)
        const formParams = rt?.form === 'record-type' ? rt.params : []

        if (formName) {
          program.push(...wearInstances(group, formName, formParams))
        }

        if (formName && rt?.form === 'record-type') {
          program.push(...formMethods(group, formName, rt.params))
        }
      }
    } else if (keyword === 'mask') {
      const mask = buildMask(group)

      if (mask) {
        program.push(mask)
      }
    } else if (keyword === 'suit') {
      program.push(...buildSuit(group))
    } else if (keyword === 'hook') {
      // `hook` is the routing / CLI DSL, with two SEPARATE shapes distinguished by content:
      //  - a SITE ROUTE: `hook </path> / zone <component>` (has a `zone`) -> buildDockRoute -> the route-lowering pass
      //    turns it into a `route(host, path)` dispatcher + boot (client mount / server render).
      //  - a CLI COMMAND: `hook <command> / task <impl>` (no `zone`) -> buildHookCommand -> the CLI command tree.
      // Both lower to a route statement (shared structure), but a route carries a component and a command does not, so
      // downstream passes treat them apart. (`dock` is reserved for native FFI bindings -- `dock load`.)
      const isRoute = rest(group).some(
        n =>
          n.kind === 'group' &&
          (headName(n) === 'zone' ||
            // a resource route: `hook </vibe.pdf> / seed proxy, text <url>` has no zone; the server streams the asset
            (headName(n) === 'seed' &&
              rest(n)[0]?.kind === 'group' &&
              headName(rest(n)[0] as GroupNode) === 'proxy')),
      )

      program.push({
        form: 'dock',
        route: isRoute
          ? buildDockRoute(group)
          : buildHookCommand(group),
        span: spanOf(group),
      })
    } else if (keyword === 'dock') {
      // `dock load` is the native FFI binding. `dock type` declares an opaque per-backend handle type. A non-FFI `dock`
      // is the legacy routing form, kept as an alias for `hook`.
      const firstChild = rest(group)[0]
      const isTypeDock =
        firstChild?.kind === 'group' && headName(firstChild) === 'type'

      if (isTypeDock) {
        program.push(...buildDock(group, true))
      } else if (isFfiDock(group)) {
        program.push(...buildDock(group))
      } else {
        program.push({
          form: 'dock',
          route: buildDockRoute(group),
          span: spanOf(group),
        })
      }
    } else if (
      keyword === 'load' ||
      keyword === 'bear' ||
      keyword === 'deck'
    ) {
      // module directives: the loader (code/compile/load.ts) resolves the path. Here we only capture `find X, name Y`
      // import aliases so the local name Y can be rewritten to X below.
      if (keyword === 'load') {
        for (const child of rest(group)) {
          if (child.kind !== 'group' || headName(child) !== 'find') {
            continue
          }

          const parts = rest(child).filter(
            (p): p is GroupNode => p.kind === 'group',
          )

          const target = parts[0] ? headName(parts[0]) : undefined
          const nameGroup = parts.find(p => headName(p) === 'name')
          const aliasNode = nameGroup ? rest(nameGroup)[0] : undefined
          const local =
            aliasNode?.kind === 'group'
              ? headName(aliasNode)
              : undefined

          if (target && local && local !== target) {
            aliases.set(local, target)
          }
        }
      }
    } else if (keyword === 'note') {
      // top-level documentation: not a statement
    } else {
      program.push(...toStatements([group], new Set<string>()))
    }
  }

  if (diagnostics.length) {
    return { ok: false, diagnostics }
  }

  // apply import aliases. A reference is a `variable` expression (reads and calls), a `record` construction (`make X`),
  // or a `named` type. Definitions are `function`/`record-type` nodes whose name is not a `variable`/`record`/`named`
  // field, and the alias name is imported (never defined here), so every match is a genuine reference. String literals
  // and a record's own field names are plain strings, never visited as `name` here, so they are untouched.
  if (aliases.size) {
    const rewriteName = (name: string): string =>
      aliases.get(name) ?? name

    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const item of node) {
          walk(item)
        }

        return
      }

      if (!node || typeof node !== 'object') {
        return
      }

      const record = node as Record<string, unknown>

      if (
        (record.form === 'variable' || record.form === 'record') &&
        typeof record.name === 'string'
      ) {
        record.name = rewriteName(record.name)
      } else if (
        record.kind === 'named' &&
        typeof record.name === 'string'
      ) {
        record.name = rewriteName(record.name)
      }

      for (const key in record) {
        const value = record[key]

        if (value && typeof value === 'object') {
          walk(value)
        }
      }
    }

    walk(program)
  }

  return { ok: true, program }
}
