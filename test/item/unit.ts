// The unit cases of the terminal output library that the mockup cards cannot reach (note/term/plan/terminal-output-
// standard.md, phase 1): section 21's wrapping cases at every width, the format edges, display width, OSC 8 links,
// the environment decision, live frames, the problem cap and the exit codes, `--plain`, the child-log adapter,
// prompts, JSON and CI annotations, robustness against hostile input, and the claim the library is built on, that
// the standard is DATA: change one value and the output follows.
//
// Every case runs the compiled `.tree` modules (deck/call/host/port/...), the same code a native build compiles.
//
// Run: npx tsx test/item/unit.ts

import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { lineText } from '@term/call/code/work/item/layout'
import type { Line, Room } from '@term/call/code/work/item/layout'
import { makeStandard } from '@term/call/code/work/item/standard'
import type { Standard } from '@term/call/code/work/item/standard'
import { drawItem } from '@term/call/code/work/item/item'
import { measureText } from '@term/call/code/work/item/measure'
import { formatDuration, formatSize } from '@term/call/code/work/item/format'
import { makePalette, paintLines } from '@term/call/code/work/item/paint'
import { decideStyle } from '@term/call/code/work/item/setting'
import { isProgressDue, placeItem, planFrame, writeFrame } from '@term/call/code/work/item/live'
import type { Region } from '@term/call/code/work/item/live'
import {
  arrangeProblems,
  closeSession,
  closingGlyph,
  exitCode,
  failSession,
  isShown,
  makeCrash,
  makeOptions,
  openSession,
  stepSession,
  worstGlyph,
} from '@term/call/code/work/item/run'
import type { RunOptions, Session } from '@term/call/code/work/item/run'
import { speakEvent } from '@term/call/code/work/item/plain'
import { adaptLine } from '@term/call/code/work/item/adapt'
import { failWithoutTerminal, pressKey } from '@term/call/code/work/item/ask'
import type { Question } from '@term/call/code/work/item/ask'
import { writeJsonEvent } from '@term/call/code/work/item/json'
import { annotateEvent } from '@term/call/code/work/item/annotate'
import { makeServiceOpening } from '@term/call/code/work/item/service'
import { plainSubject } from '@term/call/code/work/item/event'
import type { Event } from '@term/call/code/work/item/event'
import { problemOf } from '@term/call/code/output'
import { nestLines } from '@term/call/code/work/item/emit'
import { OFFSET, STANDARD, T, at, ev, field, frame, room, tally } from './build'

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

function same(name: string, got: unknown, want: unknown): void {
  ok(name, JSON.stringify(got) === JSON.stringify(want), `  want ${JSON.stringify(want)}\n  got  ${JSON.stringify(got)}`)
}

const ESCAPE = '\u001b'
const WIDTHS = [40, 44, 60, 80, 120]

function texts(lines: Line[]): string[] {
  return lines.map(lineText)
}

function show(lines: Line[]): string {
  return texts(lines)
    .map(text => `    |${text}|`)
    .join('\n')
}

function spansText(spans: { value: string }[]): string {
  return spans.map(one => one.value).join('').replace(/ /g, ' ')
}

// every line within the room, and every line after the title at the body column or past it (section 2: every child
// line starts at column 2, and nothing of an item goes back to column 0 but its title)
const BODY = STANDARD.layout.bodyColumn

function fits(name: string, lines: Line[], width: number): void {
  const wide = texts(lines).filter(text => measureText(text) > width)
  ok(`${name}: every line within ${width} cells`, wide.length === 0, show(lines))
  const loose = texts(lines)
    .slice(1)
    .filter(text => text !== '' && !text.startsWith(' '.repeat(BODY)))
  ok(`${name}: every line after the title at column ${BODY}`, loose.length === 0, show(lines))
}

// the characters of a value survive, in order: the drawing with its whitespace and quote gutters removed holds the
// value's. A quoted line wrapped inside its quote carries the gutter on every piece
function holdsWhole(name: string, lines: Line[], value: string): void {
  const flat = texts(lines)
    // a quote's arrow (`⇒`, `=>` in ASCII) on its first line; the `│` gutter too, still drawn by a code frame
    .map(text => text.replace(/^(\s*)(?:[│|]|⇒|=>) /, '$1'))
    .join('')
    .replace(/\s/g, '')
  ok(name, flat.includes(value.replace(/\s/g, '')), `  value ${value}\n${show(lines)}`)
}

// ---- section 21: the wrapping cases, at every width ----

const URL = `https://ledger.internal.shape.dev/accounts/acct_7Q2/entries?from=2026-09-30&to=x`.padEnd(70, 'x').slice(0, 70)
const HASH = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'
const PLACE = 'packages/geometry/src/shapes/polygons/regular/hexagons/large.tree:14:12'.slice(0, 70)
const WORDS = Array.from({ length: 100 }, (_, at) => ['ledger', 'entry', 'for', 'invoice', 'was', 'missing', 'when', 'reconciling'][at % 8]).join(' ')
const STACK = [
  "TypeError: Cannot read properties of undefined (reading 'id') while reconciling the nightly ledger pass for acct_7Q2",
  ...Array.from({ length: 4 }, (_, at) => `    at async Worker.step${at} (node_modules/bullmq/dist/worker-with-a-long-file-name.js:${400 + at}:3)`),
  '    at reconcile (services/payments/reconciler/src/jobs/reconcile-invoice-against-the-ledger.ts:118:22)',
  ...Array.from({ length: 24 }, (_, at) => `    at async Promise.all (index ${at}) node:internal/process/task_queues:95:5`),
]
const SOURCE = 'payments-reconciler'

ok('the 70-character URL is 70 characters', URL.length === 70)
ok('the 64-character hash is 64 characters', HASH.length === 64)
ok('the 70-character location is 70 characters', PLACE.length === 70)
ok('the message is 100 words', WORDS.split(' ').length === 100)

for (const width of WIDTHS) {
  for (const ascii of [false, true]) {
    const one = room(width, ascii)
    const mode = `${width}${ascii ? ' ascii' : ''}`

    const url = drawItem(ev({ glyph: 'done', kind: 'request', verb: 'GET', subject: URL, clock: '14:02:07.412', duration: 48, http: 200, bytes: 1200 }), one, true)
    fits(`URL subject at ${mode}`, url, width)
    holdsWhole(`URL subject at ${mode}: no character lost`, url, URL)
    ok(`URL subject at ${mode}: never broken inside ://`, texts(url).some(text => text.includes('https://')), show(url))

    const hash = drawItem(ev({ glyph: 'done', verb: 'fetch', subject: 'blob', clock: '14:02:07.412', fields: [field('digest', HASH)] }), one, true)
    fits(`64-character hash at ${mode}`, hash, width)
    holdsWhole(`64-character hash at ${mode}: no character lost`, hash, HASH)

    const place = drawItem(ev({ glyph: 'failed', kind: 'problem', verb: 'check', subject: 'There is no task named multipy', clock: '14:42:00.300', fields: [at(PLACE)] }), one, true)
    fits(`70-character location at ${mode}`, place, width)
    holdsWhole(`70-character location at ${mode}: printed in full`, place, PLACE)
    const under = texts(place).filter(text => text.trim() !== '' && PLACE.includes(text.trim()) && !text.trim().startsWith('at'))
    const brokenBadly = under.slice(0, -1).filter(text => !text.trimEnd().endsWith('/'))
    ok(`70-character location at ${mode}: breaks only after /`, brokenBadly.length === 0, show(place))

    const message = drawItem(ev({ glyph: 'failed', verb: 'job', subject: 'invoice 99231', clock: '14:02:08.120', message: [WORDS] }), one, true)
    fits(`100-word message at ${mode}`, message, width)
    holdsWhole(`100-word message at ${mode}: every word, in order`, message, WORDS)

    const stack = drawItem(ev({ glyph: 'failed', verb: 'email', subject: 'Unhandled rejection', clock: '14:42:12.300', quote: STACK }), one, true)
    fits(`long stack at ${mode}`, stack, width)
    holdsWhole(`long stack at ${mode}: the top frame kept`, stack, 'at async Worker.step0')
    holdsWhole(`long stack at ${mode}: the first frame in the user's code kept`, stack, 'reconcile-invoice-against-the-ledger.ts:118:22')
    ok(`long stack at ${mode}: the rest counted`, texts(stack).some(text => text.includes('27 more frames')), show(stack))

    const tagged = drawItem(ev({ glyph: 'done', kind: 'job', verb: 'job', subject: 'invoice 99231', source: SOURCE, clock: '14:02:08.120', duration: 2400 }), one, true)
    fits(`source over 12 cells at ${mode}`, tagged, width)
    // the source is the second fact, right after the clock (section 6), never a tag on the title
    const separator = ascii ? ' . ' : ' · '
    const tag = texts(tagged)[1]!.trim().split(separator)[1] ?? ''
    ok(`source over 12 cells at ${mode}: middle-truncated to 12`, measureText(tag) <= 12 && tag.includes(ascii ? '...' : '…') && tag.startsWith('pay'), `  tag ${JSON.stringify(tag)}`)
    ok(`source over 12 cells at ${mode}: never on the title`, !texts(tagged)[0]!.includes('pay'), show(tagged))
  }
}

// the opening item of a service lists a truncated source in full (section 11)
{
  const one = room(80)
  const opening = makeServiceOpening('dev', '~/shape', T('14:02:04.990'), 'term 2.5.22', 'PDT, UTC−7', ['api', SOURCE], one)
  holdsWhole('a source over 12 cells is listed in full by the opening item', drawItem(opening, one, true), SOURCE)
}

// ---- section 6: the format edges ----

function duration(milliseconds: number): string {
  return spansText(formatDuration(milliseconds, STANDARD, 'text'))
}

function size(bytes: number): string {
  return spansText(formatSize(bytes, STANDARD))
}

same('999 ms stays milliseconds', duration(999), '999 ms')
same('1000 ms is 1.00 s', duration(1000), '1.00 s')
same('4 ms', duration(4), '4 ms')
same('2900 ms is 2.90 s', duration(2900), '2.90 s')
same('24100 ms is 24.1 s', duration(24100), '24.1 s')
same('59.9 s', duration(59900), '59.9 s')
same('59.99 s rounds to a minute, not to 60.0 s', duration(59990), '1m 00s')
same('60 s is 1m 00s', duration(60000), '1m 00s')
same('2m 05s', duration(125000), '2m 05s')
same('10h 12m', duration(36720000), '10h 12m')
same('0 ms', duration(0), '0 ms')
same('84 B', size(84), '84 B')
same('99.9 kB', size(99900), '99.9 kB')
same('99.96 kB rounds to 100 kB, not 100.0 kB', size(99960), '100 kB')
same('100 kB', size(100000), '100 kB')
same('3.1 kB', size(3100), '3.1 kB')
same('18.4 MB', size(18400000), '18.4 MB')
same('212 MB', size(212000000), '212 MB')
same('999.96 kB rounds up a unit, not to 1000 kB', size(999960), '1.0 MB')
same('0 B', size(0), '0 B')

// ---- section 8: width by grapheme cluster and East Asian width ----

same('ASCII is one cell a character', measureText('area.tree'), 9)
same('CJK is two cells a character', measureText('漢字かな'), 8)
same('a ZWJ family is one cluster of two cells', measureText('👨‍👩‍👧'), 2)
same('a flag is one cluster of two cells', measureText('🇯🇵'), 2)
same('a combining mark adds no cell', measureText('été'), 3)
same('a variation selector makes a text symbol an emoji of two cells', measureText('❤️'), 2)
same('a zero-width space takes no cell', measureText('a​b'), 2)

for (const width of WIDTHS) {
  const one = room(width)
  const wide = drawItem(ev({ glyph: 'done', verb: 'build', subject: '漢字'.repeat(30), clock: '14:42:00.410', message: ['👨‍👩‍👧 é '.repeat(20)] }), one, true)
  fits(`wide and combining text at ${width}`, wide, width)
}

// a tab in a code frame expands to the file's tab width, so the span lands under the right cells (section 7)
{
  const one = room(80)
  const lines = texts(
    drawItem(
      ev({ glyph: 'failed', kind: 'problem', verb: 'check', subject: 'x', clock: '14:42:00.300', frames: [frame([[3, '\tback 漢字(side)']], [{ line: 3, column: 7, length: 2, label: 'here' }], 4)] }),
      one,
      true,
    ),
  )
  const source = lines.find(text => text.includes('back'))!
  const mark = lines.find(text => text.includes('━'))!
  // column 7 in characters is `漢`: a tab of 4 cells, then `back `, so 9 cells into the source
  ok('a tab expands to the file tab width and the mark lands under the wide character', mark.indexOf('━') === source.indexOf('漢'), `    |${source}|\n    |${mark}|`)
  ok('a mark under a wide character is two cells a character', (mark.match(/━/g) ?? []).length === 4, `    |${mark}|`)
}

// ---- section 8: OSC 8 links ----

const LINKED = makePalette('truecolor', 'dark', true)
const UNLINKED = makePalette('truecolor', 'dark', false)

function linkTargets(painted: string): string[] {
  return [...painted.matchAll(/\u001b\]8;id=\d+;([^\u001b\u0007]+)/g)].map(match => match[1]!)
}

{
  const one = room(80)
  const lines = drawItem(ev({ glyph: 'done', kind: 'lifecycle', verb: 'start', subject: 'http://localhost:4000', clock: '14:02:05.730', fields: [field('network', 'http://192.168.1.24:4000')] }), one, true)
  same('a URL subject and a URL field are links', linkTargets(paintLines(lines, LINKED, STANDARD)), ['http://localhost:4000', 'http://192.168.1.24:4000'])
  same('no link is emitted when the palette has none', linkTargets(paintLines(lines, UNLINKED, STANDARD)), [])
  ok('no escape at all without color', !paintLines(lines, makePalette('none', 'unknown', true), STANDARD).includes(ESCAPE))

  const plainRoom = room(80)
  const problem = ev({ glyph: 'failed', kind: 'problem', verb: 'check', subject: 'There is no task named multipy', clock: '14:42:00.300', fields: [at('code/area.tree:14:12')] })
  same('a location is not linked without a root', linkTargets(paintLines(drawItem(problem, plainRoom, true), LINKED, STANDARD)), [])
  const rooted: Room = { ...plainRoom, root: '/home/me/shape' }
  same('a location is linked to its file under the root, without its line and column', linkTargets(paintLines(drawItem(problem, rooted, true), LINKED, STANDARD)), [
    'file:///home/me/shape/code/area.tree',
  ])
  const absolute = ev({ ...problem, fields: [at('/etc/shape/area.tree:3')] })
  same('an absolute location is linked as it is', linkTargets(paintLines(drawItem(absolute, rooted, true), LINKED, STANDARD)), ['file:///etc/shape/area.tree'])
  const phrase = ev({ glyph: 'info', verb: 'note', subject: 'see https://x.dev for more', clock: '14:42:00.300' })
  same('a phrase holding a URL is not one link', linkTargets(paintLines(drawItem(phrase, one, true), LINKED, STANDARD)), [])

  const narrow = room(40)
  const wrapped = drawItem(ev({ glyph: 'done', kind: 'request', verb: 'GET', subject: URL, clock: '14:02:07.412' }), narrow, true)
  const painted = paintLines(wrapped, LINKED, STANDARD)
  const ids = [...painted.matchAll(/\u001b\]8;id=(\d+);/g)].map(match => match[1])
  ok('a URL wrapped over lines is one link on every line, with one id', ids.length >= 2 && new Set(ids).size === 1 && linkTargets(painted).every(target => target === URL), painted)
}

// ---- section 17: the environment ----

function style(variables: Record<string, string>, terminal: boolean, flag = 'auto', platform = 'darwin') {
  return decideStyle(
    Object.entries(variables).map(([name, value]) => ({ name, value })),
    terminal,
    flag,
    platform,
    STANDARD,
  )
}

const UTF = { LANG: 'en_US.UTF-8' }

same('a terminal: 16 colors, live, Unicode', [style(UTF, true).depth, style(UTF, true).live, style(UTF, true).ascii], ['ansi', true, false])
same('COLORTERM=truecolor: 24-bit', style({ ...UTF, COLORTERM: 'truecolor' }, true).depth, 'truecolor')
same('COLORTERM=24bit: 24-bit', style({ ...UTF, COLORTERM: '24bit' }, true).depth, 'truecolor')
same('a pipe: no color, no live region', [style(UTF, false).depth, style(UTF, false).live], ['none', false])
same('NO_COLOR: no color on a terminal', style({ ...UTF, NO_COLOR: '1' }, true).depth, 'none')
same('NO_COLOR empty is not set (no-color.org)', style({ ...UTF, NO_COLOR: '' }, true).depth, 'ansi')
same('FORCE_COLOR: color in a pipe, still no live region', [style({ ...UTF, FORCE_COLOR: '1' }, false).depth, style({ ...UTF, FORCE_COLOR: '1' }, false).live], ['ansi', false])
same('FORCE_COLOR beats NO_COLOR', style({ ...UTF, FORCE_COLOR: '1', NO_COLOR: '1' }, true).depth, 'ansi')
same('FORCE_COLOR=0 turns color off', style({ ...UTF, FORCE_COLOR: '0' }, true).depth, 'none')
same('FORCE_COLOR=false turns color off', style({ ...UTF, FORCE_COLOR: 'false' }, true).depth, 'none')
same('--color never beats FORCE_COLOR', style({ ...UTF, FORCE_COLOR: '1' }, true, 'never').depth, 'none')
same('--color always colors a pipe', style(UTF, false, 'always').depth, 'ansi')
same('TERM=dumb: ASCII and no live region', [style({ ...UTF, TERM: 'dumb' }, true).ascii, style({ ...UTF, TERM: 'dumb' }, true).live], [true, false])
same('no locale at all is POSIX, which is ASCII', style({}, true).ascii, true)
same('LANG=C is ASCII', style({ LANG: 'C' }, true).ascii, true)
same('LC_ALL decides before LANG', style({ LC_ALL: 'C', LANG: 'en_US.UTF-8' }, true).ascii, true)
same('LC_CTYPE=UTF-8 is Unicode', style({ LC_CTYPE: 'UTF-8' }, true).ascii, false)
same('Windows is Unicode without a locale', style({}, true, 'auto', 'windows').ascii, false)
same('Windows under TERM=dumb is ASCII', style({ TERM: 'dumb' }, true, 'auto', 'windows').ascii, true)
same('CI set: annotations', style({ ...UTF, CI: 'true' }, false).annotate, true)
same('CI=0: no annotations', style({ ...UTF, CI: '0' }, false).annotate, false)
same('COLORFGBG=15;0 is a dark background', style({ ...UTF, COLORFGBG: '15;0' }, true).theme, 'dark')
same('COLORFGBG=0;15 is a light background', style({ ...UTF, COLORFGBG: '0;15' }, true).theme, 'light')
same('COLORFGBG unreadable is unknown', style({ ...UTF, COLORFGBG: 'x' }, true).theme, 'unknown')
same('a terminal known to link: links', style({ ...UTF, TERM_PROGRAM: 'iTerm.app' }, true).links, true)
same('an unknown terminal: no links', style(UTF, true).links, false)
same('a known terminal behind a pipe: no links', style({ ...UTF, TERM_PROGRAM: 'iTerm.app' }, false).links, false)
same('FORCE_HYPERLINK=1 links a pipe', style({ ...UTF, FORCE_HYPERLINK: '1' }, false).links, true)
same('FORCE_HYPERLINK=0 unlinks a known terminal', style({ ...UTF, TERM_PROGRAM: 'iTerm.app', FORCE_HYPERLINK: '0' }, true).links, false)

// ---- section 10: live frames ----

{
  const one = room(80)
  const rust = ev({ glyph: 'running', kind: 'progress', verb: 'build', subject: 'rust', clock: '14:42:02.900', duration: 2900, tallies: [tally(31, 'files', '', 46)], done: 31, total: 46 })
  const swift = ev({ glyph: 'running', kind: 'progress', verb: 'build', subject: 'swift', clock: '14:42:02.900', duration: 2900, done: 12, total: 46 })
  let region: Region = { items: [], height: 0, drawnAt: -1, turn: 0 }
  region = placeItem(placeItem(region, rust), swift)

  const first = planFrame(region, [], 1000, false, true, one, true)
  ok('a first frame draws', first.draw && first.lines.length > 0)
  ok('a running item has a bar', texts(first.lines).some(text => text.includes('━') || text.includes('─')), show(first.lines))
  const soon = planFrame(first.region, [], 1050, false, true, one, true)
  ok('a frame inside 100 ms of the last waits', !soon.draw)
  same('a frame that waits writes nothing', writeFrame(soon, first.region.height, LINKED, STANDARD), '')
  const forced = planFrame(first.region, [], 1050, true, true, one, true)
  ok('a forced frame draws inside the limit', forced.draw)
  const later = planFrame(first.region, [], 1100, false, true, one, true)
  ok('a frame 100 ms later draws', later.draw)
  ok('the spinner turns with motion', texts(first.lines)[0]![0] !== texts(later.lines)[0]![0], `    ${texts(first.lines)[0]}\n    ${texts(later.lines)[0]}`)
  const still = planFrame(planFrame(region, [], 1000, false, false, one, true).region, [], 1100, false, false, one, true)
  ok('without motion the spinner is a static ◐', texts(still.lines)[0]!.startsWith('◐'), show(still.lines))
  ok('a frame moves up over the last one and clears below', writeFrame(later, first.region.height, LINKED, STANDARD).startsWith(`${ESCAPE}[${first.region.height}A\r${ESCAPE}[J`))

  // swift finishes below a running rust: it keeps its place; then rust finishes and both commit, in order
  const swiftDone = ev({ ...swift, glyph: 'done', kind: 'step', duration: 3100, done: -1, total: -1 })
  const below = planFrame(placeItem(later.region, swiftDone), [], 1200, true, true, one, true)
  same('an item finishing below a running one keeps its place', [below.committed.length, below.region.items.length], [0, 2])
  ok('and takes its final glyph where it stands', texts(below.lines).some(text => text.startsWith('✓ build swift')), show(below.lines))
  const rustDone = ev({ ...rust, glyph: 'done', kind: 'step', duration: 4000, done: -1, total: -1 })
  const settled = planFrame(placeItem(below.region, rustDone), [], 1300, true, true, one, true)
  same('when the top finishes the finished items commit, in declaration order', texts(settled.committed).filter(text => !text.startsWith(' ')), ['✓ build rust', '✓ build swift'])
  ok('a finished item drops its bar', !texts(settled.committed).some(text => text.includes('━')), show(settled.committed))
  same('the region is then empty', settled.region.items.length, 0)
}

same('no terminal: no progress item before 10 s', isProgressDue(0, -1, 9999, STANDARD), false)
same('no terminal: the first progress item at 10 s', isProgressDue(0, -1, 10000, STANDARD), true)
same('no terminal: the next not before 10 s after the last', isProgressDue(0, 10000, 19999, STANDARD), false)
same('no terminal: and then again', isProgressDue(0, 10000, 20000, STANDARD), true)

// ---- section 12: the problem cap, hidden problems, the crash ----

{
  const one = room(80)
  const problems: Event[] = Array.from({ length: 25 }, (_, at) =>
    ev({
      glyph: 'failed',
      kind: 'problem',
      verb: 'check',
      subject: `problem ${at}`,
      clock: '14:42:00.300',
      place: { path: `code/${String.fromCharCode(122 - (at % 5))}.tree`, line: 25 - at, column: 1 },
    }),
  )
  const arranged = arrangeProblems(problems, STANDARD, one)
  same('25 problems print as 20 and a summary', arranged.length, 21)
  const kept = arranged.slice(0, 20).map(problem => `${problem.place.path}:${problem.place.line}`)
  const sorted = [...kept].sort((a, b) => (a.split(':')[0]! < b.split(':')[0]! ? -1 : a.split(':')[0]! > b.split(':')[0]! ? 1 : Number(a.split(':')[1]) - Number(b.split(':')[1])))
  same('problems sort by path, then line', kept, sorted)
  const summary = arranged[20]!
  same('the summary says how many more, with the flag that shows all', [summary.glyph, spansText(summary.subject), summary.facts], ['info', '… 5 more problems', ['--all']])

  // 2026-10-04: a build with 12 errors and 36 warnings showed 20 warnings and cut every error, because the sort
  // was by place alone. An error now sorts before a warning wherever it is, so the cap never cuts one first
  const mixed: Event[] = Array.from({ length: 25 }, (_, at) =>
    ev({
      glyph: at >= 22 ? 'failed' : 'warning',
      kind: 'problem',
      verb: 'check',
      subject: `problem ${at}`,
      clock: '14:42:00.300',
      place: { path: `code/${String.fromCharCode(97 + at)}.tree`, line: 1, column: 1 },
    }),
  )
  const capped = arrangeProblems(mixed, STANDARD, one)
  same('errors sort before warnings, so the cap keeps every error', capped.slice(0, 3).map(problem => [problem.glyph, problem.place.path]), [
    ['failed', 'code/w.tree'],
    ['failed', 'code/x.tree'],
    ['failed', 'code/y.tree'],
  ])
  same('and the warnings follow by path', capped[3]!.place.path, 'code/a.tree')
  same('a cap below 1 shows every problem, which is what --all sets', arrangeProblems(mixed, { ...STANDARD, caps: { ...STANDARD.caps, problems: 0 } }, one).length, 25)

  const cause = ev({ glyph: 'failed', kind: 'problem', verb: 'check', subject: 'There is no task named multipy', clock: '14:42:00.300', id: 'a', place: { path: 'code/a.tree', line: 1, column: 1 } })
  const effects = [1, 2, 3].map(at => ev({ glyph: 'failed', kind: 'problem', verb: 'check', subject: `follows ${at}`, clock: '14:42:00.300', cause: 'a', place: { path: 'code/a.tree', line: at + 1, column: 1 } }))
  const hidden = arrangeProblems([cause, ...effects], STANDARD, one)
  same('a problem caused by an earlier one is hidden', hidden.length, 1)
  same('and its cause gains `3 hidden`', hidden[0]!.tallies.map(one => `${one.amount} ${one.noun}`), ['3 hidden'])
  same('the original event is not changed', cause.tallies.length, 0)

  const crash = makeCrash('prove', 'Term crashed while checking code/area.tree', 'kernel/unify', '.term/crash.log', T('14:42:00.205'), STANDARD)
  same('a crash exits 70, names where and its log', [crash.status.value, crash.fields.map(one => one.key)], [70, ['in', 'log']])
  ok('a crash prints no stack trace', !texts(drawItem(crash, one, true)).some(text => /\bat .*:\d+:\d+\)/.test(text)))
}

// ---- section 15: a run inside another run is indented two cells a level, its items children of the item before ----

{
  const one = room(80)
  const item = drawItem(ev({ glyph: 'done', verb: 'boot', subject: 'zone built', clock: '14:42:00.300', duration: 1340 }), one, true)
  const lines = [...item, { spans: [] }, ...item]
  const nested = nestLines(lines, 1, true, one).map(lineText)
  // the body column (2) a level, and no elbow (the user's choice, 2026-10-05)
  same('a nested run opens two cells in, as a child of the item before it', nested[0], '  ✓ boot zone built')
  same('and its facts sit two past that', nested[1], `  ${lineText(item[1]!)}`)
  same('blank lines are dropped, so it reads as one block', nested.length, item.length * 2)
  same('the first line is drawn as any other', nestLines(item, 1, false, one).map(lineText)[0], nested[0])
  same('two levels deep is two cells more', nestLines(item, 2, true, one).map(lineText)[0], '    ✓ boot zone built')
  ok('no arrow in Unicode or ASCII: the indent is the nesting', !nested.some(text => text.includes('⇒')) && !nestLines(item, 1, true, room(80, true)).map(lineText).some(text => text.includes('=>')))
  // a quote's text lines up under its first line's, in ASCII too, where the arrow is two cells
  const quoted = drawItem(ev({ glyph: 'info', verb: 'log', subject: 'demo', clock: '14:42:00.300', quote: ['hello from term', 'this is more text'] }), one, true).map(lineText)
  same('a quote is `⇒` then the text, and the rest under the text', quoted.slice(-2), ['  ⇒ hello from term', '    this is more text'])
  const quotedAscii = drawItem(ev({ glyph: 'info', verb: 'log', subject: 'demo', clock: '14:42:00.300', quote: ['hello from term', 'this is more text'] }), room(80, true), true).map(lineText)
  same('and in ASCII `=>`, the rest still under the text', quotedAscii.slice(-2), ['  => hello from term', '     this is more text'])
}

// ---- section 4 and 18: the worst glyph and the exit codes ----

function runOf(glyphs: string[], options: Partial<RunOptions> = {}, failure = ''): Session {
  const one = room(80)
  let session = openSession('make', { ...makeOptions(), ...options })

  for (const glyph of glyphs) {
    session = stepSession(session, ev({ glyph, verb: 'build', subject: 'x', clock: '14:42:00.300' }), one, true).session
  }

  return failure ? failSession(session, failure) : session
}

same('the worst glyph ranks ✗ › ▲ › ◐ › ✓ › ○ › ·', ['info', 'skipped', 'done', 'running', 'warning', 'failed'].map((_, at, all) => worstGlyph(all.slice(0, at + 1).map(glyph => ev({ glyph })), STANDARD)), [
  'info',
  'skipped',
  'done',
  'running',
  'warning',
  'failed',
])
same('a change glyph never decides the run', worstGlyph([ev({ glyph: 'done' }), ev({ glyph: 'added' }), ev({ glyph: 'removed' })], STANDARD), 'done')
same('success: ✓, exit 0', [closingGlyph(runOf(['done']), STANDARD), exitCode(runOf(['done']), STANDARD)], ['done', 0])
same('warnings allowed: ▲, exit 0', [closingGlyph(runOf(['done', 'warning']), STANDARD), exitCode(runOf(['done', 'warning']), STANDARD)], ['warning', 0])
same('--strict: a warning fails, ✗, exit 1', [closingGlyph(runOf(['warning'], { strict: true }), STANDARD), exitCode(runOf(['warning'], { strict: true }), STANDARD)], ['failed', 1])
same('a problem: ✗, exit 1', [closingGlyph(runOf(['done', 'failed']), STANDARD), exitCode(runOf(['done', 'failed']), STANDARD)], ['failed', 1])
same('wrong usage: exit 2', exitCode(runOf([], {}, 'usage'), STANDARD), 2)
same('a missing toolchain: exit 3', exitCode(runOf([], {}, 'environment'), STANDARD), 3)
same('a bug in the tool: exit 70', exitCode(runOf(['done'], {}, 'bug'), STANDARD), 70)
same('Ctrl-C: ○, exit 130, even after a failure', [closingGlyph(runOf(['failed'], {}, 'interrupted'), STANDARD), exitCode(runOf(['failed'], {}, 'interrupted'), STANDARD)], ['skipped', 130])
same('the closing item carries the exit', closeSession(runOf(['failed']), ev({ subject: 'Build failed', clock: '14:42:00.302' }), room(80)).exit, 1)

{
  const options = (extra: Partial<RunOptions>) => ({ ...makeOptions(), ...extra })
  same('--quiet keeps a failed item', isShown(ev({ glyph: 'failed' }), options({ quiet: true })), true)
  same('--quiet drops a done item', isShown(ev({ glyph: 'done' }), options({ quiet: true })), false)
  same('a debug item needs --verbose', [isShown(ev({ level: 'debug' }), options({})), isShown(ev({ level: 'debug' }), options({ verbose: true }))], [false, true])
  same('a trace item needs --trace', [isShown(ev({ level: 'trace' }), options({ verbose: true })), isShown(ev({ level: 'trace' }), options({ trace: true }))], [false, true])
}

// ---- section 20: --plain ----

{
  const one = room(80)
  same('a request as one sentence, the spec example', speakEvent(ev({ glyph: 'done', kind: 'request', verb: 'GET', subject: '/shape', clock: '14:02:07.412', duration: 18, http: 200, bytes: 84 }), one), 'done: GET /shape, 18 ms, HTTP 200, 84 bytes')
  const progress = speakEvent(ev({ glyph: 'running', kind: 'progress', verb: 'build', subject: 'rust', clock: '14:42:02.900', duration: 2900, done: 31, total: 46 }), one)
  ok('progress is a count, never a bar or a spinner', !/[━─◐◓◑◒]/.test(progress) && progress.includes('31 of 46'), `  ${progress}`)
  same('a size of 1 byte is singular', speakEvent(ev({ glyph: 'done', verb: 'write', subject: 'x', bytes: 1 }), one), 'done: write x, 1 byte')
  const problem = speakEvent(ev({ glyph: 'failed', kind: 'problem', verb: 'check', subject: 'There is no task named multipy', fields: [at('code/area.tree:14:12')] }), one)
  same('fields follow as key value', problem, 'failed: check There is no task named multipy. file code/area.tree:14:12')
}

// ---- section 15: the child-log adapter ----

{
  const one = room(80)
  const json = adaptLine('{"level":"error","logger":"database","msg":"Connection lost","ms":42,"host":"db1","rows":12,"took":"1.5s"}', T('14:02:12.000'), OFFSET, false, one)
  same('a JSON line becomes an item', json.kind, 'item')
  same('level maps to the glyph', json.event.glyph, 'failed')
  ok('logger becomes a verb of 7 cells at most', measureText(json.event.verb) <= 7 && json.event.verb.startsWith('databa'), `  ${json.event.verb}`)
  same('msg is the subject', spansText(json.event.subject), 'Connection lost')
  same('ms is the duration', json.event.duration, 42)
  same('a short number with a unit is a fact, one without is a field', [json.event.facts, json.event.fields.map(one => one.key)], [['1.5s'], ['host', 'rows']])
  same('a line with no time takes the clock it arrived at', json.event.clock, T('14:02:12.000'))

  const timed = adaptLine('{"level":"info","msg":"ready","time":"2026-10-03T21:02:12.300Z"}', T('14:02:13.000'), OFFSET, false, one)
  same('time is re-read as the clock', timed.event.clock, T('14:02:12.300'))

  const logfmt = adaptLine('level=warn module=smtp msg="slow to respond" duration=3000 host=smtp.mail.local', T('14:02:12.010'), OFFSET, false, one)
  same('a logfmt line becomes an item', [logfmt.kind, logfmt.event.glyph, logfmt.event.verb, spansText(logfmt.event.subject), logfmt.event.duration], ['item', 'warning', 'smtp', 'slow to respond', 3000])

  same('no logger: the verb is log', adaptLine('{"msg":"hello"}', 0, OFFSET, false, one).event.verb, 'log')
  same('debug is a debug item', adaptLine('{"level":"debug","msg":"cache"}', 0, OFFSET, false, one).event.level, 'debug')
  same('plain text is quoted', adaptLine('compiling 42 modules', 0, OFFSET, false, one).kind, 'quote')
  same('a truncated JSON line is quoted, never an error', adaptLine('{"level":"error","msg":"cut', 0, OFFSET, false, one).kind, 'quote')
  same('--raw passes a line through untouched', [adaptLine('{"level":"error"}', 0, OFFSET, true, one).kind, adaptLine('{"level":"error"}', 0, OFFSET, true, one).line], ['raw', '{"level":"error"}'])
  const stacked = adaptLine(JSON.stringify({ level: 'error', msg: 'boom', err: { stack: 'Error: boom\n    at f (a.ts:1:1)' } }), 0, OFFSET, false, one)
  same('err.stack is quoted output', stacked.event.quote, ['Error: boom', '    at f (a.ts:1:1)'])
}

// ---- section 13: prompts as values ----

function question(kind: string, extra: Partial<Question> = {}): Question {
  return { kind, label: 'Name', flag: '--name', default: 'shape', choices: [], focus: 0, typed: '', answered: false, answer: '', ...extra }
}

function press(one: Question, ...keys: string[]): Question {
  return keys.reduce((next, key) => pressKey(next, key, STANDARD), one)
}

same('typed text is the answer', press(question('text'), 'a', 'r', 'x', 'backspace', 'e', 'a', 'enter').answer, 'area')
same('enter on an empty line takes the default', press(question('text'), 'enter').answer, 'shape')
same('a key after the answer changes nothing', press(question('text'), 'enter', 'x').answer, 'shape')
same('backspace on nothing is nothing', press(question('text'), 'backspace', 'enter').answer, 'shape')
same('a confirm takes y', press(question('confirm', { default: 'no' }), 'y', 'enter').answer, 'yes')
same('a confirm takes its default on enter', press(question('confirm', { default: 'no' }), 'enter').answer, 'no')
{
  const choices = ['typescript', 'rust', 'swift'].map(label => ({ label, hint: '', picked: false, focused: false, value: label === 'typescript' ? 'ts' : '' }))
  same('a pick takes the focused choice', press(question('pick', { choices }), 'down', 'enter').answer, 'rust')
  same('up from the top stays at the top', press(question('pick', { choices }), 'up', 'enter').answer, 'ts')
  same('down past the end stays at the end', press(question('pick', { choices }), 'down', 'down', 'down', 'enter').answer, 'swift')
  same('a pick-many takes what space picked, by flag value', press(question('pick-many', { choices }), 'space', 'down', 'down', 'space', 'enter').answer, 'ts,swift')
  same('space twice unpicks', press(question('pick-many', { choices }), 'space', 'space', 'enter').answer, '')
}
{
  const questions = [question('text'), question('pick-many', { label: 'Targets', flag: '--target', choices: [{ label: 'rust', hint: '', picked: true, focused: false, value: '' }] })]
  const failure = failWithoutTerminal('init', 'term init', questions, T('14:42:00.030'), STANDARD)
  const pass = failure.fields.find(one => one.key === 'pass')
  same('no terminal: a ✗ item, never a prompt', failure.glyph, 'failed')
  same('its pass field answers every question by its flag', pass ? spansText(pass.value) : '', 'term init --name shape --target rust')
  const confirm = question('confirm', { label: 'Overwrite term.tree?', flag: '', default: 'no' })
  const unflagged = failWithoutTerminal('init', 'term init', [...questions, confirm], T('14:42:00.030'), STANDARD).fields.find(one => one.key === 'pass')
  same('a question with no flag of its own is answered by --yes', unflagged ? spansText(unflagged.value) : '', 'term init --name shape --target rust --yes')
}

// ---- section 19: JSON ----

{
  const event = ev({ glyph: 'failed', kind: 'lifecycle', verb: 'exit', subject: 'say "no"\nthen stop', source: 'api:2', clock: '14:02:09.660', message: ['one', 'two'], fields: [at('code/report.tree:8:14')], tallies: [tally(1, 'retries', '', 3)] })
  const line = writeJsonEvent(event, OFFSET, false, STANDARD)
  const read = JSON.parse(line) as Record<string, unknown>
  ok('one event is one line', !line.includes('\n'), line)
  same('the keys in the standard order', Object.keys(read), ['glyph', 'verb', 'subject', 'source', 'time', 'counts', 'message', 'fields', 'kind'])
  same('the subject is whole, quotes and line breaks escaped and read back', read.subject, 'say "no"\nthen stop')
  same('the time is RFC 3339 with the offset', read.time, '2026-10-03T14:02:09.660-07:00')
  same('a count and its total', read.counts, { retries: 1, retries_total: 3 })
  same('message lines joined by newlines', read.message, 'one\ntwo')
  same('under --utc the time is Z', JSON.parse(writeJsonEvent(event, OFFSET, true, STANDARD)).time, '2026-10-03T21:02:09.660Z')
}

// ---- section 17: CI annotations ----

{
  same(
    'a failed problem is an ::error with its place',
    annotateEvent(ev({ glyph: 'failed', kind: 'problem', verb: 'check', subject: 'There is no task named multipy', place: { path: 'code/area.tree', line: 14, column: 12 } })),
    '::error file=code/area.tree,line=14,col=12,title=check::There is no task named multipy',
  )
  ok('a warning is a ::warning', annotateEvent(ev({ glyph: 'warning', verb: 'check', subject: 'radius is never used' })).startsWith('::warning'))
  same('a done item is no annotation', annotateEvent(ev({ glyph: 'done', verb: 'build', subject: 'x' })), '')
  const hostile = annotateEvent(ev({ glyph: 'failed', verb: 'check', subject: 'line one\nline two 100%', place: { path: 'a,b:c.tree', line: 1, column: 1 } }))
  ok('a message cannot end the annotation or start another', !hostile.includes('\n') && hostile.includes('%0A') && hostile.includes('100%25'), `  ${hostile}`)
  ok('a property cannot break out of its value', hostile.includes('file=a%2Cb%3Ac.tree'), `  ${hostile}`)
}

// ---- section 18: the human view on stderr, requested data on stdout, through a real process ----

function runChild(flags: string[], environment: Record<string, string> = {}) {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !['CI', 'NO_COLOR', 'FORCE_COLOR', 'FORCE_HYPERLINK', 'COLORTERM', 'TERM'].includes(name)),
  )
  const run = spawnSync(process.execPath, [join(process.cwd(), '../../../../node_modules/tsx/dist/cli.mjs'), 'test/item/emit-child.ts', ...flags], {
    encoding: 'utf8',
    env: { ...inherited, LANG: 'en_US.UTF-8', ...environment },
  })

  return { stdout: run.stdout, stderr: run.stderr, status: run.status }
}

{
  const human = runChild([])
  ok('the human view goes to stderr, and nothing to stdout', human.stdout === '' && human.stderr.includes('✗ check There is no task named multipy'), JSON.stringify(human))
  same('a pipe gets no escapes', human.stderr.includes(ESCAPE), false)
  same('a run with a problem exits 1', human.status, 1)
  ok('the run opens and closes', human.stderr.startsWith('● make ~/shape') && human.stderr.includes('✗ make Build failed'), human.stderr)

  const json = runChild(['--log-json'])
  const objects = json.stdout.trim().split('\n').map(line => JSON.parse(line) as { kind: string; glyph: string })
  ok('--log json writes JSON lines on stdout and no human view', json.stderr === '' && objects.length === 4, JSON.stringify(json))
  same('the first object is the opening and the last the closing', [objects[0]?.kind, objects.at(-1)?.kind, objects.at(-1)?.glyph], ['open', 'close', 'failed'])

  const quietJson = runChild(['--log-json', '--quiet'])
  same('--quiet hides items from the human view, never from the JSON', quietJson.stdout.trim().split('\n').length, 4)

  // the zone is today's, read off the wall clock: `@term/base/clock`'s monotonic `now` once put every run in January
  // 1970, an hour off in summer
  const minutes = -new Date().getTimezoneOffset()
  const zone = minutes === 0 ? 'Z' : `${minutes < 0 ? '-' : '+'}${String(Math.floor(Math.abs(minutes) / 60)).padStart(2, '0')}:${String(Math.abs(minutes) % 60).padStart(2, '0')}`
  ok('the JSON time carries the local offset of today', json.stdout.split('\n')[0]!.includes(`${zone}"`), json.stdout.split('\n')[0]!)

  const quietPlain = runChild(['--plain', '--quiet'])
  ok('--quiet drops the opening from --plain too', !quietPlain.stderr.includes('info: make') && quietPlain.stderr.includes('failed: check'), quietPlain.stderr)

  const plain = runChild(['--plain'])
  ok('--plain writes one sentence per item to stderr', plain.stdout === '' && plain.stderr.includes('failed: check There is no task named multipy'), JSON.stringify(plain))

  const data = runChild(['--data'])
  ok('data the user asked for goes to stdout, alone', data.stdout === 'the data the user asked for\n' && !data.stderr.includes('the data'), JSON.stringify(data))

  const ci = runChild([], { CI: 'true' })
  // section 17 annotates every failed and warning item, and the closing item is one
  same('CI: the annotations go to stdout', ci.stdout, '::error file=code/area.tree,line=14,col=12,title=check::There is no task named multipy\n::error title=make::Build failed\n')

  const forced = runChild([], { FORCE_COLOR: '1', COLORTERM: 'truecolor' })
  ok('FORCE_COLOR colors a pipe in truecolor', forced.stderr.includes(`${ESCAPE}[38;2;`), JSON.stringify(forced.stderr.slice(0, 200)))

  const dumb = runChild([], { TERM: 'dumb' })
  ok('TERM=dumb prints ASCII', /^[\x00-\x7f]*$/.test(dumb.stderr) && dumb.stderr.includes('x check There is no task named multipy'), dumb.stderr)
}

// ---- section 15: a child process's lines, adapted (deck/call/code/output.ts `followChild`) ----

{
  const follow = (flags: string[]) =>
    spawnSync(process.execPath, [join(process.cwd(), '../../../../node_modules/tsx/dist/cli.mjs'), 'test/item/follow-child.ts', ...flags], {
      encoding: 'utf8',
      // REMOVED, not emptied: a variable set to nothing is set (FORCE_COLOR= colors, CI= annotates)
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !['CI', 'NO_COLOR', 'FORCE_COLOR', 'FORCE_HYPERLINK', 'COLORTERM', 'TERM'].includes(name))),
        LANG: 'en_US.UTF-8',
      },
    })
  const adapted = follow([])
  // the source is the fact after the clock (section 6), and never a tag on the title
  ok('a JSON line is an item: level the glyph, logger the verb cut to 7 cells, msg the subject, tagged', /✗ databa… Connection lost\n {2}[\d:.]+ · server/.test(adapted.stderr), adapted.stderr)
  ok('its other keys are fields', /host +db1/.test(adapted.stderr), adapted.stderr)
  ok('a logfmt line on stderr is an item too, with its duration', /▲ smtp slow to respond\n {2}[\d:.]+ · server · 3\.00 s/.test(adapted.stderr), adapted.stderr)
  ok('plain text is QUOTED under one `log` item named for the child, a `⇒` payload line', /● log server\n {2}⇒ listening on 4000/.test(adapted.stderr), adapted.stderr)
  same('nothing the child wrote reaches stdout', adapted.stdout, '')

  const raw = follow(['--raw'])
  ok('--raw passes stdout through untouched', raw.stdout.includes('{"level":"error","logger":"database"') && raw.stdout.includes('listening on 4000\n'), raw.stdout)
  ok('--raw passes stderr through untouched', raw.stderr.includes('level=warn module=smtp msg="slow to respond" duration=3000\n'), raw.stderr)
}

// ---- section 12: a compiler diagnostic as a Problem item (deck/call/code/output.ts) ----

{
  const text = ['task area', '  take side, like number', '  send back', '    call multipy', '      read side'].join('\n')
  const diagnostic = {
    code: 5,
    name: 'unknown-name',
    message: 'the name "multipy" is not defined',
    file: '/home/me/shape/code/area.tree',
    span: { start: { line: 3, column: 9 }, end: { line: 3, column: 16 } },
    markers: [{ span: { start: { line: 3, column: 9 }, end: { line: 3, column: 16 } }, label: 'did you mean multiply?' }],
    hint: 'define it, import it, or check the spelling',
    severity: 'error' as const,
  }
  const one = problemOf(diagnostic, '/home/me/shape', text)
  same('a diagnostic is a failed problem, its message the subject, capital first', [one.glyph, one.kind, one.verb, spansText(one.subject)], ['failed', 'problem', 'check', 'The name "multipy" is not defined'])
  same('its location is a `file` field, 1-based and relative to the root', one.fields.map(each => `${each.key} ${spansText(each.value)}`), ['file code/area.tree:4:10','next define it, import it, or check the spelling'])
  same('its place sorts by path, line and column', one.place, { path: 'code/area.tree', line: 4, column: 10 })
  same('its frame is the line and the one before, 1-based', one.frames[0]!.lines.map(line => line.number), [3, 4])
  same('its mark is the span, with the marker label', one.frames[0]!.marks, [{ line: 4, column: 10, length: 7, label: 'did you mean multiply?', primary: true }])
  const drawn = texts(drawItem(one, room(80), true))
  ok('it draws as section 12 shows', drawn[0] === '✗ check The name "multipy" is not defined unknown-name' &&drawn.some(line => line.includes('━━━━━━━ did you mean multiply?')), drawn.join('\n'))
  const title = drawItem(one, room(80), true)[0]!
  same('the diagnostic code closes the title, in the source role', title.spans.filter(span => span.value === 'unknown-name').map(span => span.role), ['source'])
  const long = drawItem({ ...one, fields: [one.fields[0]!, { ...one.fields[1]!, value: plainSubject('rewrite it as a linear comparison (<, <=, >, >=, ==), prove it in the dependent kernel with calm, fold or cite') }] }, room(60), true)
  const drawnLong = texts(long)
  const next = drawnLong.slice(drawnLong.findIndex(line => line.startsWith('  next ')))
  ok('a long field value starts beside its key and wraps 2 past it', next.length >= 2 && next[0]!.startsWith('  next rewrite') && next[1]!.startsWith('    ') && !next[1]!.startsWith('     '), texts(long).join('\n'))
  same('a proof diagnostic is verb prove',problemOf({ ...diagnostic, name: 'unchecked-hold' }, '/home/me/shape', text).verb, 'prove')
  same('a warning is ▲', problemOf({ ...diagnostic, severity: 'warning' }, '/home/me/shape', text).glyph, 'warning')
  const twoLines = problemOf({ ...diagnostic, message: 'kernel: type mismatch:\n  expected number\n  found text' }, '/home/me/shape', text)
  same('a message of several lines keeps its breaks: the first the subject, the rest message lines', [spansText(twoLines.subject), twoLines.message], [
    'Kernel: type mismatch:',
    ['expected number', 'found text'],
  ])
  ok('and no line break reaches a drawn line', !texts(drawItem(twoLines, room(80), true)).some(line => /[\n␊]/.test(line)))
  same('a diagnostic in a file that cannot be read has no frame, and still its place', problemOf({ ...diagnostic, file: '/nowhere/x.tree' }, '/home/me/shape').frames.length, 0)
}

// ---- the standard is data: change one value and the output follows ----

function withStandard(change: (standard: Standard) => void): Room {
  const standard = structuredClone(STANDARD)
  change(standard)
  return { ...room(80), standard }
}

// ---- section 6: a clock only where it says something (the user's choice, 2026-10-05) ----

{
  const shipped = { ...room(80), standard: makeStandard() }
  const clockOf = (event: Event): string => texts(drawItem(event, shipped, true))[1] ?? ''
  same('a quick step shows no clock', clockOf(ev({ glyph: 'done', verb: 'build', subject: 'typescript', clock: '14:42:00.410', duration: 410 })), '  410 ms')
  same('a change with nothing else has no facts line at all', texts(drawItem(ev({ glyph: 'added', kind: 'change', verb: 'add', subject: 'deck.tree', clock: '14:42:00.410' }), shipped, true)).length, 1)
  ok('a step that took a second shows its clock', clockOf(ev({ glyph: 'done', verb: 'build', subject: 'rust', clock: '14:42:00.410', duration: 1000 })).includes('14:42:00.410'))
  ok('a request, a line of a live log, shows its clock', clockOf(ev({ glyph: 'done', kind: 'request', verb: 'GET', subject: '/', clock: '14:42:00.410', duration: 4 })).includes('14:42:00.410'))
  ok('a line tagged with its source shows its clock', clockOf(ev({ glyph: 'info', verb: 'log', subject: 'listening', source: 'api', clock: '14:42:00.410' })).includes('14:42:00.410'))
  ok('a service opening, which carries the zone, shows its clock', clockOf(ev({ glyph: 'info', kind: 'open', verb: 'boot', subject: '~/shape', clock: '14:42:00.410', zone: 'PDT, UTC−7' })).includes('14:42:00.410'))

  // D41, the user's choice on 2026-10-05: the verb in its own cyan role, where v3 draws it gray
  const title = drawItem(ev({ glyph: 'done', verb: 'build', subject: 'typescript', clock: '14:42:00.410' }), shipped, true)[0]!
  same('the verb is drawn in the verb role', title.spans.find(span => span.value === 'build')?.role, 'verb')
  same('and the subject in the text role', title.spans.find(span => span.value === 'typescript')?.role, 'text')
  same('the verb role is cyan', ['dark', 'light', 'ansi'].map(key => (makeStandard().roles.find(one => one.name === 'verb') as Record<string, string> | undefined)?.[key]), ['#7FD1D1', '#1B7A80', '96'])
}

{
  const event = ev({ glyph: 'done', verb: 'build', subject: 'typescript', clock: '14:42:00.410', duration: 410, tallies: [tally(46, 'files', '', 46)] })
  same('the standard as written', texts(drawItem(event, room(80), true)), ['✓ build typescript', '  14:42:00.410 · 410 ms · 46/46 files'])
  same(
    'a wider verb column and body column move every line',
    texts(
      drawItem(
        event,
        withStandard(standard => {
          standard.layout.verbWidth = 9
          standard.layout.bodyColumn = 13
        }),
        true,
      ),
    ),
    ['✓ build      typescript', '             14:42:00.410 · 410 ms · 46/46 files'],
  )
  same(
    'a different glyph for done',
    texts(drawItem(event, withStandard(standard => void (standard.glyphs.find(one => one.name === 'done')!.unicode = '✔')), true))[0],
    '✔ build typescript',
  )
  same(
    'a different fact separator',
    texts(drawItem(event, withStandard(standard => void (standard.symbols.find(one => one.name === 'separator')!.unicode = '|')), true))[1],
    '  14:42:00.410 | 410 ms | 46/46 files',
  )
  same(
    'a different duration unit',
    texts(drawItem(event, withStandard(standard => void (standard.durations.millisecondUnit = 'msec')), true))[1],
    '  14:42:00.410 · 410 msec · 46/46 files',
  )
  const capped = withStandard(standard => void (standard.caps.problems = 2))
  same(
    'a different problem cap',
    arrangeProblems(
      [1, 2, 3, 4].map(at => ev({ glyph: 'failed', kind: 'problem', verb: 'check', subject: `p${at}`, place: { path: 'a.tree', line: at, column: 1 } })),
      capped.standard,
      capped,
    ).length,
    3,
  )
}

// ---- robustness ----

{
  const one = room(80)
  const empty = drawItem(ev({ glyph: 'done', verb: 'build', clock: '14:42:00.410' }), one, true)
  same('an empty subject draws the glyph and verb with nothing after them', texts(empty)[0], '✓ build')

  const nan = texts(drawItem(ev({ glyph: 'done', verb: 'build', subject: 'x', clock: '14:42:00.410', duration: Number.NaN, bytes: Number.NaN }), one, true))
  ok('a NaN duration and size draw nothing, never NaN', !nan.join('\n').includes('NaN'), nan.join('\n'))
  const infinite = texts(drawItem(ev({ glyph: 'done', verb: 'build', subject: 'x', clock: '14:42:00.410', duration: Number.POSITIVE_INFINITY }), one, true))
  ok('an infinite duration draws nothing, never Infinity', !infinite.join('\n').includes('Infinity'), infinite.join('\n'))

  for (const width of [0, -5, Number.NaN, 12]) {
    const narrow = room(width)
    const lines = drawItem(ev({ glyph: 'failed', verb: 'check', subject: 'There is no task named multipy anywhere', clock: '14:42:00.300', fields: [at(PLACE)] }), narrow, true)
    ok(`width ${width} is treated as 40`, narrow.width === 40 && texts(lines).every(text => measureText(text) <= 40), show(lines))
  }

  const hostile = texts(drawItem(ev({ glyph: 'done', verb: 'b\u001b[31mad', subject: 'red\u001b[31m text\u0007 ‮evil‬', clock: '14:42:00.410', message: ['\u001b]8;;http://x\u001b\\click\u001b]8;;\u001b\\'] }), one, true)).join('\n')
  ok('control characters, escapes and bidi overrides never reach the terminal', !/[\u0000-\u0008\u000b-\u001f\u007f‪-‮⁦-⁩]/.test(hostile), JSON.stringify(hostile))

  // v3 pads no verb, so a long one is never cut: it moves the subject along, one space after it (section 2)
  const huge = texts(drawItem(ev({ glyph: 'done', verb: 'transmogrify', subject: 'x', clock: '14:42:00.410' }), one, true))[0]!
  same('a long verb is whole, and the subject one space after it', huge, '✓ transmogrify x')
  const hugeAscii = texts(drawItem(ev({ glyph: 'done', verb: 'transmogrify', subject: 'x', clock: '14:42:00.410' }), room(80, true), true))[0]!
  same('and in ASCII', hugeAscii, 'v transmogrify x')

  const token = 'a'.repeat(200)
  fits('a 200-character token with no break point', drawItem(ev({ glyph: 'done', verb: 'fetch', subject: token, clock: '14:42:00.410' }), room(40), true), 40)
  const wideToken = '漢'.repeat(50)
  fits('a token of wide characters with no break point', drawItem(ev({ glyph: 'done', verb: 'fetch', subject: wideToken, clock: '14:42:00.410' }), room(40), true), 40)
  same('an unknown glyph draws as info', texts(drawItem(ev({ glyph: 'sparkle', verb: 'x', subject: 'y' }), one, true))[0], '● x y')
  same('an event with no clock draws no clock', texts(drawItem(ev({ glyph: 'done', verb: 'build', subject: 'x', duration: 410 }), one, true)), ['✓ build x', '  410 ms'])
}

console.log(`\nitem/unit: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
