// A local notification shown on iOS (device-layer-0018), through the platform's own prompt. `simctl privacy` grants
// no notifications, so the only way to the grant is the alert SpringBoard puts up, and only a UI test can tap it: an
// XCUITest bundle, written and built here (./shared/springboard-taps.ts), drives SpringBoard, taps Allow when our app's
// prompt comes up, and then waits for a banner carrying the notification's title. That banner is the witness:
// SpringBoard drew it, the app did not report it.
//
// The app (a UIKit toolkit program) asks for the grant, posts the notification while it is in front, and says what it
// was answered. A notification posted in front is shown only when the app's delegate asks for it, which the runtime
// now does (native-notification.swift `NotificationPresenter`); before that `shown` answered for a banner nobody saw.
//
// Skips, with the reason, without xcodebuild or a simulator. Run: npx tsx test/compile/notification-prompt.ts
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  console.log('skip  notification-prompt  (no xcodebuild)')
  process.exit(0)
}

const dir = mkdtempSync(join(tmpdir(), 'term-notification-'))
const TITLE = `Term notice ${process.pid}`
const APP = 'surf.term.notification-prompt-test'

// The taps: Allow on our app's prompt, then the banner. Every element SpringBoard draws is searched, since a banner's
// title is one static text among the app name and the body
const taps = buildTaps(
  dir,
  `        let allow = springboard.buttons["Allow"]
        XCTAssertTrue(allow.waitForExistence(timeout: 120), "no notification prompt came up")
        allow.tap()
        let banner = springboard.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "${TITLE}")).firstMatch
        XCTAssertTrue(banner.waitForExistence(timeout: 60), "no banner with the title came up")
        print("taps: allowed, banner shown")`,
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

load @term/site/code/view/notification
  find show-notification

task main
  save root
    call open-root
      text <Term notice>
      code 320
      code 200
  call launch
    task check
      mark async
      save before
        call permission-status
          text <notification>
      call say
        text <step before {before}>
      save asked
        call request-permission
          text <notification>
      call say
        text <step asked {asked}>
      save posted
        call show-notification
          text <${TITLE}>
          text <posted by notification-prompt>
      call say
        text <step posted {posted}>
      call exit-app
        code 0
  call run-app
`

function step(output: string, name: string): string {
  const line = output.split('\n').find(l => l.includes(`step ${name} `)) ?? ''

  return line.slice(line.indexOf(`step ${name} `) + `step ${name} `.length).trim()
}

// started once the app is installed and before it launches: the UI test waits for the prompt the launch brings up
function prepare(leg: Leg, target: { udid?: string; identifier: string }): void {
  if (leg === 'ios' && target.udid && taps.built) {
    taps.start(target.udid)
  }
}

function judge(leg: Leg, toolkit: string, output: string): void {
  const named = `${leg} (${toolkit})`
  ok(`${named}: before asking, the grant is not-determined`, step(output, 'before') === 'not-determined', step(output, 'before'))
  ok(`${named}: the prompt was tapped, and the request answers granted`, step(output, 'asked') === 'granted', step(output, 'asked'))
  ok(`${named}: the notification is posted`, step(output, 'posted') === 'shown', step(output, 'posted'))
}

async function main(): Promise<void> {
  runToolkits({ root: process.cwd(), dir, name: 'Notice', iosIdentifier: APP, androidIdentifier: 'surf.term.notice', program, judge, ok, shots: {}, prepare }, 'ios')
  const tapped = await taps.finish()

  if (tapped) {
    // the witness: SpringBoard drew a banner with the notification's title, which only the platform can do
    ok(
      'ios: SpringBoard showed the prompt, took the tap, and drew the banner with its title',
      tapped.status === 0 && tapped.log.includes('taps: allowed, banner shown'),
      tapped.log.split('\n').filter(line => /error|failed|XCTAssert/i.test(line)).join('\n').slice(0, 1200),
    )
  }

  console.log(`\nnotification-prompt: ${pass} pass, ${fail} fail`)

  if (fail > 0) {
    process.exit(1)
  }
}

main()
