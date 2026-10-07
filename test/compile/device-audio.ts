// The audio module (beat-term-0001) on AppKit (macOS) and UIKit (the iPhone simulator): one program calls every task of
// site/code/view/audio.tree and prints each answer as `step <name> <answer>`, judged here against what the platform can
// answer. Nothing sounds: the loop and the player run at volume 0, so the engine renders and keeps time while the
// person's speakers stay quiet. The witnesses are the platform's own:
//
//   length     a 3 second, 44.1 kHz WAV this test writes, whose length AVAudioFile reads from its frames
//   the loop   two half-second segments, a one-second round: the watcher must hear `wrap 1` and `wrap 2` a round apart
//              by the wall clock, and the place the engine's own render clock reports must fall inside a segment
//   volume     held to 0 through 100, as the node took it
//   edges      a segment past the end of the file is invalid, a file that is not there unavailable, and stopping and
//              restarting answer what they did
//   the queue  two half-second files at volume 0, each `playing` as it starts and `done` about a second after the first
//   recording  the grant only: on the simulator never asked, so not-determined; the Mac is not asked at all, since a
//              grant its terminal holds would record the person's own microphone
//
// The files go where the app reads its temporary folder: the app's own container on the simulator
// (`simctl get_app_container`), the Mac's temporary folder for the AppKit program. AUDIO_ONLY=macos or ios runs one.
// Run: npx tsx test/compile/device-audio.ts
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
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

// the two files, named for this run so an earlier run's cannot answer for this one
const TONE = `term-audio-tone-${process.pid}.wav`
const SHORT = `term-audio-short-${process.pid}.wav`
const RATE = 44_100

// a 440 Hz sine at a quarter of full scale, `seconds` long, as a 16-bit mono WAV
function sine(seconds: number): Buffer {
  const count = Math.round(RATE * seconds)
  const out = Buffer.alloc(44 + count * 2)
  out.write('RIFF', 0, 'ascii')
  out.writeUInt32LE(36 + count * 2, 4)
  out.write('WAVEfmt ', 8, 'ascii')
  out.writeUInt32LE(16, 16)
  out.writeUInt16LE(1, 20)
  out.writeUInt16LE(1, 22)
  out.writeUInt32LE(RATE, 24)
  out.writeUInt32LE(RATE * 2, 28)
  out.writeUInt16LE(2, 32)
  out.writeUInt16LE(16, 34)
  out.write('data', 36, 'ascii')
  out.writeUInt32LE(count * 2, 40)

  for (let index = 0; index < count; index++) out.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * index) / RATE) * 8000), 44 + index * 2)

  return out
}

function writeFiles(dir: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, TONE), sine(3))
  writeFileSync(join(dir, SHORT), sine(0.5))
}

// each step the program prints, its task call stacked one argument a line
const say = (step: string): string[] => ['      call say', `        text <step ${step} {said-${step}}>`]

const program = (leg: Leg, _shot: string): string => `load @term/site/code/dom/native/toolkit/dom
  find open-root
  find launch
  find run-app
  find exit-app
  find say

load @term/site/code/view/audio
  find audio-segment
  find start-loop
  find stop-loop
  find restart-loop
  find set-loop-volume
  find loop-state
  find watch-loop
  find play-audio
  find stop-audio
  find watch-playback
  find start-recording
  find stop-recording
  find watch-recording
  find audio-length

load @term/base/environment/path
  find known-directory

load @term/base/clock
  find now
  find sleep

load @term/base/list
  find list
  find push
  find join

task main
  save root
    call open-root
      text <Term audio>
      code 320
      code 200
  call launch
    task check
      mark async
      save folder
        call known-directory
          text <temporary>
      save tone, text <{folder}/${TONE}>
      save short, text <{folder}/${SHORT}>
      save said-length
        call audio-length
          read tone
${say('length').join('\n')}
      # the loop's events, each with the wall clock's millisecond beside it
      save heard-loop
        make list
      save drop-loop
        call watch-loop
          task heard
            take value, like text
            call push
              bind list, read heard-loop
              bind item, text <{value}@{now()}>
      save spans
        make list
      call push
        bind list, read spans
        bind item
          make audio-segment
            bind start, code 500
            bind end, code 1000
      call push
        bind list, read spans
        bind item
          make audio-segment
            bind start, code 2000
            bind end, code 2500
      save said-started
        call start-loop
          read tone
          read spans
          code 0
${say('started').join('\n')}
      call sleep
        code 2600
      save said-state
        call loop-state
${say('state').join('\n')}
      save said-louder
        call set-loop-volume
          code 150
${say('louder').join('\n')}
      save said-quieter
        call set-loop-volume
          code -5
${say('quieter').join('\n')}
      save said-restarted
        call restart-loop
${say('restarted').join('\n')}
      save said-stopped
        call stop-loop
${say('stopped').join('\n')}
      save said-state-after
        call loop-state
${say('state-after').join('\n')}
      save said-restart-stopped
        call restart-loop
${say('restart-stopped').join('\n')}
      save said-heard-loop
        call join
          read heard-loop
          text <,>
${say('heard-loop').join('\n')}
      call drop-loop
      save past
        make list
      call push
        bind list, read past
        bind item
          make audio-segment
            bind start, code 5000
            bind end, code 6000
      save said-invalid
        call start-loop
          read tone
          read past
          code 0
${say('invalid').join('\n')}
      save said-missing
        call start-loop
          text <{folder}/no-such-${process.pid}.wav>
          read spans
          code 0
${say('missing').join('\n')}
      # the queue: two short files, back to back
      save heard-playback
        make list
      save drop-playback
        call watch-playback
          task heard
            take value, like text
            call push
              bind list, read heard-playback
              bind item, text <{value}@{now()}>
      save queue
        make list
      call push
        bind list, read queue
        bind item, read short
      call push
        bind list, read queue
        bind item, read short
      save said-playing
        call play-audio
          read queue
          code 0
${say('playing').join('\n')}
      call sleep
        code 1600
      save said-heard-playback
        call join
          read heard-playback
          text <,>
${say('heard-playback').join('\n')}
      call drop-playback
      save gone
        make list
      call push
        bind list, read gone
        bind item, text <{folder}/no-such-${process.pid}.wav>
      save said-play-missing
        call play-audio
          read gone
          code 0
${say('play-missing').join('\n')}
      save said-play-stopped
        call stop-audio
${say('play-stopped').join('\n')}
      # the microphone's grant, and an idle recorder
      save heard-recording
        make list
      save drop-recording
        call watch-recording
          task heard
            take value, like text
            call push
              bind list, read heard-recording
              bind item, read value
${
  leg === 'ios'
    ? ['      save said-record', '        call start-recording', '          text <{folder}/term-take.m4a>', ...say('record')].join('\n')
    : ''
}
      save said-record-stopped
        call stop-recording
${say('record-stopped').join('\n')}
      save said-heard-recording
        call join
          read heard-recording
          text <,>
${say('heard-recording').join('\n')}
      call drop-recording
      call exit-app
        code 0
  call run-app
`

function step(output: string, name: string): string {
  const line = output.split('\n').find(l => l.includes(`step ${name} `)) ?? ''

  return line.slice(line.indexOf(`step ${name} `) + `step ${name} `.length).trim()
}

// `value@ms` events, split
const events = (said: string): { value: string; at: number }[] =>
  said
    .split(',')
    .filter(Boolean)
    .map(one => {
      const at = one.lastIndexOf('@')

      return { value: one.slice(0, at), at: Number(one.slice(at + 1)) }
    })

function prepare(leg: Leg, target: { udid?: string; identifier: string }): void {
  if (leg === 'ios' && target.udid) {
    const container = spawnSync('xcrun', ['simctl', 'get_app_container', target.udid, target.identifier, 'data'], { encoding: 'utf8' }).stdout.trim()
    writeFiles(join(container, 'tmp'))
    // never asked, so the recorder answers not-determined and never reaches the Mac's microphone
    spawnSync('xcrun', ['simctl', 'privacy', target.udid, 'reset', 'microphone', target.identifier])
  }
}

function judge(leg: Leg, toolkit: string, output: string): void {
  const said = (name: string) => step(output, name)
  const named = `${leg} (${toolkit})`

  ok(`${named}: the file's length, read from its frames, is 3000 ms`, Math.abs(Number(said('length')) - 3000) <= 1, said('length'))
  ok(`${named}: the loop starts`, said('started') === 'looping', said('started'))

  const loop = events(said('heard-loop'))
  const started = loop.find(one => one.value === 'looping')
  const wraps = loop.filter(one => one.value.startsWith('wrap '))
  ok(`${named}: the watcher hears the loop stopped, then looping`, loop[0]?.value === 'stopped' && started !== undefined, said('heard-loop'))
  ok(`${named}: and wraps 1 and 2, in order`, wraps[0]?.value === 'wrap 1' && wraps[1]?.value === 'wrap 2', said('heard-loop'))

  const first = (wraps[0]?.at ?? 0) - (started?.at ?? 0)
  const second = (wraps[1]?.at ?? 0) - (wraps[0]?.at ?? 0)
  ok(`${named}: a round apart, the two half-second segments, by the wall clock`, Math.abs(first - 1000) <= 150 && Math.abs(second - 1000) <= 150, `${first} ms, then ${second} ms`)

  const [word = '', segment = '', ms = ''] = said('state').split(' ')
  const place = Number(ms)
  const inside = segment === '0' ? place >= 500 && place < 1000 : segment === '1' ? place >= 2000 && place < 2500 : false
  ok(`${named}: the engine's render clock places playback inside a segment`, word === 'looping' && inside, said('state'))
  ok(`${named}: the volume is held to 100 and to 0`, said('louder') === '100' && said('quieter') === '0', `${said('louder')} ${said('quieter')}`)
  ok(`${named}: restart, stop, the state after, and restart with nothing running`, said('restarted') === 'looping' && said('stopped') === 'stopped' && said('state-after') === 'stopped' && said('restart-stopped') === 'stopped', ['restarted', 'stopped', 'state-after', 'restart-stopped'].map(said).join(' '))
  ok(`${named}: and the watcher heard it stop`, loop.at(-1)?.value === 'stopped', said('heard-loop'))
  ok(`${named}: a segment past the file's end is invalid, a missing file unavailable`, said('invalid') === 'invalid' && said('missing') === 'unavailable', `${said('invalid')} ${said('missing')}`)

  const playback = events(said('heard-playback'))
  const playing = playback.filter(one => one.value.startsWith('playing '))
  const done = playback.find(one => one.value === 'done')
  ok(`${named}: the queue plays both files, each heard as it starts, then done`, said('playing') === 'playing' && playing.length === 2 && playing.every(one => one.value.endsWith(SHORT)) && done !== undefined, said('heard-playback'))
  const span = (done?.at ?? 0) - (playing[0]?.at ?? 0)
  ok(`${named}: about a second from the first start to done, two half-second files`, Math.abs(span - 1000) <= 250, `${span} ms`)
  ok(`${named}: a file that is not there is unavailable, and stopping answers stopped`, said('play-missing') === 'unavailable' && said('play-stopped') === 'stopped', `${said('play-missing')} ${said('play-stopped')}`)

  if (leg === 'ios') {
    ok(`${named}: never asked, the recorder says not-determined and records nothing`, said('record') === 'not-determined', said('record'))
  }

  ok(`${named}: an idle recorder stops as idle, and its watcher hears idle`, said('record-stopped') === 'idle' && said('heard-recording') === 'idle', `${said('record-stopped')} ${said('heard-recording')}`)
}

// the Apple hosts, which are the ones built (Android's is beat-term-0011)
const LEGS = process.env.AUDIO_ONLY ? [process.env.AUDIO_ONLY] : ['macos', 'ios']

// the Mac's own program reads the Mac's temporary folder, which is node's
if (LEGS.includes('macos')) {
  writeFiles(tmpdir())
}

for (const leg of LEGS) {
  runToolkits(
    {
      root: process.cwd(),
      dir: mkdtempSync(join(tmpdir(), 'term-audio-')),
      name: 'Audio',
      iosIdentifier: 'surf.term.device-audio-test',
      androidIdentifier: 'surf.term.deviceaudio',
      program,
      judge,
      ok,
      shots: {},
      prepare,
    },
    leg,
  )
}

console.log(`\ndevice-audio: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
