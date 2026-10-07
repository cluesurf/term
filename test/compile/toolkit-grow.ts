// Free room in a stack goes to the growing children, else to the stack's own rest spacer (D028, T018, T019, beat-term-0061).
// On the Apple toolkits a view with no intrinsic size has no hugging, so a `div`, a `span`, a scroll and a spacer share free
// room by the solver's leftovers unless the host states every preference as a constraint. Eleven cases on one root, one
// after another, each screen removed before the next mounts, each printing `grow <case> <frames>` (x,y,w,h in the window):
//   tall, short  a growing scroll that arrives after a layout pass, with more content than the window and with less
//   hug          a screen with no flex-grow keeps its own height
//   nested       screen, body div and scroll all grow: the scroll and the body end at the safe area's bottom
//   inner        a growing screen where nothing grows: its header keeps its height and its rest spacer takes the room
//   two          two growing scrolls, 3 rows and 13 rows, share the room in the ratio of their factors
//   empty        an empty `div` before a growing screen is 0 tall
//   spacer       a growing empty `div` between a screen and a footer pushes the footer to the bottom
//   row          Back and a title across a screen: the title keeps its own width
//   cross        two columns stretched down a 200 tall row: each label keeps its height at the top
//   still        a scroll with no flex-grow is as tall as its rows
// Judged on UIKit and AppKit; the Android hosts are not covered by D021 and D028. GROW_ONLY=macos (or ios) runs one
// platform. Run: GROW_ONLY=ios npx tsx test/compile/toolkit-grow.ts

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runToolkits } from './shared/toolkit-run'
import type { Leg } from './shared/toolkit-run'

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

const SCREEN = 'display: flex; flex-direction: column; gap: 12px; padding: 12px 0px 0px 0px; align-items: stretch; flex-grow: 1'
const NESTED = 'display: flex; flex-direction: column; gap: 12px; align-items: stretch; flex-grow: 1'
const HUG = 'display: flex; flex-direction: column; gap: 12px; padding: 12px 0px 0px 0px; align-items: stretch'

const rows = (count: number): string =>
  Array.from({ length: count }, () => '      view div\n        bind style, text <height: 64px>\n').join('')

const program = (_leg: Leg, shot: string): string => `load @term/site/code/dom/dom
  find view

load @term/site/code/dom/native/toolkit/dom
  find open-root
  find after-launch
  find show-window
  find run-app
  find exit-app
  find child-at
  find child-count
  find frame-of
  find safe-area
  find remove
  find snapshot
  find say

# a growing screen holding only its header
view grown-screen
  take host, like view
  view div
    bind style, text <${SCREEN}>
    view span
      text <Header>

# the same screen with no flex-grow
view hugging-screen
  take host, like view
  view div
    bind style, text <${HUG}>
    view span
      text <Header>

# a growing scroll of 13 rows, taller than the window
view tall-body
  take host, like view
  view scroll
    bind style, text <flex-grow: 1>
    view div
      bind style, text <display: flex; flex-direction: column; gap: 12px>
${rows(13)}
# a growing scroll of 3 rows, shorter than the window
view short-body
  take host, like view
  view scroll
    bind style, text <flex-grow: 1>
    view div
      bind style, text <display: flex; flex-direction: column; gap: 12px>
${rows(3)}
# a growing screen's body: a growing column holding a span and a growing scroll of 3 rows
view nested-body
  take host, like view
  view div
    bind style, text <${NESTED}>
    view span
      text <Note>
    view scroll
      bind style, text <flex-grow: 1>
      view div
        bind style, text <display: flex; flex-direction: column; gap: 12px>
${rows(3).replace(/^(?=.)/gm, '  ')}
# a column of two spans with no flex-grow anywhere in it
view inner-body
  take host, like view
  view div
    bind style, text <display: flex; flex-direction: column; gap: 12px; align-items: stretch>
    view span
      text <First line>
    view span
      text <Second line>

# a div with no style and nothing in it
view empty-box
  take host, like view
  view div

# a growing div with nothing in it, the vocabulary's spacer
view spacer-box
  take host, like view
  view div
    bind style, text <flex-grow: 1>

view footer-box
  take host, like view
  view span
    text <Footer>

# Back and a title in a row
view row-body
  take host, like view
  view div
    bind style, text <display: flex; flex-direction: row; gap: 12px>
    view button
      bind style, text <min-width: 88px; min-height: 44px>
      text <Back>
    view span
      text <Title>

# a row 200 tall that stretches two columns, each holding one span
view cross-body
  take host, like view
  view div
    bind style, text <display: flex; flex-direction: row; gap: 12px; height: 200px; align-items: stretch>
    view div
      view span
        text <left>
    view div
      view span
        text <right column>

# a scroll with no style holding 3 rows
view still-body
  take host, like view
  view scroll
    view div
      bind style, text <display: flex; flex-direction: column; gap: 12px>
${rows(3)}
# the root's last child is the screen (T016); a node's last child is the scroll
task last-child
  take node, like view
  like view
  send back
    call child-at
      read node
      call subtract
        call child-count
          read node
        code 1

task main
  save root
    call open-root
      text <Term grow>
      code 402
      code 874
  call after-launch
    task check
      call show-window

      call grown-screen
        read root
      save tall-screen
        call last-child
          read root
      call safe-area
      call tall-body
        read tall-screen
      save tall-scroll
        call last-child
          read tall-screen
      save tall-safe
        call safe-area
      save tall-root
        call frame-of
          read root
      save tall-screen-frame
        call frame-of
          read tall-screen
      save tall-scroll-frame
        call frame-of
          read tall-scroll
      call say
        text <grow tall {tall-safe} {tall-root} {tall-screen-frame} {tall-scroll-frame}>
      call snapshot
        text <${shot}>
      call remove
        read tall-screen

      call grown-screen
        read root
      save short-screen
        call last-child
          read root
      call safe-area
      call short-body
        read short-screen
      save short-scroll
        call last-child
          read short-screen
      save short-safe
        call safe-area
      save short-root
        call frame-of
          read root
      save short-screen-frame
        call frame-of
          read short-screen
      save short-scroll-frame
        call frame-of
          read short-scroll
      call say
        text <grow short {short-safe} {short-root} {short-screen-frame} {short-scroll-frame}>
      call remove
        read short-screen

      call hugging-screen
        read root
      save hug-screen
        call last-child
          read root
      save hug-safe
        call safe-area
      save hug-frame
        call frame-of
          read hug-screen
      call say
        text <grow hug {hug-safe} {hug-frame}>
      call remove
        read hug-screen

      call grown-screen
        read root
      save nested-screen
        call last-child
          read root
      call safe-area
      call nested-body
        read nested-screen
      save nested-div
        call last-child
          read nested-screen
      save nested-scroll
        call last-child
          read nested-div
      save nested-safe
        call safe-area
      save nested-root
        call frame-of
          read root
      save nested-screen-frame
        call frame-of
          read nested-screen
      save nested-div-frame
        call frame-of
          read nested-div
      save nested-scroll-frame
        call frame-of
          read nested-scroll
      call say
        text <grow nested {nested-safe} {nested-root} {nested-screen-frame} {nested-div-frame} {nested-scroll-frame}>
      call remove
        read nested-screen

      call grown-screen
        read root
      save inner-screen
        call last-child
          read root
      call safe-area
      call inner-body
        read inner-screen
      save inner-div
        call last-child
          read inner-screen
      save inner-safe
        call safe-area
      save inner-root
        call frame-of
          read root
      save inner-screen-frame
        call frame-of
          read inner-screen
      save inner-div-frame
        call frame-of
          read inner-div
      call say
        text <grow inner {inner-safe} {inner-root} {inner-screen-frame} {inner-div-frame}>
      call remove
        read inner-screen

      call grown-screen
        read root
      save two-screen
        call last-child
          read root
      call safe-area
      call short-body
        read two-screen
      save two-first
        call last-child
          read two-screen
      call tall-body
        read two-screen
      save two-second
        call last-child
          read two-screen
      save two-safe
        call safe-area
      save two-screen-frame
        call frame-of
          read two-screen
      save two-first-frame
        call frame-of
          read two-first
      save two-second-frame
        call frame-of
          read two-second
      call say
        text <grow two {two-safe} {two-screen-frame} {two-first-frame} {two-second-frame}>
      call remove
        read two-screen

      call empty-box
        read root
      save empty-box-node
        call last-child
          read root
      call grown-screen
        read root
      save empty-screen
        call last-child
          read root
      call safe-area
      call short-body
        read empty-screen
      save empty-scroll
        call last-child
          read empty-screen
      save empty-safe
        call safe-area
      save empty-box-frame
        call frame-of
          read empty-box-node
      save empty-scroll-frame
        call frame-of
          read empty-scroll
      call say
        text <grow empty {empty-safe} {empty-box-frame} {empty-scroll-frame}>
      call remove
        read empty-screen
      call remove
        read empty-box-node

      call hugging-screen
        read root
      save spacer-screen
        call last-child
          read root
      call spacer-box
        read root
      save spacer-box-node
        call last-child
          read root
      call footer-box
        read root
      save spacer-footer
        call last-child
          read root
      save spacer-safe
        call safe-area
      save spacer-screen-frame
        call frame-of
          read spacer-screen
      save spacer-box-frame
        call frame-of
          read spacer-box-node
      save spacer-footer-frame
        call frame-of
          read spacer-footer
      call say
        text <grow spacer {spacer-safe} {spacer-screen-frame} {spacer-box-frame} {spacer-footer-frame}>
      call remove
        read spacer-footer
      call remove
        read spacer-box-node
      call remove
        read spacer-screen

      call grown-screen
        read root
      save row-screen
        call last-child
          read root
      call safe-area
      call row-body
        read row-screen
      save row-div
        call last-child
          read row-screen
      save row-title
        call child-at
          read row-div
          code 1
      call short-body
        read row-screen
      save row-scroll
        call last-child
          read row-screen
      save row-safe
        call safe-area
      save row-screen-frame
        call frame-of
          read row-screen
      save row-div-frame
        call frame-of
          read row-div
      save row-title-frame
        call frame-of
          read row-title
      save row-scroll-frame
        call frame-of
          read row-scroll
      call say
        text <grow row {row-safe} {row-screen-frame} {row-div-frame} {row-title-frame} {row-scroll-frame}>
      call remove
        read row-screen

      call grown-screen
        read root
      save cross-screen
        call last-child
          read root
      call safe-area
      call cross-body
        read cross-screen
      save cross-row
        call last-child
          read cross-screen
      save cross-left
        call child-at
          read cross-row
          code 0
      save cross-right
        call child-at
          read cross-row
          code 1
      save cross-left-text
        call child-at
          read cross-left
          code 0
      save cross-right-text
        call child-at
          read cross-right
          code 0
      save cross-safe
        call safe-area
      save cross-left-frame
        call frame-of
          read cross-left
      save cross-right-frame
        call frame-of
          read cross-right
      save cross-left-text-frame
        call frame-of
          read cross-left-text
      save cross-right-text-frame
        call frame-of
          read cross-right-text
      call say
        text <grow cross {cross-safe} {cross-left-frame} {cross-right-frame} {cross-left-text-frame} {cross-right-text-frame}>
      call remove
        read cross-screen

      call grown-screen
        read root
      save still-screen
        call last-child
          read root
      call safe-area
      call still-body
        read still-screen
      save still-scroll
        call last-child
          read still-screen
      save still-safe
        call safe-area
      save still-scroll-frame
        call frame-of
          read still-scroll
      call say
        text <grow still {still-safe} {still-scroll-frame}>
      call exit-app
        code 0
  call run-app
`

// the text after `<marker> ` on the line holding it
function after(output: string, marker: string): string {
  const line = output.split('\n').find(l => l.startsWith(`${marker} `) || l.includes(`${marker} `)) ?? ''

  return line.slice(line.indexOf(`${marker} `) + marker.length + 1).trim()
}

const frames = (output: string, marker: string): number[][] =>
  after(output, marker).split(' ').map(part => part.split(',').map(Number))

const near = (a: number | undefined, b: number | undefined, by = 1): boolean => a !== undefined && b !== undefined && Math.abs(a - b) <= by

const equal = (a: number[] | undefined, b: number[] | undefined): boolean =>
  !!a && !!b && a.length === 4 && b.length === 4 && a.every((value, index) => near(value, b[index], 0.5))

function judge(leg: Leg, toolkit: string, output: string): void {
  if (leg !== 'ios' && leg !== 'macos') {
    console.log(`skip  ${leg}  (D021 and D028 do not cover the Android hosts)`)

    return
  }
  for (const name of ['tall', 'short']) {
    const line = after(output, `grow ${name}`)
    const [safe, root, screen, scroll] = frames(output, `grow ${name}`)
    ok(`${leg}: ${name}: the root equals the safe area (${toolkit})`, equal(root, safe), line)
    ok(
      `${leg}: ${name}: the screen's top and bottom equal the root's`,
      !!screen && !!root && near(screen[1], root[1]) && near(screen[1]! + screen[3]!, root[1]! + root[3]!),
      line,
    )
    ok(
      `${leg}: ${name}: the scroll ends at the safe area's bottom`,
      !!scroll && !!safe && near(scroll[1]! + scroll[3]!, safe[1]! + safe[3]!),
      line,
    )
    ok(`${leg}: ${name}: the scroll is at least 300 tall`, !!scroll && scroll[3]! >= 300, line)
  }
  const line = after(output, 'grow hug')
  const [safe, screen] = frames(output, 'grow hug')
  ok(`${leg}: hug: a screen with no flex-grow keeps its own height`, !!screen && screen[3]! < 200, line)
  ok(`${leg}: hug: its top is the safe area's top`, !!screen && !!safe && near(screen[1], safe[1]), line)

  {
    const line = after(output, 'grow nested')
    const [safe, root, screen, body, scroll] = frames(output, 'grow nested')
    const bottom = safe && safe[1]! + safe[3]!
    ok(`${leg}: nested: the scroll ends at the safe area's bottom`, !!scroll && near(scroll[1]! + scroll[3]!, bottom), line)
    ok(`${leg}: nested: the body ends at the safe area's bottom`, !!body && near(body[1]! + body[3]!, bottom), line)
    ok(`${leg}: nested: the screen is the root's height`, !!screen && !!root && near(screen[3], root[3]), line)
  }
  {
    const line = after(output, 'grow inner')
    const [, root, screen, body] = frames(output, 'grow inner')
    ok(
      `${leg}: inner: the screen's top and bottom are the root's`,
      !!screen && !!root && near(screen[1], root[1]) && near(screen[1]! + screen[3]!, root[1]! + root[3]!),
      line,
    )
    ok(`${leg}: inner: the column with no growing child is below 100 tall`, !!body && body[3]! < 100, line)
  }
  {
    const line = after(output, 'grow two')
    const [safe, , first, second] = frames(output, 'grow two')
    ok(`${leg}: two: the scrolls' heights differ by 1 or less`, !!first && !!second && near(first[3], second[3]), line)
    ok(`${leg}: two: each is at least 200 tall`, !!first && !!second && first[3]! >= 200 && second[3]! >= 200, line)
    ok(
      `${leg}: two: the second ends at the safe area's bottom`,
      !!second && !!safe && near(second[1]! + second[3]!, safe[1]! + safe[3]!),
      line,
    )
  }
  {
    const line = after(output, 'grow empty')
    const [safe, box, scroll] = frames(output, 'grow empty')
    ok(`${leg}: empty: the empty div is 0 tall`, !!box && box[3]! < 1, line)
    ok(
      `${leg}: empty: the scroll ends at the safe area's bottom`,
      !!scroll && !!safe && near(scroll[1]! + scroll[3]!, safe[1]! + safe[3]!),
      line,
    )
  }
  {
    const line = after(output, 'grow spacer')
    const [safe, screen, box, footer] = frames(output, 'grow spacer')
    ok(
      `${leg}: spacer: the footer ends at the safe area's bottom`,
      !!footer && !!safe && near(footer[1]! + footer[3]!, safe[1]! + safe[3]!),
      line,
    )
    ok(`${leg}: spacer: the screen with no flex-grow is below 200 tall`, !!screen && screen[3]! < 200, line)
    ok(`${leg}: spacer: the growing div is at least 300 tall`, !!box && box[3]! >= 300, line)
  }
  {
    const line = after(output, 'grow row')
    const [safe, screen, row, title, scroll] = frames(output, 'grow row')
    ok(`${leg}: row: the row is as wide as the screen`, !!row && !!screen && near(row[2], screen[2]), line)
    ok(`${leg}: row: the title keeps its own width (below 150)`, !!title && title[2]! < 150, line)
    // without a rest spacer in the row, Back is stretched and the title is pushed to the far edge
    ok(`${leg}: row: the title sits next to Back (left edge below 150)`, !!title && title[0]! < 150, line)
    ok(
      `${leg}: row: the scroll ends at the safe area's bottom`,
      !!scroll && !!safe && near(scroll[1]! + scroll[3]!, safe[1]! + safe[3]!),
      line,
    )
  }
  {
    const line = after(output, 'grow cross')
    const [, left, right, leftText, rightText] = frames(output, 'grow cross')
    ok(`${leg}: cross: each column is 200 tall`, !!left && !!right && near(left[3], 200) && near(right[3], 200), line)
    ok(
      `${leg}: cross: each label is below 60 tall`,
      !!leftText && !!rightText && leftText[3]! < 60 && rightText[3]! < 60,
      line,
    )
    ok(
      `${leg}: cross: each label's top is its column's top`,
      !!left && !!right && !!leftText && !!rightText && near(leftText[1], left[1]) && near(rightText[1], right[1]),
      line,
    )
  }
  {
    const line = after(output, 'grow still')
    const [, scroll] = frames(output, 'grow still')
    ok(`${leg}: still: a scroll with no flex-grow is 216 tall (its rows)`, !!scroll && near(scroll[3], 216), line)
  }
}

runToolkits(
  {
    root: process.cwd(),
    dir: mkdtempSync(join(tmpdir(), 'term-toolkit-grow-')),
    name: 'Grow',
    iosIdentifier: 'surf.term.toolkit-grow-test',
    androidIdentifier: 'surf.term.toolkitgrow',
    program,
    judge,
    ok,
    shots: {
      macos: process.env.SNAPSHOT_GROW,
      ios: process.env.SNAPSHOT_GROW_IOS,
      android: process.env.SNAPSHOT_GROW_ANDROID,
    },
  },
  process.env.GROW_ONLY ?? '',
)

console.log(`\ntoolkit-grow: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
