// The device watchers on the toolkit hosts (device-layer-0016): `watch-position`, `watch-battery`, `watch-network` and
// `watch-motion`, each with a handler that is told the current value first and then each change the platform reports.
// The app says each answer that differs from the one before, and exits once every watcher this platform can change has
// answered twice with two different values, and every other one has answered once.
//
// What changes them is the platform, told from here: a second Node process, detached, alternates the emulator's place
// (`emu geo fix`), battery level (`dumpsys battery set level`) and acceleration (`emu sensor set acceleration`), and the
// simulator's place (`simctl location set`), every two seconds until this test has gone. So a second answer is one the
// platform reported, not one the app asked for again.
//
//   android, compose-android   position, battery and motion change; the network answers once
//   ios                        the position changes; the battery, network and motion answer once
//   macos, compose             the battery, network and motion answer once. No position on the Mac, as in
//                              device-features: it would be the person's own
//
// WATCH_ONLY=android (or ios, macos, compose, compose-android) runs one. Run: npx tsx test/compile/device-watch.ts
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

// the two of each the platform is told, in turn: two places in Paris, two battery levels, two accelerations
const PLACES = [
  ['48.858370', '2.294481'],
  ['48.860611', '2.337644'],
]
const LEVELS = [42, 57]
const ACCELERATIONS = [
  ['1.50', '2.50', '9.50'],
  ['0.50', '3.50', '8.50'],
]

const android = (leg: Leg): boolean => leg === 'android' || leg === 'compose-android'

// each watcher a leg starts, what it watches, whether the platform here is made to change it, and whether the app drops
// it the moment it has started
type Watcher = { name: string; task: string; changes: boolean; dropped?: boolean }

// The second battery watcher shares the first one's subscription and must hear every change too. The dropped motion
// watcher is dropped as soon as it is made, so it may hear the value that was current then and nothing after
function watchers(leg: Leg): Watcher[] {
  return [
    ...(leg === 'macos' ? [] : [{ name: 'position', task: 'watch-position', changes: leg === 'ios' || android(leg) }]),
    { name: 'battery', task: 'watch-battery', changes: android(leg) },
    { name: 'battery-again', task: 'watch-battery', changes: android(leg) },
    { name: 'network', task: 'watch-network', changes: false },
    { name: 'motion', task: 'watch-motion', changes: android(leg) },
    { name: 'motion-dropped', task: 'watch-motion', changes: false, dropped: true },
  ]
}

// what a watcher's answers are, read off its task
const kind = (watcher: Watcher): string => watcher.task.replace(/^watch-/, '')

// the app's own test of done: every watcher that changes has changed, every other one has been heard, written as nested
// forks ending in the exit
function finished(list: Watcher[], depth: string): string {
  const [first, ...rest] = list

  if (!first) {
    return `${depth}call exit-app\n${depth}  code 0`
  }

  return [
    `${depth}fork test`,
    `${depth}  hook test`,
    `${depth}    call is-equal`,
    `${depth}      call read-signal`,
    `${depth}        bind self, read ${first.changes ? 'changed' : 'seen'}-${first.name}`,
    `${depth}      text <yes>`,
    `${depth}  hook hold`,
    finished(rest, `${depth}    `),
    `${depth}  hook miss`,
    `${depth}    save waiting, code 0`,
  ].join('\n')
}

// one watch, whose handler says a new answer, marks it seen or changed, and asks whether every watcher is done
function written(watcher: Watcher, list: Watcher[]): string {
  const { name, task } = watcher

  return [
    `      save drop-${name}`,
    `        call ${task}`,
    '          task heard',
    '            take value, like text',
    '            fork test',
    '              hook test',
    '                call is-equal',
    '                  call read-signal',
    `                    bind self, read last-${name}`,
    '                  read value',
    '              hook hold',
    '                save same, code 0',
    '              hook miss',
    '                call write-signal',
    `                  bind self, read last-${name}`,
    '                  bind value, read value',
    '                call say',
    `                  text <step watch-${name} {value}>`,
    '                fork test',
    '                  hook test',
    '                    call is-equal',
    '                      call read-signal',
    `                        bind self, read seen-${name}`,
    '                      text <yes>',
    '                  hook hold',
    '                    call write-signal',
    `                      bind self, read changed-${name}`,
    '                      bind value, text <yes>',
    '                  hook miss',
    '                    call write-signal',
    `                      bind self, read seen-${name}`,
    '                      bind value, text <yes>',
    finished(list.filter(one => !one.dropped), '                '),
    ...(watcher.dropped ? [`      call drop-${name}`] : []),
  ].join('\n')
}

// every watcher's signals made before any watch starts, since a handler may be told at once and reads all of them
function program(leg: Leg, _shot: string): string {
  const list = watchers(leg)
  const signals = list.flatMap(({ name }) => ['last', 'seen', 'changed'].map(kind => `${kind}-${name}`))
  const made = signals.map(name => [`      save ${name}`, '        call make-signal', '          bind value, text <none>'].join('\n'))
  const watches = list.map(watcher => written(watcher, list))

  return `load @term/site/code/view/reactive
  find make-signal
  find read-signal
  find write-signal

load @term/site/code/dom/native/toolkit/dom
  find open-root
  find launch
  find run-app
  find exit-app
  find say

load @term/site/code/view/location
  find watch-position

load @term/site/code/view/battery
  find watch-battery

load @term/site/code/view/network
  find watch-network

load @term/site/code/view/motion
  find watch-motion

task main
  save root
    call open-root
      text <Term watch>
      code 320
      code 200
  call launch
    task check
      mark async
${made.join('\n')}
${watches.join('\n')}
      call say
        text <step watching all>
  call run-app
`
}

// every answer one watcher gave, in order
function answers(output: string, name: string): string[] {
  const at = `step watch-${name} `

  return output
    .split('\n')
    .filter(line => line.includes(at))
    .map(line => line.slice(line.indexOf(at) + at.length).trim())
}

const adb = (serial: string, ...args: string[]) => spawnSync(androidTools().adb, ['-s', serial, ...args], { encoding: 'utf8' })

// the emulator's serial, kept for the battery reset after the run
let serial = ''

// The changer: a detached Node process telling the platform the next place, level and acceleration every two seconds,
// until this test's own process is gone. From this machine, as the permission prompt's tapper is
function prepare(leg: Leg, target: { udid?: string; serial?: string; identifier: string }): void {
  if (leg === 'ios' && target.udid) {
    spawnSync('xcrun', ['simctl', 'privacy', target.udid, 'grant', 'location', target.identifier])
  }

  if (android(leg) && target.serial) {
    serial = target.serial
    adb(target.serial, 'shell', 'pm', 'grant', target.identifier, 'android.permission.ACCESS_FINE_LOCATION')
    adb(target.serial, 'shell', 'dumpsys', 'battery', 'unplug')
    adb(target.serial, 'shell', 'dumpsys', 'battery', 'set', 'status', '3')
  }

  if (!target.udid && !target.serial) {
    return
  }

  const script = `
    const { spawnSync } = require('node:child_process')
    const adb = ${JSON.stringify(androidTools().adb)}
    const serial = ${JSON.stringify(target.serial ?? '')}
    const udid = ${JSON.stringify(target.udid ?? '')}
    const places = ${JSON.stringify(PLACES)}
    const levels = ${JSON.stringify(LEVELS)}
    const accelerations = ${JSON.stringify(ACCELERATIONS)}
    const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
    for (let turn = 0; turn < 150 && alive(${process.pid}); turn++) {
      const at = turn % 2
      if (serial) {
        spawnSync(adb, ['-s', serial, 'emu', 'geo', 'fix', places[at][1], places[at][0]])
        spawnSync(adb, ['-s', serial, 'shell', 'dumpsys', 'battery', 'set', 'level', String(levels[at])])
        spawnSync(adb, ['-s', serial, 'emu', 'sensor', 'set', 'acceleration', accelerations[at].join(':')])
      }
      if (udid) {
        spawnSync('xcrun', ['simctl', 'location', udid, 'set', places[at].join(',')])
      }
      spawnSync('sleep', ['2'])
    }
    if (serial) {
      spawnSync(adb, ['-s', serial, 'shell', 'dumpsys', 'battery', 'reset'])
    }`
  spawn(process.execPath, ['-e', script], { detached: true, stdio: 'ignore' }).unref()
}

const near = (said: string, [latitude, longitude]: string[]): boolean => {
  const [a = '', b = ''] = said.split(' ')

  return Math.abs(Number(a) - Number(latitude)) < 0.0005 && Math.abs(Number(b) - Number(longitude)) < 0.0005
}

function judge(leg: Leg, toolkit: string, output: string): void {
  const named = `${leg} (${toolkit})`

  for (const watcher of watchers(leg)) {
    const { name, changes } = watcher
    const heard = answers(output, name)

    if (watcher.dropped) {
      ok(`${named}: the ${name} watcher hears nothing after its drop`, heard.length <= 1, heard.join(' | '))
      continue
    }

    if (!changes) {
      ok(`${named}: the ${name} watcher answers`, heard.length >= 1, heard.join(' | ') || output.slice(-400))
      continue
    }

    ok(`${named}: the ${name} watcher heard the platform change it`, new Set(heard).size >= 2, heard.join(' | ') || output.slice(-400))

    // and every answer after the first is one this test told the platform
    const told = heard.slice(1).every(said => {
      if (kind(watcher) === 'position') {
        return PLACES.some(place => near(said, place))
      }

      if (kind(watcher) === 'battery') {
        return LEVELS.some(level => said === `${(level / 100).toFixed(2)} unplugged`)
      }

      return ACCELERATIONS.some(acceleration => said === acceleration.join(' '))
    })
    ok(`${named}: and each change is one the platform was told`, told, heard.join(' | '))
  }

  for (const watcher of watchers(leg)) {
    const { name, changes } = watcher
    const [first = ''] = answers(output, name)

    if (changes || watcher.dropped) {
      continue
    }

    if (kind(watcher) === 'network') {
      ok(`${named}: the ${name} watcher's first answer is online`, /^online (wifi|cellular|wired|other)$/.test(first), first)
    } else if (kind(watcher) === 'motion') {
      ok(`${named}: no accelerometer here, the ${name} watcher said so once`, first === 'unavailable', first)
    } else if (kind(watcher) === 'battery') {
      ok(`${named}: the ${name} watcher answers in the contract's shape`, /^(\d\.\d\d|unknown) (charging|full|unplugged|unknown)$|^unavailable$/.test(first), first)
    } else {
      ok(`${named}: the ${name} watcher answers once`, first !== '', first)
    }
  }
}

try {
  runToolkits(
    {
      root: process.cwd(),
      dir: mkdtempSync(join(tmpdir(), 'term-watch-')),
      name: 'Watch',
      iosIdentifier: 'surf.term.device-watch-test',
      androidIdentifier: 'surf.term.devicewatch',
      program,
      judge,
      ok,
      shots: {},
      compose: true,
      composeAndroid: true,
      prepare,
    },
    process.env.WATCH_ONLY ?? '',
  )
} finally {
  if (serial) {
    adb(serial, 'shell', 'dumpsys', 'battery', 'reset')
  }
}

console.log(`\ndevice-watch: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
