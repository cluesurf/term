// Moving files in and out of an app (beat-term-0002, 0003, 0004) on AppKit (macOS) and UIKit (the iPhone simulator).
// A download, a share, and a pick, each answer printed as `step <name> <answer>` and judged against the platform.
//
//   download   this test serves a payload of every byte value from its own HTTP server; the file the app wrote must
//              hold exactly those bytes, read back by this test off the disk (the simulator's files are the Mac's). A
//              404 answers `failed 404` and a port nothing listens on `failed 0`, and a failed download leaves the file
//              that was there as it was
//   pick       on the simulator the picker comes up and a UI test (./shared/springboard-taps.ts, here driving the app
//              itself) taps its dismiss button (Close on iOS 26, Cancel before), so the answer must be `cancelled`. Not on the Mac, whose open panel would be modal
//              on the person's screen
//   share      then, on the simulator, the sheet comes up for a file the app wrote (`shown`, only once it is up); a path
//              that is no file is `unavailable` on both. The Mac is never shown a sheet: it would come up over the
//              person's work
//
// TRANSFER_ONLY=macos or ios runs one. Run: npx tsx test/compile/device-transfer.ts
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildTaps } from './shared/springboard-taps'
import { bootedSimulator } from './shared/simulator'
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

// every byte value, four times over, and a few more: a payload no text decoding could pass through unchanged
const PAYLOAD = Buffer.from(Array.from({ length: 1030 }, (_, index) => index % 256))
const FILE = `term-transfer-${process.pid}.bin`
const IOS_ID = 'surf.term.device-transfer-test'

// the server runs in a process of its own: the toolkit legs launch the app with spawnSync, which holds this process's
// event loop, so a server here could not answer the app while it downloads. It prints its port, and ends with this test
const SERVE = `
  const payload = Buffer.from(Array.from({ length: ${PAYLOAD.length} }, (_, index) => index % 256))
  const server = require('node:http').createServer((request, response) => {
    if (request.url === '/payload') response.writeHead(200, { 'content-length': payload.length }).end(payload)
    else response.writeHead(404).end('not here')
  })
  server.listen(0, '127.0.0.1', () => console.log(server.address().port))
  const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
  setInterval(() => { if (!alive(${process.pid})) process.exit(0) }, 1000)
`
const serving = spawn(process.execPath, ['-e', SERVE], { stdio: ['ignore', 'pipe', 'ignore'] })
const port = await new Promise<number>(settle => serving.stdout.once('data', chunk => settle(Number(String(chunk).trim()))))
const origin = `http://127.0.0.1:${port}`
// a port nothing listens on: one this test held a moment ago and let go
const closed = await new Promise<number>(settle => {
  const probe = createServer().listen(0, '127.0.0.1', () => {
    const port = (probe.address() as AddressInfo).port
    probe.close(() => settle(port))
  })
})

const say = (step: string): string[] => ['      call say', `        text <step ${step} {said-${step}}>`]

const program = (leg: Leg, _shot: string): string => `load @term/site/code/dom/native/toolkit/dom
  find open-root
  find launch
  find run-app
  find exit-app
  find say

load @term/site/code/view/download
  find download-file

load @term/site/code/view/open
  find share-file

load @term/site/code/view/files
  find pick-file

load @term/base/environment/path
  find known-directory

${
  leg === 'ios'
    ? `load @term/base/clock
  find sleep
`
    : ''
}
task main
  save root
    call open-root
      text <Term transfer>
      code 320
      code 200
  call launch
    task check
      mark async
      save folder
        call known-directory
          text <temporary>
      save target, text <{folder}/${FILE}>
      save said-download
        call download-file
          text <${origin}/payload>
          read target
${say('download').join('\n')}
      save said-missing
        call download-file
          text <${origin}/no-such-file>
          read target
${say('missing').join('\n')}
      save said-closed
        call download-file
          text <http://127.0.0.1:${closed}/payload>
          read target
${say('closed').join('\n')}
      save said-target, read target
${say('target').join('\n')}
      save said-share-none
        call share-file
          text <{folder}/no-such-${process.pid}.bin>
${say('share-none').join('\n')}
${
  leg === 'ios'
    ? [
        '      save said-pick',
        '        call pick-file',
        '          text <audio>',
        ...say('pick'),
        '      save said-share',
        '        call share-file',
        '          read target',
        ...say('share'),
        // the sheet stays up for 25 seconds while the UI test looks for the file's name on it (it finds it at once when the sheet is up)
        '      call sleep',
        '        code 25000',
      ].join('\n')
    : ''
}
      call exit-app
        code 0
  call run-app
`

function step(output: string, name: string): string {
  const line = output.split('\n').find(l => l.includes(`step ${name} `)) ?? ''

  return line.slice(line.indexOf(`step ${name} `) + `step ${name} `.length).trim()
}

// the UI test for the pick and the share: the picker's dismiss button, `Close` (an X in the navigation bar
// FullDocumentManagerViewControllerNavigationBar) on iOS 26 and `Cancel` before. The app's `cancelled` alone would not do:
// a picker that never came up answers `unavailable` (native-files.swift), and only this tap shows the picker was there to
// cancel. Then the share sheet: an element whose label holds the shared file's name, the sheet's header
const dir = mkdtempSync(join(tmpdir(), 'term-transfer-'))
const LEGS = process.env.TRANSFER_ONLY ? [process.env.TRANSFER_ONLY] : ['macos', 'ios']
// a requested iOS leg with no booted simulator does not run: it is counted as skipped on the last line, never a pass
const booted = LEGS.includes('ios') ? bootedSimulator() : undefined
const iosSkipped = booted !== undefined && 'missing' in booted
const taps = !LEGS.includes('ios') || iosSkipped || spawnSync('xcodebuild', ['-version']).status !== 0
  ? undefined
  : buildTaps(
      dir,
      `        let app = XCUIApplication(bundleIdentifier: "${IOS_ID}")
        let close = app.navigationBars["FullDocumentManagerViewControllerNavigationBar"].buttons["Close"]
        let cancel = app.buttons["Cancel"]
        // what is on the screen while the app waits on its pick, for when no button is found: the tree and a PNG
        var looked = 0
        while !(close.waitForExistence(timeout: 10) || cancel.exists), looked < 9 {
            looked += 1
            if looked == 3 {
                print("taps: tree \\(app.debugDescription)")
                try? XCUIScreen.main.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: "${dir}/picker.png"))
            }
        }
        XCTAssertTrue(close.exists || cancel.exists, "no document picker came up")
        if close.exists {
            close.tap()
            print("taps: picker cancelled")
        } else if cancel.exists {
            cancel.tap()
            print("taps: picker cancelled")
        } else {
            print("taps: no picker button")
        }
        // the share sheet, up for 25 seconds (the Term program waits before it exits): its header shows THIS run's file name
        let named = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "${FILE}")).firstMatch
        var seen = 0
        while !named.waitForExistence(timeout: 10), seen < 2 {
            seen += 1
            if seen == 2 {
                print("taps: share tree \\(app.debugDescription)")
                try? XCUIScreen.main.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: "${dir}/share.png"))
            }
        }
        XCTAssertTrue(named.exists, "the share sheet did not show the file's name")
        if named.exists {
            print("taps: share sheet shows the file")
        }
        // dismiss the sheet when it has a button for it: not finding one is not a failure
        let dismiss = app.buttons["Close"].exists ? app.buttons["Close"] : app.buttons["Cancel"]
        if dismiss.exists {
            dismiss.tap()
        }`,
    )

if (taps) {
  ok('the UI test that cancels the picker builds', taps.built, taps.errors)
}

// the simulator the iOS leg used, kept so the app can be ended after it
let usedUdid: string | undefined

function prepare(leg: Leg, target: { udid?: string; identifier: string }): void {
  if (leg === 'ios') {
    usedUdid = target.udid
  }

  if (leg === 'ios' && target.udid && taps?.built) {
    taps.start(target.udid)
  }
}

function judge(leg: Leg, toolkit: string, output: string): void {
  const said = (name: string) => step(output, name)
  const named = `${leg} (${toolkit})`
  const where = said('target')
  const written = existsSync(where) ? readFileSync(where) : Buffer.alloc(0)

  ok(`${named}: the download answers its length`, said('download') === `downloaded ${PAYLOAD.length}`, said('download'))
  ok(`${named}: a 404 is failed 404, and a closed port failed 0`, said('missing') === 'failed 404' && said('closed') === 'failed 0', `${said('missing')} ${said('closed')}`)
  // the program downloads the good file first, then the 404 and the closed port to the SAME path, so this read, after
  // all three, is what the failures left
  ok(`${named}: the file holds every byte the server sent, after a 404 and a closed port to the same path`, written.equals(PAYLOAD), `${written.length} bytes at ${where}`)
  ok(`${named}: a path that is no file has nothing to share`, said('share-none') === 'unavailable', said('share-none'))

  if (leg === 'ios') {
    ok(`${named}: the share sheet comes up for the file`, said('share') === 'shown', said('share'))
    ok(`${named}: the picker came up and was cancelled`, said('pick') === 'cancelled', said('pick'))
  }
}

try {
  for (const leg of LEGS) {
    runToolkits({ root: process.cwd(), dir: mkdtempSync(join(tmpdir(), 'term-transfer-')), name: 'Transfer', iosIdentifier: IOS_ID, androidIdentifier: 'surf.term.devicetransfer', program, judge, ok, shots: {}, prepare }, leg)
  }

  const tapped = await taps?.finish()

  if (tapped) {
    writeFileSync(join(dir, 'taps.log'), tapped.log)
    console.log(`taps log: ${join(dir, 'taps.log')}`)
    const failures = tapped.log
      .split('\n')
      .filter(line => !/^taps: (share )?tree/.test(line) && /error|failed|XCTAssert/i.test(line))
      .join('\n')
      .slice(0, 1200)

    ok('ios: the UI test found the picker and tapped Close', tapped.status === 0 && tapped.log.includes('taps: picker cancelled'), failures)
    ok("ios (UIKit): the share sheet showed the file's name", tapped.log.includes('taps: share sheet shows the file'), failures)
  }
} finally {
  // a picker left up must not stay on the shared simulator's screen: the app is ended, its failure ignored
  if (usedUdid) {
    spawnSync('xcrun', ['simctl', 'terminate', usedUdid, IOS_ID], { stdio: 'ignore' })
    console.log(`terminated ${IOS_ID} on ${usedUdid}`)
  }

  serving.kill()
}

// runToolkits printed the `skip  ios  (reason)` line itself
console.log(`\ndevice-transfer: ${pass} pass, ${fail} fail${iosSkipped ? ', 1 skipped' : ''}`)

if (fail > 0) {
  process.exit(1)
}
