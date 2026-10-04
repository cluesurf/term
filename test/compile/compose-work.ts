// Live reload on Compose (live-reload): `term work --target compose|compose-android` through its own loop,
// `startComposeWork` in deck/call/code/compose-work.ts, with REAL edits to the app's file picked up by the loop's own
// watcher. Each relaunched app says where it STARTED before it moves, which is the witness that the history crossed the
// relaunch (deck/site/code/view/native/toolkit/address.tree):
//
//   run 1   starts at /, moves to /notes, draws `notes v1`
//   edit    `notes v2`: rebuilt and relaunched, it starts at /notes and draws `notes v2`
//   edit    a program that does not compile: a failure is reported and nothing is launched; the app is kept
//   edit    `notes v3`, with a step back: relaunched at /notes, and back reaches /, the screen behind it, so the whole
//           history crossed and not just the screen on top
//
// The desktop app runs headless (TERM_WINDOW_AWAY=1) and exits after it has drawn, as every Compose test does; the loop
// relaunches it on the next edit either way. The app folder is under this package's tmp/ (gitignored), so its `@term/*`
// imports resolve as any app's would. COMPOSE_WORK_ONLY=compose (or compose-android) runs one target.
// Run: npx tsx test/compile/compose-work.ts

import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { androidDevice } from '@term/call/code/cask'
import { startComposeWork } from '@term/call/code/compose-work'
import type { ComposeTarget, WorkEvent } from '@term/call/code/compose-work'

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

const ROOT = join(import.meta.dirname, '../..')

// the app at one version: two screens, and a check that says where it started, moves to /notes on a first run, steps
// back when asked, and says what it drew
const program = (version: string, back: boolean): string => `load @term/site/code/dom/dom
  find view
  find page-body

load @term/site/code/dom/native/toolkit/dom
  find after-launch
  find exit-app
  find serialize
  find later
  find say

load @term/site/code/view/navigation
  find navigate
  find navigate-back
  find current-path

view home
  take host, like view
  view span
    text <home>

view notes
  take host, like view
  view span
    text <notes ${version}>

hook /
  view home

hook /notes
  view notes

task main
  call after-launch
    task check
      save start
        call current-path
      call say
        text <step start {start}>
      fork test
        hook test
          call is-equal
            read start
            text </>
        hook hold
          call navigate
            text </notes>
${
  back
    ? `      save went
        call navigate-back
      save now
        call current-path
      call say
        text <step back {went} {now}>
`
    : ''
}      call later
        task drawn
          save tree
            call serialize
              call page-body
          call say
            text <step drawn {tree}>
          call exit-app
            code 0
  call boot
    text <>
    code 0
`

// a program that does not compile: a name nothing defines
const BROKEN = program('v2', false).replace('call current-path', 'call current-place')

function have(tool: string): boolean {
  return spawnSync('which', [tool], { encoding: 'utf8' }).status === 0
}

// wait for a condition, checking every quarter second, for at most `seconds`
async function until(cond: () => boolean, seconds: number): Promise<boolean> {
  const end = Date.now() + seconds * 1000

  while (!cond()) {
    if (Date.now() > end) {
      return false
    }

    await new Promise(done => setTimeout(done, 250))
  }

  return true
}

async function leg(target: ComposeTarget): Promise<void> {
  if (!have('kotlinc') || !have('java')) {
    console.log(`skip  ${target}: kotlinc or java not installed`)

    return
  }

  if (target === 'compose-android' && 'missing' in androidDevice()) {
    console.log(`skip  ${target}: no Android device online`)

    return
  }

  // a folder of its own per target: the gate runs the two at once
  const app = join(ROOT, 'tmp', 'compose-work', target, 'composework')
  rmSync(app, { recursive: true, force: true })
  mkdirSync(app, { recursive: true })
  const entry = join(app, 'app.tree')
  writeFileSync(entry, program('v1', false))

  const events: WorkEvent[] = []
  // what each run said, by its generation
  const said = new Map<number, string[]>()
  const exited = new Set<number>()
  const work = startComposeWork({
    root: app,
    target,
    env: { TERM_WINDOW_AWAY: '1' },
    onEvent: event => {
      events.push(event)

      if (event.kind === 'launch') {
        const lines: string[] = []
        said.set(event.generation, lines)
        let rest = ''
        event.child.stdout?.on('data', (chunk: Buffer) => {
          const parts = (rest + chunk.toString()).split('\n')
          rest = parts.pop() ?? ''
          lines.push(...parts.map(line => line.trim()))
        })
      } else if (event.kind === 'exit') {
        exited.add(event.generation)
      }
    },
  })

  const step = (generation: number, name: string): string => {
    const line = (said.get(generation) ?? []).find(l => l.includes(`step ${name} `)) ?? ''

    return line.slice(line.indexOf(`step ${name} `) + `step ${name} `.length)
  }
  // build results so far: a written file is taken up by the watcher a moment later, so an edit is waited on until a NEW
  // result appears, never by asking the loop at once whether it is idle (it is, until the watcher hears the write)
  const results = (): number => events.filter(e => e.kind === 'built' || e.kind === 'failed').length
  const taken = async (before: number): Promise<void> => {
    await until(() => results() > before, 60)
    await work.idle()
  }
  // the latest launch once it has drawn, after the edit before it was taken up
  const settled = async (before: number): Promise<number> => {
    await taken(before)
    const launched = events.filter(e => e.kind === 'launch').at(-1)?.generation ?? 0
    await until(() => exited.has(launched) || step(launched, 'drawn') !== '', 120)

    return launched
  }

  try {
    const first = await settled(0)
    const built = events.find(e => e.kind === 'built' || e.kind === 'failed')
    ok(`${target}: the loop builds the app and launches it`, first === 1 && built?.kind === 'built', JSON.stringify(built))
    ok(`${target}: run 1 starts at /`, step(first, 'start') === '/', step(first, 'start'))
    ok(`${target}: run 1 moves to /notes and draws notes v1`, step(first, 'drawn').includes('notes v1'), step(first, 'drawn'))

    const edited = Date.now()
    let before = results()
    writeFileSync(entry, program('v2', false))
    const second = await settled(before)
    const seconds = ((Date.now() - edited) / 1000).toFixed(1)
    console.log(`      ${target}: an edit to the app on screen in ${seconds}s, a full rebuild and relaunch`)
    ok(`${target}: an edit is rebuilt and relaunched`, second > first, `${first} then ${second}`)
    ok(`${target}: the relaunched app STARTS at /notes, where the last one was`, step(second, 'start') === '/notes', step(second, 'start'))
    ok(`${target}: it draws the edit, notes v2`, step(second, 'drawn').includes('notes v2'), step(second, 'drawn'))

    const launchesBefore = events.filter(e => e.kind === 'launch').length
    before = results()
    writeFileSync(entry, BROKEN)
    await taken(before)
    const broken = events.filter(e => e.kind === 'failed').at(-1)
    ok(`${target}: an edit that does not compile is reported, naming the stage and the name`, !!broken && broken.kind === 'failed' && broken.stage === 'compile' && broken.reason.includes('current-place'), JSON.stringify(broken))
    ok(`${target}: and nothing is launched for it`, events.filter(e => e.kind === 'launch').length === launchesBefore, String(launchesBefore))

    before = results()
    writeFileSync(entry, program('v3', true))
    const third = await settled(before)
    ok(`${target}: the fixed edit is relaunched at /notes`, step(third, 'start') === '/notes', step(third, 'start'))
    ok(`${target}: back from it reaches /, the screen behind it: the whole history crossed`, step(third, 'back') === 'true /', step(third, 'back'))
    ok(`${target}: and draws the screen back reached, home`, step(third, 'drawn').includes('home') && !step(third, 'drawn').includes('notes'), step(third, 'drawn'))
  } finally {
    await work.stop()
  }
}

const only = process.env.COMPOSE_WORK_ONLY ?? ''

for (const target of ['compose', 'compose-android'] as const) {
  if (!only || only === target) {
    await leg(target)
  }
}

console.log(`\ncompose-work: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
