// The look CSS backend: a static-output compiler that turns the `look` DSL (face / have / case / tone) into a plain
// atomic stylesheet at build time (Tailwind-style, zero runtime). It is the CSS counterpart of `zone-lower.ts`: where
// zones lower to backend functions, look rules lower to a stylesheet string. CSS is not a normal compile target (TS /
// Rust / Kotlin / Swift), so it gets its own static-output pass rather than going through the term IR.
//
// The canonical grammar lives in the self-hosted mill at `@cluesurf/term/code/code/look` (mine + mint) with AST forms
// at `@cluesurf/base/code/look`. This TS pass hand-walks the parse tree the same way `mill.ts` hand-parses the zone
// DSL today, during the self-hosting transition (one grammar source of truth, two readers). The parse tree wraps each
// argument as a child group whose head is its name, so `have color, text <white>` is a group `[name have, group[name
// color], group[name text, text white]]` -- the accessors below mirror mill.ts (headName / rest).
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
function nameText(node: Node | undefined): string {
  if (node && (node.kind === 'name' || node.kind === 'text')) {
    return node.parts
      .map(part => (part.kind === 'chunk' ? part.text : ''))
      .join('')
  }

  return ''
}

// a group's head word (its first child name)
function headName(group: GroupNode): string {
  const first = group.nodes[0]

  return first?.kind === 'name' ? nameText(first) : ''
}

// the arguments + nested children of a group (everything after the head)
function rest(group: GroupNode): Node[] {
  return group.nodes.slice(1)
}

// the name of the i-th argument: `rest(group)[i]` is a group wrapping a name (`color` in `have color, ...`)
function argName(group: GroupNode, index: number): string {
  const arg = rest(group)[index]

  return arg?.kind === 'group' ? headName(arg) : ''
}

// the literal text of the i-th argument: the arg is a `text <...>` group whose first child is the text node
function argText(group: GroupNode, index: number): string {
  const arg = rest(group)[index]

  if (arg?.kind === 'group') {
    return nameText(rest(arg)[0])
  }

  if (arg?.kind === 'text') {
    return nameText(arg)
  }

  return ''
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

// collect the CSS declarations from a group's `have <property>, <value>` children
function declarations(group: GroupNode): string {
  const out: string[] = []

  for (const node of rest(group)) {
    if (node.kind === 'group' && headName(node) === 'have') {
      const property = argName(node, 0)
      const value = argText(node, 1)

      if (property) {
        out.push(`  ${property}: ${value};`)
      }
    }
  }

  return out.join('\n')
}

// escape a utility class name for a CSS selector: `:` `/` `.` are legal in a class attribute (Tailwind uses them, e.g.
// `w-1/2`, `hover:bg-x`) but must be backslash-escaped in the selector
function escapeClass(name: string): string {
  return name.replace(/[:/.]/g, char => `\\${char}`)
}

// emit one utility class (`face <name>`) plus a rule per `case <variant>` child
function emitFace(group: GroupNode): string {
  const name = argName(group, 0)

  if (!name) {
    return ''
  }

  const css = `.${escapeClass(name)}`
  const rules: string[] = []
  const base = declarations(group)

  if (base) {
    rules.push(`${css} {\n${base}\n}`)
  }

  for (const node of rest(group)) {
    if (node.kind !== 'group' || headName(node) !== 'case') {
      continue
    }

    const variant = argName(node, 0)
    const body = declarations(node)

    if (!body) {
      continue
    }

    if (variant in BREAKPOINT) {
      rules.push(
        `@media (min-width: ${BREAKPOINT[variant]}) {\n${css} {\n${body}\n}\n}`,
      )
    } else if (variant === 'dark') {
      rules.push(`.dark ${css} {\n${body}\n}`)
    } else if (variant in STATE_ATTR) {
      rules.push(`${css}${STATE_ATTR[variant]} {\n${body}\n}`)
    } else if (variant.startsWith('group-')) {
      rules.push(`.group:${variant.slice(6)} ${css} {\n${body}\n}`)
    } else if (variant.startsWith('peer-')) {
      rules.push(`.peer:${variant.slice(5)} ~ ${css} {\n${body}\n}`)
    } else {
      // a pseudo-class: hover / focus / focus-visible / active / disabled / checked / first / last / odd / even
      rules.push(`${css}:${variant} {\n${body}\n}`)
    }
  }

  return rules.join('\n\n')
}

// emit the theme tokens (`tone`, or `tone dark`) as :root / .dark custom properties
function emitTone(group: GroupNode): string {
  const first = rest(group)[0]
  // `tone dark` has a scope arg before the `have` children; bare `tone` goes straight to declarations
  const scope =
    first?.kind === 'group' && headName(first) !== 'have'
      ? headName(first)
      : ''

  const selector = scope === 'dark' ? '.dark' : ':root'
  const out: string[] = []

  for (const node of rest(group)) {
    if (node.kind === 'group' && headName(node) === 'have') {
      const token = argName(node, 0)
      const value = argText(node, 1)

      if (token) {
        out.push(`  --${token}: ${value};`)
      }
    }
  }

  return out.length ? `${selector} {\n${out.join('\n')}\n}` : ''
}

// emit a raw-selector rule (`base <html, body>` -> `html, body { ... }`). For the base layer (element resets, fonts,
// ::selection, @font-face) and descendant rules (e.g. `prose` typography) that are not single utility classes. The
// selector is a text literal (verbatim CSS: commas, pseudo-elements, descendant combinators), never escaped. Always
// kept by the JIT.
//
// NESTED: a `base` group whose children are themselves `base` groups (not `have` declarations) is an at-rule wrapper --
// `base <@container (min-width: 760px)>` with nested `base <.x>` children emits `@container (min-width: 760px) { .x { ... } }`.
// This is how container queries / media queries with descendant rules (the block-cq grid) are expressed. Recurses, so
// at-rules can nest. Always kept by the JIT.
function emitBase(group: GroupNode): string {
  const selector = argText(group, 0)

  if (!selector) {
    return ''
  }

  const nested = rest(group)
    .filter(
      (node): node is GroupNode =>
        node.kind === 'group' && headName(node) === 'base',
    )
    .map(emitBase)
    .filter(Boolean)

  if (nested.length) {
    return `${selector} {\n${nested.join('\n')}\n}`
  }

  const body = declarations(group)

  return body ? `${selector} {\n${body}\n}` : ''
}

// compile a `.tree` source of `face` / `tone` declarations into a CSS stylesheet. With `only`, this is the Tailwind
// JIT: emit only the `face` rules whose class name is in the used set, matched by FULL name (a component writes the
// exact class it uses, base `flex` or prefixed `md:flex`, so `md:flex` is kept only when literally used, not because
// `flex` is). Every `tone` block is always kept (the theme tokens the utilities reference).
export function compileLookCss(
  source: {
    file: string
    text: string
  },
  options?: { only?: Set<string> },
): string {
  const parsed = parse(source)

  if (!parsed.ok) {
    return ''
  }

  const only = options?.only
  const blocks: string[] = []

  for (const group of parsed.tree.nodes) {
    const name = headName(group)

    if (name === 'face') {
      if (only && !only.has(argName(group, 0))) {
        continue
      }

      blocks.push(emitFace(group))
    } else if (name === 'tone') {
      blocks.push(emitTone(group))
    } else if (name === 'base') {
      // raw-selector rules (base layer, prose) are always emitted, never filtered by the JIT
      blocks.push(emitBase(group))
    }
  }

  return blocks.filter(Boolean).join('\n\n') + '\n'
}
