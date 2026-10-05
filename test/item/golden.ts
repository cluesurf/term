// Every mockup of note/term/output/mockups.html as a golden test of the item library (deck/call/code/work/item/).
//
// Each card's EVENTS (cards.ts) are drawn at the card's width and compared with the card: every line's text, and the
// role of every character, so color is checked as well as layout. A card that disagrees with the spec is compared
// with its spec-correct form, the mockup plus patches that each name their entry in
// note/term/output/mockup-differences.md. Then every card is drawn three ways, in color, without color and in ASCII,
// and every line of every one must satisfy `display_width(line) <= cols` (section 21). The color is checked twice:
// in the layout, and again in the escapes the truecolor and 16-color targets write, read back into roles.
//
// Run: npx tsx test/item/golden.ts

import { readFileSync } from 'node:fs'
import { blankLine, lineText } from '@term/call/code/work/item/layout'
import type { Line } from '@term/call/code/work/item/layout'
import { drawCommand } from '@term/call/code/work/item/run'
import { measureText } from '@term/call/code/work/item/measure'
import { makePalette, paintLines } from '@term/call/code/work/item/paint'
import { writeJsonEvent } from '@term/call/code/work/item/json'
import { CARDS, machineEvents } from './cards'
import { OFFSET, STANDARD, room } from './build'
import type { Card, Expected, Mark, Patch } from './build'
import { MOCKUP_DIFFERENCES, MOCKUP_FIXTURE, MOCKUP_PAGE, readMockups } from './mockup'
import type { Mockup } from './mockup'

let pass = 0
let fail = 0

function ok(name: string, holds: boolean, detail = ''): void {
  if (holds) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}${detail ? `\n${detail}` : ''}`)
  }
}

// ---- the fixture is the page ----

const mockups = readMockups(readFileSync(MOCKUP_PAGE, 'utf8'))
const fixture = JSON.parse(readFileSync(MOCKUP_FIXTURE, 'utf8')) as Mockup[]

ok('test/item/mockups.json is what the mockup page extracts to', JSON.stringify(mockups) === JSON.stringify(fixture))
ok('every card on the page has a golden test, and in page order', mockups.length === CARDS.length && mockups.every((one, at) => one.caption === CARDS[at]!.caption))

// every difference from the mockup is written down, and every one written down is still applied
const written = new Set([...readFileSync(MOCKUP_DIFFERENCES, 'utf8').matchAll(/^### (D\d+)$/gm)].map(match => match[1]!))
// D33 and D34 are applied to every card by `elbowQuotes` and `oneSpaceFields`, not by a patch, so they are cited here
const cited = new Set(['D33', 'D34',...CARDS.flatMap(card => [...card.patches.flatMap(patch => patch.entry.split(' ')), ...(card.entry ? [card.entry] : [])])])
const unwritten = [...cited].filter(entry => !written.has(entry))
const unapplied = [...written].filter(entry => !cited.has(entry))
const unjustified = CARDS.filter(card => card.whole && !card.entry).map(card => card.caption)
ok(
  'mockup-differences.md and the patches name the same entries',
  unwritten.length === 0 && unapplied.length === 0 && unjustified.length === 0,
  [
    unwritten.length ? `  cited, not in the note: ${unwritten.join(', ')}` : '',
    unapplied.length ? `  in the note, never cited: ${unapplied.join(', ')}` : '',
    unjustified.length ? `  a whole card with no entry: ${unjustified.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n'),
)

// ---- expected lines ----

function applyPatches(lines: Expected[], patches: Patch[]): Expected[] {
  const out = lines.map(line => ({ text: line.text, marks: [...line.marks] }))

  // recolorings first, at their original line numbers, then line replacements from the bottom up so each patch's
  // line number is the mockup's own
  for (const patch of patches) {
    if ('retint' in patch) {
      const line = out[patch.retint]!

      for (let at = patch.from; at < patch.to; at++) {
        const mark = line.marks[at]

        if (mark) {
          line.marks[at] = { ...mark, role: patch.role }
        }
      }
    }
  }

  const replacements = patches.filter((patch): patch is Extract<Patch, { at: number }> => 'at' in patch).sort((a, b) => b.at - a.at)

  for (const patch of replacements) {
    out.splice(patch.at, patch.remove, ...patch.insert)
  }

  return out
}

function expectedOf(card: Card, mockup: Mockup): Expected[] {
  if (card.whole) {
    return oneSpaceFields(card.whole, card.colorless === true)
  }

  const lines: Expected[] = mockup.lines.map(line => ({
    text: line.text,
    marks: line.marks.map(mark => (mark.role === 'cursor' ? null : mark)),
  }))

  return oneSpaceFields(elbowQuotes(applyPatches(lines, card.patches)), card.colorless === true)
}

// D34: a field's value sits one space after its own key, where the mockups pad every key of an item to the widest
// (the user's choice, 2026-10-04). A field line opens at the body column with a dim key and 2 or more spaces before
// a value that is not dim; a table's header row is dim all along, so its gaps are left alone
const FIELD = /^( {11}[a-z][\w-]*)( {2,})(?=\S)/

function oneSpaceFields(lines: Expected[], colorless: boolean): Expected[] {
  return lines.map(line => {
    const found = FIELD.exec(line.text)

    if (!found) {
      return line
    }

    const keyEnd = found[1]!.length
    const valueAt = keyEnd + found[2]!.length

    // a card drawn without color has no marks to tell a key by, and its fields are the same shape
    if (!colorless && (line.marks[keyEnd - 1]?.role !== 'dim' || line.marks[valueAt]?.role === 'dim')) {
      return line
    }

    return {
      text: `${found[1]} ${line.text.slice(valueAt)}`,
      marks: [...line.marks.slice(0, keyEnd), null, ...line.marks.slice(valueAt)],
    }
  })
}

// D33: a quote is a child program's own lines, and hangs off a dim `⎿` elbow on its first line with the rest under it,
// 3 cells right of the body column, where the mockups draw a `│ ` gutter on every line (the user's choice, 2026-10-04).
// A quote line is one that opens with the body column's 11 spaces and then `│`; a code frame has its line number there,
// and a tree's stem (`│  └─`) goes on with the tree's own characters
const QUOTE = /^ {11}│ (?! *[├└│])/
const ELBOW: Mark = { role: 'dim', strong: false, focus: false }

function elbowQuotes(lines: Expected[]): Expected[] {
  return lines.map((line, at) => {
    if (!QUOTE.test(line.text)) {
      return line
    }

    const first = at === 0 || !QUOTE.test(lines[at - 1]!.text)
    const lead = first ? '⎿  ' : '   '
    const rest = [...line.text].slice(13)

    return {
      text: `${' '.repeat(11)}${lead}${rest.join('')}`,
      marks: [...line.marks.slice(0, 11), first ? ELBOW : null, null, null, ...line.marks.slice(13)],
    }
  })
}

// ---- drawing a card ----

function drawCard(card: Card, width: number, ascii: boolean): Line[] {
  const one = room(width, ascii)
  const out: Line[] = []

  card.segments.forEach((segment, at) => {
    if (at > 0) {
      out.push(blankLine())
    }

    out.push(drawCommand(segment.command, one))
    out.push(...segment.draw(one))
  })

  return out
}

// the mark of every character of a drawn line
function marksOf(line: Line): { text: string; marks: Mark[] } {
  let text = ''
  const marks: Mark[] = []

  for (const span of line.spans) {
    for (const character of span.value) {
      text += character === ' ' ? ' ' : character
      marks.push({ role: span.role, strong: span.strong, focus: span.focus })
    }
  }

  return { text, marks }
}

function compareLines(name: string, expected: Expected[], actual: { text: string; marks: Mark[] }[], colorless: boolean): void {
  const problems: string[] = []
  const count = Math.max(expected.length, actual.length)

  for (let at = 0; at < count; at++) {
    const want = expected[at]
    const got = actual[at]

    if (!want || !got) {
      problems.push(`  line ${at}: ${want ? 'missing' : 'extra'}: ${JSON.stringify((want ?? got)!.text)}`)
      continue
    }

    if (want.text.trimEnd() !== got.text.trimEnd()) {
      problems.push(`  line ${at} text\n    want ${JSON.stringify(want.text.trimEnd())}\n    got  ${JSON.stringify(got.text.trimEnd())}`)
      continue
    }

    if (colorless) {
      continue
    }

    const wantCharacters = [...want.text]

    for (let index = 0; index < wantCharacters.length; index++) {
      const mark = want.marks[index]
      const character = wantCharacters[index]!

      if (!mark || character === ' ') {
        continue
      }

      const seen = got.marks[index]

      if (!seen) {
        problems.push(`  line ${at} column ${index} ${JSON.stringify(character)}: no mark`)
        break
      }

      const roleWrong = seen.role !== mark.role
      const strongWrong = mark.role === 'text' && seen.strong !== mark.strong
      const focusWrong = mark.focus !== seen.focus

      if (roleWrong || strongWrong || focusWrong) {
        problems.push(
          `  line ${at} column ${index} ${JSON.stringify(character)}: want ${mark.role}${mark.strong ? ' bold' : ''}${mark.focus ? ' focus' : ''}, got ${seen.role}${seen.strong ? ' bold' : ''}${seen.focus ? ' focus' : ''}\n    ${JSON.stringify(want.text)}`,
        )
        break
      }
    }
  }

  ok(name, problems.length === 0, problems.slice(0, 6).join('\n'))
}

// ---- reading painted output back into roles ----

const ESCAPE = '\u001b'

function reverseRoles(theme: 'dark' | 'light' | 'ansi'): Map<string, string> {
  const out = new Map<string, string>()

  for (const role of STANDARD.roles) {
    if (role.name === 'focus') {
      continue
    }

    if (theme === 'ansi') {
      out.set(role.ansi, role.name)
    } else {
      const hex = theme === 'dark' ? role.dark : role.light
      const rgb = [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16)).join(';')
      out.set(`38;2;${rgb}`, role.name)
    }
  }

  return out
}

// the characters of painted text with the role, boldness and focus each was painted with
function readPainted(painted: string, theme: 'dark' | 'light' | 'ansi'): { text: string; marks: Mark[] }[] {
  const roles = reverseRoles(theme)
  const lines: { text: string; marks: Mark[] }[] = []
  let text = ''
  let marks: Mark[] = []
  let current: Mark = { role: 'text', strong: false, focus: false }
  let at = 0

  while (at < painted.length) {
    if (painted.startsWith(`${ESCAPE}]8;`, at)) {
      const end = painted.indexOf(`${ESCAPE}\\`, at)
      at = end < 0 ? painted.length : end + 2
      continue
    }

    if (painted.startsWith(`${ESCAPE}[`, at)) {
      const end = painted.indexOf('m', at)
      const parameters = painted.slice(at + 2, end)
      at = end + 1

      if (parameters === '0') {
        current = { role: 'text', strong: false, focus: false }
        continue
      }

      let rest = parameters

      if (rest === '1' || rest.startsWith('1;')) {
        current = { ...current, strong: true }
        rest = rest === '1' ? '' : rest.slice(2)
      }

      if (rest.includes('48;2;')) {
        current = { ...current, focus: true }
        rest = rest.replace(/;?48;2;\d+;\d+;\d+/, '')
      }

      if (rest === '7' || rest.endsWith(';7')) {
        current = { ...current, focus: true }
        rest = rest === '7' ? '' : rest.slice(0, -2)
      }

      if (rest !== '') {
        current = { ...current, role: roles.get(rest) ?? `unknown ${rest}` }
      }

      continue
    }

    const character = String.fromCodePoint(painted.codePointAt(at)!)
    at += character.length

    if (character === '\n') {
      lines.push({ text, marks })
      text = ''
      marks = []
      continue
    }

    text += character
    marks.push(current)
  }

  return lines
}

// ---- the cards ----

for (let index = 0; index < CARDS.length; index++) {
  const card = CARDS[index]!
  const mockup = mockups[index]!
  const width = mockup.width
  const expected = expectedOf(card, mockup)
  const name = `${card.caption} (${width} columns)`

  if (card.caption === 'Machine output') {
    // the machine view is data on stdout: one object per event, never wrapped (section 19)
    const lines = [lineText(drawCommand('term dev --log json', room(width))), ...machineEvents().map(event => writeJsonEvent(event, OFFSET, false, STANDARD))]
    compareLines(name, expected, lines.map(text => ({ text, marks: [] })), true)
    continue
  }

  const drawn = drawCard(card, width, card.ascii ?? false)
  compareLines(name, expected, drawn.map(marksOf), card.colorless ?? false)

  // the width invariant, in the three views. Color changes no width, so the layout's lines are the color view's
  for (const ascii of [false, true]) {
    const lines = ascii === (card.ascii ?? false) ? drawn : drawCard(card, width, ascii)
    const wide = lines.map(line => ({ text: lineText(line), cells: measureText(lineText(line)) })).filter(line => line.cells > width)
    ok(`${name} ${ascii ? 'ASCII' : 'Unicode'}: every line within ${width} cells`, wide.length === 0, wide.map(line => `  ${line.cells}: ${line.text}`).join('\n'))

    if (ascii) {
      const foreign = lines.map(lineText).filter(text => [...text].some(character => character.codePointAt(0)! > 126))
      ok(`${name} ASCII: every character is ASCII`, foreign.length === 0, foreign.slice(0, 3).map(text => `  ${text}`).join('\n'))
    }
  }

  // no color: the painted text is the layout's text exactly, and holds no escape
  const none = paintLines(drawn, makePalette('none', 'unknown', false), STANDARD)
  ok(`${name} no color: the text exactly, no escapes`, none === drawn.map(line => `${lineText(line)}\n`).join('') && !none.includes(ESCAPE))

  // color: the escapes read back into the roles the layout gave
  for (const theme of [card.light ? 'light' : 'dark', 'ansi'] as const) {
    const palette = theme === 'ansi' ? makePalette('ansi', 'unknown', false) : makePalette('truecolor', theme, true)
    const read = readPainted(paintLines(drawn, palette, STANDARD), theme)
    const layout = drawn.map(marksOf)
    const wrong: string[] = []

    layout.forEach((line, at) => {
      const seen = read[at]

      if (!seen || seen.text !== line.text) {
        wrong.push(`  line ${at}: text ${JSON.stringify(seen?.text)} against ${JSON.stringify(line.text)}`)
        return
      }

      ;[...line.text].forEach((character, column) => {
        const want = line.marks[column]!
        const got = seen.marks[column]!

        if (character !== ' ' && (want.role !== got.role || want.strong !== got.strong || want.focus !== got.focus)) {
          wrong.push(`  line ${at} column ${column} ${JSON.stringify(character)}: ${JSON.stringify(want)} painted as ${JSON.stringify(got)}`)
        }
      })
    })

    ok(`${name} ${theme === 'ansi' ? '16 colors' : `truecolor ${theme}`}: painted roles read back as drawn`, wrong.length === 0, wrong.slice(0, 4).join('\n'))
  }
}

console.log(`\nitem/golden: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
