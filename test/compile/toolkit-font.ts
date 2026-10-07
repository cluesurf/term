// Fonts on the toolkit hosts (native-text-0002): a face registered with the platform and drawn, on AppKit (macOS),
// UIKit (the iPhone simulator) and Android views (the emulator). The program registers CrowMark, the house face, asks
// `check-font` and `watch-font` about it and about a family nobody registered, sets one text in each with `font-family`,
// and says what the PLATFORM reports for each text's face: NSFont/UIFont's own family name on Apple, and on Android the
// family the host handed the TextView, since a Typeface cannot name itself.
//
// The face is mesh/site/word.surf/home/public/text/CrowMark.otf, ClueSurf's own (note/project/legal/fonts.md). macOS and
// the simulator read it by path; the emulator cannot, so the APK carries it as an asset and the program reads
// `asset:CrowMark.otf`. FONT_ONLY=macos (or ios, android) runs one platform. Run: npx tsx test/compile/toolkit-font.ts

import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
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

const FACE = resolve(process.cwd(), '../../../../mesh/site/word.surf/home/public/text/CrowMark.otf')
const MISSING = 'No Such Face'

// where each platform finds the file
const source = (leg: Leg): string => (leg === 'android' || leg === 'compose-android' ? 'asset:CrowMark.otf' : FACE)

const program = (leg: Leg, shot: string): string => `load @term/site/code/dom/dom
  find view

load @term/site/code/dom/native/toolkit/dom
  find open-root
  find after-launch
  find show-window
  find run-app
  find exit-app
  find child-at
  find frame-of
  find style-of
  find register-font
  find check-font
  find watch-font
  find snapshot
  find say

# one text in the registered face, one in a family nobody registered
view faces
  take host, like view
  view span
    bind style, text <font-family: CrowMark; font-size: 24px>
    text <Meditations>
  view span
    bind style, text <font-family: "${MISSING}", serif; font-size: 24px>
    text <Meditations>

task main
  save before
    call check-font
      text <CrowMark>
  save registered
    call register-font
      text <CrowMark>
      text <${source(leg)}>
  save again
    call register-font
      text <CrowMark>
      text <${source(leg)}>
  save unread
    call register-font
      text <Nothing Here>
      text </no/such/file.otf>
  save after
    call check-font
      text <CrowMark>
  save missing
    call check-font
      text <${MISSING}>
  call say
    text <fonts before={{before}} registered={{registered}} again={{again}} unread={{unread}} after={{after}} missing={{missing}}>
  call watch-font
    text <CrowMark>
    task on-ready
      take status, like text
      call say
        text <watch CrowMark {{status}}>
  call watch-font
    text <${MISSING}>
    task on-missing
      take status, like text
      call say
        text <watch missing {{status}}>
  save root
    call open-root
      text <Term fonts>
      code 420
      code 300
  call faces
    read root
  call after-launch
    task check
      call show-window
      save drawn
        call style-of
          call child-at
            call child-at
              read root
              code 0
            code 0
          text <font-family>
      save fallen
        call style-of
          call child-at
            call child-at
              read root
              code 1
            code 0
          text <font-family>
      call say
        text <drawn registered=[{{drawn}}] missing=[{{fallen}}]>
      save first-frame
        call frame-of
          call child-at
            read root
            code 0
      save second-frame
        call frame-of
          call child-at
            read root
            code 1
      call say
        text <frames {{first-frame}} {{second-frame}}>
      call snapshot
        text <${shot}>
      call exit-app
        code 0
  call run-app
`

// the text after `<marker> ` on the line holding it
function after(output: string, marker: string): string {
  const line = output.split('\n').find(l => l.includes(`${marker} `)) ?? ''

  return line.slice(line.indexOf(`${marker} `) + marker.length + 1).trim()
}

function judge(leg: Leg, toolkit: string, output: string): void {
  const fonts = after(output, 'fonts')
  // a Mac may have CrowMark installed by hand already; the platform's answer before is reported, not judged
  ok(`${leg}: registering CrowMark from ${source(leg).startsWith('asset:') ? 'the APK' : 'its file'} succeeds (${toolkit})`, fonts.includes('registered=true'), fonts)
  ok(`${leg}: registering it again is not a failure`, fonts.includes('again=true'), fonts)
  ok(`${leg}: a file that does not exist is refused`, fonts.includes('unread=false'), fonts)
  ok(`${leg}: check-font says CrowMark is drawable once registered`, fonts.includes('after=true'), fonts)
  ok(`${leg}: check-font says a family nobody registered is not`, fonts.includes('missing=false'), fonts)
  ok(`${leg}: watch-font calls back ready for the registered family`, after(output, 'watch CrowMark') === 'ready', after(output, 'watch CrowMark'))
  ok(`${leg}: watch-font calls back error for the missing one`, after(output, 'watch missing') === 'error', after(output, 'watch missing'))

  const drawn = /registered=\[([^\]]*)\]/.exec(after(output, 'drawn'))?.[1] ?? ''
  const fallen = /missing=\[([^\]]*)\]/.exec(after(output, 'drawn'))?.[1] ?? ''
  ok(`${leg}: the text in font-family CrowMark is drawn in CrowMark, as the platform reports it`, drawn === 'CrowMark', drawn)
  ok(`${leg}: the text in a missing family is drawn in the system face, not in it`, fallen !== MISSING && fallen !== 'CrowMark', fallen)

  // the registered face's line is sized by its ascent and descent, as on the web: CrowMark's are 650 and 200 on an 800
  // unit em, so a 24px line is about 26 tall, never its 17 em bounding box (Android's font padding drew it 418 tall)
  const [first, second] = after(output, 'frames').split(' ').map(part => part.split(',').map(Number))
  ok(
    `${leg}: the CrowMark line is a line tall, not its bounding box, and the next line sits directly under it`,
    !!first && !!second && first[3]! > 20 && first[3]! < 48 && Math.abs(second[1]! - (first[1]! + first[3]!)) <= 1,
    after(output, 'frames'),
  )
}

if (!existsSync(FACE)) {
  ok('the face is on disk', false, FACE)
} else {
  runToolkits(
    {
      root: process.cwd(),
      dir: mkdtempSync(join(tmpdir(), 'term-toolkit-font-')),
      name: 'Fonts',
      iosIdentifier: 'surf.term.toolkit-font-test',
      androidIdentifier: 'surf.term.toolkitfont',
      program,
      judge,
      ok,
      assets: { 'CrowMark.otf': FACE },
      shots: {
        macos: process.env.SNAPSHOT_FONT,
        ios: process.env.SNAPSHOT_FONT_IOS,
        android: process.env.SNAPSHOT_FONT_ANDROID,
        compose: process.env.SNAPSHOT_FONT_COMPOSE,
        'compose-android': process.env.SNAPSHOT_FONT_COMPOSE_ANDROID,
      },
      compose: true,
      composeAndroid: true,
    },
    process.env.FONT_ONLY ?? '',
  )
}

console.log(`\ntoolkit-font: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
