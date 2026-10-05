// The permission prompt itself (device-layer-0001), on the Android emulator: an app with no grant asks for the camera,
// the platform's own dialog comes up, a person's tap is made on its allow button (found by `uiautomator dump`, tapped
// with `input tap`), and the request answers `granted` because the platform now says so. Every other device test
// grants ahead of time; this is the one that goes through the prompt.
//
// Then the other way: a second app is refused (the deny button), and its request answers `denied`.
// Android views and Jetpack Compose, each its own app. Skipped, with the reason, when no device is online.
// PROMPT_ONLY=android (or compose-android) runs one. Run: npx tsx test/compile/permission-prompt.ts
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { androidTools } from '@term/call/code/cask'
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

// which button each run presses: allow the camera on the first app, deny it on the second
const ANSWER = (process.env.PROMPT_ANSWER ?? 'allow') as 'allow' | 'deny'

// the allow and deny buttons of Android's permission dialog, by their resource ids (Android 11 on), which do not change
// with the language the emulator speaks
const BUTTONS = {
  allow: ['permission_allow_foreground_only_button', 'permission_allow_button', 'permission_allow_one_time_button'],
  deny: ['permission_deny_button', 'permission_deny_and_dont_ask_again_button'],
}

const program = (_leg: Leg, shot: string): string => `load @term/site/code/dom/native/toolkit/dom
  find open-root
  find launch
  find run-app
  find exit-app
  find snapshot
  find say

load @term/site/code/view/permission
  find permission-status
  find request-permission

load @term/site/code/view/camera
  find take-photo

task main
  save root
    call open-root
      text <Term prompt>
      code 320
      code 200
  call launch
    task check
      mark async
      save before
        call permission-status
          text <camera>
      call say
        text <step before {before}>
      save after
        call request-permission
          text <camera>
      call say
        text <step after {after}>
      save now
        call permission-status
          text <camera>
      call say
        text <step now {now}>
      # the photo the grant was asked for: a program that never takes one never links the camera, and then declares no
      # camera permission, which Android reads as unavailable (device-declare.ts)
      save photo
        call take-photo
      call say
        text <step photo {photo}>
      call snapshot
        text <${shot}>
      call exit-app
        code 0
  call run-app
`

function step(output: string, name: string): string {
  const line = output.split('\n').find(l => l.includes(`step ${name} `)) ?? ''

  return line.slice(line.indexOf(`step ${name} `) + `step ${name} `.length).trim()
}

// While the app waits on its prompt, find the dialog's button and tap its centre, as a person would. Runs beside the
// launch: `prepare` starts it in the background with `sh -c` so the harness's own launch and log read are not held up
function prepare(leg: Leg, target: { serial?: string; identifier: string }): void {
  if (!target.serial) {
    return
  }

  const adb = androidTools().adb
  // the grant cleared, so the app asks from not-determined. `pm clear` would also clear the asked flag the runtime keeps
  spawnSync(adb, ['-s', target.serial, 'shell', 'pm', 'revoke', target.identifier, 'android.permission.CAMERA'])
  // A second Node process, detached, so the harness goes on to launch the app: it reads the screen through
  // `uiautomator dump` once a second for a minute, and the first time one of the buttons is there it taps its centre.
  // From this machine rather than in the device's own shell, whose quoting the loop did not survive
  const ids = BUTTONS[ANSWER].map(id => `com.android.permissioncontroller:id/${id}`)
  const script = `
    const { spawnSync } = require('node:child_process')
    const adb = (...args) => spawnSync(${JSON.stringify(adb)}, ['-s', ${JSON.stringify(target.serial)}, ...args], { encoding: 'utf8' })
    const ids = ${JSON.stringify(ids)}
    for (let tries = 0; tries < 60; tries++) {
      adb('shell', 'uiautomator', 'dump', '/sdcard/term-prompt.xml')
      const screen = adb('exec-out', 'cat', '/sdcard/term-prompt.xml').stdout || ''
      for (const id of ids) {
        const found = new RegExp('resource-id="' + id + '"[^>]*bounds="\\\\[(\\\\d+),(\\\\d+)\\\\]\\\\[(\\\\d+),(\\\\d+)\\\\]"').exec(screen)
        if (found) {
          const [, left, top, right, bottom] = found.map(Number)
          adb('shell', 'input', 'tap', String((left + right) >> 1), String((top + bottom) >> 1))
          process.exit(0)
        }
      }
      spawnSync('sleep', ['1'])
    }`
  spawn(process.execPath, ['-e', script], { detached: true, stdio: 'ignore' }).unref()
}

function judge(leg: Leg, toolkit: string, output: string): void {
  const named = `${leg} (${toolkit})`
  ok(`${named}: before asking, the camera reads not-determined`, step(output, 'before') === 'not-determined', step(output, 'before'))

  if (ANSWER === 'allow') {
    ok(`${named}: the platform's prompt came up, allow was tapped, and the request answers granted`, step(output, 'after') === 'granted', step(output, 'after'))
    ok(`${named}: and the grant reads granted after`, step(output, 'now') === 'granted', step(output, 'now'))
    ok(`${named}: so the photo it was asked for is taken`, step(output, 'photo').startsWith('photo '), step(output, 'photo'))
  } else {
    ok(`${named}: the platform's prompt came up, deny was tapped, and the request answers denied`, step(output, 'after') === 'denied', step(output, 'after'))
    ok(`${named}: and the grant reads denied after, not not-determined`, step(output, 'now') === 'denied', step(output, 'now'))
    ok(`${named}: so the photo answers denied, and no camera opened`, step(output, 'photo') === 'denied', step(output, 'photo'))
  }
}

runToolkits(
  {
    root: process.cwd(),
    dir: mkdtempSync(join(tmpdir(), 'term-prompt-')),
    name: 'Prompt',
    iosIdentifier: 'surf.term.permission-prompt-test',
    androidIdentifier: `surf.term.prompt${ANSWER}`,
    program,
    judge,
    ok,
    shots: {},
    composeAndroid: true,
    prepare,
  },
  process.env.PROMPT_ONLY ?? 'android',
)

console.log(`\npermission-prompt: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
