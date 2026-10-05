// The device capabilities on the toolkit hosts (device-layer): one program, every capability called through its
// contract (site/code/view/<capability>.tree), on AppKit (macOS), UIKit (the iPhone simulator), Android views (the
// emulator), Compose on the desktop and Jetpack Compose (the emulator). Each answer is printed as `step <name> <answer>`
// and judged here against what THIS platform can answer, and where the platform keeps a copy of its own the answer is
// read back from that, not from the app:
//
//   clipboard      written, read back by the app, and on the Mac by `pbpaste` after the app has gone. The Mac's own
//                  clipboard is saved before the run and put back after it, since the AppKit and Compose legs write it
//   permission     each grant's status; the simulator and emulator are granted location and the camera first
//                  (`simctl privacy`, `pm grant`), so they must read `granted`
//   location       the position the simulator and the emulator were told (`simctl location set`, `emu geo fix`)
//   battery        the emulator's set level (`dumpsys battery set level 42`), and the Mac's against `pmset -g batt`
//   network        online, on every host that has a network
//   vibration      played; on Android the vibrator manager's own record of it (`dumpsys vibrator_manager`)
//   torch          unavailable on every host here, none of which has a flash unit; a phone proves the light
//   notification   shown on Android, read back from `dumpsys notification`
//   open           an address no app handles answers `unavailable`, which opens nothing on the machine
//   share          shown, on the simulator and the emulator only (a sheet would come up on the Mac)
//   motion         the acceleration the emulator was told (`emu sensor set acceleration`)
//   camera         a JPEG from the emulator's virtual camera, pulled off the device and checked as a JPEG
//
// NOT ON THE MAC, on purpose: the camera and location, which would use the person's own camera and place if the shell
// running this already holds those grants, and the share sheet, which would come up over their work.
// DEVICE_ONLY=macos (or ios, android, compose, compose-android) runs one platform.
// Run: npx tsx test/compile/device-features.ts
import { execFileSync, spawnSync } from 'node:child_process'
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

// a line no clipboard holds by chance, so a read that answers it read what this run wrote
const TOKEN = `term-clipboard-${process.pid}-${Date.now()}`
// what the simulator and the emulator are told: the Eiffel Tower, a battery at 42 percent, and an acceleration
const PLACE = { latitude: '48.858370', longitude: '2.294481' }
const LEVEL = 42
const ACCELERATION = ['1.50', '2.50', '9.50']
// the notification's title, found again in the platform's own list
const TITLE = `Term device ${process.pid}`
const STATUSES = ['granted', 'denied', 'not-determined', 'restricted', 'unavailable']

const phone = (leg: Leg): boolean => leg === 'ios' || leg === 'android' || leg === 'compose-android'

// one call a leg makes: the step it prints under, the contract task, and its text arguments
type Call = [step: string, task: string, args: string[]]

// the calls each leg makes, each printed once
function calls(leg: Leg): Call[] {
  const only = (when: boolean, call: Call): Call[] => (when ? [call] : [])

  return [
    ['permission-camera', 'permission-status', ['camera']],
    ['permission-location', 'permission-status', ['location']],
    ['permission-notification', 'permission-status', ['notification']],
    ...only(leg !== 'macos', ['position', 'current-position', []]),
    ['battery', 'battery-status', []],
    ['network', 'network-status', []],
    ['vibrate', 'vibrate', ['medium']],
    ['torch-state', 'torch-state', []],
    ['torch-set', 'set-torch', ['on']],
    ['torch-after', 'torch-state', []],
    // off again before anything opens the camera, which takes the light with it
    ['torch-off', 'set-torch', ['off']],
    ['notification', 'show-notification', [TITLE, 'posted by device-features']],
    ...only(leg !== 'compose', ['open', 'open-address', ['term-no-handler://nothing']]),
    ...only(phone(leg), ['share', 'share-text', ['shared by device-features']]),
    ['motion', 'read-motion', []],
    ...only(leg !== 'macos' && leg !== 'compose', ['camera', 'take-photo', []]),
  ]
}

// a call as the program writes it, stacked: one argument a line
const written = ([step, task, args]: Call): string =>
  [`      save said-${step}`, `        call ${task}`, ...args.map(arg => `          text <${arg}>`), '      call say', `        text <step ${step} {said-${step}}>`].join('\n')

const program = (leg: Leg, shot: string): string => `load @term/site/code/dom/dom
  find view

load @term/site/code/dom/native/toolkit/dom
  find open-root
  find launch
  find run-app
  find exit-app
  find snapshot
  find say

load @term/site/code/view/clipboard
  find read-clipboard
  find write-clipboard

load @term/site/code/view/permission
  find permission-status

load @term/site/code/view/location
  find current-position

load @term/site/code/view/battery
  find battery-status

load @term/site/code/view/network
  find network-status

load @term/site/code/view/vibration
  find vibrate

load @term/site/code/view/torch
  find torch-state
  find set-torch

load @term/site/code/view/notification
  find show-notification

load @term/site/code/view/open
  find open-address
  find share-text

load @term/site/code/view/motion
  find read-motion

load @term/site/code/view/camera
  find take-photo

view board
  take host, like view
  view span
    text <device>

task main
  save root
    call open-root
      text <Term device>
      code 320
      code 200
  call board
    read root
  # launch, not after-launch: a capability waits on the platform
  call launch
    task check
      mark async
      save wrote
        call write-clipboard
          text <${TOKEN}>
      save held
        call read-clipboard
      call say
        text <step clipboard {wrote} {held}>
${calls(leg).map(written).join('\n')}
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

const adb = (serial: string, ...args: string[]) => spawnSync(androidTools().adb, ['-s', serial, ...args], { encoding: 'utf8' })

// the emulator's serial, each Android leg's package, and how many times the camera service had logged a torch turned on
// before each leg ran, all kept from `prepare` for the read-backs after the run
let serial = ''
const packages: Partial<Record<Leg, string>> = {}
const torchesBefore: Partial<Record<Leg, number>> = {}

// the camera service's own record of a torch turned on, counted: its events log survives the app
const torchesLit = (): number => ((adb(serial, 'shell', 'dumpsys', 'media.camera').stdout ?? '').match(/Torch for camera id \S+ turned on/g) ?? []).length

function prepare(leg: Leg, target: { udid?: string; serial?: string; identifier: string }): void {
  if (leg === 'ios' && target.udid) {
    for (const service of ['location', 'camera']) {
      spawnSync('xcrun', ['simctl', 'privacy', target.udid, 'grant', service, target.identifier])
    }

    spawnSync('xcrun', ['simctl', 'location', target.udid, 'set', `${PLACE.latitude},${PLACE.longitude}`])
  }

  if ((leg === 'android' || leg === 'compose-android') && target.serial) {
    serial = target.serial
    packages[leg] = target.identifier

    for (const permission of ['CAMERA', 'ACCESS_FINE_LOCATION', 'POST_NOTIFICATIONS']) {
      adb(target.serial, 'shell', 'pm', 'grant', target.identifier, `android.permission.${permission}`)
    }

    adb(target.serial, 'emu', 'geo', 'fix', PLACE.longitude, PLACE.latitude)
    // unplugged AND discharging: `unplug` leaves the status the emulator had, which reads charging
    adb(target.serial, 'shell', 'dumpsys', 'battery', 'unplug')
    adb(target.serial, 'shell', 'dumpsys', 'battery', 'set', 'status', '3')
    adb(target.serial, 'shell', 'dumpsys', 'battery', 'set', 'level', String(LEVEL))
    torchesBefore[leg] = torchesLit()
    adb(target.serial, 'emu', 'sensor', 'set', 'acceleration', ACCELERATION.join(':'))
  }
}

function judge(leg: Leg, toolkit: string, output: string): void {
  const said = (name: string) => step(output, name)
  const named = `${leg} (${toolkit})`
  const android = leg === 'android' || leg === 'compose-android'

  ok(`${named}: the clipboard takes a line and gives it back`, said('clipboard') === `written ${TOKEN}`, said('clipboard') || output.slice(-600))

  if ((leg === 'macos' || leg === 'compose') && process.platform === 'darwin') {
    const pasted = spawnSync('pbpaste', [], { encoding: 'utf8' }).stdout
    ok(`${named}: the Mac's pasteboard holds it after the app has gone (pbpaste)`, pasted === TOKEN, pasted.slice(0, 200))
  }

  // permissions
  for (const name of ['camera', 'location', 'notification']) {
    ok(`${named}: the ${name} grant reads one of the five statuses`, STATUSES.includes(said(`permission-${name}`)), said(`permission-${name}`))
  }

  if (leg === 'compose') {
    ok(`${named}: a desktop JVM has no grants to give`, ['camera', 'location', 'notification'].every(name => said(`permission-${name}`) === 'unavailable'))
  }

  if (leg === 'ios' || android) {
    ok(`${named}: the location and camera grants the platform was given read granted`, said('permission-location') === 'granted' && said('permission-camera') === 'granted', `${said('permission-location')} ${said('permission-camera')}`)
  }

  // location
  if (leg === 'ios' || android) {
    const [latitude = '', longitude = ''] = said('position').split(' ')
    const near = Math.abs(Number(latitude) - Number(PLACE.latitude)) < 0.0005 && Math.abs(Number(longitude) - Number(PLACE.longitude)) < 0.0005
    ok(`${named}: the position is the one the platform was told`, near, said('position'))
  } else if (leg === 'compose') {
    ok(`${named}: no location service on a desktop JVM`, said('position') === 'unavailable', said('position'))
  }

  // battery
  if (android) {
    ok(`${named}: the battery reads the level the emulator was set to, unplugged`, said('battery') === `${(LEVEL / 100).toFixed(2)} unplugged`, said('battery'))
  } else if (leg === 'macos') {
    const percent = /(\d+)%/.exec(spawnSync('pmset', ['-g', 'batt'], { encoding: 'utf8' }).stdout)?.[1]
    const level = Number(said('battery').split(' ')[0])
    ok(
      `${named}: the battery agrees with pmset`,
      percent === undefined ? said('battery') === 'unavailable' : Math.abs(level * 100 - Number(percent)) <= 1,
      `${said('battery')} against ${percent ?? 'no battery'}%`,
    )
  } else {
    ok(`${named}: the battery answers in the contract's shape`, /^(\d\.\d\d|unknown) (charging|full|unplugged|unknown)$|^unavailable$/.test(said('battery')), said('battery'))
  }

  ok(`${named}: the network is online`, /^online (wifi|cellular|wired|other)$/.test(said('network')), said('network'))

  // vibration
  ok(`${named}: a vibration answers what it did`, leg === 'compose' ? said('vibrate') === 'unavailable' : said('vibrate') === 'played', said('vibrate'))

  if (android && said('vibrate') === 'played') {
    const record = adb(serial, 'shell', 'dumpsys', 'vibrator_manager').stdout ?? ''
    ok(`${named}: and the vibrator manager recorded it for this app`, record.includes(packages[leg] ?? '?'), record.slice(0, 400))
  }

  // torch: the emulator's camera has a flash unit, and the camera service logs every torch turned on; nothing else here
  // has one
  const torch = ['torch-state', 'torch-set', 'torch-after', 'torch-off'].map(said).join(' ')

  if (android) {
    ok(`${named}: the torch goes on, reads on, and goes off again`, torch === 'off on on off', torch)
    ok(`${named}: and the camera service logged it turned on`, torchesLit() > (torchesBefore[leg] ?? Number.POSITIVE_INFINITY), `${torchesBefore[leg]} before`)
  } else {
    ok(`${named}: no torch here, said so every time`, torch === 'unavailable unavailable unavailable unavailable', torch)
  }

  // notification
  if (android) {
    ok(`${named}: the notification is shown`, said('notification') === 'shown', said('notification'))
    const listed = adb(serial, 'shell', 'dumpsys', 'notification', '--noredact').stdout ?? ''
    ok(`${named}: and the platform lists it by its title`, listed.includes(TITLE), '')
  } else {
    ok(`${named}: the notification answers from the closed set`, ['shown', 'not-determined', 'denied', 'unavailable', 'failed'].includes(said('notification')), said('notification'))
  }

  if (leg !== 'compose') {
    ok(`${named}: an address nothing handles is unavailable, and opens nothing`, said('open') === 'unavailable', said('open'))
  }

  if (phone(leg)) {
    ok(`${named}: the share sheet comes up`, said('share') === 'shown', said('share'))
  }

  // motion
  if (android) {
    ok(`${named}: the acceleration is the one the emulator was told`, said('motion') === ACCELERATION.join(' '), said('motion'))
  } else {
    ok(`${named}: no accelerometer here, said so`, said('motion') === 'unavailable', said('motion'))
  }

  // camera
  if (android) {
    const where = said('camera').replace(/^photo /, '')
    const bytes = said('camera').startsWith('photo ') ? spawnSync(androidTools().adb, ['-s', serial, 'exec-out', 'cat', where]).stdout : Buffer.alloc(0)
    ok(`${named}: the camera takes a photo, a JPEG on the device`, bytes.length > 1000 && bytes[0] === 0xff && bytes[1] === 0xd8, `${said('camera')}, ${bytes.length} bytes`)
  } else if (leg === 'ios') {
    ok(`${named}: the simulator has no camera, said so`, said('camera') === 'unavailable', said('camera'))
  }
}

// the person's clipboard, kept across the run
const kept = process.platform === 'darwin' ? spawnSync('pbpaste', [], { encoding: 'utf8' }).stdout : undefined

try {
  runToolkits(
    {
      root: process.cwd(),
      dir: mkdtempSync(join(tmpdir(), 'term-device-')),
      name: 'Device',
      iosIdentifier: 'surf.term.device-features-test',
      androidIdentifier: 'surf.term.devicefeatures',
      program,
      judge,
      ok,
      shots: {},
      compose: true,
      composeAndroid: true,
      prepare,
    },
    process.env.DEVICE_ONLY ?? '',
  )
} finally {
  if (kept !== undefined) {
    execFileSync('pbcopy', [], { input: kept })
  }

  // the emulator's battery back to its own reading
  if (serial) {
    adb(serial, 'shell', 'dumpsys', 'battery', 'reset')
  }
}

console.log(`\ndevice-features: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
