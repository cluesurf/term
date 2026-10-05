// The look STYLE TABLE: the native counterpart of look-css.ts (native-dom-0008). A native host has no CSS engine and
// should not get one, so a `look` sheet compiles instead to a table: for each `face` class, the typed properties it
// sets, every `var(--token)` resolved at build time against the sheet's `tone` blocks, every length in points and
// every color in hex. A host applies a class by looking up its row and never parses a selector or a token.
//
// What a host cannot honor is NAMED in the table's `unlowered` list with the reason, never dropped: a pseudo-class
// (`focus-visible`, `hover`), a breakpoint, a `group-` or `peer-` variant, an animation, a shadow, or a value form the
// table does not read (`em`, `%`, `rgb()`). The restriction is the one React Native's StyleSheet makes: a class and a
// state attribute, nothing that needs a selector engine.
//
// The sheet is read with the compiler's parser and look-css.ts's accessors, so there is still one reader of `look`.

import { parse } from '@term/make/code/parser/tree'
import type { GroupNode } from '@term/make/code/parser/narrow'
import {
  argName,
  BREAKPOINT,
  childrenNamed,
  headName,
  renderValue,
  STATE_ATTR,
} from '@term/make/code/compile/look-css'

export type StyleValue =
  | { kind: 'length'; points: number }
  // padding's one to four sides, in CSS order (top, right, bottom, left once expanded)
  | { kind: 'sides'; points: [number, number, number, number] }
  | { kind: 'color'; hex: string }
  | { kind: 'number'; value: number }
  | { kind: 'keyword'; text: string }
  | { kind: 'border'; points: number; style: string; hex: string }

export type StyleRow = { property: string; value: StyleValue }

// a state row applies while the node carries `attribute` (with `value`, when one is given)
export type StyleState = { attribute: string; value?: string; rows: StyleRow[] }

export type StyleClass = { name: string; rows: StyleRow[]; states: StyleState[] }

// `at` is the class (or `base <kind>`), and `variant` the `case` it was under, when it was under one. Kept apart
// because a class name may itself hold a colon (tailwind's `sm:p-0`)
export type Unlowered = { at: string; variant?: string; what: string; why: string }

export type StyleTable = {
  target: 'toolkit'
  scheme: 'light' | 'dark'
  classes: StyleClass[]
  unlowered: Unlowered[]
}

const REM = 16

// what the toolkit host lowers, by the kind of value each property takes. A property outside this table is named
const PROPERTY_KIND: Record<string, StyleValue['kind']> = {
  display: 'keyword',
  'flex-direction': 'keyword',
  'align-items': 'keyword',
  'justify-content': 'keyword',
  gap: 'length',
  padding: 'sides',
  width: 'length',
  height: 'length',
  'flex-grow': 'number',
  background: 'color',
  'background-color': 'color',
  color: 'color',
  border: 'border',
  'border-color': 'color',
  'border-width': 'length',
  'border-radius': 'length',
  opacity: 'number',
  'font-size': 'length',
  'font-weight': 'number',
}

// properties with no native counterpart, and why, so the reason travels with the name
const NO_COUNTERPART: Record<string, string> = {
  transition: 'an animation, which the table does not carry: a native host animates a state change itself',
  animation: 'an animation, which the table does not carry: a native host animates a state change itself',
  'box-shadow': 'a shadow, which the toolkit host does not draw',
  outline: 'the platform draws its own focus indication',
  cursor: 'a pointer shape, which the toolkit host does not set',
}

// variants a native host can apply: the state attributes (look-css's STATE_ATTR) and `disabled`, which every control
// the toolkit host makes carries as an attribute
function stateOf(variant: string): { attribute: string; value?: string } | undefined {
  const attr = STATE_ATTR[variant]

  if (attr) {
    const match = /^\[([a-z-]+)=([a-z-]+)\]$/.exec(attr)

    return match ? { attribute: match[1]!, value: match[2]! } : undefined
  }

  if (variant === 'disabled') {
    return { attribute: 'disabled' }
  }

  return undefined
}

function whyNotVariant(variant: string): string {
  if (variant in BREAKPOINT) {
    return 'a width breakpoint: a native window reads its size class from the device traits, not a media query'
  }

  if (variant.startsWith('group-') || variant.startsWith('peer-')) {
    return 'a variant on another node, which needs a selector engine'
  }

  return 'a pseudo-class, which needs the browser\'s state machine: the platform control tracks its own focus, hover and press'
}

// the `tone` blocks: the base tokens, then the dark overrides on top when the scheme is dark
function tokensOf(groups: GroupNode[], scheme: 'light' | 'dark'): Map<string, string> {
  const tokens = new Map<string, string>()
  const read = (group: GroupNode) => {
    for (const have of childrenNamed(group, 'have')) {
      const token = argName(have, 0)

      if (token) {
        tokens.set(token, renderValue(have))
      }
    }
  }

  // a bare `tone` has no scope, so its first argument is its first `have`: anything but `dark` is the base scope, the
  // way look-css.ts reads it
  for (const group of groups) {
    if (headName(group) === 'tone' && argName(group, 0) !== 'dark') {
      read(group)
    }
  }

  if (scheme === 'dark') {
    for (const group of groups) {
      if (headName(group) === 'tone' && argName(group, 0) === 'dark') {
        read(group)
      }
    }
  }

  return tokens
}

// replace every `var(--name)` / `var(--name, fallback)` with its token, to a fixed point. Throws with the reason
function resolve(text: string, tokens: Map<string, string>, depth = 0): string {
  if (depth > 16) {
    throw new Error('a token refers to itself')
  }

  const out = text.replace(/var\(--([a-z0-9-]+)(?:,\s*([^()]*))?\)/g, (_, name: string, fallback?: string) => {
    const value = tokens.get(name) ?? fallback?.trim()

    if (value === undefined) {
      throw new Error(`no token \`${name}\``)
    }

    return value
  })

  return out.includes('var(') ? resolve(out, tokens, depth + 1) : out
}

function length(text: string): number {
  const match = /^(-?\d*\.?\d+)(px|rem)?$/.exec(text.trim())

  if (!match || (!match[2] && Number(match[1]) !== 0)) {
    throw new Error(`\`${text}\` is not a length in px or rem`)
  }

  return match[2] === 'rem' ? Number(match[1]) * REM : Number(match[1])
}

function color(text: string): string {
  const value = text.trim().toLowerCase()

  if (value === 'transparent') {
    return '#00000000'
  }

  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])([0-9a-f])?$/.exec(value)

  if (short) {
    return `#${short.slice(1).filter(Boolean).map(digit => digit + digit).join('')}`
  }

  if (/^#([0-9a-f]{6}|[0-9a-f]{8})$/.test(value)) {
    return value
  }

  throw new Error(`\`${text}\` is not a hex color`)
}

function valueOf(property: string, text: string): StyleValue {
  const kind = PROPERTY_KIND[property]

  switch (kind) {
    case 'keyword':
      return { kind, text: text.trim() }
    case 'length':
      return { kind, points: length(text) }
    case 'number': {
      const value = Number(text.trim())

      if (Number.isNaN(value)) {
        throw new Error(`\`${text}\` is not a number`)
      }

      return { kind, value }
    }
    case 'color':
      return { kind, hex: color(text) }
    case 'sides': {
      const parts = text.trim().split(/\s+/).map(length)
      const [top, right = top, bottom = top, left = right] = parts

      if (parts.length > 4) {
        throw new Error(`\`${text}\` has more than four sides`)
      }

      return { kind, points: [top!, right!, bottom!, left!] }
    }
    case 'border': {
      const [width, style, ...rest] = text.trim().split(/\s+/)

      if (!width || !style || rest.length !== 1) {
        throw new Error(`\`${text}\` is not \`<width> <style> <color>\``)
      }

      return { kind, points: length(width), style, hex: color(rest[0]!) }
    }
    default:
      throw new Error(NO_COUNTERPART[property] ?? 'a property the toolkit host does not lower')
  }
}

// a block's direct `have` declarations as rows, naming each one that does not lower
function rowsOf(
  group: GroupNode,
  place: { at: string; variant?: string },
  tokens: Map<string, string>,
  unlowered: Unlowered[],
): StyleRow[] {
  const rows: StyleRow[] = []

  for (const have of childrenNamed(group, 'have')) {
    const property = argName(have, 0)
    const written = renderValue(have)

    try {
      rows.push({ property, value: valueOf(property, resolve(written, tokens)) })
    } catch (error) {
      unlowered.push({ ...place, what: `${property}: ${written}`, why: (error as Error).message })
    }
  }

  return rows
}

// compile a look sheet to the style table a toolkit host applies. `scheme` picks the token set: the dark table is the
// light one with `tone dark` laid over it and every class's `case dark` rows merged in
export function compileLookTable(
  source: { file: string; text: string },
  options?: { scheme?: 'light' | 'dark' },
): StyleTable {
  const scheme = options?.scheme ?? 'light'
  const table: StyleTable = { target: 'toolkit', scheme, classes: [], unlowered: [] }
  const parsed = parse(source)

  if (!parsed.ok) {
    return table
  }

  const groups = parsed.tree.nodes.filter((node): node is GroupNode => node.kind === 'group')
  const tokens = tokensOf(groups, scheme)

  for (const group of groups) {
    const head = headName(group)

    if (head === 'base') {
      table.unlowered.push({
        at: `base ${argName(group, 0)}`.trim(),
        what: 'a selector rule or at-rule',
        why: 'it styles by selector, and a native host applies classes only',
      })
      continue
    }

    if (head !== 'face') {
      continue
    }

    const name = argName(group, 0)
    const entry: StyleClass = { name, rows: rowsOf(group, { at: name }, tokens, table.unlowered), states: [] }

    for (const variant of childrenNamed(group, 'case')) {
      const which = argName(variant, 0)
      const place = { at: name, variant: which }

      if (which === 'dark') {
        if (scheme === 'dark') {
          entry.rows.push(...rowsOf(variant, place, tokens, table.unlowered))
        }
        continue
      }

      const state = stateOf(which)

      if (!state) {
        table.unlowered.push({ ...place, what: `case ${which}`, why: whyNotVariant(which) })
        continue
      }

      entry.states.push({ ...state, rows: rowsOf(variant, place, tokens, table.unlowered) })
    }

    table.classes.push(entry)
  }

  return table
}

// a row as the one declaration a host's set-style reads: lengths in px, colors in hex, nothing left to resolve
export function declarationOf(row: StyleRow): string {
  const value = row.value

  switch (value.kind) {
    case 'length':
      return `${row.property}: ${value.points}px`
    case 'sides':
      return `${row.property}: ${value.points.map(side => `${side}px`).join(' ')}`
    case 'color':
      return `${row.property}: ${value.hex}`
    case 'number':
      return `${row.property}: ${value.value}`
    case 'keyword':
      return `${row.property}: ${value.text}`
    case 'border':
      return `${row.property}: ${value.points}px ${value.style} ${value.hex}`
  }
}

// the table as the text a host loads: rows joined by `;`, each `<class>|<state>|<declaration>`, where state is empty for
// a class's own rows and `attribute` or `attribute=value` for a state row. A lowered value is a number, a length, a hex
// color or a keyword, so neither separator can appear inside one, the host splits without a parser, and the whole
// table is one line any text literal can carry
export function styleTableText(table: StyleTable): string {
  const lines: string[] = []

  for (const entry of table.classes) {
    for (const row of entry.rows) {
      lines.push(`${entry.name}||${declarationOf(row)}`)
    }

    for (const state of entry.states) {
      const on = state.value === undefined ? state.attribute : `${state.attribute}=${state.value}`

      for (const row of state.rows) {
        lines.push(`${entry.name}|${on}|${declarationOf(row)}`)
      }
    }
  }

  return lines.join(';')
}
