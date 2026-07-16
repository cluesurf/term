// The look CSS backend: a static-output compiler that turns the `look` DSL into a plain stylesheet at build time
// (Tailwind-style, zero runtime). It is the CSS counterpart of `zone-lower.ts`: where zones lower to backend functions,
// look rules lower to a stylesheet string. CSS is not a normal compile target (TS / Rust / Kotlin / Swift), so it gets
// its own static-output pass rather than going through the term IR.
//
// The canonical grammar lives in the self-hosted mill at `deck/mill/code/look` (mine + mint) with AST forms at
// `@cluesurf/seed/code/look`. This TS pass hand-walks the parse tree the same way `mill.ts` hand-parses the zone DSL
// during the self-hosting transition (one grammar source of truth, two readers). The parse tree wraps each argument as
// a child group whose head is its name, so `have color, red` is a group `[name have, group[name color], group[name
// red]]`; the accessors below mirror mill.ts (headName / rest).
//
// Two DSL generations coexist and both compile:
//
//   OLD (raw selectors + `text` values):
//     face flex / have display, text <flex>
//     base <html, body> / have font-size, text <17px>
//     tone dark / have color-x, text <#fff>
//
//   NEW (structured selectors + bare / list / function / tint values), documented in book/language/css.md:
//     base font-face / have src / have url, </a.otf>
//     base style / find html / find body / have color, tint rgb, 63, 63, 70
//     base media / have width / have min, 640px / base style ...
//     base container / face card ...
//     tone base  (explicit default scope for :root)
//
// The value renderer accepts both `text <x>` (old) and bare / `<x>` / `tint ...` / list / function (new), so a sheet
// can migrate rule by rule.

import { parse } from '@cluesurf/make/code/parser/tree'
import type { GroupNode, Node } from '@cluesurf/make/code/parser/tree'

// ── tree accessors (mirror mill.ts) ───────────────────────────────────────────

// flatten a name / text node's chunks to a string; read the numeric value of an integer / decimal / mark node
function nodeText(node: Node | undefined): string {
  if (!node) {
    return ''
  }

  if (node.kind === 'name' || node.kind === 'text') {
    return node.parts
      .map(part => (part.kind === 'chunk' ? part.text : ''))
      .join('')
  }

  if (
    node.kind === 'integer' ||
    node.kind === 'decimal' ||
    node.kind === 'mark'
  ) {
    return String((node as { value: number | string }).value)
  }

  return ''
}

// a group's head word (its first child name)
function headName(group: GroupNode): string {
  const first = group.nodes[0]

  return first?.kind === 'name' ? nodeText(first) : ''
}

// the arguments + nested children of a group (everything after the head)
function rest(group: GroupNode): Node[] {
  return group.nodes.slice(1)
}

// the child groups of a group whose head is `head` (e.g. every `have` under a `face`)
function childrenNamed(group: GroupNode, head: string): GroupNode[] {
  return rest(group).filter(
    (node): node is GroupNode =>
      node.kind === 'group' && headName(node) === head,
  )
}

// the name of the i-th argument: `rest(group)[i]` is a group wrapping a name (`color` in `have color, ...`)
function argName(group: GroupNode, index: number): string {
  const arg = rest(group)[index]

  return arg?.kind === 'group' ? headName(arg) : nodeText(arg)
}

// the literal text of the i-th argument: an arg group's first child, or a bare text / value node
function argText(group: GroupNode, index: number): string {
  const arg = rest(group)[index]

  if (arg?.kind === 'group') {
    // `text <x>` wrapper, or a bare value group `[name x]`
    return headName(arg) === 'text' ? nodeText(rest(arg)[0]) : nodeText(arg.nodes[0])
  }

  return nodeText(arg)
}

// ── value rendering (bare / <x> / text <x> / tint / list / function) ───────────

// CSS properties whose value list is comma-separated; everything else joins with spaces
const COMMA_LIST = new Set([
  'font-family',
  'font',
  'transition',
  'transition-property',
  'animation',
  'grid-template-areas',
  'will-change',
  'cursor',
  'voice-family',
  'mask',
  'background',
  'box-shadow',
])

// color spaces whose components are space-separated in modern CSS (vs the legacy comma form)
const SPACE_COLOR = new Set(['oklch', 'oklab', 'lab', 'lch', 'color', 'hwb'])

// `tint <space>, ...components` -> a CSS color. The space is the tint group's first child; the components follow.
function renderTint(group: GroupNode): string {
  const parts = rest(group)
  const space = parts[0]?.kind === 'group' ? headName(parts[0]) : nodeText(parts[0])
  const comps = parts.slice(1).map(renderValueNode)

  if (space === 'hex') {
    return `#${comps[0] ?? ''}`
  }

  if (SPACE_COLOR.has(space)) {
    return `${space}(${comps.join(' ')})`
  }

  return `${space}(${comps.join(', ')})`
}

// a nested `have <fn>, <arg>...` inside a value -> `fn(arg)`. `url` / `format` args are quoted.
function renderFunction(group: GroupNode): string {
  const fn = argName(group, 0)
  const args = rest(group)
    .slice(1)
    .map(renderValueNode)

  if (fn === 'url' || fn === 'format') {
    return `${fn}(${args.map(a => `"${a}"`).join(', ')})`
  }

  return `${fn}(${args.join(', ')})`
}

// axis shorthands for `have transform` children: `have y, 8px` -> `translateY(8px)`
const TRANSFORM_FN: Record<string, string> = {
  x: 'translateX',
  y: 'translateY',
  z: 'translateZ',
  scale: 'scale',
  rotate: 'rotate',
  skew: 'skew',
}

// render one value node: a leaf, a `text <x>` wrapper, a `tint ...`, a function, or a bare value group
function renderValueNode(node: Node): string {
  if (node.kind !== 'group') {
    return nodeText(node)
  }

  const head = headName(node)

  if (head === 'tint') {
    return renderTint(node)
  }

  if (head === 'have') {
    return renderFunction(node)
  }

  if (head === 'text') {
    // old syntax `text <x>` — unwrap
    return rest(node)
      .map(renderValueNode)
      .join(' ')
  }

  if (head in TRANSFORM_FN) {
    const args = rest(node).map(renderValueNode)
    return `${TRANSFORM_FN[head]}(${args.join(', ')})`
  }

  // a bare value group `[name 17px]` or a multi-token value `[name 2n, ...]`
  const more = rest(node)
    .map(renderValueNode)
    .join(' ')

  return more ? `${head} ${more}` : head
}

// render the full value of a `have <property>, ...` declaration
function renderValue(have: GroupNode): string {
  const property = argName(have, 0)
  const vals = rest(have).slice(1)

  if (vals.length === 0) {
    return ''
  }

  // `have transform` with axis children: `have y, 8px` -> `translateY(8px)`
  if (property === 'transform') {
    return vals
      .map(v => {
        if (v.kind === 'group' && headName(v) === 'have') {
          const axis = argName(v, 0)
          return `${TRANSFORM_FN[axis] ?? axis}(${argText(v, 1)})`
        }

        return renderValueNode(v)
      })
      .join(' ')
  }

  // a sequence of `have <fn>` children (e.g. `src: url(...) format(...)`)
  if (
    vals.length > 1 &&
    vals.every(v => v.kind === 'group' && headName(v) === 'have')
  ) {
    return vals.map(v => renderFunction(v as GroupNode)).join(' ')
  }

  if (vals.length === 1) {
    return renderValueNode(vals[0])
  }

  // a list of simple values: comma- or space-joined by the property
  const rendered = vals.map(renderValueNode)
  const separator = COMMA_LIST.has(property) ? ', ' : ' '

  return rendered.join(separator)
}

// collect the CSS declarations from a group's direct `have <property>, <value>` children
function declarations(group: GroupNode): string {
  const out: string[] = []

  for (const node of childrenNamed(group, 'have')) {
    const property = argName(node, 0)
    const value = renderValue(node)

    if (property) {
      out.push(`  ${property}: ${value};`)
    }
  }

  return out.join('\n')
}

// ── selectors (`find` / `link` trees) ─────────────────────────────────────────

// the four `link` combinators, keyed by the `like` argument; absent `like` is a descendant
const COMBINATOR: Record<string, string> = {
  child: ' > ',
  next: ' + ',
  after: ' ~ ',
}

// attribute-operator qualifiers nested under a bare `have <attr>` (start -> `^=`, etc.)
const ATTR_OP: Record<string, string> = {
  start: '^=',
  end: '$=',
  has: '*=',
  word: '~=',
}

// render one element's qualifiers (everything after its tag): id / class / attr / state / position / part / :has /
// :where / :not. Multiple `have state` collapse to `:is(...)`.
function qualifiers(element: GroupNode): string {
  const out: string[] = []
  const states: string[] = []
  let part = ''

  for (const node of rest(element)) {
    if (node.kind !== 'group') {
      continue
    }

    const head = headName(node)

    if (head === 'have') {
      const key = argName(node, 0)
      const value = argText(node, 1)

      if (key === 'id') {
        out.push(`#${value}`)
      } else if (key === 'class') {
        out.push(`.${value}`)
      } else if (key === 'state') {
        states.push(`:${value}`)
      } else if (key === 'position') {
        out.push(`:nth-child(${value})`)
      } else if (key === 'part') {
        part = `::${value}`
      } else if (key === 'match') {
        out.push(`:has(${innerSelector(node)})`)
      } else if (key === 'constraint') {
        out.push(`:where(${classList(node)})`)
      } else {
        // an attribute: `have <attr>, <value>` or `have <attr>` + nested operator (start / end / ...)
        const op = rest(node).find(
          (n): n is GroupNode =>
            n.kind === 'group' && headName(n) === 'have',
        )

        if (op) {
          const opName = argName(op, 0)
          const opValue = argText(op, 1)
          out.push(`[${key}${ATTR_OP[opName] ?? '='}"${opValue}"]`)
        } else if (value) {
          out.push(`[${key}="${value}"]`)
        } else {
          out.push(`[${key}]`)
        }
      }
    } else if (head === 'lack') {
      const key = argName(node, 0)
      const value = argText(node, 1)

      if (key === 'field') {
        out.push(`:not([${value}])`)
      } else {
        out.push(`:not([${key}="${value}"])`)
      }
    }
  }

  const stateSelector =
    states.length > 1 ? `:is(${states.join(', ')})` : states.join('')

  return out.join('') + stateSelector + part
}

// the `.a, .b` class list inside a `have constraint` (:where) block
function classList(group: GroupNode): string {
  return childrenNamed(group, 'have')
    .filter(node => argName(node, 0) === 'class')
    .map(node => `.${argText(node, 1)}`)
    .join(', ')
}

// the inner selector of a `have match` (:has) block: a nested find + link chain
function innerSelector(matchGroup: GroupNode): string {
  const find = childrenNamed(matchGroup, 'find')[0]

  return find ? element(find) : ''
}

// render one element (tag + qualifiers) plus its nested `link` chain
function element(node: GroupNode): string {
  const tag = argName(node, 0)
  const quals = qualifiers(node)
  // `any` is `*`, but drop the `*` when a qualifier already anchors the selector (`.landing-h1`, not `*.landing-h1`)
  const tagText = tag === 'any' ? (quals ? '' : '*') : tag
  const self = tagText + quals

  const links = childrenNamed(node, 'link')
    .map(link => {
      const like = childrenNamed(link, 'like')[0]
      const combinator = like ? COMBINATOR[argName(like, 0)] ?? ' ' : ' '

      return combinator + element(link)
    })
    .join('')

  return self + links
}

// the full selector of a `base style`: each top-level `find` is one selector-list entry
function selector(group: GroupNode): string {
  return childrenNamed(group, 'find')
    .map(element)
    .join(',\n')
}

// ── at-rule + block emitters ──────────────────────────────────────────────────

// the responsive breakpoint min-widths (Tailwind defaults) used by `face` `case` variants
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

  for (const node of childrenNamed(group, 'case')) {
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
      rules.push(`${css}:${variant} {\n${body}\n}`)
    }
  }

  return rules.join('\n\n')
}

// emit theme tokens: `tone base` -> :root, `tone dark` -> .dark. (Bare `tone` still means :root.)
function emitTone(group: GroupNode): string {
  const scope = argName(group, 0)
  const selectorText = scope === 'dark' ? '.dark' : ':root'
  const out: string[] = []

  for (const node of childrenNamed(group, 'have')) {
    const token = argName(node, 0)
    const value = renderValue(node)

    if (token) {
      out.push(`  --${token}: ${value};`)
    }
  }

  return out.length ? `${selectorText} {\n${out.join('\n')}\n}` : ''
}

// emit `base font-face` -> @font-face
function emitFontFace(group: GroupNode): string {
  const body = declarations(group)

  return body ? `@font-face {\n${body}\n}` : ''
}

// emit `base style` -> a selector rule. The selector is a find/link tree; the declarations are the direct `have`s.
function emitStyle(group: GroupNode): string {
  const sel = selector(group)
  const body = declarations(group)

  return sel && body ? `${sel} {\n${body}\n}` : ''
}

// media/container feature conditions from `have` children: `have width` + min/max -> `(min-width: ...)`, a scalar
// `have <feature>, <value>` -> `(feature: value)`, `have type` -> a media type, `lack type` -> `not <type>`,
// `have preference` -> `(prefers-<k>: v)`, `have any`/`have all` -> boolean groups.
function conditions(group: GroupNode, isContainer: boolean): string {
  const parts: string[] = []

  for (const node of rest(group)) {
    if (node.kind !== 'group') {
      continue
    }

    const head = headName(node)

    if (head === 'have') {
      const key = argName(node, 0)
      const scalar = argText(node, 1)

      if (key === 'type') {
        parts.push(scalar)
      } else if (key === 'name' && isContainer) {
        // the container name is emitted before the condition list, not here
      } else if (key === 'width' || key === 'height') {
        for (const bound of childrenNamed(node, 'have')) {
          const which = argName(bound, 0)
          const px = argText(bound, 1)
          if (which === 'min') {
            parts.push(`(min-${key}: ${px})`)
          } else if (which === 'max') {
            parts.push(`(max-${key}: ${px})`)
          }
        }
      } else if (key === 'preference') {
        for (const pref of childrenNamed(node, 'have')) {
          parts.push(`(prefers-${argName(pref, 0)}: ${argText(pref, 1)})`)
        }
      } else if (key === 'style' && isContainer) {
        for (const bind of childrenNamed(node, 'bind')) {
          parts.push(`style(--${argName(bind, 0)}: ${argText(bind, 1)})`)
        }
      } else if (key === 'all' || key === 'any') {
        const joiner = key === 'all' ? ' and ' : ' or '
        const inner = childrenNamed(node, 'have')
          .map(sub => conditionOne(sub))
          .filter(Boolean)
        parts.push(`(${inner.join(joiner)})`)
      } else if (scalar) {
        parts.push(`(${key}: ${scalar})`)
      }
    } else if (head === 'lack') {
      if (argName(node, 0) === 'type') {
        parts.push(`not ${argText(node, 1)}`)
      }
    }
  }

  return parts.join(' and ')
}

// one nested boolean-group condition (`have hover, <hover>` -> `(hover: hover)`, or a nested `have all`/`have any`)
function conditionOne(node: GroupNode): string {
  const key = argName(node, 0)

  if (key === 'all' || key === 'any') {
    const joiner = key === 'all' ? ' and ' : ' or '
    const inner = childrenNamed(node, 'have')
      .map(conditionOne)
      .filter(Boolean)
    return `(${inner.join(joiner)})`
  }

  return `(${key}: ${argText(node, 1)})`
}

// emit `base media` / `base container` -> an @media / @container block wrapping its nested rules
function emitQuery(group: GroupNode, kind: 'media' | 'container'): string {
  const isContainer = kind === 'container'
  const query = conditions(group, isContainer)
  const inner = nestedRules(group)

  if (!inner) {
    return ''
  }

  if (isContainer) {
    const name = childrenNamed(group, 'have')
      .filter(node => argName(node, 0) === 'name')
      .map(node => argText(node, 1))[0]
    const prefix = name ? `${name} ` : ''

    return `@container ${prefix}${query} {\n${inner}\n}`
  }

  return `@media ${query} {\n${inner}\n}`
}

// emit `base layers` -> `@layer a, b, c;`
function emitLayers(group: GroupNode): string {
  const names = rest(group)
    .map(renderValueNode)
    .filter(Boolean)

  return names.length ? `@layer ${names.join(', ')};` : ''
}

// emit `base layer, name <x>` -> `@layer x { ... }`
function emitLayer(group: GroupNode): string {
  const name = childrenNamed(group, 'name')
    .map(node => argText(node, 0))[0]
  const inner = nestedRules(group)

  return name && inner ? `@layer ${name} {\n${inner}\n}` : ''
}

// emit `base keyframes, name <x>` -> `@keyframes x { <stop> { ... } }` from its `case` children
function emitKeyframes(group: GroupNode): string {
  const name = childrenNamed(group, 'name')
    .map(node => argText(node, 0))[0]

  if (!name) {
    return ''
  }

  const stops: string[] = []

  for (const stop of childrenNamed(group, 'case')) {
    const at = argName(stop, 0) || argText(stop, 0)
    const body = declarations(stop)
    if (at && body) {
      stops.push(`${at} {\n${body}\n}`)
    }
  }

  return stops.length ? `@keyframes ${name} {\n${stops.join('\n')}\n}` : ''
}

// the rules nested inside an at-rule block (media / container / layer): `base style` / `face` / further at-rules
function nestedRules(group: GroupNode): string {
  const out: string[] = []

  for (const node of rest(group)) {
    if (node.kind !== 'group') {
      continue
    }

    const rendered = emitBase(node)
    if (rendered) {
      out.push(rendered)
    }
  }

  return out.join('\n\n')
}

// emit any `base ...` block by its second token, plus a `face` nested inside an at-rule. Falls back to the OLD
// raw-selector form (`base <html, body>` with a text-literal selector, optionally wrapping nested `base` at-rules) for
// backward compatibility with sheets that have not migrated.
function emitBase(group: GroupNode): string {
  const head = headName(group)

  if (head === 'face') {
    return emitFace(group)
  }

  if (head === 'tone') {
    return emitTone(group)
  }

  if (head !== 'base') {
    return ''
  }

  switch (argName(group, 0)) {
    case 'font-face':
      return emitFontFace(group)
    case 'style':
      return emitStyle(group)
    case 'media':
      return emitQuery(group, 'media')
    case 'container':
      return emitQuery(group, 'container')
    case 'layers':
      return emitLayers(group)
    case 'layer':
      return emitLayer(group)
    case 'keyframes':
      return emitKeyframes(group)
    default:
      return emitBaseRaw(group)
  }
}

// OLD raw-selector rule: `base <html, body>` -> `html, body { ... }`, with nested `base <@media ...>` at-rule wrappers.
// The selector is a verbatim text literal. Kept so pre-migration sheets (clue.surf/home2) still compile.
function emitBaseRaw(group: GroupNode): string {
  const sel = argText(group, 0)

  if (!sel) {
    return ''
  }

  const nested = childrenNamed(group, 'base')
    .map(emitBaseRaw)
    .filter(Boolean)

  if (nested.length) {
    return `${sel} {\n${nested.join('\n')}\n}`
  }

  const body = declarations(group)

  return body ? `${sel} {\n${body}\n}` : ''
}

// ── entry ─────────────────────────────────────────────────────────────────────

// compile a `.tree` look sheet into a CSS stylesheet. With `only`, this is the Tailwind JIT: emit only the `face` rules
// whose class name is in the used set (matched by FULL name). Every non-`face` block (`base ...`, `tone`) is always
// emitted (the resets, fonts, theme tokens, and at-rules the utilities rely on).
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
      blocks.push(emitBase(group))
    }
  }

  return blocks.filter(Boolean).join('\n\n') + '\n'
}
