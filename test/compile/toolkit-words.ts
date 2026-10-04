// The vocabulary words no toolkit host drew until native-dom-0049 (note/term/view/11-vocabulary.md): spacer, divider,
// image and scroll, and frame's min and max bounds, on AppKit (macOS), UIKit (the iPhone simulator) and Android views
// (the emulator). One program mounts each on the window's root and says what it reads back FROM THE VIEWS: frames, the
// picture's pixel size and accessibility label as the platform holds them, and a scroll's content extent. Built and run
// on each platform by ./shared/toolkit-run.ts.
//
// The image is a 4 by 3 PNG written here as a `data:` URI, so no file has to reach a simulator or an emulator.
// The same program also runs on Compose on the desktop JVM, headless (compose-target).
// WORDS_ONLY=macos (or ios, android, compose) runs one platform. Run: npx tsx test/compile/toolkit-words.ts

import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
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

// a PNG of `width` by `height` red pixels: the signature, IHDR, one IDAT of filter-0 rows, IEND
function redPng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const check = Buffer.alloc(4)
    check.writeUInt32BE(crc32(body))

    return Buffer.concat([length, body, check])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  // 8 bits per sample, color type 2 (RGB), deflate, no filter method beyond 0, no interlace
  header.set([8, 2, 0, 0, 0], 8)
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [255, 0, 0]).flat())])
  const pixels = Buffer.concat(Array.from({ length: height }, () => row))

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const PICTURE = `data:image/png;base64,${redPng(4, 3).toString('base64')}`
const ITEMS = 12

const scrollItems = Array.from({ length: ITEMS }, (_, i) => `    view button\n      text <${i + 1}>\n`).join('')

const program = (_leg: Leg, shot: string): string => `load @term/site/code/dom/dom
  find view

load @term/site/code/dom/native/toolkit/dom
  find open-root
  find after-launch
  find show-window
  find run-app
  find exit-app
  find frame-of
  find child-at
  find serialize
  find snapshot
  find say

# each word on the root, in order: the spacer row, the divider column, the image, the scroll, the two bounds
view words
  take host, like view
  view div
    bind style, text <display: flex; flex-direction: row; width: 300px>
    view button
      text <a>
    view div
      bind style, text <flex-grow: 1>
    view button
      text <bb>
  view div
    bind style, text <display: flex; flex-direction: column; width: 200px>
    view button
      text <a>
    view hr
    view button
      text <bb>
  view img
    bind src, text <${PICTURE}>
    bind alt, text <A red dot>
  view scroll
    bind style, text <height: 100px>
${scrollItems}  view div
    bind style, text <min-width: 250px>
    view button
      text <a>
  view button
    bind style, text <max-width: 60px>
    text <a much longer label than sixty points>

# a node's frame and its children's, said as: the label, then x,y,w,h for the node and each of its first three children
task say-frames
  take label, like text
  take node, like view
  save whole
    call frame-of
      read node
  save first
    call frame-of
      call child-at
        read node
        code 0
  save second
    call frame-of
      call child-at
        read node
        code 1
  save third
    call frame-of
      call child-at
        read node
        code 2
  call say
    text <frames {{label}} {{whole}} {{first}} {{second}} {{third}}>

task main
  save root
    call open-root
      text <Term words>
      code 420
      code 640
  call words
    read root
  call after-launch
    task check
      call show-window
      call say-frames
        text <spacer>
        call child-at
          read root
          code 0
      call say-frames
        text <divider>
        call child-at
          read root
          code 1
      save column
        call serialize
          call child-at
            read root
            code 1
      call say
        text <tree divider {{column}}>
      save picture
        call child-at
          read root
          code 2
      save image-tree
        call serialize
          read picture
      save image-frame
        call frame-of
          read picture
      call say
        text <tree image {{image-tree}} {{image-frame}}>
      save scroller
        call child-at
          read root
          code 3
      save scroll-tree
        call serialize
          read scroller
      save scroll-frame
        call frame-of
          read scroller
      call say
        text <tree scroll {{scroll-frame}} {{scroll-tree}}>
      save least
        call frame-of
          call child-at
            read root
            code 4
      save most
        call frame-of
          call child-at
            read root
            code 5
      call say
        text <bounds {{least}} {{most}}>
      call snapshot
        text <${shot}>
      call exit-app
        code 0
  call run-app
`

const near = (a: number, b: number) => Math.abs(a - b) <= 1

// the text after `<marker> ` on the line holding it
function after(output: string, marker: string): string {
  const line = output.split('\n').find(l => l.includes(`${marker} `)) ?? ''

  return line.slice(line.indexOf(`${marker} `) + marker.length + 1).trim()
}

const frames = (output: string, label: string): number[][] =>
  after(output, `frames ${label}`).split(' ').map(part => part.split(',').map(Number))

function judge(leg: Leg, toolkit: string, output: string, shot: string): void {
  // spacer: a growing empty child pushes `bb` to the row's far edge
  const [row, a, spacer, bb] = frames(output, 'spacer')
  ok(
    `${leg}: the spacer takes the rest of a 300 row, so the last button ends at its edge (${toolkit})`,
    !!row && !!a && !!spacer && !!bb && near(row[2]!, 300) && near(a[0]!, row[0]!) && near(bb[0]! + bb[2]!, row[0]! + 300) && near(spacer[2]!, 300 - a[2]! - bb[2]!),
    JSON.stringify({ row, a, spacer, bb }),
  )

  // divider: a hairline across the 200 column, between the two buttons
  const [column, top, line, bottom] = frames(output, 'divider')
  ok(
    `${leg}: the divider is a hairline across the 200 column, between its neighbors`,
    !!column && !!top && !!line && !!bottom && near(line[2]!, 200) && line[3]! >= 0 && line[3]! <= 2 && line[1]! >= top[1]! + top[3]! - 1 && bottom[1]! >= line[1]! + line[3]! - 1,
    JSON.stringify({ column, top, line, bottom }),
  )
  ok(`${leg}: the divider reads back as one`, after(output, 'tree divider').includes('<hr></hr>'), after(output, 'tree divider'))

  // image: the platform holds the 4 by 3 picture and the words for it
  const image = after(output, 'tree image')
  ok(`${leg}: the image holds the 4x3 picture, decoded by the platform`, image.includes('size="4x3"'), image)
  ok(`${leg}: the image's words are the platform's accessibility label`, image.includes('alt="A red dot"'), image)

  // scroll: a 100 tall frame around content taller than it, holding every item
  const scroll = after(output, 'tree scroll')
  const scrollFrame = scroll.split(' ')[0]!.split(',').map(Number)
  const extent = /extent="(\d+),(\d+)"/.exec(scroll)
  ok(`${leg}: the scroll's frame is its 100 height`, near(scrollFrame[3]!, 100), scroll.slice(0, 200))
  ok(`${leg}: its content is taller than its frame, so it scrolls`, !!extent && Number(extent[2]) > 100, scroll.slice(0, 200))
  ok(`${leg}: its content holds all ${ITEMS} items`, (scroll.match(/<button>/g) ?? []).length === ITEMS, scroll.slice(0, 200))

  // frame bounds: a minimum widens a block past its button, a maximum narrows a long button
  const [least, most] = after(output, 'bounds').split(' ').map(part => part.split(',').map(Number))
  ok(`${leg}: min-width 250 holds a block at least 250 wide`, !!least && least[2]! >= 249, JSON.stringify(least))
  ok(`${leg}: max-width 60 holds a long button to 60`, !!most && most[2]! <= 61 && most[2]! > 0, JSON.stringify(most))

  ok(`${leg}: a PNG of the screen was written`, existsSync(shot) && readFileSync(shot).subarray(1, 4).toString() === 'PNG', shot)
}

runToolkits(
  {
    root: process.cwd(),
    dir: mkdtempSync(join(tmpdir(), 'term-toolkit-words-')),
    name: 'Words',
    iosIdentifier: 'surf.term.toolkit-words-test',
    androidIdentifier: 'surf.term.toolkitwords',
    program,
    judge,
    ok,
    shots: {
      macos: process.env.SNAPSHOT_WORDS,
      ios: process.env.SNAPSHOT_WORDS_IOS,
      android: process.env.SNAPSHOT_WORDS_ANDROID,
      compose: process.env.SNAPSHOT_WORDS_COMPOSE,
    },
    compose: true,
  },
  process.env.WORDS_ONLY ?? '',
)

console.log(`\ntoolkit-words: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
