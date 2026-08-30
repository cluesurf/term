// Template expansion for `tree` and `fuse` (compile-time macros), run on the parse tree (CST) before the mill. A
// `tree` defines a parameterized body with `{param}` interpolations; a `fuse` instantiates it, substituting the bound
// values. Expansion is fully compile-time and supports:
//   - parameter substitution, both `{name}` interpolation and `read name` value positions
//   - `site` / `beam` (a fuse beams content into a named site of the template; the head was `slot` until 2026-08-28)
//   - dynamic fuse: `fuse read <param>` takes the template name from a bound parameter
//   - compile-time meta-loops: `walk <kind>, read <enum>` inside a template body unrolls over a `host` enumeration
//     (`host interval / term year / term month / ...`), binding the loop item for each iteration. This is how one
//     `fuse` generates a whole family of definitions (e.g. get-year / get-month / ... per interval).
// See note/research/vibe/computation/plans/11-elaboration.md (expand phase) and language/12-templates.md. Browser-safe.

import type {
  ChunkNode,
  GroupNode,
  IntegerNode,
  InterpolationNode,
  NameNode,
  Node,
  RootNode,
  TextNode,
} from '@term/make/code/parser/tree'
import type { Span } from '@term/make/code/parser/diagnostic'
import type { Token } from '@term/make/code/parser/token'
import { TokenKind } from '@term/make/code/parser/token'

const ZERO_SPAN: Span = {
  start: { line: 0, column: 0 },
  end: { line: 0, column: 0 },
}

function chunkToken(text: string): Token {
  return { kind: TokenKind.Name, span: ZERO_SPAN, text }
}

// a bare integer node carrying `value`, so a numeric `{param}` interpolated into a value position (`code {mask}`)
// mills as the integer literal it stands for rather than an undefined name.
function integerNode(value: number): IntegerNode {
  return {
    kind: 'integer',
    value,
    token: { kind: TokenKind.Integer, span: ZERO_SPAN, text: String(value) },
  }
}

function nameNodeOf(text: string): NameNode {
  return {
    kind: 'name',
    parts: [{ kind: 'chunk', text, token: chunkToken(text) }],
  }
}

// `read <name>` as a group, the runtime variable read a non-parameter `{x}` interpolation lowers to (outer-scope value)
function readGroup(name: string): GroupNode {
  return {
    kind: 'group',
    nodes: [nameNodeOf('read'), { kind: 'group', nodes: [nameNodeOf(name)] }],
  }
}

// a numeric string is interpolated as an integer literal (so it works in `code`/value positions), everything else as a name
function isNumeric(text: string): boolean {
  return /^-?\d+$/.test(text)
}

// if `node` is a bare interpolation wrapper -- a group whose only child is a name made of one `{param}` -- return that
// param name. This is the `{x}` standalone form (`code {mask}`, `call f / {x}`), distinct from `i{size}` (a name with a
// literal chunk) which substitutes textually in place.
function bareInterpParam(node: Node): string | undefined {
  if (node.kind !== 'group' || node.nodes.length !== 1) {
    return undefined
  }

  const only = node.nodes[0]

  if (
    only?.kind !== 'name' ||
    only.parts.length !== 1 ||
    only.parts[0]?.kind !== 'interpolation'
  ) {
    return undefined
  }

  return interpolationName(only.parts[0])
}

// resolve a standalone `{param}` interpolation node. A bound numeric param becomes an integer literal; an unbound one
// (from outer / runtime scope) becomes `read param`. A bound non-numeric param returns undefined so the caller's normal
// name substitution handles it (keeping the wrapper, e.g. `case {col}` -> `case e0`).
function transformInterp(
  node: Node,
  subs: Map<string, string>,
): Node | undefined {
  const param = bareInterpParam(node)

  if (param === undefined) {
    return undefined
  }

  if (!subs.has(param)) {
    return readGroup(param)
  }

  const value = subs.get(param)!

  return isNumeric(value) ? integerNode(value === '' ? 0 : Number(value)) : undefined
}

function nameText(name: NameNode): string {
  return name.parts
    .map(p => (p.kind === 'chunk' ? p.text : ''))
    .join('')
}

function headName(group: GroupNode): string | undefined {
  const first = group.nodes[0]

  return first?.kind === 'name' ? nameText(first) : undefined
}

function rest(group: GroupNode): Node[] {
  return group.nodes.slice(1)
}

// the string value a node denotes, resolving parameters via `subs`. `read x` / a bare name `x` resolves to subs[x]
// (or itself); `like X` / `size N` / `mark N` unwrap to their inner value; literals are themselves.
function resolveValue(
  node: Node | undefined,
  subs: Map<string, string>,
): string {
  if (!node) {
    return ''
  }

  switch (node.kind) {
    case 'integer':
    case 'decimal':
      return String(node.value)

    case 'name': {
      const text = nameText(node)

      return subs.get(text) ?? text
    }

    case 'text':
      return node.parts
        .map(p => (p.kind === 'chunk' ? p.text : ''))
        .join('')

    case 'group': {
      const kw = headName(node)
      const args = rest(node)

      if (
        (kw === 'read' ||
          kw === 'loan' ||
          kw === 'move' ||
          kw === 'like' ||
          kw === 'size' ||
          kw === 'mark') &&
        args[0]
      ) {
        return resolveValue(args[0], subs)
      }

      if (kw && args.length === 0) {
        return subs.get(kw) ?? kw
      } // a bare name group

      return kw ?? ''
    }

    default:
      return ''
  }
}

// the head term of a fuse interpolation: `{param}` -> "param"
function interpolationName(
  node: InterpolationNode,
): string | undefined {
  return node.group ? headName(node.group) : undefined
}

// substitute params inside a name's `{param}` interpolations, returning a flat name. A name that IS a bound
// parameter, whole (`like self-type` under `take self-type, like like`), substitutes too: a template's type
// parameters are in scope across its body, and without this the placeholder rode into the checker as a type
// name no build knows (found by the unknown-type warning: 276 `self-type` sites, every one a template body)
function substituteName(
  name: NameNode,
  subs: Map<string, string>,
): NameNode {
  let text = ''

  for (const part of name.parts) {
    if (part.kind === 'chunk') {
      text += part.text
    } else {
      const param = interpolationName(part)

      if (param !== undefined && subs.has(param)) {
        text += subs.get(param)!
      } else {
        text += `${'{'.repeat(part.depth)}${param ?? ''}${'}'.repeat(
          part.depth,
        )}`
      }
    }
  }

  if (subs.has(text)) {
    text = subs.get(text)!
  }

  return {
    kind: 'name',
    parts: [{ kind: 'chunk', text, token: chunkToken(text) }],
  }
}

function substituteText(
  text: TextNode,
  subs: Map<string, string>,
): TextNode {
  const parts = text.parts.map(
    (part): ChunkNode | InterpolationNode => {
      if (part.kind === 'chunk') {
        return part
      }

      const param = interpolationName(part)

      if (param !== undefined && subs.has(param)) {
        return {
          kind: 'chunk',
          text: subs.get(param)!,
          token: chunkToken(subs.get(param)!),
        }
      }

      return part
    },
  )

  return { kind: 'text', parts }
}

export type Template = { params: string[]; body: Node[] }
type Beams = Map<string, Node[]>
// the expansion context threaded through a fuse body: the template registry, the enumerations, the current parameter
// substitutions, and the beamed site contents
type Context = {
  templates: Map<string, Template>
  enums: Map<string, string[]>
  subs: Map<string, string>
  beams: Beams
}

// extract the `tree` template definitions from a parse tree. The body is the content of the template's hook (`hook
// fuse`, `hook bind`, ...) if present, else its non-parameter children.
export function collectTemplates(
  tree: RootNode,
): Map<string, Template> {
  const templates = new Map<string, Template>()

  for (const group of tree.nodes) {
    if (headName(group) !== 'tree') {
      continue
    }

    const args = rest(group)
    const name =
      args[0]?.kind === 'group' ? headName(args[0]) : undefined

    if (!name) {
      continue
    }

    const params: string[] = []

    let body: Node[] = []

    for (const node of args.slice(1)) {
      if (node.kind !== 'group') {
        continue
      }

      const head = headName(node)

      if (head === 'take') {
        // the parameter name arrives as a nested group when written on its own line, but as a bare NAME node when
        // written inline after a comma. Both are the same thing.
        const p = rest(node)[0]
        const pName =
          p?.kind === 'group'
            ? headName(p)
            : p?.kind === 'name'
              ? nameText(p)
              : undefined

        if (pName) {
          params.push(pName)
        }
      } else if (head === 'hook') {
        body = rest(node).slice(1) // drop the hook variant marker (fuse / bind / ...), keep the body
      }
    }

    templates.set(name, { params, body })
  }

  return templates
}

// extract `host <name> / term <a> / term <b> / ...` enumerations, so a meta-loop can iterate their items
export function collectEnumerations(
  tree: RootNode,
): Map<string, string[]> {
  const enums = new Map<string, string[]>()

  for (const group of tree.nodes) {
    if (headName(group) !== 'host') {
      continue
    }

    const args = rest(group)
    const name =
      args[0]?.kind === 'group' ? headName(args[0]) : undefined

    if (!name) {
      continue
    }

    const items = args
      .slice(1)
      .filter(
        (n): n is GroupNode =>
          n.kind === 'group' && headName(n) === 'term',
      )
      .map(n => {
        const item = rest(n)[0]

        return item?.kind === 'group' ? headName(item) : undefined
      })
      .filter((x): x is string => x !== undefined)

    if (items.length > 0) {
      enums.set(name, items)
    }
  }

  return enums
}

// instantiate a fuse: resolve the template (static name or `read <param>`), bind its parameters from the fuse's
// positional / `bind` arguments and `beam`s, then expand its body in the new context
function expandFuse(group: GroupNode, ctx: Context): Node[] {
  const args = rest(group)
  const first = args[0]
  const dynamic =
    first?.kind === 'group' &&
    (headName(first) === 'read' ||
      headName(first) === 'loan' ||
      headName(first) === 'move')

  const name = dynamic
    ? resolveValue(first, ctx.subs)
    : first?.kind === 'group'
      ? headName(first)
      : undefined

  const template = name ? ctx.templates.get(name) : undefined

  if (!template) {
    return []
  }

  const subs = new Map<string, string>()
  const beams: Beams = new Map()

  let positional = 0

  for (const node of args.slice(1)) {
    const head = node.kind === 'group' ? headName(node) : undefined

    if (
      head !== 'bind' &&
      head !== 'beam' &&
      positional < template.params.length
    ) {
      // a positional argument: a group (`size 8`, a bare name), or a bare literal (`8`, a number / text node). Both
      // resolve to their string value, so `fuse sized, 8, 255` binds size = "8", mask = "255".
      subs.set(
        template.params[positional]!,
        resolveValue(node, ctx.subs),
      )
      positional++
    } else if (head === 'bind' && node.kind === 'group') {
      const inner = rest(node)
      const param =
        inner[0]?.kind === 'group' ? headName(inner[0]) : undefined

      if (param) {
        subs.set(param, resolveValue(inner[1], ctx.subs))
      }
    } else if (head === 'beam' && node.kind === 'group') {
      const inner = rest(node)
      const beamName =
        inner[0]?.kind === 'group' ? headName(inner[0]) : undefined

      if (beamName) {
        beams.set(beamName, inner.slice(1))
      }
    }
  }

  return expandBody(template.body, {
    templates: ctx.templates,
    enums: ctx.enums,
    subs,
    beams,
  })
}

// unroll a compile-time meta-loop, or return undefined if it is not one (a runtime `walk` over a real list)
function unrollWalk(
  group: GroupNode,
  ctx: Context,
): Node[] | undefined {
  const args = rest(group)
  const iterArg = args.find(
    a =>
      a.kind === 'group' &&
      (headName(a) === 'read' ||
        headName(a) === 'loan' ||
        headName(a) === 'move'),
  )

  const iterName = iterArg ? resolveValue(iterArg, ctx.subs) : undefined
  const items = iterName ? ctx.enums.get(iterName) : undefined

  if (!items) {
    return undefined
  } // the iterable is not a known enumeration: leave it as a runtime walk

  const stepHook = args.find(
    (a): a is GroupNode => a.kind === 'group' && headName(a) === 'hook',
  )

  if (!stepHook) {
    return undefined
  }

  const stepChildren = rest(stepHook).slice(1) // drop the hook variant marker (`step` / `next`), keep the loop body
  const takeNode = stepChildren.find(
    (c): c is GroupNode => c.kind === 'group' && headName(c) === 'take',
  )

  const itemArg = takeNode && rest(takeNode)[0]
  const itemVar =
    itemArg?.kind === 'group' ? (headName(itemArg) ?? 'item') : 'item'

  const bodyNodes = stepChildren.filter(c => c !== takeNode)

  const out: Node[] = []

  for (const item of items) {
    const subs = new Map(ctx.subs)
    subs.set(itemVar, item)

    for (const node of expandBody(bodyNodes, { ...ctx, subs })) {
      out.push(node)
    }
  }

  return out
}

// expand a template body within a context: sites, nested fuses, meta-loops, and parameter substitution
function expandBody(nodes: Node[], ctx: Context): Node[] {
  const out: Node[] = []

  for (const node of nodes) {
    if (node.kind === 'group') {
      // a standalone `{param}` interpolation: a numeric param becomes an integer literal, an unbound one becomes a
      // runtime `read param`; a bound non-numeric param falls through to ordinary name substitution below.
      const interp = transformInterp(node, ctx.subs)

      if (interp) {
        out.push(interp)
        continue
      }

      const head = headName(node)

      // `read <param>` with the param bound to a NUMBER substitutes the literal itself (`read amount` with
      // amount = 5 becomes `5`), the same way a numeric `{param}` interpolation does; bound to a word it falls
      // through to name substitution below (a read of that name). Before this the read rode through untouched
      // and resolved against a name that does not exist (compiler-hygiene-0013).
      if (
        (head === 'read' || head === 'loan' || head === 'move') &&
        rest(node).length === 1
      ) {
        const target = rest(node)[0]
        const word =
          target?.kind === 'group' ? headName(target) : undefined
        const bound = word ? ctx.subs.get(word) : undefined

        if (bound !== undefined && isNumeric(bound)) {
          out.push(integerNode(Number(bound)))
          continue
        }
      }

      // `site <name>` (formerly `slot`) marks the injection point a `beam <name>` at the fuse site fills
      if (head === 'site' || head === 'slot') {
        const slotArg = rest(node)[0]
        const slotName =
          slotArg?.kind === 'group' ? headName(slotArg) : undefined

        const beamed = (slotName && ctx.beams.get(slotName)) || []

        for (const b of expandBody(beamed, ctx)) {
          out.push(b)
        }

        continue
      }

      if (head === 'fuse') {
        for (const e of expandFuse(node, ctx)) {
          out.push(e)
        }

        continue
      }

      if (head === 'tree') {
        continue
      }

      if (head === 'walk') {
        const unrolled = unrollWalk(node, ctx)

        if (unrolled) {
          for (const u of unrolled) {
            out.push(u)
          }

          continue
        }
      }

      out.push({
        kind: 'group',
        nodes: expandBody(node.nodes, ctx) as GroupNode['nodes'],
        optional: node.optional,
        // leading `#` comments ride through expansion: they are the
        // CLI help text the mill reads off hook / take groups
        ...(node.comments ? { comments: node.comments } : {}),
      })
    } else if (node.kind === 'name') {
      out.push(substituteName(node, ctx.subs))
    } else if (node.kind === 'text') {
      out.push(substituteText(node, ctx.subs))
    } else {
      out.push(node)
    }
  }

  return out
}

// expand a top-level node: instantiate fuses, drop template definitions, and recurse into groups (so a `fuse` nested
// inside a `form` expands in place). Top-level `walk`s are runtime loops and left untouched.
function expandTop(node: Node, ctx: Context, top = false): Node[] {
  if (node.kind !== 'group') {
    return [node]
  }

  // a standalone `{x}` in ordinary (non-template) code is a runtime variable read from the surrounding scope. With no
  // template parameters in scope here, it always lowers to `read x` (the compile-time cases happen inside `expandBody`).
  const interp = transformInterp(node, ctx.subs)

  if (interp) {
    return [interp]
  }

  const head = headName(node)

  if (head === 'fuse') {
    return expandFuse(node, ctx)
  }

  // a template definition is a TOP-LEVEL statement: only a top-level `tree` drops after expansion. A nested
  // group whose head happens to be `tree` (a data anchor, a `walk tree` structure) rides through untouched
  // (compiler-hygiene-0011).
  if (head === 'tree' && top) {
    return []
  }

  // a `host <name> / term <a> / term <b>` block is a compile-time enumeration consumed by meta-loops (see
  // collectEnumerations). It carries no runtime value, so drop it after expansion. A runtime constant
  // (`host x, code 10`) has no `term` children and is left untouched.
  if (head === 'host') {
    const items = rest(node).slice(1)

    if (
      items.length > 0 &&
      items.every(n => n.kind === 'group' && headName(n) === 'term')
    ) {
      return []
    }
  }

  const nodes: Node[] = []

  for (const child of node.nodes) {
    for (const e of expandTop(child, ctx)) {
      nodes.push(e)
    }
  }

  return [
    {
      kind: 'group',
      nodes: nodes as GroupNode['nodes'],
      optional: node.optional,
      // leading `#` comments ride through expansion: they are the
      // CLI help text the mill reads off hook / take groups
      ...(node.comments ? { comments: node.comments } : {}),
    },
  ]
}

// expand all templates in a parse tree. `externalTemplates` / `externalEnums` carry definitions from other loaded
// modules, so a `fuse` (or a meta-loop) can use a template or enumeration an imported module defines.
export function expandTemplates(
  tree: RootNode,
  externalTemplates?: Map<string, Template>,
  externalEnums?: Map<string, string[]>,
): RootNode {
  const templates = new Map(externalTemplates)

  for (const [name, template] of collectTemplates(tree)) {
    templates.set(name, template)
  }

  const enums = new Map(externalEnums)

  for (const [name, items] of collectEnumerations(tree)) {
    enums.set(name, items)
  }

  const ctx: Context = {
    templates,
    enums,
    subs: new Map(),
    beams: new Map(),
  }

  const nodes: GroupNode[] = []

  for (const group of tree.nodes) {
    for (const expanded of expandTop(group, ctx, true)) {
      if (expanded.kind === 'group') {
        nodes.push(expanded)
      }
    }
  }

  return { kind: 'root', nodes }
}
