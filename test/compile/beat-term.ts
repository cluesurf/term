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

// what a step does before it is read: send the app to a path, press a control by its accessibility name (the way a
// person does), or wait for the platform to finish a presentation
type Act = { go: string } | { press: string } | { type: [name: string, text: string] } | { wait: number } | { loop: string }

// read the audio loop's state (`looping` or `stopped`) off the platform, and say it as `loop <label> <state>`
const loop = (label: string): Act => ({ loop: label })
const go = (path: string): Act => ({ go: path })
const press = (name: string): Act => ({ press: name })
const type = (name: string, text: string): Act => ({ type: [name, text] })
const sheet: Act = { wait: 800 }
const SONG = `/songs/${HOME}`
// the delete dialogs are drawn and closed unless BEAT_DIALOGS=0
const DIALOGS = process.env.BEAT_DIALOGS !== '0'

// each screen: the name its PNG and its step go under, and what is done before it is read (item 0051). A press is read
// with nothing after it but a `later`: what the press wrote is drawn by then (item 0067, the fix in reactive.tree
// `run-effect`), and a `navigate` after it would hide a screen that does not redraw by drawing it afresh
const SCREENS: [step: string, acts: Act[]][] = [
  ['home', [go('/')]],
  ['import', [go('/import')]],
  // an address typed into the field, the way a person types it: Connect is enabled by it. Connect is never pressed here,
  // since nothing may reach the network (item 0053)
  ['import-typed', [type('Laptop address', '127.0.0.1:9')]],
  ['song', [go(SONG)]],
  ['record-empty', [go(`${SONG}/record`)]],
  ['song-chosen', [go(SONG), press('Section Intro'), press('Section Chorus')]],
  ['record', [press('Record takes')]],
  // the song's screen entered again forgets the chosen sections (item 0068: a `call` in the view body ran never before)
  ['song-reset', [go(SONG)]],
  // a loop started on the song's screen is stopped by leaving it (item 0068: `on-cleanup` in the view body)
  ['song-looping', [press('Section Intro'), press('Loop'), loop('playing')]],
  ['song-left', [go('/'), loop('left')]],
  ['takes', [go(`${SONG}/takes`)]],
  ...(DIALOGS
    ? ([
        ['song-dialog', [go(SONG), press('Delete song'), sheet]],
        ['song-kept', [press('Keep'), sheet]],
        ['take-dialog', [go(`${SONG}/takes`), press('Delete take 4'), sheet]],
        ['take-kept', [press('Keep'), sheet]],
      ] as [string, Act[]][])
    : []),
]

// the platform finishes a navigation, a press or a presentation on its own turn, AFTER the code that asked returns, and a
// `sleep` does not give it the turn (the harness reads the screen as it was before the press). So every act is followed by
// a `later`, and what comes after it is the body of that `later`: a step's rows are a nest of them. `@later` marks where
const LATER = '@later'

function actRows(step: string, act: Act): string[] {
  if ('go' in act) return ['call navigate', `  text <${act.go}>`, LATER]
  if ('press' in act) return ['call press-named', '  read root', `  text <${step}>`, `  text <${act.press}>`, LATER]
  if ('type' in act) return ['call type-named', '  read root', `  text <${step}>`, `  text <${act.type[0]}>`, `  text <${act.type[1]}>`, LATER]

  if ('loop' in act) return [`save loop-${act.loop}`, '  call loop-state', 'call say', `  text <loop ${act.loop} {loop-${act.loop}}>`]

  return [LATER]
}

// rows at no indent, with `@later` where the rest of the program nests inside a `later` body, indented at `depth`
function nest(rows: string[], depth: number): string {
  const out: string[] = []
  let at = depth
  let count = 0

  for (const row of rows) {
    if (row === LATER) {
      out.push(`${' '.repeat(at)}call later`, `${' '.repeat(at + 2)}task later-${count++}`)
      at += 4
    } else {
      out.push(`${' '.repeat(at)}${row}`)
    }
  }

  return out.join('\n')
}

// a line `named <step> <role|name> <frame>` for every node under the root (a dialog's sheet included) whose accessibility
// name is not empty and whose role is not `staticText`, found by walking the tree with a list as the stack (no recursive
// task). Later items assert on these lines (item 0048)
function namedLines(step: string): string {
  const s = step
  const rows = [
    `save stack-${s}`,
    '  make list',
    'call push',
    `  bind list, read stack-${s}`,
    '  bind item, read root',
    'walk test',
    '  hook test',
    '    call is-above',
    '      call length',
    `        read stack-${s}`,
    '      code 0',
    '  hook hold',
    `    save current-${s}`,
    '      call pop',
    `        read stack-${s}`,
    `    save kids-${s}`,
    '      call child-count',
    `        read current-${s}`,
    `    save at-${s}`,
    '      code 0',
    '    walk test',
    '      hook test',
    '        call is-below',
    `          read at-${s}`,
    `          read kids-${s}`,
    '      hook hold',
    '        call push',
    `          bind list, read stack-${s}`,
    '          bind item',
    '            call child-at',
    `              read current-${s}`,
    `              read at-${s}`,
    `        save at-${s}`,
    '          call add',
    `            read at-${s}`,
    '            code 1',
    `    save access-${s}`,
    '      call accessibility-of',
    `        read current-${s}`,
    `    save parts-${s}`,
    '      call split',
    `        read access-${s}`,
    '        text <|>',
    '    fork test',
    '      hook test',
    '        call and',
    '          call not',
    '            call ends-with',
    `              read access-${s}`,
    '              text <|>',
    '          call not',
    '            call is-equal',
    `              read parts-${s}/0`,
    '              text <staticText>',
    '      hook hold',
    `        save frame-${s}`,
    '          call frame-of',
    `            read current-${s}`,
    '        call say',
    `          text <named ${s} {access-${s}} {frame-${s}}>`,
  ]

  return rows.join('\n')
}

// a step: its acts, then everything read off UIKit once they have settled
function stepRows(step: string, acts: Act[]): string[] {
  const sheetRows = /dialog|kept/.test(step)
    ? [
        `save sheet-${step}`,
        '  call find-sheet',
        '    read root',
        `save sheet-tree-${step}, text <none>`,
        'fork test',
        '  hook test',
        '    call is-above',
        '      call length',
        `        read sheet-${step}`,
        '      code 0',
        '  hook hold',
        `    save sheet-tree-${step}`,
        '      call serialize',
        `        read sheet-${step}/0`,
        'call say',
        `  text <sheet ${step} {sheet-tree-${step}}>`,
      ]
    : []

  return [
    ...acts.flatMap(act => actRows(step, act)),
    `save drawn-${step}`,
    '  call serialize',
    '    read root',
    'call say',
    `  text <step ${step} {drawn-${step}}>`,
    ...sheetRows,
    `save root-count-${step}`,
    '  call child-count',
    '    read root',
    `save screen-${step}`,
    '  call child-at',
    '    read root',
    '    call subtract',
    `      read root-count-${step}`,
    '      code 1',
    `save count-${step}`,
    '  call child-count',
    `    read screen-${step}`,
    `save scroll-${step}`,
    '  call child-at',
    `    read screen-${step}`,
    '    call subtract',
    `      read count-${step}`,
    '      code 1',
    `save frame-root-${step}`,
    '  call frame-of',
    '    read root',
    `save frame-screen-${step}`,
    '  call frame-of',
    `    read screen-${step}`,
    `save frame-scroll-${step}`,
    '  call frame-of',
    `    read scroll-${step}`,
    'call say',
    `  text <frames ${step} {frame-root-${step}} {frame-screen-${step}} {frame-scroll-${step}}>`,
    `save safe-${step}`,
    '  call safe-area',
    'call say',
    `  text <safe ${step} {safe-${step}}>`,
    ...namedLines(step).split('\n'),
    'call snapshot',
    `  text <{temporary}/${step}.png>`,
  ]
}

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
  find child-at
  find child-count
  find frame-of
  find safe-area
  find accessibility-of
  find press
  find type-text

load @term/base/list
  find push
  find pop
  find length

load @term/base/text
  find split
  find starts-with
  find ends-with

load @term/site/code/view/navigation
  find navigate

load @term/base/clock
  find sleep

load @term/site/view/audio
  find loop-state

# a list holding the first node whose accessibility role starts with \`role\` named \`name\`, empty when none: a control
# is \`<button>\`, and a text field, which UIKit gives no role, is \`<>\`. The tree is walked with a list as the stack (no
# recursive task). The sheet of a dialog is under the root (T016)
task find-named
  take top, like view
  take role, like text
  take name, like text
  like list
  save found
    make list
  save stack
    make list
  call push
    bind list, read stack
    bind item, read top
  walk test
    hook test
      call and
        call is-above
          call length
            read stack
          code 0
        call is-equal
          call length
            read found
          code 0
    hook hold
      save current
        call pop
          read stack
      save kids
        call child-count
          read current
      save at
        code 0
      walk test
        hook test
          call is-below
            read at
            read kids
        hook hold
          call push
            bind list, read stack
            bind item
              call child-at
                read current
                read at
          save at
            call add
              read at
              code 1
      save access
        call accessibility-of
          read current
      fork test
        hook test
          call and
            call starts-with
              read access
              read role
            call ends-with
              read access
              text <|{name}>
        hook hold
          call push
            bind list, read found
            bind item, read current
  send back, read found

# a list holding the first node that serializes as a sheet (a dialog's), empty when none is under \`top\`
task find-sheet
  take top, like view
  like list
  save found
    make list
  save stack
    make list
  call push
    bind list, read stack
    bind item, read top
  walk test
    hook test
      call and
        call is-above
          call length
            read stack
          code 0
        call is-equal
          call length
            read found
          code 0
    hook hold
      save current
        call pop
          read stack
      save kids
        call child-count
          read current
      save at
        code 0
      walk test
        hook test
          call is-below
            read at
            read kids
        hook hold
          call push
            bind list, read stack
            bind item
              call child-at
                read current
                read at
          save at
            call add
              read at
              code 1
      fork test
        hook test
          call starts-with
            call serialize
              read current
            text <\\<sheet>
        hook hold
          call push
            bind list, read found
            bind item, read current
  send back, read found

# press the control named \`name\`, or say \`missing <step> <name>\`, which the judge fails on
task press-named
  take top, like view
  take step, like text
  take name, like text
  save found
    call find-named
      read top
      text <button>
      read name
  fork test
    hook test
      call is-equal
        call length
          read found
        code 0
    hook hold
      call say
        text <missing {step} {name}>
    hook miss
      call press
        read found/0

# type \`text\` into the field named \`name\`, the field's text first and then its report, or say \`missing <step> <name>\`
task type-named
  take top, like view
  take step, like text
  take name, like text
  take text, like text
  save found
    call find-named
      read top
      text <>
      read name
  fork test
    hook test
      call is-equal
        call length
          read found
        code 0
    hook hold
      call say
        text <missing {step} {name}>
    hook miss
      call type-text
        read found/0
        read text

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
${nest(
  [
    ...SCREENS.flatMap(([step, acts]) => stepRows(step, acts)),
    'call exit-app',
    '  code 0',
  ],
  6,
)}
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

  // the whole console, so a layout number or a crash reads off a file and not off a truncated line
  writeFileSync(join(SHOTS, 'console.txt'), output)

  // `frames <step> <root> <screen> <scroll>` and `safe <step> <safe area>` are `x,y,width,height` in points. The root
  // fills the safe area on every screen (D021), and every screen's scroll takes `flex-grow` (look.tree `scroll-style`): a
  // scroll with no height was 0 tall, which drew every screen as its header alone
  const lines = output.split('\n')

  for (const [name] of SCREENS) {
    const root = lines.find(l => l.startsWith(`frames ${name} `))?.split(' ')[2] ?? ''
    const safe = lines.find(l => l.startsWith(`safe ${name} `))?.split(' ')[2] ?? ''
    ok(`${named}: ${name}: the root fills the safe area`, root !== '' && root === safe, `root ${root}, safe area ${safe}`)
  }

  // what each screen names to accessibility: `namedFrames[step]` maps `role|name` to its frame. Later items assert on
  // it, so it prints nothing on a pass and fails only when a screen names nothing
  const namedFrames: Record<string, Map<string, string>> = {}

  for (const [name] of SCREENS) {
    const map = new Map<string, string>()

    for (const line of lines.filter(l => l.startsWith(`named ${name} `))) {
      const rest = line.slice(`named ${name} `.length).trim()
      const cut = rest.lastIndexOf(' ')
      map.set(rest.slice(0, cut), rest.slice(cut + 1))
    }

    namedFrames[name] = map

    if (map.size === 0) ok(`${named}: ${name} names something to accessibility`, false, 'no named line')
  }

  // a disabled control keeps UIKit's `notEnabled` trait (item 0049, review F6): nothing is chosen on the song screen, so
  // Loop is disabled and Review takes is not. The role is what `accessibility-of` reads off the platform
  const songNames = [...(namedFrames.song?.keys() ?? [])]
  ok(`${named}: song: the disabled Loop reads button+notEnabled`, songNames.includes('button+notEnabled|Loop'), `named ${songNames.join(' ; ')}`)
  ok(`${named}: song: Review takes reads button, enabled`, songNames.includes('button|Review takes'), `named ${songNames.join(' ; ')}`)

  // what a view `fork` swaps in is installed as an appended node is, so the review's cards reach the width of the filter
  // row (item 0049, review F3): the right edge (x plus width) of a card's Delete, of a section's Compare and of the last
  // filter are one. The Delete chip sits inside its card's 12 point padding (look.tree `card-style`), so its edge plus
  // that padding is the CARD's right edge, which is what must equal the other two. Before the fix the card hugged its
  // chips: Delete take 2 ended at 272, the card at 284, against 382
  const takes = namedFrames.takes ?? new Map<string, string>()
  const cardPadding = 12
  const edge = (key: string, inset: number): number | undefined => {
    const [x, , width] = (takes.get(key) ?? '').split(',').map(Number)
    return x === undefined || width === undefined || Number.isNaN(x + width) ? undefined : x + width + inset
  }
  const edges = [
    ['button|Delete take 2', edge('button|Delete take 2', cardPadding)],
    ['button|Compare Intro', edge('button|Compare Intro', 0)],
    ['button|Starred', edge('button|Starred', 0)],
  ] as const
  ok(
    `${named}: takes: the right edges of Delete take 2's card, Compare Intro and Starred are equal`,
    edges.every(([, e]) => e !== undefined) && new Set(edges.map(([, e]) => e)).size === 1,
    `${edges.map(([key, e]) => `${key} ${e}`).join(', ')} (Delete take 2 plus the card's ${cardPadding})`,
  )

  for (const [name] of SCREENS) {
    const frames = output.split('\n').find(l => l.startsWith(`frames ${name} `))?.split(' ') ?? []
    const [, , , height] = (frames[4] ?? '').split(',').map(Number)
    ok(`${named}: ${name} draws its content (the scroll is ${height} tall)`, (height ?? 0) >= 300, frames.join(' '))
  }

  // the layout of D021 and D022 (item 0050), held by frames read off UIKit. The app carries no `scroll-room` or
  // `screen-least`: the screen fills the root and its scroll spans the screen down to the safe area's bottom
  const rect = (text: string): number[] => text.split(',').map(Number)

  for (const [name] of SCREENS) {
    const frames = lines.find(l => l.startsWith(`frames ${name} `))?.split(' ') ?? []
    const root = rect(frames[2] ?? '')
    const scroll = rect(frames[4] ?? '')
    const safe = rect(lines.find(l => l.startsWith(`safe ${name} `))?.split(' ')[2] ?? '')
    const valid = [...root, ...scroll, ...safe].length === 12 && ![...root, ...scroll, ...safe].some(Number.isNaN)

    ok(
      `${named}: ${name}: the scroll ends at the safe area's bottom`,
      valid && scroll[1] + scroll[3] === safe[1] + safe[3],
      `scroll ${scroll.join(',')}, safe area ${safe.join(',')} (${frames.join(' ')})`,
    )
    ok(`${named}: ${name}: the scroll spans the screen`, valid && scroll[0] === root[0] && scroll[2] === root[2], `scroll ${scroll.join(',')}, root ${root.join(',')}`)

    // every button is a target of 44 points on its narrow side (D022 rule 1), and Back is 44 tall and 88 wide. The slider
    // and the address field are the platform's own controls. A frame of 0,0,0,0 is a closed dialog's button
    const small: string[] = []

    for (const [key, frame] of namedFrames[name] ?? []) {
      const [role, label] = key.split('|')
      const [, , width, height] = rect(frame)

      if (!role.includes('button') || (width === 0 && height === 0)) continue
      if (label === 'Back' ? width < 88 || height < 44 : Math.min(width, height) < 44) small.push(`${key} ${frame}`)
    }

    ok(`${named}: ${name}: every button is 44 points or more on its narrow side, Back 44 by 88`, small.length === 0, small.join(' ; '))
  }

  // song: the volume slider's thumb is drawn whole inside the scroll, and Delete song stands apart from Review takes
  const songFrame = (key: string): number[] => rect(namedFrames.song?.get(key) ?? '')
  const songScroll = rect(lines.find(l => l.startsWith('frames song '))?.split(' ')[4] ?? '')
  const slider = [...(namedFrames.song?.entries() ?? [])].find(([key]) => key.endsWith('|Loop volume'))
  const sliderBox = rect(slider?.[1] ?? '')
  ok(
    `${named}: song: the Loop volume slider's right edge is 16 points inside the scroll`,
    slider !== undefined && songScroll[0] + songScroll[2] - (sliderBox[0] + sliderBox[2]) >= 16,
    `slider ${slider?.join(' ')}, scroll ${songScroll.join(',')}`,
  )
  const review = songFrame('button|Review takes')
  const destroy = songFrame('button|Delete song')
  ok(
    `${named}: song: Delete song's top is 30 points or more below Review takes' bottom`,
    review.length === 4 && destroy.length === 4 && destroy[1] - (review[1] + review[3]) >= 30,
    `Review takes ${review.join(',')}, Delete song ${destroy.join(',')}`,
  )

  // takes: the rating chips of take 2 do not touch, 12 points between each neighbor (D022 rule 2)
  const chips = ['button|Rate take 2 down', 'button|Rate take 2 up', 'button|Star take 2'].map(key => ({ key, box: rect(takes.get(key) ?? '') }))
  const gaps = chips.slice(1).map((chip, index) => chip.box[0] - (chips[index].box[0] + chips[index].box[2]))
  ok(
    `${named}: takes: the rating chips of take 2 are 12 points or more apart`,
    chips.every(chip => chip.box.length === 4 && !chip.box.some(Number.isNaN)) && gaps.every(gap => gap >= 12),
    `${chips.map(chip => `${chip.key} ${chip.box.join(',')}`).join(' ; ')} gaps ${gaps.join(',')}`,
  )

  // item 0051: a step that pressed a name it could not find says `missing <step> <name>`
  const missing = lines.filter(l => l.startsWith('missing '))
  ok(`${named}: no step pressed a control it could not find`, missing.length === 0, missing.join(' ; '))

  const labelsOf = (name: string): string[] => [...(namedFrames[name]?.keys() ?? [])].map(key => key.slice(key.indexOf('|') + 1))
  const rolesOf = (name: string, label: string): string[] => [...(namedFrames[name]?.keys() ?? [])].filter(key => key.endsWith(`|${label}`)).map(key => key.slice(0, key.indexOf('|')))

  // the recorder opened by its path with nothing chosen is the original's `Not found` shell and nothing it could record with
  const emptyNames = labelsOf('record-empty')
  ok(
    `${named}: record-empty: NOT FOUND and no Record, Loop or Review takes`,
    step(output, 'record-empty').includes('NOT FOUND') && !['Record', 'Loop', 'Review takes'].some(label => emptyNames.includes(label)),
    `named ${emptyNames.join(' ; ')} in ${step(output, 'record-empty').slice(0, 400)}`,
  )

  // choosing two sections enables the Loop and says how many the recorder will cover; the recorder reached by pressing Record takes is titled by them
  ok(`${named}: song-chosen: Loop reads button`, rolesOf('song-chosen', 'Loop').join() === 'button', `Loop read ${rolesOf('song-chosen', 'Loop').join()}`)
  holds(named, 'song-chosen: Record over 2 parts', step(output, 'song-chosen'), ['Record over 2 parts'])

  // controls disabled where the original disabled them (item 0053, review F12): Record takes with nothing chosen, Connect
  // with no address. Each is read off UIKit, and each comes back enabled once there is something for it to do, which a
  // press or a keystroke makes so without a `navigate` (item 0067)
  const roleOf = (name: string, label: string): string => rolesOf(name, label).join()
  ok(`${named}: song: Record takes reads button+notEnabled with nothing chosen`, roleOf('song', 'Record takes') === 'button+notEnabled', `read ${roleOf('song', 'Record takes')}`)
  ok(`${named}: song-chosen: Record takes reads button with two chosen`, roleOf('song-chosen', 'Record takes') === 'button', `read ${roleOf('song-chosen', 'Record takes')}`)
  ok(`${named}: import: Connect reads button+notEnabled with no address`, roleOf('import', 'Connect') === 'button+notEnabled', `read ${roleOf('import', 'Connect')}`)
  ok(`${named}: import-typed: Connect reads button once an address is typed`, roleOf('import-typed', 'Connect') === 'button', `read ${roleOf('import-typed', 'Connect')}`)
  holds(named, 'record: reached by choosing, titled INTRO +1', step(output, 'record'), ['INTRO +1'])

  // item 0068: a `call` in a view body runs. Entering the song's screen again forgets the sections chosen before (the call
  // that writes `chosen`), and leaving it stops its loop (`on-cleanup`), read off the platform's loop state
  ok(`${named}: song-reset: Record takes reads button+notEnabled again, the chosen sections forgotten`, roleOf('song-reset', 'Record takes') === 'button+notEnabled', `read ${roleOf('song-reset', 'Record takes')}`)
  holds(named, 'song-reset: asks for a part first', step(output, 'song-reset'), ['Loop: choose a part first', 'Record: choose a part first'])
  ok(`${named}: song-reset: no Record over parts`, !step(output, 'song-reset').includes('Record over'), step(output, 'song-reset').slice(0, 400))
  const loopOf = (label: string): string => lines.find(l => l.startsWith(`loop ${label} `))?.slice(`loop ${label} `.length).trim() ?? ''
  ok(`${named}: song-looping: pressing Loop starts the loop`, loopOf('playing').startsWith('looping'),`loop state ${JSON.stringify(loopOf('playing'))}`)
  ok(`${named}: song-left: leaving the song's screen stops the loop`, loopOf('left') === 'stopped', `loop state ${JSON.stringify(loopOf('left'))}`)

  // both delete dialogs are presented with their two choices, and Keep closes them with the song and the take still there
  for (const [open, kept, still, question] of DIALOGS
    ? [
        ['song-dialog', 'song-kept', 'MEET HOME', 'Delete Meet Home?'],
        ['take-dialog', 'take-kept', 'Take 4', 'Delete this take?'],
      ]
    : []) {
    const frames = (name: string, label: string): string => namedFrames[name]?.get(`button|${label}`) ?? ''
    // the sheet is the root's first child (T016), serialized on its own line `sheet <step> <tree>`
    const sheetLine = (name: string): string => lines.find(l => l.startsWith(`sheet ${name} `)) ?? ''
    holds(named, `${open}: the sheet is presented`, sheetLine(open), ['<sheet open="true">'])
    // D029: the question is drawn in the sheet as a heading view, not only set as the platform's title
    holds(named, `${open}: the sheet draws its question as a heading`, sheetLine(open), [`<h2>${question}</h2>`])
    const drawn = ['Delete', 'Keep'].filter(label => frames(open, label) === '' || frames(open, label) === '0,0,0,0')
    ok(`${named}: ${open}: Delete and Keep are named and have a frame`, drawn.length === 0, `not drawn ${drawn.join(',')}; named ${labelsOf(open).join(' ; ')}`)
    holds(named, `${kept}: the sheet is closed`, sheetLine(kept), ['<sheet open="false">'])
    holds(named, `${kept}: and ${still} is still drawn`, step(output, kept), [still])
  }

  // every label of spec.md 3.2 a screen can show without a server or a recording, read off UIKit
  const takeLabels = [1, 2, 3, 4].flatMap(n => [`Play take ${n}`, `Rate take ${n} down`, `Rate take ${n} up`, `Star take ${n}`, `Share take ${n}`, `Delete take ${n}`])
  const LABELS: [string, string[]][] = [
    ['home', ['Import from laptop', 'Import from Files', 'Open Meet Home', 'Open Empty Parts']],
    ['import', ['Back', 'Laptop address', 'Connect']],
    ['song', ['Back', 'Section Intro', 'Section Verse', 'Section Chorus', 'Loop', 'Loop volume', 'Record takes', 'Review takes', 'Delete song']],
    ['record', ['Back', 'Loop', 'Loop volume', 'Record', 'Review takes']],
    ['takes', ['Back', 'All', 'Liked', 'Starred', 'Compare Intro', 'Compare Chorus', ...takeLabels]],
    ...(DIALOGS ? ([['song-dialog', ['Delete', 'Keep']], ['take-dialog', ['Delete', 'Keep']]] as [string, string[]][]) : []),
  ]

  for (const [name, wanted] of LABELS) {
    const present = labelsOf(name)
    const lacking = wanted.filter(label => !present.includes(label))
    ok(`${named}: ${name}: all ${wanted.length} labels of spec 3.2 are read back`, lacking.length === 0, `lacks ${lacking.join(',')}; named ${present.join(' ; ')}`)
  }

  holds(named, 'the first screen lists both songs and offers both imports', step(output, 'home'), ['Meet Home', 'Empty Parts', 'Import from laptop', 'Import from Files'])
  holds(named, 'and draws the title and counts', step(output, 'home'), ['BEAT', '2 songs', '3 sections', '1 section'])
  holds(named, 'the import screen offers Connect, asks for the address', step(output, 'import'), ['IMPORT', 'Connect', 'The computer'])
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
