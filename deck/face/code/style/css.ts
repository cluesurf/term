// The `face` CSS compiler: turns the `.tree` CSS-utility DSL (face / have / case / tone) into a static atomic
// stylesheet at build time (Tailwind-style, zero runtime). It walks the generic tree AST (the same parser the rest of
// Seed uses), so it needs no new statement forms in the main compiler — it is a sibling build pass. See
// note/seed/look-css-dsl.md.
//
//   face bg-hatch                       ->  .bg-hatch { background-image: ...; background-size: 8px 8px }
//     have background-image, text <...>
//     have background-size, text <8px 8px>
//     case hover                        ->  .bg-hatch:hover { ... }
//       have background, text <...>
//   tone                                ->  :root { --color-zinc-200: #e4e4e7 }
//     have color-zinc-200, text <#e4e4e7>

import { parse } from '@cluesurf/make/code/parser/tree'
import type { GroupNode, Node } from '@cluesurf/make/code/parser/tree'

// flatten a name / text node's chunks to a string
function textOf(node: Node | undefined): string {
  if (!node) {
    return ''
  }

  if (node.kind === 'name' || node.kind === 'text') {
    return node.parts
      .map(part => (part.kind === 'chunk' ? part.text : ''))
      .join('')
  }

  return ''
}

// a group's head word (its first child) and the rest (inline args + nested child groups)
function head(group: GroupNode): string {
  return textOf(group.nodes[0])
}

function rest(group: GroupNode): Node[] {
  return group.nodes.slice(1)
}

// the responsive breakpoint min-widths (Tailwind defaults)
const BREAKPOINT: Record<string, string> = {
  sm: '640px',
  md: '768px',
  lg: '1024px',
  xl: '1280px',
  '2xl': '1536px',
}

// data/aria state variants -> the attribute selector they target on the class
const STATE_ATTR: Record<string, string> = {
  open: '[data-state=open]',
  closed: '[data-state=closed]',
  checked: '[data-state=checked]',
  unchecked: '[data-state=unchecked]',
  active: '[data-state=active]',
  inactive: '[data-state=inactive]',
  selected: '[aria-selected=true]',
  expanded: '[aria-expanded=true]',
}

// collect the CSS declarations from a group's `have <prop>, <value>` children
function declarations(group: GroupNode): string {
  const out: string[] = []

  for (const node of rest(group)) {
    if (node.kind === 'group' && head(node) === 'have') {
      const property = textOf(rest(node)[0])
      const value = textOf(rest(node)[1])

      if (property) {
        out.push(`  ${property}: ${value};`)
      }
    }
  }

  return out.join('\n')
}

// emit one utility class (`face <name>`) plus a rule per `case <variant>` child
function emitFace(group: GroupNode): string {
  const name = textOf(rest(group)[0])

  if (!name) {
    return ''
  }

  const rules: string[] = []
  const base = declarations(group)

  if (base) {
    rules.push(`.${name} {\n${base}\n}`)
  }

  for (const node of rest(group)) {
    if (node.kind !== 'group' || head(node) !== 'case') {
      continue
    }

    const variant = textOf(rest(node)[0])
    const body = declarations(node)

    if (!body) {
      continue
    }

    if (variant in BREAKPOINT) {
      rules.push(
        `@media (min-width: ${BREAKPOINT[variant]}) {\n.${name} {\n${body}\n}\n}`,
      )
    } else if (variant === 'dark') {
      rules.push(`.dark .${name} {\n${body}\n}`)
    } else if (variant in STATE_ATTR) {
      rules.push(`.${name}${STATE_ATTR[variant]} {\n${body}\n}`)
    } else if (variant.startsWith('group-')) {
      rules.push(`.group:${variant.slice(6)} .${name} {\n${body}\n}`)
    } else if (variant.startsWith('peer-')) {
      rules.push(`.peer:${variant.slice(5)} ~ .${name} {\n${body}\n}`)
    } else {
      // a pseudo-class: hover / focus / focus-visible / active / disabled / checked / first / last / odd / even
      rules.push(`.${name}:${variant} {\n${body}\n}`)
    }
  }

  return rules.join('\n\n')
}

// emit the theme tokens (`tone`) as :root (or .dark for `tone dark`) custom properties
function emitTone(group: GroupNode): string {
  const scope = textOf(rest(group)[0])
  const selector = scope === 'dark' ? '.dark' : ':root'
  const out: string[] = []

  for (const node of rest(group)) {
    if (node.kind === 'group' && head(node) === 'have') {
      const token = textOf(rest(node)[0])
      const value = textOf(rest(node)[1])

      if (token) {
        out.push(`  --${token}: ${value};`)
      }
    }
  }

  return out.length ? `${selector} {\n${out.join('\n')}\n}` : ''
}

// compile a `.tree` source of `face` / `tone` declarations into a CSS stylesheet
export function compileFaceCss(source: {
  file: string
  text: string
}): string {
  const parsed = parse(source)

  if (!parsed.ok) {
    return ''
  }

  const blocks: string[] = []

  for (const group of parsed.tree.nodes) {
    const name = head(group)

    if (name === 'face') {
      blocks.push(emitFace(group))
    } else if (name === 'tone') {
      blocks.push(emitTone(group))
    }
  }

  return blocks.filter(Boolean).join('\n\n') + '\n'
}
