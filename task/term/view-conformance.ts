// pnpm term:view-conformance
//
// view-vocabulary-0005: every word of the view vocabulary against every target, read from what exists rather than kept
// by hand. The words are the `### <word>` headings under "## The words" in note/project/term/view/11-vocabulary.md, so the
// list cannot drift from the spec. For each word:
//
//   specified   its section has a props table (or `Props: none`), a target table, and a `Left out` line
//   dom         the face component exists (deck/face/code/component/<word>.tree), or the word is an element every host
//               draws, and test/view/vocabulary.ts or the blog places it
//   toolkits    every tag the word draws is one the AppKit/UIKit runtime (native-view.swift) and the Android runtime
//               (native-view.kt) build: named in a `tag == "<tag>"` branch, or drawn by their default container/label
//   cell grid   the terminal painter (deck/site/code/dom/native/terminal/paint.tree) reads the shape the word's face
//               component builds: a branch for its tag, its style word, or its node builder. Held by
//               test/view/terminal-host.ts and test/view/terminal-words.ts on four backends
//   compose     every tag the word draws is one the Compose runtime (deck/site/code/dom/native/compose/runtime/
//               native-view.kt) builds, the same reading as the Android column. Held by test/compile/compose-view.ts and
//               the compose leg of test/compile/toolkit-words.ts, both read back from Compose's semantics (compose-target)
//   swiftui     no lowering exists, so 0: counted, never hidden. The retained tree over UIKit, AppKit and Android views
//               is the toolkit columns (note/project/term/view/12-render-seam.md, reactive-bridge-0002)
//
// Exits 1 while a word has no spec, or the DOM, a toolkit or the Compose column is below every word. Prints the table either way.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TERM_ROOT, parentRoot } from './root'

const REPO = TERM_ROOT
const NOTE = (): string => join(parentRoot(), 'note/project/term/view/11-vocabulary.md')
const FACE = join(TERM_ROOT, 'deck/face/code/component')
const TOOLKIT = join(TERM_ROOT, 'deck/site/code/dom/native/toolkit/runtime')
const COMPOSE_RUNTIME = join(TERM_ROOT, 'deck/site/code/dom/native/compose/runtime/native-view.kt')

// the tags each word draws on every host, from "Where each word lives". A component word draws what its face file
// draws; an element word is that element; the list is the DSL's walk, which draws its items' own tags
const DRAWS: Record<string, string[]> = {
  text: ['span', 'h1', 'a'],
  stack: ['div'],
  image: ['img'],
  spacer: ['div'],
  divider: ['hr'],
  frame: ['div'],
  scroll: ['scroll'],
  field: ['input'],
  button: ['button'],
  toggle: ['switch'],
  range: ['slider'],
  choice: ['choice'],
  dialog: ['sheet'],
  list: [],
}

// the face component a word is, where it is one
const COMPONENT: Record<string, string> = {
  text: 'text',
  stack: 'stack',
  image: 'image',
  spacer: 'spacer',
  divider: 'divider',
  frame: 'frame',
  scroll: 'scroll',
  toggle: 'switch',
  range: 'slider',
  choice: 'select',
  dialog: 'dialog',
}

// tags every toolkit draws without a branch of its own: the default container (a stack) and the text label
const DEFAULT_DRAWN = new Set(['div', 'span', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'section', 'main'])

const note = readFileSync(NOTE(), 'utf8')
const wordsPart = note.slice(note.indexOf('## The words'), note.indexOf('## The layout model'))
const sections = wordsPart.split(/^### /m).slice(1)
const words = sections.map(section => section.split('\n')[0]!.trim())

// the accessibility contract (native-accessibility-0001): the `## Accessibility` table's row for each word, which
// must fill all ten columns, `none` included, since a blank cell is an undecided field
const ACCESSIBILITY_COLUMNS = 10
const accessibilityPart = note.slice(note.indexOf('## Accessibility'), note.indexOf('## The layout model'))
const accessibility = new Map(
  accessibilityPart
    .split('\n')
    .filter(line => line.startsWith('| ') && !line.startsWith('| word') && !line.startsWith('| ---') && !line.startsWith('| column'))
    .map(line => line.split('|').slice(1, -1).map(cell => cell.trim()))
    .filter(cells => cells.length === ACCESSIBILITY_COLUMNS)
    .map(cells => [cells[0]!, cells] as const),
)

// what in the terminal painter draws each word: the face shape it reads (a tag, a style word, a node builder)
const PAINTER = readFileSync(join(TERM_ROOT, 'deck/site/code/dom/native/terminal/paint.tree'), 'utf8')
const CELLS: Record<string, string> = {
  text: 'task is-inline-tag',
  stack: 'text <display>',
  spacer: 'text <flex-grow>',
  frame: 'text <max-height>',
  divider: 'text <hr>',
  image: 'text <img>',
  field: 'text <textarea>',
  button: 'text <button>',
  list: 'task cell-children',
  toggle: 'task toggle-node',
  range: 'task range-node',
  choice: 'task choice-node',
  scroll: 'text <scroll>',
  dialog: 'task dialog-node',
}

const swift = readFileSync(join(TOOLKIT, 'native-view.swift'), 'utf8')
const kotlin = readFileSync(join(TOOLKIT, 'native-view.kt'), 'utf8')
const compose = readFileSync(COMPOSE_RUNTIME, 'utf8')
const placedInTests =
  readFileSync(join(TERM_ROOT, 'test/view/vocabulary.ts'), 'utf8') +
  readFileSync(join(TERM_ROOT, 'deck/site/test/site/face/blog.tree'), 'utf8')

const builds = (runtime: string, tag: string): boolean =>
  DEFAULT_DRAWN.has(tag) || runtime.includes(`tag == "${tag}"`)

type Row = {
  word: string
  specified: boolean
  accessible: boolean
  dom: boolean
  apple: boolean
  android: boolean
  compose: boolean
  cells: boolean
}

const rows: Row[] = words.map((word, i) => {
  const section = sections[i]!
  const specified = (/\| prop \| kind \| what \|/.test(section) || /Props: none/.test(section)) && /\| target \| draws \|/.test(section) && /Left out/.test(section)
  const component = COMPONENT[word]
  const tags = DRAWS[word] ?? []
  const dom =
    (component ? existsSync(join(FACE, `${component}.tree`)) : tags.length > 0 || word === 'list') &&
    (word === 'list' ? placedInTests.includes('walk list') : true)

  return {
    word,
    specified,
    accessible: (accessibility.get(word) ?? []).length === ACCESSIBILITY_COLUMNS && accessibility.get(word)!.every(cell => cell.length > 0),
    dom,
    apple: tags.every(tag => builds(swift, tag)) && (word !== 'list' || swift.includes('func append')),
    android: tags.every(tag => builds(kotlin, tag)) && (word !== 'list' || kotlin.includes('fun append')),
    compose: tags.every(tag => builds(compose, tag)) && (word !== 'list' || compose.includes('fun append')),
    cells: Boolean(CELLS[word]) && PAINTER.includes(CELLS[word]!),
  }
})

const mark = (v: boolean) => (v ? 'yes' : 'NO ')
console.log('word        spec  a11y  dom   apple android swiftui compose cells')

for (const row of rows) {
  console.log(`${row.word.padEnd(11)} ${mark(row.specified)}   ${mark(row.accessible)}   ${mark(row.dom)}   ${mark(row.apple)}   ${mark(row.android)}     -       ${mark(row.compose)}     ${mark(row.cells)}`)
}

const count = (key: keyof Omit<Row, 'word'>) => rows.filter(r => r[key]).length
const total = rows.length
const unspecified = total - count('specified')

console.log(
  `\nview-conformance: ${total} words, ${unspecified} unspecified, accessibility ${count('accessible')} of ${total}, dom ${count('dom')} of ${total}, AppKit/UIKit ${count('apple')} of ${total}, Android ${count('android')} of ${total}, cell grid ${count('cells')} of ${total}, Compose ${count('compose')} of ${total}, SwiftUI 0 of ${total} (no lowering: the retained tree is the toolkit columns)`,
)

// the gate's summary line: each word's seven required columns (spec, accessibility, dom, AppKit/UIKit, Android,
// Compose, cell grid) as one check apiece
const required =
  count('specified') + count('accessible') + count('dom') + count('apple') + count('android') + count('compose') + count('cells')
console.log(`view-conformance: ${required} pass, ${total * 7 - required} fail`)

// ---- the layout model, property by property (swiftui-target-0002): which test holds each property on each target.
// The web and the toolkits are held by ONE judge (test/compile/shared/layout-rows.ts, read back from Chromium by
// layout-golden.ts and from AppKit, UIKit and Android by toolkit-view.ts, plus toolkit-words.ts for the frame bounds),
// the cell grid by test/view/cells.ts. A property is held where a held test sets it; a blank is a gap, never hidden
const TESTS = join(TERM_ROOT, 'test')
const shared = ['compile/shared/layout-rows.ts', 'compile/toolkit-view.ts', 'compile/toolkit-words.ts']
  .map(file => readFileSync(join(TESTS, file), 'utf8'))
  .join('\n')
const grid = readFileSync(join(TESTS, 'view/cells.ts'), 'utf8')

// each property of note/project/term/view/11-vocabulary.md "The layout model", as the CSS a test sets and as a cells.ts tree
// writes it (a stack's arguments are direction, gap, align, justify, padding)
const LAYOUT: [property: string, css: RegExp, cells: RegExp][] = [
  ['direction', /flex-direction: (row|column)/, /stack\(<row>/],
  ['gap', /gap: \d+px/, /stack\(<(row|column)>, [1-9]/],
  ['align start, end', /align-items: (start|end)/, /stack\(<\w+>, \d+, <(start|end)>/],
  ['align center, stretch', /align-items: (center|stretch)/, /stack\(<\w+>, \d+, <center>/],
  ['justify center, end', /justify-content: (center|end)/, /stack\(<\w+>, \d+, <\w+>, <(center|end)>/],
  ['justify between', /justify-content: space-between/, /stack\(<\w+>, \d+, <\w+>, <between>/],
  ['padding', /padding: \d+px/, /stack\(<\w+>, \d+, <\w+>, <\w+>, [1-9]/],
  ['grow', /flex-grow: 1/, /spacer-node/],
  ['width, height', /[^-]width: \d+px/, /frame-node\(\d+/],
  ['min, max width', /min-width: \d+px/, /bounded-node\(/],
]

console.log('\nlayout      web+toolkits   cells')

for (const [property, css, cells] of LAYOUT) {
  console.log(`${property.padEnd(22)} ${mark(css.test(shared))}            ${mark(cells.test(grid))}`)
}

const layoutHeld = LAYOUT.filter(([, css]) => css.test(shared)).length
const layoutCells = LAYOUT.filter(([, , cells]) => cells.test(grid)).length
console.log(
  `view-conformance: layout ${layoutHeld} of ${LAYOUT.length} properties held on the web and every toolkit, ${layoutCells} of ${LAYOUT.length} on the cell grid`,
)

if (
  unspecified > 0 ||
  count('accessible') < total ||
  count('dom') < total ||
  count('apple') < total ||
  count('android') < total ||
  count('compose') < total ||
  count('cells') < total ||
  layoutHeld < LAYOUT.length ||
  layoutCells < LAYOUT.length
) {
  process.exit(1)
}
