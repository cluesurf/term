// The photo library read on iOS (device-layer-0025), through the platform's own prompt. On the iOS 26 simulator
// `simctl privacy grant photos` writes its row to TCC.db and PhotoKit does not read it: every level of
// PHPhotoLibrary.authorizationStatus answered notDetermined beside a granted camera written the same way. So the grant
// is given the way a person gives it: the app asks, and a UI test (./shared/springboard-taps.ts) taps Allow Full Access
// on the alert SpringBoard puts up.
//
// The witnesses are the platform's: a photo of a size no camera makes (./shared/photo-sample.ts) put in the library
// with `simctl addmedia` must come back as the newest by its size, and its copy, which the app writes into its own
// folder on the Mac's disk, must be a JPEG of that size, read here from the file.
//
// Skips, with the reason, without xcodebuild or a simulator. Run: npx tsx test/compile/photos-prompt.ts
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SAMPLE, jpegSize, makePhoto } from './shared/photo-sample'
import { buildTaps } from './shared/springboard-taps'
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

if (spawnSync('xcodebuild', ['-version']).status !== 0) {
  console.log('skip  photos-prompt  (no xcodebuild)')
  process.exit(0)
}

const dir = mkdtempSync(join(tmpdir(), 'term-photos-'))
const APP = 'surf.term.photos-prompt-test'

// the full-access button: `Allow Full Access` since iOS 17, `Allow Access to All Photos` before
const taps = buildTaps(
  dir,
  `        let full = springboard.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@ OR label CONTAINS[c] %@", "Full Access", "All Photos")).firstMatch
        XCTAssertTrue(full.waitForExistence(timeout: 120), "no photo library prompt came up")
        full.tap()
        print("taps: full access allowed")`,
)
ok('the UI test that taps the prompt builds', taps.built, taps.errors)

const program = (_leg: Leg, _shot: string): string => `load @term/site/code/dom/native/toolkit/dom
  find open-root
  find launch
  find run-app
  find exit-app
  find say

load @term/site/code/view/permission
  find permission-status
  find request-permission

load @term/site/code/view/photos
  find find-photos
  find copy-photo

load @term/base/text
  find substring
  find index-of
  find replace-all

task main
  save root
    call open-root
      text <Term photos>
      code 320
      code 200
  call launch
    task check
      mark async
      save before
        call permission-status
          text <photos>
      call say
        text <step before {before}>
      save asked
        call request-permission
          text <photos>
      call say
        text <step asked {asked}>
      save newest
        call find-photos
          code 1
      save id
        call substring
          read newest
          code 0
          call index-of
            read newest
            text <\\t>
      save shown
        call replace-all
          read newest
          text <\\t>
          text < ~ >
      call say
        text <step newest {shown}>
      save copied
        call copy-photo
          read id
      call say
        text <step copied {copied}>
      call exit-app
        code 0
  call run-app
`

function step(output: string, name: string): string {
  const line = output.split('\n').find(l => l.includes(`step ${name} `)) ?? ''

  return line.slice(line.indexOf(`step ${name} `) + `step ${name} `.length).trim()
}

// once the app is installed and before it launches: the photo in the library, the grant forgotten so the request
// prompts, and the UI test waiting for that prompt
function prepare(leg: Leg, target: { udid?: string; identifier: string }): void {
  if (leg !== 'ios' || !target.udid) return

  spawnSync('xcrun', ['simctl', 'addmedia', target.udid, makePhoto(`term-photos-prompt-${process.pid}.jpg`)])
  spawnSync('xcrun', ['simctl', 'privacy', target.udid, 'reset', 'photos', target.identifier])

  if (taps.built) taps.start(target.udid)
}

function judge(leg: Leg, toolkit: string, output: string): void {
  const named = `${leg} (${toolkit})`
  ok(`${named}: before asking, the grant is not-determined`, step(output, 'before') === 'not-determined', step(output, 'before'))
  ok(`${named}: the prompt was tapped, and the request answers granted`, step(output, 'asked') === 'granted', step(output, 'asked'))
  const fields = step(output, 'newest').split(' ~ ')
  ok(
    `${named}: the newest photo is the one simctl put in the library, by its size, with a UTC time`,
    fields.length === 3 && fields[0] !== '' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(fields[1] ?? '') && fields[2] === `${SAMPLE.width}x${SAMPLE.height}`,
    step(output, 'newest'),
  )
  // the simulator's files are the Mac's, so the copy is read where the app wrote it
  const where = step(output, 'copied').replace(/^photo /, '')
  const size = step(output, 'copied').startsWith('photo ') && existsSync(where) ? jpegSize(readFileSync(where)) : undefined
  ok(`${named}: and its copy is a JPEG of that size, PhotoKit's data made one by ImageIO`, size?.width === SAMPLE.width && size?.height === SAMPLE.height, `${step(output, 'copied')} ${JSON.stringify(size)}`)
}

async function main(): Promise<void> {
  runToolkits({ root: process.cwd(), dir, name: 'Photos', iosIdentifier: APP, androidIdentifier: 'surf.term.photos', program, judge, ok, shots: {}, prepare }, 'ios')
  const tapped = await taps.finish()

  if (tapped) {
    ok('ios: SpringBoard showed the photo library prompt and took the tap', tapped.status === 0 && tapped.log.includes('taps: full access allowed'), tapped.log.split('\n').filter(line => /error|failed|XCTAssert/i.test(line)).join('\n').slice(0, 1200))
  }

  console.log(`\nphotos-prompt: ${pass} pass, ${fail} fail`)

  if (fail > 0) {
    process.exit(1)
  }
}

main()
