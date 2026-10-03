// The cell grid (terminal-target-0001, deck/site/code/view/cells/grid.tree): the vocabulary's layout model measured and
// placed in a terminal's cells. Each case's EXPECTED grid is worked out by hand from the rules in
// note/term/view/11-vocabulary.md ("The layout model": CSS's defaults, a cell 8 points wide and 16 tall, growers
// sharing the free cells, clipping never shrinking) and written here, never read from the engine's own output, which
// would only prove the engine agrees with itself. Rows end where the last drawn cell does.
//
// The width of a character is held separately: `cell-width` is asked for EVERY code point, U+0000 to U+10FFFF, and
// each answer is compared with string-width's for that code point alone. That catches a run the generator merged
// wrong, a search that misses an edge, and a table that has drifted from string-width since it was written
// (`pnpm term:cell-width-table` is the drift check on the file itself).
// Run: npx tsx test/view/cells.ts

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { nativePrelude } from '@term/make/code/compile/native'
import { projectResolver } from '@term/call/code/make'

// the width every Node terminal library uses, from mesh, where it is installed; the grid's table is generated from it
const STRING_WIDTH = join(import.meta.dirname, '../../../../../../mesh/node_modules/string-width/index.js')

let pass = 0
let fail = 0

function ok(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  ${info}`)
  }
}

// clusters a code point at a time gets wrong: a man, a woman and a girl joined by zero-width joiners; the flag of Japan
// in two regional-indicator letters; 각 spelled as its three jamo; a heart asked to draw as an emoji (U+FE0F)
const FAMILY = '\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}'
const FLAG = '\u{1F1EF}\u{1F1F5}'
const JAMO = '\u{1100}\u{1161}\u{11A8}'
const HEART = '\u{2764}\u{FE0F}'

// each case: what it holds, the Term expression building its tree, the grid's size, and the grid by hand
type Case = { name: string; tree: string; width: number; height: number; want: string }

const CASES: Case[] = [
  {
    name: 'a stack with no direction is a column: one child under the other',
    tree: 'stack(<column>, 0, <stretch>, <start>, 0, two(text-node(<one>), text-node(<two>)))',
    width: 10,
    height: 3,
    want: 'one\ntwo\n',
  },
  {
    name: 'a row with a 16 point gap: 2 blank cells between',
    tree: 'stack(<row>, 16, <stretch>, <start>, 0, two(text-node(<ab>), text-node(<cd>)))',
    width: 10,
    height: 1,
    want: 'ab  cd',
  },
  {
    name: 'a grower between two texts takes the 8 free cells of a 10 cell row',
    tree: 'stack(<row>, 0, <stretch>, <start>, 0, three(text-node(<L>), spacer-node(), text-node(<R>)))',
    width: 10,
    height: 1,
    want: 'L        R',
  },
  {
    name: 'justify between spreads 6 free cells as 3 between each pair',
    tree: 'stack(<row>, 0, <stretch>, <between>, 0, three(text-node(<a>), text-node(<b>), text-node(<c>)))',
    width: 9,
    height: 1,
    want: 'a   b   c',
  },
  {
    name: 'align center in a 10 cell column puts a 2 cell text at column 4',
    tree: 'stack(<column>, 0, <center>, <start>, 0, one(text-node(<hi>)))',
    width: 10,
    height: 1,
    want: '    hi',
  },
  {
    name: 'a divider in a column is a line across it',
    tree: 'stack(<column>, 0, <stretch>, <start>, 0, three(text-node(<ab>), divider-node(), text-node(<cd>)))',
    width: 4,
    height: 3,
    want: 'ab\n────\ncd',
  },
  {
    name: 'a divider in a row is a line down it',
    tree: 'stack(<row>, 0, <stretch>, <start>, 0, three(text-node(<ab>), divider-node(), text-node(<cd>)))',
    width: 5,
    height: 1,
    want: 'ab│cd',
  },
  {
    name: 'text wraps at the width, words kept whole',
    tree: 'stack(<column>, 0, <stretch>, <start>, 0, one(text-node(<the quick brown fox>)))',
    width: 10,
    height: 3,
    want: 'the quick\nbrown fox\n',
  },
  {
    name: 'a frame 48 points wide keeps its 6 cells in a stretching column, its text wraps there and clips at the height',
    tree: 'stack(<column>, 0, <stretch>, <start>, 0, one(frame-node(48, text-node(<aaa bbb ccc>))))',
    width: 20,
    height: 2,
    want: 'aaa\nbbb',
  },
  {
    name: 'a wide character takes two cells, a combining mark none',
    tree: 'stack(<column>, 0, <stretch>, <start>, 0, two(text-node(<日本語>), text-node(<éx>)))',
    width: 10,
    height: 2,
    want: '日本語\néx',
  },
  {
    name: '16 points of padding is 2 cells across and 1 down',
    tree: 'stack(<row>, 0, <stretch>, <start>, 16, one(text-node(<x>)))',
    width: 6,
    height: 3,
    want: '\n  x\n',
  },
  {
    // half a cell rounds up and less rounds down, the same whole number on every backend: 8 points down is 1 row, 4 is 0
    name: 'an 8 point gap in a column is one blank row, a 4 point gap none',
    tree: 'stack(<column>, 0, <stretch>, <start>, 0, two(stack(<column>, 8, <stretch>, <start>, 0, two(text-node(<a>), text-node(<b>))), stack(<column>, 4, <stretch>, <start>, 0, two(text-node(<c>), text-node(<d>)))))',
    width: 4,
    height: 5,
    want: 'a\n\nb\nc\nd',
  },
  {
    // align end in a 6 cell column: each child keeps its own width, against the right edge
    name: 'align end puts each child of a column against its far edge, at its own width',
    tree: 'stack(<column>, 0, <end>, <start>, 0, two(text-node(<ab>), text-node(<c>)))',
    width: 6,
    height: 2,
    want: '    ab\n     c',
  },
  {
    // justify center in an 8 cell row: 4 cells of children, the 4 free split 2 before and 2 after
    name: 'justify center leaves equal room before and after the children of a row',
    tree: 'stack(<row>, 0, <stretch>, <center>, 0, two(text-node(<ab>), text-node(<cd>)))',
    width: 8,
    height: 1,
    want: '  abcd',
  },
  {
    name: 'justify end puts the children of a row against its far edge',
    tree: 'stack(<row>, 0, <stretch>, <end>, 0, two(text-node(<ab>), text-node(<cd>)))',
    width: 8,
    height: 1,
    want: '    abcd',
  },
  {
    // a 64 point minimum is 8 cells: the frame around `ab` is 8 wide, so `x` starts in the ninth
    name: 'a minimum width holds a frame wider than its content',
    tree: 'stack(<row>, 0, <stretch>, <start>, 0, two(bounded-node(64, 0, text-node(<ab>)), text-node(<x>)))',
    width: 12,
    height: 1,
    want: 'ab      x',
  },
  {
    // a 32 point maximum is 4 cells: the text inside wraps there
    name: 'a maximum width holds a frame narrower than its content, which wraps inside it',
    tree: 'stack(<column>, 0, <start>, <start>, 0, one(bounded-node(0, 32, text-node(<abc def>))))',
    width: 12,
    height: 2,
    want: 'abc\ndef',
  },
  {
    name: 'a row inside a column is stretched across, so its grower reaches the far edge',
    tree: 'stack(<column>, 0, <stretch>, <start>, 0, one(stack(<row>, 0, <stretch>, <start>, 0, three(text-node(<a>), spacer-node(), text-node(<b>)))))',
    width: 6,
    height: 1,
    want: 'a    b',
  },
  {
    // 7 cells, `ab` takes 2 and the gap 2, so `cd ef` has 3 left and wraps there. Offered the room without the gap (5)
    // it stayed one line and was clipped at the edge
    name: 'a child of a row is measured in the room left after the children and the gaps before it',
    tree: 'stack(<row>, 16, <stretch>, <start>, 0, two(text-node(<ab>), text-node(<cd ef>)))',
    width: 7,
    height: 2,
    want: 'ab  cd\n    ef',
  },
  {
    // `add` is wider than the 2 cell line: `[` is flushed, `ad` is what fits, and `d` starts the next line, which `]`
    // cannot join (1 + a space + 1 is 3)
    name: 'a word wider than a 2 cell line is broken at the edge and its rest starts the next line',
    tree: 'stack(<column>, 0, <stretch>, <start>, 0, one(frame-node(16, text-node(<[ add ]>))))',
    width: 2,
    height: 4,
    want: '[\nad\nd\n]',
  },
  {
    // the family is one cluster of 2 cells, so `ab` fits after it in 4. Counted per code point it was 6 cells
    name: 'a family joined by zero-width joiners takes 2 cells, as one cluster',
    tree: `stack(<row>, 0, <stretch>, <start>, 0, one(text-node(<${FAMILY}ab>)))`,
    width: 4,
    height: 1,
    want: `${FAMILY}ab`,
  },
  {
    // the word is two flags, 4 cells, in a line of 3: broken between the flags, never between a flag's two letters
    name: 'a word wider than its line breaks between flags, never inside one',
    tree: `stack(<column>, 0, <stretch>, <start>, 0, one(text-node(<${FLAG}${FLAG} x>)))`,
    width: 3,
    height: 3,
    want: `${FLAG}\n${FLAG}\nx`,
  },
  {
    // the jamo are one syllable of 2 cells, so `x` fits in the third. Counted per code point they were 4
    name: 'a Hangul syllable spelled in jamo takes 2 cells',
    tree: `stack(<row>, 0, <stretch>, <start>, 0, one(text-node(<${JAMO}x>)))`,
    width: 3,
    height: 1,
    want: `${JAMO}x`,
  },
  {
    // the heart drawn as an emoji is 2 cells, so the 3 cell text ends against the edge of 4 with one cell before it
    name: 'a character asked to draw as an emoji takes 2 cells',
    tree: `stack(<row>, 0, <stretch>, <end>, 0, one(text-node(<${HEART}x>)))`,
    width: 4,
    height: 1,
    want: ` ${HEART}x`,
  },
]

// whole texts measured by the grid beside string-width, which measures by grapheme cluster
const CLUSTER_SAMPLES = [FAMILY, FLAG, JAMO, '\u{AC00}\u{11A8}', '\u{1100}\u{1161}', HEART, 'e\u{301}', `${FLAG}${FLAG}`, `a${FAMILY}b`, '#\u{FE0F}\u{20E3}', '\u{1F44D}\u{1F3FD}', '日本']

// the tree builders the cases call, and one line per case into the output
const PROGRAM = `load @term/site/code/view/cells/grid
  find cell-node
  find lay-out
  find runes-width

load @term/base/code/list
  find list

load @term/base/text/unicode
  find to-runes

task cluster-cells
  take value, like text
  like number
  send back
    call runes-width
      call to-runes
        read value

task blank
  like cell-node
  send back
    make cell-node
      bind kind, text <text>
      bind text, text <>
      bind direction, text <column>
      bind gap, code 0
      bind align, text <stretch>
      bind justify, text <start>
      bind padding, code 0
      bind grow, code 0
      bind width, code 0
      bind height, code 0
      bind min-width, code 0
      bind max-width, code 0
      bind min-height, code 0
      bind max-height, code 0
      bind children
        make list

task text-node
  take value, like text
  like cell-node
  save made
    call blank
  save made/text, read value
  send back, read made

task spacer-node
  like cell-node
  save made
    call blank
  save made/kind, text <spacer>
  save made/grow, code 1
  send back, read made

task divider-node
  like cell-node
  save made
    call blank
  save made/kind, text <divider>
  send back, read made

task frame-node
  take width, like number
  take child, like cell-node
  like cell-node
  save made
    call blank
  save made/kind, text <frame>
  save made/width, read width
  call made/children/push
    read child
  send back, read made

task bounded-node
  take low, like number
  take high, like number
  take child, like cell-node
  like cell-node
  save made
    call blank
  save made/kind, text <frame>
  save made/min-width, read low
  save made/max-width, read high
  call made/children/push
    read child
  send back, read made

task stack
  take direction, like text
  take gap, like number
  take align, like text
  take justify, like text
  take padding, like number
  take children
    like list
      like cell-node
  like cell-node
  save made
    call blank
  save made/kind, text <stack>
  save made/direction, read direction
  save made/gap, read gap
  save made/align, read align
  save made/justify, read justify
  save made/padding, read padding
  save made/children, read children
  send back, read made

task one
  take a, like cell-node
  like list
    like cell-node
  save made
    make list
  call made/push
    read a
  send back, read made

task two
  take a, like cell-node
  take b, like cell-node
  like list
    like cell-node
  save made
    make list
  call made/push
    read a
  call made/push
    read b
  send back, read made

task three
  take a, like cell-node
  take b, like cell-node
  take c, like cell-node
  like list
    like cell-node
  save made
    make list
  call made/push
    read a
  call made/push
    read b
  call made/push
    read c
  send back, read made
`

// a case's tree is written as a call; this spells it as the Term the program above holds, one call per line
function termOf(expression: string, depth: number): string {
  const pad = '  '.repeat(depth)
  const text = expression.trim()

  if (text.startsWith('<')) {
    return `${pad}text ${text}`
  }

  if (/^-?\d+$/.test(text)) {
    return `${pad}code ${text}`
  }

  const open = text.indexOf('(')
  const name = text.slice(0, open)
  const inside = text.slice(open + 1, -1)
  const args: string[] = []
  let level = 0
  let quoted = false
  let start = 0

  for (let i = 0; i < inside.length; i++) {
    const c = inside[i]

    if (c === '<') {
      quoted = true
    } else if (c === '>') {
      quoted = false
    } else if (!quoted && c === '(') {
      level++
    } else if (!quoted && c === ')') {
      level--
    } else if (!quoted && level === 0 && c === ',') {
      args.push(inside.slice(start, i))
      start = i + 1
    }
  }

  if (inside.trim()) {
    args.push(inside.slice(start))
  }

  return [`${pad}call ${name}`, ...args.map(arg => termOf(arg, depth + 1))].join('\n')
}

const program = PROGRAM + '\n' + CASES.map((one, i) =>
  [`task case-${i}`, '  like text', '  send back', '    call lay-out', termOf(one.tree, 3), `      code ${one.width}`, `      code ${one.height}`].join('\n'),
).join('\n\n') + '\n'

const dir = mkdtempSync(join(tmpdir(), 'term-cells-'))
const entry = join(dir, 'cells.tree')
writeFileSync(entry, program)
const result = compile({ file: entry, text: program }, { resolve: projectResolver(process.cwd(), 'node'), env: 'node' })
ok('the cell grid and the cases compile', result.ok, result.ok ? '' : [...new Set(result.diagnostics.map(d => d.message))].slice(0, 6).join(' | '))

if (result.ok) {
  const readRuntime = (file: string): string | undefined => (existsSync(file) ? readFileSync(file, 'utf8') : undefined)
  const file = join(dir, 'cells.ts')
  const calls = CASES.map((_, i) => `case${i}()`).join(', ')
  // every code point through the grid's cell-width beside string-width's, the disagreements counted and the first eight kept
  const witness = [
    `import stringWidth from ${JSON.stringify(STRING_WIDTH)}`,
    'const disagree = []',
    'let count = 0',
    'for (let rune = 0; rune <= 0x10ffff; rune++) {',
    '  const theirs = rune >= 0xd800 && rune <= 0xdfff ? 0 : stringWidth(String.fromCodePoint(rune))',
    '  const ours = cellWidth(rune)',
    '  if (ours !== theirs) { count++; if (disagree.length < 8) disagree.push([rune, ours, theirs]) }',
    '}',
    `const clusters = ${JSON.stringify(CLUSTER_SAMPLES)}.map(text => [text, clusterCells(text), stringWidth(text)])`,
  ].join('\n')
  writeFileSync(file, `${nativePrelude(result.program, 'node', readRuntime, result.typescript)}\n${result.typescript}\n${witness}\nconsole.log(JSON.stringify({ grids: [${calls}], count, disagree, clusters }))\n`)
  const ran = spawnSync('npx', ['tsx', file], { encoding: 'utf8' })
  ok('it runs', ran.status === 0, ran.stderr.slice(0, 600))

  if (ran.status === 0) {
    const { grids, count, disagree, clusters } = JSON.parse(ran.stdout.trim().split('\n').pop()!) as {
      grids: string[]
      count: number
      disagree: [number, number, number][]
      clusters: [string, number, number][]
    }
    const shown = disagree.map(([rune, ours, theirs]) => `U+${rune.toString(16).toUpperCase()} ${ours} not ${theirs}`)
    ok('cell-width agrees with string-width on all 1,114,112 code points', count === 0, `${count} disagree: ${shown.join(', ')}`)

    for (const [text, ours, theirs] of clusters) {
      const spelled = [...text].map(rune => `U+${rune.codePointAt(0)!.toString(16).toUpperCase()}`).join(' ')
      ok(`${spelled} takes ${theirs} cells, as string-width measures the cluster`, ours === theirs, `got ${ours}`)
    }

    for (const [i, one] of CASES.entries()) {
      ok(one.name, grids[i] === one.want, `got ${JSON.stringify(grids[i])}, want ${JSON.stringify(one.want)}`)
    }
  }
}

console.log(`\ncells: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
