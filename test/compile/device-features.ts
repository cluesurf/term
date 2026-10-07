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
//   microphone     a WAV from the emulator's virtual microphone, pulled off the device and its header read field by
//                  field; on the simulator, never granted, `not-determined`
//   calendar       two events added, found, one removed; the one kept read back from the platform's own store
//                  (`content query` on the emulator, the simulator's Calendar.sqlitedb), the removed one gone from it
//   photos         a 321x123 JPEG made by `sips`, pushed into the emulator's library and scanned, found as the newest by
//                  its size, and its copy read back as a JPEG of that size. On the simulator, `not-determined`: simctl's
//                  grant does not reach PhotoKit (photos-prompt.ts taps the real prompt)
//   contacts       two people written through the platform (`simctl addmedia` of a vCard, `content insert` into the
//                  provider), found by a query in another case and answered sorted; and a name nobody has, `none`
//
// NOT ON THE MAC, on purpose: the camera and location, which would use the person's own camera and place if the shell
// running this already holds those grants, and the share sheet, which would come up over their work.
// DEVICE_ONLY=macos (or ios, android, compose, compose-android) runs one platform.
// Run: npx tsx test/compile/device-features.ts
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { androidTools } from '@term/call/code/cask'
import { SAMPLE, jpegSize, makePhoto } from './shared/photo-sample'
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
// an address the emulator's phone app handles, read back from the activity manager
const PHONE = '5550100'
const STATUSES = ['granted', 'denied', 'not-determined', 'restricted', 'unavailable']
// a secret and the name it is kept under, both unique to this run
const SECRET_NAME = `term-device-${process.pid}`
const SECRET = `term-secret-${process.pid}-${Date.now()}`

const phone = (leg: Leg): boolean => leg === 'ios' || leg === 'android' || leg === 'compose-android'

// two contacts unique to this run, written through the platform (a vCard on the simulator, the provider on the
// emulator): one with a number and one without, found by a query in another case, and answered sorted by name
const FAMILY = `Termwright${process.pid}`
const PEOPLE = [
  { given: 'Bea', number: '' },
  { given: 'Ada', number: '555-0101' },
]
const FOUND = [`Ada ${FAMILY}\t555-0101`, `Bea ${FAMILY}\t`].join('\n')
// two events unique to this run, written by the app: the first removed again, the second kept past the run and read
// back from the platform's own store. Their times are hours apart from a base that moves with the process id, the
// second written with a +01:00 offset, and every time the app answers is UTC to the second
const EVENT = `Term event ${process.pid}`
const KEPT_EVENT = `${EVENT} kept`
const HOUR = 3_600_000
const EVENT_BASE = Date.UTC(2031, 0, 1) + (process.pid % 50_000) * HOUR
const utc = (ms: number): string => new Date(ms).toISOString().replace('.000Z', 'Z')
const plusOne = (ms: number): string => new Date(ms + HOUR).toISOString().replace('.000Z', '+01:00')
const EVENTS = {
  first: [EVENT_BASE + 9 * HOUR, EVENT_BASE + 10 * HOUR],
  kept: [EVENT_BASE + 11 * HOUR, EVENT_BASE + 12 * HOUR],
  span: [utc(EVENT_BASE + 8 * HOUR), utc(EVENT_BASE + 14 * HOUR)],
}
const BOTH_EVENTS = [`${utc(EVENTS.first[0]!)}\t${utc(EVENTS.first[1]!)}\t${EVENT}`, `${utc(EVENTS.kept[0]!)}\t${utc(EVENTS.kept[1]!)}\t${KEPT_EVENT}`].join('\n')

// a photo of a size no camera makes, put in the emulator's library (`adb push` into its Pictures, then scanned), found
// again as the newest by its size, and copied out as a JPEG of that size. The simulator's half is photos-prompt.ts
const PHOTO = { ...SAMPLE, name: `term-photo-${process.pid}.jpg` }

// lines a step's answer is turned into after it is said: the first event's id, read off `added <id>`, and the newest
// photo's, the first line's text before its tab
const AFTER: Record<string, string[]> = {
  'calendar-add': ['      save event-id', '        call replace-all', '          read said-calendar-add', '          text <added >', '          text <>'],
  'photos-newest': [
    '      save photo-id',
    '        call substring',
    '          read said-photos-newest',
    '          code 0',
    '          call index-of',
    '            read said-photos-newest',
    '            text <\\t>',
  ],
}

// the steps whose answer is lines: printed with each line break as ` | ` and each tab as ` ~ `, since every step is one
// printed line (and logcat splits a message at its breaks), and read back the same way. A step is read trimmed, so
// the expected text is trimmed too: the last contact has no number, and its line ends at the tab
const FLAT = new Set(['contacts', 'contacts-none', 'calendar-find', 'calendar-after', 'photos-newest'])
const flat = (text: string): string => text.replaceAll('\n', ' | ').replaceAll('\t', ' ~ ')

// how long the recording runs, and so how many bytes of samples its WAV must hold: 16,000 a second, two bytes each
const RECORDING = 1
const RECORDED = RECORDING * 16_000 * 2

// one call a leg makes: the step it prints under, the contract task, and its arguments, a number written as one and
// `{ read }` a name the program saved
type Call = [step: string, task: string, args: (string | number | { read: string })[]]

// the calls each leg makes, each printed once
function calls(leg: Leg): Call[] {
  const only = (when: boolean, call: Call): Call[] => (when ? [call] : [])

  return [
    ['permission-camera', 'permission-status', ['camera']],
    ['permission-microphone', 'permission-status', ['microphone']],
    ['permission-contacts', 'permission-status', ['contacts']],
    // the contacts the platform was given, and a name nobody has. Not on the Mac, whose address book is the person's
    ...only(leg !== 'macos', ['contacts', 'find-contacts', [FAMILY.toUpperCase()]]),
    ...only(leg !== 'macos', ['contacts-none', 'find-contacts', [`nobody-${process.pid}`]]),
    // the calendar: two events added, both found, the first removed, the second found alone, the first removed again
    // finding nothing, and a time that is no time. Not on the Mac, whose calendar is the person's
    ['permission-calendar', 'permission-status', ['calendar']],
    ...(leg === 'macos'
      ? []
      : ([
          ['calendar-add', 'add-event', [EVENT, utc(EVENTS.first[0]!), utc(EVENTS.first[1]!)]],
          ['calendar-kept', 'add-event', [KEPT_EVENT, plusOne(EVENTS.kept[0]!), plusOne(EVENTS.kept[1]!)]],
          ['calendar-find', 'find-events', EVENTS.span],
          ['calendar-remove', 'remove-event', [{ read: 'event-id' }]],
          ['calendar-after', 'find-events', EVENTS.span],
          ['calendar-remove-again', 'remove-event', [{ read: 'event-id' }]],
          ['calendar-invalid', 'add-event', [EVENT, 'no time at all', utc(EVENTS.first[1]!)]],
        ] satisfies Call[])),
    // the photo library: the newest photo is the one the platform was given, and its copy is a JPEG of its size. Not on
    // the Mac, whose library is the person's
    ['permission-photos', 'permission-status', ['photos']],
    ...(leg === 'macos'
      ? []
      : ([
          ['photos-newest', 'find-photos', [1]],
          ['photos-copy', 'copy-photo', [{ read: 'photo-id' }]],
          ['photos-absent', 'copy-photo', ['no-such-photo']],
        ] satisfies Call[])),
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
    // biometrics: the hardware everywhere, and the sheet itself where nobody's own face or finger would be asked
    ['biometric-kind', 'biometric-kind', []],
    ...only(leg !== 'macos', ['biometric', 'authenticate', ['Prove it is you']]),
    // the vault: kept, read back, removed, gone, and a second removal finding nothing
    ['secret-save', 'save-secret', [SECRET_NAME, SECRET]],
    ['secret-read', 'read-secret', [SECRET_NAME]],
    ['secret-remove', 'remove-secret', [SECRET_NAME]],
    ['secret-again', 'read-secret', [SECRET_NAME]],
    ['secret-remove-again', 'remove-secret', [SECRET_NAME]],
    // and one kept past the run on Android, whose preferences file is then read as root: it must hold the secret only
    // as ciphertext. Not on the Mac, where a kept item would be left in the person's login keychain
    ...only(leg === 'android' || leg === 'compose-android', ['secret-kept', 'save-secret', [`${SECRET_NAME}-kept`, SECRET]]),
    // a recording: on Android from the emulator's virtual microphone, which hears nothing of the Mac's; on the iPhone
    // simulator with no grant, since a granted one would record the Mac's own microphone. Not on the Mac, for the same
    // reason
    ...only(leg !== 'macos', ['microphone', 'record-audio', [RECORDING]]),
    ...only(leg !== 'macos' && leg !== 'compose', ['camera', 'take-photo', []]),
    // last, because it puts another app in front, and a camera does not open for an app in the background
    ...only(leg === 'android' || leg === 'compose-android', ['open-handled', 'open-address', [`tel:${PHONE}`]]),
  ]
}

// a call as the program writes it, stacked: one argument a line
const written = ([step, task, args]: Call): string =>
  [
    `      save said-${step}`,
    `        call ${task}`,
    ...args.map(arg => (typeof arg === 'number' ? `          code ${arg}` : typeof arg === 'object' ? `          read ${arg.read}` : `          text <${arg}>`)),
    ...(AFTER[step] ?? []),
    ...(FLAT.has(step)
      ? [
          `      save said-${step}`,
          '        call replace-all',
          '          call replace-all',
          `            read said-${step}`,
          '            text <\\n>',
          '            text < | >',
          '          text <\\t>',
          '          text < ~ >',
        ]
      : []),
    '      call say',
    `        text <step ${step} {said-${step}}>`,
  ].join('\n')

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

load @term/site/code/view/microphone
  find record-audio

load @term/site/code/view/contacts
  find find-contacts

load @term/site/code/view/calendar
  find add-event
  find find-events
  find remove-event

load @term/site/code/view/photos
  find find-photos
  find copy-photo

load @term/base/text
  find replace-all
  find substring
  find index-of

load @term/site/code/view/biometric
  find biometric-kind
  find authenticate

load @term/site/code/view/secret
  find save-secret
  find read-secret
  find remove-secret

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

// the emulator's serial, each Android leg's package, and the torch-on lines the camera service had logged before each
// leg ran, all kept from `prepare` for the read-backs after the run
let serial = ''
const packages: Partial<Record<Leg, string>> = {}
const torchesBefore: Partial<Record<Leg, Set<string>>> = {}

// the camera service's own record of a torch turned on, each line WITH its timestamp: its events log survives the app,
// but it is a fixed-size ring, so once full a new line pushes an old one out and a COUNT stays flat. A line the
// before-set lacks is the one this leg wrote.
const torchesLit = (): Set<string> =>
  new Set((adb(serial, 'shell', 'dumpsys', 'media.camera').stdout ?? '').match(/^.*Torch for camera id \S+ turned on.*$/gm) ?? [])
const torchLitSince = (before: Set<string> | undefined): boolean =>
  before !== undefined && [...torchesLit()].some(line => !before.has(line))

// the simulator the iOS leg ran on, for reading its calendar store afterwards
let simulator = ''

// the run's photo as a JPEG (./shared/photo-sample.ts), made once
let photoFile = ''
const photo = (): string => (photoFile ||= makePhoto(PHOTO.name))

// the photo pushed into the emulator's shared Pictures folder, then scanned, and waited for until the media provider
// holds it settled. A row `adb push` makes stays pending (`is_pending=1`), which hides it from every app but its owner:
// the app holding READ_MEDIA_IMAGES saw no image at all until the scanner read the file
function pushPhoto(on: string): void {
  const where = `/storage/emulated/0/Pictures/${PHOTO.name}`
  spawnSync(androidTools().adb, ['-s', on, 'push', photo(), where])
  adb(on, 'shell', 'am', 'broadcast', '-a', 'android.intent.action.MEDIA_SCANNER_SCAN_FILE', '-d', `file://${where}`)

  for (let turn = 0; turn < 20; turn++) {
    const row = adb(on, 'shell', 'content', 'query', '--uri', 'content://media/external/images/media', '--projection', 'is_pending', '--where', `"_display_name='${PHOTO.name}'"`).stdout ?? ''

    if (row.includes('is_pending=0')) return

    spawnSync('sleep', ['0.5'])
  }
}

// this run's events as the platform's own store holds them, `title start end` in milliseconds, joined by ` | `: the
// provider on the emulator, read through `content query` (an event deleted by an app is marked deleted until a sync
// adapter purges it, so only live ones are read), and the simulator's Calendar.sqlitedb, read-only, whose times are
// seconds since 2001
function storedEvents(leg: Leg): string {
  if (leg === 'ios') {
    const store = join(process.env.HOME ?? '', 'Library/Developer/CoreSimulator/Devices', simulator, 'data/Library/Calendar/Calendar.sqlitedb')
    const rows = spawnSync('sqlite3', ['-readonly', '-separator', ' ', store, `select summary, start_date, end_date from CalendarItem where summary like '${EVENT}%' order by start_date`], { encoding: 'utf8' })
    const since2001 = (seconds: string) => String(Math.round((Number(seconds) + 978_307_200) * 1000))

    return (rows.stdout ?? rows.stderr ?? '')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const parts = line.split(' ')
        const [start = '', end = ''] = parts.slice(-2)

        return `${parts.slice(0, -2).join(' ')} ${since2001(start)} ${since2001(end)}`
      })
      .join(' | ')
  }

  const rows = adb(serial, 'shell', 'content', 'query', '--uri', 'content://com.android.calendar/events', '--projection', 'title:dtstart:dtend', '--where', `"title LIKE '${EVENT}%' AND deleted=0"`).stdout ?? ''

  return [...rows.matchAll(/title=(.*?), dtstart=(\d+), dtend=(\d+)/g)].map(([, title, start, end]) => `${title} ${start} ${end}`).join(' | ')
}

// the raw contacts this run wrote on the emulator, removed again once the run is over
const contactRows: string[] = []

// each contact as the provider takes one with no account: a raw contact, then its name row and its phone row bound to
// it. `adb shell` hands the device's shell one line, so a value holding a space is quoted for it
function addContacts(on: string): void {
  if (contactRows.length > 0) return

  for (const one of PEOPLE) {
    adb(on, 'shell', 'content', 'insert', '--uri', 'content://com.android.contacts/raw_contacts', '--bind', 'account_name:n:', '--bind', 'account_type:n:')
    const rows = adb(on, 'shell', 'content', 'query', '--uri', 'content://com.android.contacts/raw_contacts', '--projection', '_id', '--sort', "'_id DESC'").stdout ?? ''
    const id = /_id=(\d+)/.exec(rows)?.[1]

    if (!id) continue

    contactRows.push(id)
    const data = (...binds: string[]) =>
      adb(on, 'shell', 'content', 'insert', '--uri', 'content://com.android.contacts/data', '--bind', `raw_contact_id:i:${id}`, ...binds.flatMap(bind => ['--bind', bind]))
    data('mimetype:s:vnd.android.cursor.item/name', `'data1:s:${one.given} ${FAMILY}'`, `data2:s:${one.given}`, `data3:s:${FAMILY}`)

    if (one.number) data('mimetype:s:vnd.android.cursor.item/phone_v2', `data1:s:${one.number}`, 'data2:i:2')
  }
}

function prepare(leg: Leg, target: { udid?: string; serial?: string; identifier: string }): void {
  if (leg === 'ios' && target.udid) {
    simulator = target.udid

    for (const service of ['location', 'camera', 'calendar']) {
      spawnSync('xcrun', ['simctl', 'privacy', target.udid, 'grant', service, target.identifier])
    }

    // never asked, so the recording must answer not-determined and never reach the Mac's microphone
    spawnSync('xcrun', ['simctl', 'privacy', target.udid, 'reset', 'microphone', target.identifier])

    // the two contacts, as one vCard file, into the simulator's address book, and the grant to read it
    const cards = PEOPLE.map(one =>
      ['BEGIN:VCARD', 'VERSION:3.0', `N:${FAMILY};${one.given};;;`, `FN:${one.given} ${FAMILY}`, ...(one.number ? [`TEL;TYPE=CELL:${one.number}`] : []), 'END:VCARD'].join('\r\n'),
    )
    const vcard = join(mkdtempSync(join(tmpdir(), 'term-contacts-')), 'people.vcf')
    writeFileSync(vcard, `${cards.join('\r\n')}\r\n`)
    spawnSync('xcrun', ['simctl', 'addmedia', target.udid, vcard])
    spawnSync('xcrun', ['simctl', 'privacy', target.udid, 'grant', 'contacts', target.identifier])
    // the photo library grant, which on iOS 26 lands in TCC.db and is not read by PhotoKit (photos-prompt.ts taps the
    // real prompt instead): the leg shows the honest answer to the grant as simctl gives it
    spawnSync('xcrun', ['simctl', 'privacy', target.udid, 'grant', 'photos', target.identifier])

    spawnSync('xcrun', ['simctl', 'location', target.udid, 'set', `${PLACE.latitude},${PLACE.longitude}`])

    // a face enrolled, as Features > Face ID > Enrolled does, then a match signaled every second while the app's sheet
    // waits, as Features > Face ID > Matching Face does, until this test has gone
    const notify = (...args: string[]) => spawnSync('xcrun', ['simctl', 'spawn', target.udid!, 'notifyutil', ...args])
    notify('-s', 'com.apple.BiometricKit.enrollmentChanged', '1')
    notify('-p', 'com.apple.BiometricKit.enrollmentChanged')
    const script = `
      const { spawnSync } = require('node:child_process')
      const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
      for (let turn = 0; turn < 120 && alive(${process.pid}); turn++) {
        spawnSync('xcrun', ['simctl', 'spawn', ${JSON.stringify(target.udid)}, 'notifyutil', '-p', 'com.apple.BiometricKit_Sim.pearl.match'])
        spawnSync('sleep', ['1'])
      }`
    spawn(process.execPath, ['-e', script], { detached: true, stdio: 'ignore' }).unref()
  }

  if ((leg === 'android' || leg === 'compose-android') && target.serial) {
    serial = target.serial
    packages[leg] = target.identifier

    for (const permission of ['CAMERA', 'RECORD_AUDIO', 'READ_CONTACTS', 'READ_CALENDAR', 'WRITE_CALENDAR', 'READ_MEDIA_IMAGES', 'ACCESS_FINE_LOCATION', 'POST_NOTIFICATIONS']) {
      adb(target.serial, 'shell', 'pm', 'grant', target.identifier, `android.permission.${permission}`)
    }

    addContacts(target.serial)
    pushPhoto(target.serial)

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
  for (const name of ['camera', 'microphone', 'location', 'notification']) {
    ok(`${named}: the ${name} grant reads one of the five statuses`, STATUSES.includes(said(`permission-${name}`)), said(`permission-${name}`))
  }

  if (leg === 'compose') {
    ok(`${named}: a desktop JVM has no grants to give`, ['camera', 'microphone', 'location', 'notification'].every(name => said(`permission-${name}`) === 'unavailable'))
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
    ok(`${named}: and the camera service logged it turned on`, torchLitSince(torchesBefore[leg]), `${torchesBefore[leg]?.size ?? 'none'} lines before`)
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

  if (android) {
    ok(`${named}: an address an app handles is opened`, said('open-handled') === 'opened', said('open-handled'))
    const resumed = (adb(serial, 'shell', 'dumpsys', 'activity', 'activities').stdout ?? '').split('\n').filter(line => /ResumedActivity/.test(line)).join(' ')
    ok(`${named}: and the phone app is the one in front`, /dialer/i.test(resumed), resumed.slice(0, 300))
    // the phone app out of the way of the next leg
    adb(serial, 'shell', 'input', 'keyevent', 'KEYCODE_HOME')
  }

  // motion
  if (android) {
    ok(`${named}: the acceleration is the one the emulator was told`, said('motion') === ACCELERATION.join(' '), said('motion'))
  } else {
    ok(`${named}: no accelerometer here, said so`, said('motion') === 'unavailable', said('motion'))
  }

  // biometrics
  if (android) {
    ok(`${named}: the emulator has fingerprint hardware, and nothing enrolled`, said('biometric-kind') === 'fingerprint' && said('biometric') === 'not-enrolled', `${said('biometric-kind')} ${said('biometric')}`)
  } else if (leg === 'compose') {
    ok(`${named}: a desktop JVM has no biometric, said both ways`, said('biometric-kind') === 'unavailable' && said('biometric') === 'unavailable', `${said('biometric-kind')} ${said('biometric')}`)
  } else if (leg === 'macos') {
    ok(`${named}: the Mac names its hardware without asking anything`, ['fingerprint', 'none'].includes(said('biometric-kind')), said('biometric-kind'))
  } else {
    ok(`${named}: the simulator's face was enrolled and matched, so the sheet answers passed`, said('biometric-kind') === 'face' && said('biometric') === 'passed', `${said('biometric-kind')} ${said('biometric')}`)
  }

  // the vault
  const vault = ['secret-save', 'secret-read', 'secret-remove', 'secret-again', 'secret-remove-again'].map(said)

  if (leg === 'compose') {
    ok(`${named}: a desktop JVM has no vault, and says so`, vault.join('|') === 'unavailable||unavailable||unavailable', vault.join('|'))
  } else {
    ok(`${named}: a secret is kept, read back, removed, gone, and a second removal finds nothing`, vault.join('|') === `saved|${SECRET}|removed||absent`, vault.join('|'))
  }

  if (leg === 'macos' && process.platform === 'darwin') {
    // asked without -w, so the keychain answers whether the item is there and is never asked for its value
    const left = spawnSync('security', ['find-generic-password', '-s', 'term', '-a', SECRET_NAME], { encoding: 'utf8' })
    ok(`${named}: and the login keychain holds nothing under the name afterwards`, left.status !== 0, `${left.status} ${left.stdout.slice(0, 200)}`)
  }

  if (android) {
    ok(`${named}: the kept secret saves`, said('secret-kept') === 'saved', said('secret-kept'))
    const file = adb(serial, 'shell', 'su', '0', 'cat', `/data/data/${packages[leg] ?? '?'}/shared_prefs/term-secret.xml`).stdout ?? ''
    ok(`${named}: and the app's preferences hold it, but only as ciphertext`, file.includes(`${SECRET_NAME}-kept`) && !file.includes(SECRET), file.slice(0, 300))
  }

  // camera
  if (android) {
    const where = said('camera').replace(/^photo /, '')
    const bytes = said('camera').startsWith('photo ') ? spawnSync(androidTools().adb, ['-s', serial, 'exec-out', 'cat', where]).stdout : Buffer.alloc(0)
    ok(`${named}: the camera takes a photo, a JPEG on the device`, bytes.length > 1000 && bytes[0] === 0xff && bytes[1] === 0xd8, `${said('camera')}, ${bytes.length} bytes`)
  } else if (leg === 'ios') {
    ok(`${named}: the simulator has no camera, said so`, said('camera') === 'unavailable', said('camera'))
  }

  // contacts
  if (leg === 'ios' || android) {
    ok(`${named}: the contacts grant the platform was given reads granted`, said('permission-contacts') === 'granted', said('permission-contacts'))
    ok(`${named}: the two contacts the platform was given are found, sorted, the one with no number ending at its tab`, said('contacts') === flat(FOUND).trim(), said('contacts'))
    ok(`${named}: a name nobody has finds none`, said('contacts-none') === 'none', said('contacts-none'))
  } else if (leg === 'compose') {
    ok(`${named}: a desktop JVM has no address book, said so`, said('contacts') === 'unavailable' && said('permission-contacts') === 'unavailable', `${said('contacts')} ${said('permission-contacts')}`)
  } else {
    ok(`${named}: the contacts grant reads one of the five statuses`, STATUSES.includes(said('permission-contacts')), said('permission-contacts'))
  }

  // calendar
  const calendar = ['calendar-add', 'calendar-kept', 'calendar-find', 'calendar-remove', 'calendar-after', 'calendar-remove-again', 'calendar-invalid'].map(said)

  if (leg === 'ios' || android) {
    const [added, kept, found, removed, after, again, invalid] = calendar
    const keptOnly = flat(BOTH_EVENTS.split('\n')[1]!)
    ok(`${named}: the calendar grant the platform was given reads granted`, said('permission-calendar') === 'granted', said('permission-calendar'))
    ok(`${named}: both events are added, each with the platform's identifier`, /^added \S/.test(added ?? '') && /^added \S/.test(kept ?? ''), `${added} | ${kept}`)
    ok(`${named}: both are found in the span, in UTC, the +01:00 one too, sorted by start`, found === flat(BOTH_EVENTS), found)
    ok(`${named}: the first is removed, the second then found alone, and the first is absent the second time`, removed === 'removed' && after === keptOnly && again === 'absent', `${removed} | ${after} | ${again}`)
    ok(`${named}: a time that is no time is invalid`, invalid === 'invalid', invalid)
    const stored = storedEvents(leg)
    ok(`${named}: and the platform's own store holds the kept event at its times, and not the removed one`, stored === `${KEPT_EVENT} ${EVENTS.kept[0]} ${EVENTS.kept[1]}`, stored)
  } else if (leg === 'compose') {
    ok(`${named}: a desktop JVM has no calendar, said by every task`, calendar.every(one => one === 'unavailable') && said('permission-calendar') === 'unavailable', calendar.join(' | '))
  } else {
    ok(`${named}: the calendar grant reads one of the five statuses`, STATUSES.includes(said('permission-calendar')), said('permission-calendar'))
  }

  // photo library
  if (leg === 'ios') {
    // simctl's grant reaches TCC.db and not PhotoKit, so every task answers as an app never asked would. The grant
    // given through the prompt, and the read after it, are photos-prompt.ts
    const photos = ['permission-photos', 'photos-newest', 'photos-copy'].map(said)
    ok(`${named}: the photo library, never asked through PhotoKit, says not-determined from every task`, photos.every(one => one === 'not-determined'), photos.join(' | '))
  } else if (android) {
    ok(`${named}: the photo library grant the platform was given reads granted`, said('permission-photos') === 'granted', said('permission-photos'))
    const fields = said('photos-newest').split(' ~ ')
    ok(
      `${named}: the newest photo is the one the platform was given, by its size, with a UTC time`,
      fields.length === 3 && fields[0] !== '' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(fields[1] ?? '') && fields[2] === `${PHOTO.width}x${PHOTO.height}`,
      said('photos-newest'),
    )
    const where = said('photos-copy').replace(/^photo /, '')
    const bytes = said('photos-copy').startsWith('photo ') ? spawnSync(androidTools().adb, ['-s', serial, 'exec-out', 'cat', where]).stdout : Buffer.alloc(0)
    const size = jpegSize(bytes)
    ok(`${named}: and its copy is a JPEG of that size`, size?.width === PHOTO.width && size?.height === PHOTO.height, `${said('photos-copy')}, ${JSON.stringify(size)} from ${bytes.length} bytes`)
    ok(`${named}: an identifier no photo has is absent`, said('photos-absent') === 'absent', said('photos-absent'))
  } else if (leg === 'compose') {
    ok(`${named}: a desktop JVM has no photo library, said so`, said('photos-newest') === 'unavailable' && said('photos-copy') === 'unavailable', `${said('photos-newest')} ${said('photos-copy')}`)
  } else {
    ok(`${named}: the photo library grant reads one of the five statuses`, STATUSES.includes(said('permission-photos')), said('permission-photos'))
  }

  // microphone
  if (android) {
    ok(`${named}: the microphone grant the emulator was given reads granted`, said('permission-microphone') === 'granted', said('permission-microphone'))
    const where = said('microphone').replace(/^audio /, '')
    const bytes = said('microphone').startsWith('audio ') ? spawnSync(androidTools().adb, ['-s', serial, 'exec-out', 'cat', where]).stdout : Buffer.alloc(0)
    const wave = readWave(bytes)
    ok(
      `${named}: the recording is a WAV of 16-bit PCM, mono, 16,000 a second, ${RECORDING} second long`,
      wave !== undefined && wave.format === 1 && wave.channels === 1 && wave.rate === 16_000 && wave.bits === 16 && wave.data === RECORDED,
      `${said('microphone')}, ${JSON.stringify(wave)} from ${bytes.length} bytes`,
    )
  } else if (leg === 'ios') {
    ok(
      `${named}: never asked, so the recording says so and hears nothing`,
      said('permission-microphone') === 'not-determined' && said('microphone') === 'not-determined',
      `${said('permission-microphone')} ${said('microphone')}`,
    )
  } else if (leg === 'compose') {
    ok(`${named}: a desktop JVM records nothing, said so`, said('microphone') === 'unavailable', said('microphone'))
  }
}

// a WAV's header, read field by field from its RIFF chunks, and the loudest sample, so a silent recording is told
// apart from a missing one in the failure line. Undefined when the bytes are not a WAV
function readWave(bytes: Buffer): { format: number; channels: number; rate: number; bits: number; data: number; peak: number } | undefined {
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') return undefined

  let at = 12
  let format: { format: number; channels: number; rate: number; bits: number } | undefined

  while (at + 8 <= bytes.length) {
    const id = bytes.toString('ascii', at, at + 4)
    const size = bytes.readUInt32LE(at + 4)

    if (id === 'fmt ') {
      format = { format: bytes.readUInt16LE(at + 8), channels: bytes.readUInt16LE(at + 10), rate: bytes.readUInt32LE(at + 12), bits: bytes.readUInt16LE(at + 22) }
    } else if (id === 'data' && format) {
      let peak = 0

      for (let one = at + 8; one + 1 < Math.min(bytes.length, at + 8 + size); one += 2) peak = Math.max(peak, Math.abs(bytes.readInt16LE(one)))

      return { ...format, data: Math.min(size, bytes.length - at - 8), peak }
    }

    at += 8 + size + (size % 2)
  }

  return undefined
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

  // the emulator's battery back to its own reading, and the contacts this run wrote removed
  if (serial) {
    adb(serial, 'shell', 'dumpsys', 'battery', 'reset')

    for (const id of contactRows) {
      adb(serial, 'shell', 'content', 'delete', '--uri', 'content://com.android.contacts/raw_contacts', '--where', `'_id=${id}'`)
    }

    adb(serial, 'shell', 'content', 'delete', '--uri', 'content://com.android.calendar/events', '--where', `"title LIKE '${EVENT}%'"`)
    // the photo, through the media provider, which removes its file with its row
    adb(serial, 'shell', 'content', 'delete', '--uri', 'content://media/external/images/media', '--where', `"_display_name='${PHOTO.name}'"`)
  }
}

console.log(`\ndevice-features: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
