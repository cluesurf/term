// beat-term (note/project/beat-term/spec.md) driven on the iPhone simulator: the app's own `start-app` (the one its
// `term make --target uikit` build runs), mounted in a program that walks its screens and says what each one draws,
// read back off UIKit's views, with a PNG of each screen for a person to look at.
//
// The app's data folder is seeded before it launches (spec.md 3.5 "inject"): a library document holding two songs,
// Meet Home with three sections and Empty Parts with one, and four rated takes on Meet Home, all of it silent audio, so
// nothing can sound on the Mac (traps.md#t007). The document is in the format the app's tests hold (library.tree).
//
// SHOTS=<folder> keeps the PNGs there. Run: npx tsx test/compile/beat-term.ts
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

const APP = join(import.meta.dirname, '../../../../../tool/tool/beat-term')
const RATE = 44_100
const SHOTS = process.env.SHOTS ?? mkdtempSync(join(tmpdir(), 'term-beat-shots-'))
mkdirSync(SHOTS, { recursive: true })

// `seconds` of digital silence as a 16-bit mono WAV
function silence(seconds: number): Buffer {
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

  return out
}

// the seeded library, in the document A/code/base/library.tree `encode-library` writes: "Meet Home" (Intro, Verse,
// Chorus, 8 s), "Empty Parts" (one section from 0, 3 s) and four takes on Meet Home, 1 and 2 on Intro (rated none, up),
// 3 and 4 on Chorus (star, down), each a 1 s silent WAV named takes/<id>.wav
const HOME = '7f0c6a3e-2b1d-4c6e-9a8f-1d2e3f4a5b6c'
const EMPTY = '8a1d7b4f-3c2e-4d7f-8b9a-2e3f4a5b6c7d'
const SECTIONS = ['a1b2c3d4-0001-4000-8000-000000000001', 'a1b2c3d4-0002-4000-8000-000000000002', 'a1b2c3d4-0003-4000-8000-000000000003']
const FULL = 'a1b2c3d4-0004-4000-8000-000000000004'
const TAKES = [
  { id: 'b0000000-0000-4000-8000-000000000001', section: SECTIONS[0], rating: 'none', number: 1, made: 11 },
  { id: 'b0000000-0000-4000-8000-000000000002', section: SECTIONS[0], rating: 'up', number: 2, made: 12 },
  { id: 'b0000000-0000-4000-8000-000000000003', section: SECTIONS[2], rating: 'star', number: 3, made: 13 },
  { id: 'b0000000-0000-4000-8000-000000000004', section: SECTIONS[2], rating: 'down', number: 4, made: 14 },
]
const LIBRARY = {
  version: 1,
  songs: [
    { id: HOME, name: 'Meet Home', audio: 'meet-home.wav', length_ms: 8000, section_ids: SECTIONS, made_ms: 1, next_take: 5 },
    { id: EMPTY, name: 'Empty Parts', audio: 'empty-parts.wav', length_ms: 3000, section_ids: [FULL], made_ms: 2, next_take: 1 },
  ],
  sections: [
    { id: SECTIONS[0], song_id: HOME, name: 'Intro', start_ms: 0, end_ms: 2000 },
    { id: SECTIONS[1], song_id: HOME, name: 'Verse', start_ms: 2000, end_ms: 5000 },
    { id: SECTIONS[2], song_id: HOME, name: 'Chorus', start_ms: 5000, end_ms: 8000 },
    { id: FULL, song_id: EMPTY, name: 'Full song', start_ms: 0, end_ms: 3000 },
  ],
  takes: TAKES.map(t => ({ id: t.id, song_id: HOME, section_id: t.section, file: `${t.id}.wav`, length_ms: 1000, rating: t.rating, number: t.number, made_ms: t.made })),
  server: '',
}

function seed(data: string): void {
  const folder = join(data, 'Library', 'Application Support', 'beat')
  mkdirSync(join(folder, 'songs'), { recursive: true })
  mkdirSync(join(folder, 'takes'), { recursive: true })
  writeFileSync(join(folder, 'library.json'), JSON.stringify(LIBRARY))
  writeFileSync(join(folder, 'songs', 'meet-home.wav'), silence(8))
  writeFileSync(join(folder, 'songs', 'empty-parts.wav'), silence(3))

  for (const t of TAKES) writeFileSync(join(folder, 'takes', `${t.id}.wav`), silence(1))
}

// each screen: where the app is sent, how long it is given to draw, and the name its PNG and its step go under
const SCREENS: [step: string, path: string][] = [
  ['home', '/'],
  ['import', '/import'],
  ['song', `/songs/${HOME}`],
  ['record', `/songs/${HOME}/record`],
  ['takes', `/songs/${HOME}/takes`],
]

// the PNGs are written in the app's own temporary folder, which is what a program on the simulator may write
const program = (_leg: Leg, _shot: string): string => `load ../../code/app
  find start-app

load @term/base/environment/path
  find known-directory

load @term/site/code/dom/native/toolkit/dom
  find launch
  find run-app
  find exit-app
  find snapshot
  find serialize
  find say

load @term/site/code/view/navigation
  find navigate

load @term/base/clock
  find sleep

task main
  save temporary
    call known-directory
      text <temporary>
  save root
    call start-app
  call launch
    task walk-screens
      mark async
      call sleep
        code 800
${SCREENS.map(([step, path]) =>
  [
    '      call navigate',
    `        text <${path}>`,
    '      call sleep',
    '        code 600',
    `      save drawn-${step}`,
    '        call serialize',
    '          read root',
    '      call say',
    `        text <step ${step} {drawn-${step}}>`,
    '      call snapshot',
    `        text <{temporary}/${step}.png>`,
  ].join('\n'),
).join('\n')}
      call exit-app
        code 0
  call run-app
`

function step(output: string, name: string): string {
  const line = output.split('\n').find(l => l.includes(`step ${name} `)) ?? ''

  return line.slice(line.indexOf(`step ${name} `) + `step ${name} `.length).trim()
}

// the app's container on the simulator, where the library is seeded and the PNGs are copied out of
let container = ''

function prepare(leg: Leg, target: { udid?: string; identifier: string }): void {
  if (leg !== 'ios' || !target.udid) return

  container = spawnSync('xcrun', ['simctl', 'get_app_container', target.udid, target.identifier, 'data'], { encoding: 'utf8' }).stdout.trim()
  seed(container)
}

// a check that the serialized text of a screen holds every word of `words`, naming the ones it lacks
function holds(named: string, what: string, text: string, words: string[]): void {
  const lacking = words.filter(word => !text.includes(word))
  ok(`${named}: ${what}`, lacking.length === 0, `lacks ${JSON.stringify(lacking)} in ${text.slice(0, 800)}`)
}

function judge(leg: Leg, toolkit: string, output: string): void {
  const named = `${leg} (${toolkit})`

  holds(named, 'the first screen lists both songs and offers both imports', step(output, 'home'), ['Meet Home', 'Empty Parts', 'Import from laptop', 'Import from Files'])
  holds(named, 'and draws the title and counts', step(output, 'home'), ['BEAT', '2 songs', '3 sections', '1 section'])
  holds(named, 'the import screen offers Connect, asks for the address', step(output, 'import'), ['IMPORT', 'Connect', '192.168.1.20:7777'])
  holds(named, "a song's screen lists its sections, review and delete", step(output, 'song'), ['Intro', 'Verse', 'Chorus', 'Review takes', 'Delete song'])
  holds(named, 'and shows each section with the takes it holds and asks for a part first', step(output, 'song'), ['Intro  ·  2 takes', 'Chorus  ·  2 takes', 'Loop: choose a part first', 'Record: choose a part first', 'Loop volume'])
  holds(named, 'the recorder has the loop volume and review', step(output, 'record'), ['Loop volume', 'Review takes', 'Record'])
  holds(named, 'review has the three filters and the sections that hold takes', step(output, 'takes'), ['All', 'Liked', 'Starred', 'Intro', 'Chorus'])
  holds(named, 'and the four takes with their length, rating, share and delete', step(output, 'takes'), ['Take 1', 'Take 2', 'Take 3', 'Take 4', '0:01', 'Down', 'Up', 'Star', 'Share', 'Delete'])
  ok(`${named}: and no section without takes`, !step(output, 'takes').includes('Verse'), step(output, 'takes').slice(0, 800))
  holds(named, 'and Compare for a section with more than one take', step(output, 'takes'), ['Compare'])
}

const dir = join(APP, 'tmp', `run-${process.pid}`)
mkdirSync(dir, { recursive: true })

runToolkits(
  {
    root: APP,
    dir,
    name: 'Beat',
    iosIdentifier: 'surf.term.beatterm-test',
    androidIdentifier: 'surf.term.beattermtest',
    program,
    judge,
    ok,
    shots: {},
    prepare,
  },
  'ios',
)

// the PNGs, out of the app's temporary folder
if (container) {
  for (const [name] of SCREENS) {
    spawnSync('cp', [join(container, 'tmp', `${name}.png`), join(SHOTS, `${name}.png`)])
  }

  console.log(`shots in ${SHOTS}`)
}

console.log(`\nbeat-term: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
