// Template expansion for `tree` and `fuse` (compile-time macros). A `tree` defines a parameterized body with
// `{param}` interpolations; a `fuse` instantiates it, substituting the bound values. Expansion happens on the
// parse tree (CST) before the mill runs. See note/research/vibe/computation/plans/11-elaboration.md (expand phase)
// and the language reference language/12-templates.md. Browser-safe.

import type { ChunkNode, GroupNode, InterpolationNode, NameNode, Node, RootNode, TextNode } from '@/code/parser/tree'
import type { Span } from '@/code/parser/diagnostic'
import type { Token } from '@/code/parser/token'
import { TokenKind } from '@/code/parser/token'

const ZERO_SPAN: Span = { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } }
function chunkToken(text: string): Token {
  return { kind: TokenKind.Name, span: ZERO_SPAN, text }
}

function nameText(name: NameNode): string {
  return name.parts.map((p) => (p.kind === 'chunk' ? p.text : '')).join('')
}
function headName(group: GroupNode): string | undefined {
  const first = group.nodes[0]
  return first && first.kind === 'name' ? nameText(first) : undefined
}
function rest(group: GroupNode): Array<Node> {
  return group.nodes.slice(1)
}

// the text value of a bind/argument node, for substitution
function valueText(node: Node | undefined): string {
  if (!node) return ''
  switch (node.kind) {
    case 'integer':
    case 'decimal':
      return String(node.value)
    case 'name':
      return nameText(node)
    case 'text':
      return node.parts.map((p) => (p.kind === 'chunk' ? p.text : '')).join('')
    case 'group': {
      const kw = headName(node)
      const args = rest(node)
      // `like X`, `size 32`, `mark 0` -> the inner value; a bare name -> the name
      if ((kw === 'like' || kw === 'size' || kw === 'mark') && args[0]) return valueText(args[0])
      if (kw && args.length === 0) return kw
      return kw ?? ''
    }
    default:
      return ''
  }
}

// the head term of a fuse interpolation: `{param}` -> "param"
function interpolationName(node: InterpolationNode): string | undefined {
  return node.group ? headName(node.group) : undefined
}

// substitute params inside a name's parts, returning a flat name (chunks merged)
function substituteName(name: NameNode, subs: Map<string, string>): NameNode {
  let text = ''
  let hadInterp = false
  for (const part of name.parts) {
    if (part.kind === 'chunk') text += part.text
    else {
      const param = interpolationName(part)
      if (param !== undefined && subs.has(param)) {
        text += subs.get(param)!
        hadInterp = true
      } else {
        // keep an unresolved interpolation literally (rare); render its braces
        text += `${'{'.repeat(part.depth)}${param ?? ''}${'}'.repeat(part.depth)}`
      }
    }
  }
  void hadInterp
  const chunk: ChunkNode = { kind: 'chunk', text, token: chunkToken(text) }
  return { kind: 'name', parts: [chunk] }
}

function substituteText(text: TextNode, subs: Map<string, string>): TextNode {
  const parts = text.parts.map((part): ChunkNode | InterpolationNode => {
    if (part.kind === 'chunk') return part
    const param = interpolationName(part)
    if (param !== undefined && subs.has(param)) {
      return { kind: 'chunk', text: subs.get(param)!, token: chunkToken(subs.get(param)!) }
    }
    return part
  })
  return { kind: 'text', parts }
}

type Beams = Map<string, Array<Node>>

// clone a list of nodes, expanding any `slot <name>` into the beamed content for that name
function cloneList(nodes: Array<Node>, subs: Map<string, string>, beams: Beams): Array<Node> {
  const out: Array<Node> = []
  for (const node of nodes) {
    if (node.kind === 'group' && headName(node) === 'slot') {
      const slotArg = rest(node)[0]
      const slotName = slotArg && slotArg.kind === 'group' ? headName(slotArg) : undefined
      const beamed = (slotName && beams.get(slotName)) || []
      for (const b of cloneList(beamed, subs, beams)) out.push(b)
    } else {
      out.push(cloneNode(node, subs, beams))
    }
  }
  return out
}

// deep-clone a node, substituting params, expanding slots, dropping parent links
function cloneNode(node: Node, subs: Map<string, string>, beams: Beams): Node {
  switch (node.kind) {
    case 'group':
      return { kind: 'group', nodes: cloneList(node.nodes, subs, beams) as GroupNode['nodes'], optional: node.optional }
    case 'name':
      return substituteName(node, subs)
    case 'text':
      return substituteText(node, subs)
    case 'integer':
    case 'decimal':
    case 'radix':
      return { ...node }
    default:
      return node
  }
}

type Template = { params: Array<string>; body: Array<Node> }

function collectTemplates(tree: RootNode): Map<string, Template> {
  const templates = new Map<string, Template>()
  for (const group of tree.nodes) {
    if (headName(group) !== 'tree') continue
    const args = rest(group)
    const name = args[0] && args[0].kind === 'group' ? headName(args[0]) : undefined
    if (!name) continue
    const params: Array<string> = []
    let body: Array<Node> = []
    for (const node of args.slice(1)) {
      if (node.kind !== 'group') continue
      if (headName(node) === 'take') {
        const p = rest(node)[0]
        const pName = p && p.kind === 'group' ? headName(p) : undefined
        if (pName) params.push(pName)
      } else if (headName(node) === 'hook') {
        const inner = rest(node)
        const variant = inner[0]
        if (variant && variant.kind === 'group' && headName(variant) === 'fuse') body = inner.slice(1)
      }
    }
    templates.set(name, { params, body })
  }
  return templates
}

// expand one fuse group into its instantiated body nodes
function expandFuse(group: GroupNode, templates: Map<string, Template>): Array<Node> {
  const args = rest(group)
  const name = args[0] && args[0].kind === 'group' ? headName(args[0]) : undefined
  const template = name ? templates.get(name) : undefined
  if (!template) return []
  const subs = new Map<string, string>()
  const beams: Beams = new Map()
  for (const node of args.slice(1)) {
    if (node.kind !== 'group') continue
    if (headName(node) === 'bind') {
      const inner = rest(node)
      const param = inner[0] && inner[0].kind === 'group' ? headName(inner[0]) : undefined
      if (param) subs.set(param, valueText(inner[1]))
    } else if (headName(node) === 'beam') {
      // `beam <name>` sends its nested body back to the matching `slot <name>` in the template
      const inner = rest(node)
      const beamName = inner[0] && inner[0].kind === 'group' ? headName(inner[0]) : undefined
      if (beamName) beams.set(beamName, inner.slice(1))
    }
  }
  return cloneList(template.body, subs, beams)
}

// recursively expand fuses inside a node's children
function expandNode(node: Node, templates: Map<string, Template>): Array<Node> {
  if (node.kind !== 'group') return [node]
  if (headName(node) === 'fuse') return expandFuse(node, templates)
  if (headName(node) === 'tree') return [] // template definitions are removed after expansion
  // expand children in place
  const nodes: Array<GroupNode | NameNode | TextNode | typeof node.nodes[number]> = []
  for (const child of node.nodes) {
    for (const expanded of expandNode(child, templates)) nodes.push(expanded as typeof nodes[number])
  }
  return [{ kind: 'group', nodes, optional: node.optional }]
}

// expand all templates in a parse tree
export function expandTemplates(tree: RootNode): RootNode {
  const templates = collectTemplates(tree)
  const nodes: Array<GroupNode> = []
  for (const group of tree.nodes) {
    for (const expanded of expandNode(group, templates)) {
      if (expanded.kind === 'group') nodes.push(expanded)
    }
  }
  return { kind: 'root', nodes }
}
