// Text geometry for the language server: positions, edits, folding and selection, read off the document text alone.
//
// EVERY COLUMN HERE IS A UTF-16 CODE UNIT, which is what the LSP means by a character unless a client negotiates
// otherwise, and what a JavaScript string index already is. The compiler's columns are string indices too, so a
// span from the parser maps across unchanged. Term text holds Greek, CJK and emoji, and an emoji is two units: a
// column counted in code points would land one place left of every name after it.

import type { LspPosition, LspRange } from '@term/flow/code/analyze'

// the offset of a position in the text, clamped into it: a line past the end is the end, a character past a line's
// end is that line's end (the protocol says to treat both that way rather than fail)
export function offsetAt(text: string, position: LspPosition): number {
  let line = 0
  let offset = 0

  while (line < position.line) {
    const next = text.indexOf('\n', offset)

    if (next < 0) {
      return text.length
    }

    offset = next + 1
    line++
  }

  const end = text.indexOf('\n', offset)
  const lineEnd = end < 0 ? text.length : end

  return Math.min(offset + Math.max(0, position.character), lineEnd)
}

export type ContentChange =
  | { text: string }
  | { range: LspRange; rangeLength?: number; text: string }

// apply one `didChange` content change: a whole-document replacement, or a ranged edit
export function applyChange(text: string, change: ContentChange): string {
  if (!('range' in change) || !change.range) {
    return change.text
  }

  const start = offsetAt(text, change.range.start)
  const end = Math.max(start, offsetAt(text, change.range.end))

  return text.slice(0, start) + change.text + text.slice(end)
}

const indentOf = (line: string): number => line.length - line.trimStart().length
const blank = (line: string): boolean => line.trim().length === 0

// the last line of the block a line opens: every following line that is blank or indented deeper, up to the last
// non-blank one
function blockEnd(lines: string[], at: number): number {
  const indent = indentOf(lines[at]!)

  let end = at

  for (let i = at + 1; i < lines.length; i++) {
    if (blank(lines[i]!)) {
      continue
    }

    if (indentOf(lines[i]!) <= indent) {
      break
    }

    end = i
  }

  return end
}

export type FoldingRange = {
  startLine: number
  endLine: number
  kind?: 'comment' | 'imports' | 'region'
}

// a block folds from the line that opens it to its last indented line. A run of two or more `#` comment lines folds
// as a comment, and a `load` / `bear` block as imports.
export function foldingRanges(text: string): FoldingRange[] {
  const lines = text.split('\n')
  const out: FoldingRange[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!

    if (blank(line)) {
      continue
    }

    if (line.trimStart().startsWith('#')) {
      // a comment run at this indent, counted once from its first line
      const previous = lines[i - 1]

      if (
        previous !== undefined &&
        previous.trimStart().startsWith('#') &&
        indentOf(previous) === indentOf(line)
      ) {
        continue
      }

      let end = i

      while (
        end + 1 < lines.length &&
        lines[end + 1]!.trimStart().startsWith('#') &&
        indentOf(lines[end + 1]!) === indentOf(line)
      ) {
        end++
      }

      if (end > i) {
        out.push({ startLine: i, endLine: end, kind: 'comment' })
      }

      continue
    }

    const end = blockEnd(lines, i)

    if (end > i) {
      const head = line.trimStart().split(/[\s,]/)[0]
      out.push(
        head === 'load' || head === 'bear'
          ? { startLine: i, endLine: end, kind: 'imports' }
          : { startLine: i, endLine: end },
      )
    }
  }

  return out
}

export type SelectionRange = { range: LspRange; parent?: SelectionRange }

const NAME = /[A-Za-z0-9-]/

// the selection steps out from a position: the word under it, the line's content, the block that line opens, then
// each enclosing block, then the whole document. Each step contains the one before, as the protocol requires.
export function selectionRange(text: string, position: LspPosition): SelectionRange {
  const lines = text.split('\n')
  const lastLine = Math.max(0, lines.length - 1)
  const whole: LspRange = {
    start: { line: 0, character: 0 },
    end: { line: lastLine, character: lines[lastLine]!.length },
  }

  const line = Math.min(Math.max(0, position.line), lastLine)
  const content = lines[line]!
  const character = Math.min(Math.max(0, position.character), content.length)

  const steps: LspRange[] = []

  // the word
  let from = character
  let to = character

  while (from > 0 && NAME.test(content[from - 1]!)) {
    from--
  }

  while (to < content.length && NAME.test(content[to]!)) {
    to++
  }

  if (to > from) {
    steps.push({ start: { line, character: from }, end: { line, character: to } })
  }

  // the line's content
  if (!blank(content)) {
    steps.push({
      start: { line, character: indentOf(content) },
      end: { line, character: content.trimEnd().length },
    })
  }

  // the block this line opens, then each block enclosing it
  let at = blank(content) ? -1 : line

  while (at >= 0) {
    const end = blockEnd(lines, at)
    steps.push({
      start: { line: at, character: indentOf(lines[at]!) },
      end: { line: end, character: lines[end]!.length },
    })

    // the nearest line above with a smaller indent opens the enclosing block
    const indent = indentOf(lines[at]!)
    let up = at - 1

    while (up >= 0 && (blank(lines[up]!) || indentOf(lines[up]!) >= indent)) {
      up--
    }

    at = indent === 0 ? -1 : up
  }

  steps.push(whole)

  // keep only steps that strictly grow, so each parent contains its child
  const contains = (outer: LspRange, inner: LspRange): boolean =>
    (outer.start.line < inner.start.line ||
      (outer.start.line === inner.start.line && outer.start.character <= inner.start.character)) &&
    (outer.end.line > inner.end.line ||
      (outer.end.line === inner.end.line && outer.end.character >= inner.end.character))

  const same = (a: LspRange, b: LspRange): boolean =>
    a.start.line === b.start.line &&
    a.start.character === b.start.character &&
    a.end.line === b.end.line &&
    a.end.character === b.end.character

  const kept: LspRange[] = []

  for (const step of steps) {
    const last = kept[kept.length - 1]

    if (!last || (contains(step, last) && !same(step, last))) {
      kept.push(step)
    }
  }

  let result: SelectionRange | undefined

  for (let i = kept.length - 1; i >= 0; i--) {
    result = { range: kept[i]!, parent: result }
  }

  return result ?? { range: whole }
}

// Where a line of the text the compiler read came from in the text the author wrote. A test file is compiled after
// its `test` blocks are rewritten into tasks, which moves lines (call/code/test-preprocess.ts `origin`). For every
// other file the two texts are one and the mapping is the identity.
export type Mapping = {
  identity: boolean
  // compiler coordinates to the author's
  outer(position: LspPosition, edge?: 'start' | 'end'): LspPosition
  // the author's coordinates to the compiler's
  inner(position: LspPosition): LspPosition
}

export const IDENTITY: Mapping = {
  identity: true,
  outer: p => p,
  inner: p => p,
}

export function makeMapping(source: string, compiled: string, origin: number[]): Mapping {
  const sourceLines = source.split('\n')
  const compiledLines = compiled.split('\n')

  // per compiled line, the column shift to its source line, or undefined when the text differs beyond indentation
  const shift = compiledLines.map((line, n) => {
    const from = sourceLines[origin[n] ?? n]

    if (from === undefined) {
      return undefined
    }

    if (line === from) {
      return 0
    }

    return line.trim() === from.trim() ? indentOf(from) - indentOf(line) : undefined
  })

  // per source line, the compiled line that carries its text (the first such)
  const back = new Map<number, number>()

  origin.forEach((from, n) => {
    if (shift[n] !== undefined && !back.has(from)) {
      back.set(from, n)
    }
  })

  return {
    identity: false,
    outer(position, edge = 'start') {
      const line = origin[position.line] ?? position.line
      const delta = shift[position.line]
      const text = sourceLines[line] ?? ''

      if (delta !== undefined) {
        return { line, character: Math.max(0, Math.min(text.length, position.character + delta)) }
      }

      return { line, character: edge === 'start' ? indentOf(text) : text.length }
    },
    inner(position) {
      const line = back.get(position.line)

      if (line === undefined) {
        // a source line the compiled text does not carry verbatim: its first compiled line, or itself
        const first = origin.indexOf(position.line)

        return { line: first >= 0 ? first : position.line, character: position.character }
      }

      return {
        line,
        character: Math.max(0, position.character - (shift[line] ?? 0)),
      }
    },
  }
}

export function outerRange(map: Mapping, range: LspRange): LspRange {
  return map.identity
    ? range
    : { start: map.outer(range.start, 'start'), end: map.outer(range.end, 'end') }
}
