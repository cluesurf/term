// Building events and expected lines for the golden tests, in TypeScript, the way a command will (phase 2): an event is
// `blankEvent()` with what it has, and every value is a number until the library formats it.

import { blankEvent, plainSubject } from '@term/call/code/work/item/event'
import type { Event, Frame, ItemField, Tally, Span, TreeNode } from '@term/call/code/work/item/event'
import { makeStandard } from '@term/call/code/work/item/standard'
import { makeRoom } from '@term/call/code/work/item/layout'
import type { Room, Line } from '@term/call/code/work/item/layout'

// the standard as the mockups draw it: a clock on every item (D35). The standard itself shows one only on a slow item
// or a live log, which test/item/unit.ts holds against `makeStandard()` as it ships
const SHIPPED = makeStandard()
export const STANDARD = { ...SHIPPED, facts: { ...SHIPPED.facts, clockFrom: -1 } }

// the mockups' zone: Pacific daylight time, 2026-10-03
export const OFFSET = -420

export function room(width: number, ascii = false, utc = false): Room {
  return makeRoom(width, STANDARD, ascii, OFFSET, utc)
}

// a clock on the mockups' day, `14:42:00.005`, as epoch milliseconds
export function T(time: string, day = 3): number {
  const [clock, millis = '0'] = time.split('.')
  const [hours = 0, minutes = 0, seconds = 0] = clock!.split(':').map(Number)

  return Date.UTC(2026, 9, day, hours, minutes, seconds, Number(millis.padEnd(3, '0'))) - OFFSET * 60000
}

export type EventInput = Partial<Omit<Event, 'subject' | 'clock' | 'status'>> & {
  subject?: string | Span[]
  clock?: string | number
  http?: number
  exit?: number
  signal?: string
}

export function ev(input: EventInput): Event {
  const { subject, clock, http, exit, signal, ...rest } = input
  const event: Event = { ...blankEvent(), ...rest }

  if (subject !== undefined) {
    event.subject = typeof subject === 'string' ? plainSubject(subject) : subject
  }

  if (clock !== undefined) {
    event.clock = typeof clock === 'string' ? T(clock) : clock
  }

  if (http !== undefined) {
    event.status = { kind: 'http', value: http, name: '' }
  }

  if (exit !== undefined) {
    event.status = { kind: 'exit', value: exit, name: '' }
  }

  if (signal !== undefined) {
    event.status = { kind: 'signal', value: 0, name: signal }
  }

  return event
}

export function tally(amount: number, noun: string, one = '', total = -1): Tally {
  return { amount, noun, one, total }
}

export function field(key: string, value: string | Span[], location = false): ItemField {
  return { key, value: typeof value === 'string' ? plainSubject(value) : value, location }
}

export function at(value: string): ItemField {
  return field('at', value, true)
}

export function frame(lines: [number, string][], marks: { line: number; column: number; length: number; label?: string; primary?: boolean }[], tabWidth = 8): Frame {
  return {
    lines: lines.map(([number, value]) => ({ number, value })),
    marks: marks.map(mark => ({ line: mark.line, column: mark.column, length: mark.length, label: mark.label ?? '', primary: mark.primary ?? true })),
    tabWidth,
  }
}

export function node(label: string, detail = '', children: TreeNode[] = [], deduped = false): TreeNode {
  return { label, detail, deduped, children }
}

// ---- expected lines ----

export type Mark = { role: string; strong: boolean; focus: boolean }

// a line as it should be: its text, and the mark each character should carry (null: not checked)
export type Expected = { text: string; marks: (Mark | null)[] }

export type Part = string | { role: string; text: string; strong?: boolean; focus?: boolean }

function part(role: string, text: string, strong = false): Part {
  return { role, text, strong }
}

export const t = (text: string): Part => part('text', text)
export const B = (text: string): Part => part('text', text, true)
export const d = (text: string): Part => part('dim', text)
export const f = (text: string): Part => part('faint', text)
export const o = (text: string): Part => part('done', text)
export const x = (text: string): Part => part('failed', text)
export const w = (text: string): Part => part('warning', text)
export const a = (text: string): Part => part('active', text)
export const s = (text: string): Part => part('source', text)

// a line from parts: a plain string is text, and every space is left unchecked
export function row(...parts: Part[]): Expected {
  let text = ''
  const marks: (Mark | null)[] = []

  for (const each of parts) {
    const piece = typeof each === 'string' ? { role: 'text', text: each, strong: false, focus: false } : each

    for (const character of piece.text) {
      text += character
      marks.push(character === ' ' ? null : { role: piece.role, strong: piece.strong ?? false, focus: piece.focus ?? false })
    }
  }

  return { text, marks }
}

// a line whose text alone is checked: the views with no color
export function plain(text: string): Expected {
  return { text, marks: [...text].map(() => null) }
}

export const BLANK: Expected = { text: '', marks: [] }

// the indent of the body column
export const I = ' '.repeat(11)

// a patch to a mockup's lines, naming the entry of note/term/output/mockup-differences.md that justifies it
export type Patch =
  | { entry: string; at: number; remove: number; insert: Expected[] }
  | { entry: string; retint: number; from: number; to: number; role: string }

export function replace(entry: string, at: number, remove: number, ...insert: Expected[]): Patch {
  return { entry, at, remove, insert }
}

export function retint(entry: string, line: number, from: number, to: number, role: string): Patch {
  return { entry, retint: line, from, to, role }
}

export type Segment = { command: string; draw: (room: Room) => Line[] }

export type Card = {
  caption: string
  segments: Segment[]
  patches: Patch[]
  // a card whose spec-correct form is written out in full rather than patched, and the entry that justifies it
  whole?: Expected[]
  entry?: string
  // the card is drawn in ASCII (No color, ASCII only)
  ascii?: boolean
  // no color in the card: text alone is compared
  colorless?: boolean
  // light theme (the paint round trip is checked in it)
  light?: boolean
  // lines that are data on stdout, not the human view (Machine output): no width invariant
  data?: boolean
}
