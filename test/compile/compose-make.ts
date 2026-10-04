// `term make --target compose` and `--target compose-android` (compose-target-0004), through the CLI's own function,
// `makeCompose` in deck/call/code/compose.ts: an app folder holding an `app.tree` is built into `host/<target>/`, and
// what comes out is RUN, not looked at. The desktop target's output is a jpackage app image with its own JVM, and the
// launcher inside it is started headless (TERM_WINDOW_AWAY=1), so the program runs on the JVM the package carries; the
// Android target's output is an APK, installed on the emulator. Each presses a button twice and reads it back from
// Compose's semantics, and must exit 0.
//
// The app folder is under this package's tmp/ (gitignored), so its `@term/*` imports resolve as any app's would.
// COMPOSE_MAKE_ONLY=compose (or compose-android) runs one target. Run: npx tsx test/compile/compose-make.ts

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeCompose } from '@term/call/code/compose'
import { runComposeAndroid } from './shared/compose-android'

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
const only = process.env.COMPOSE_MAKE_ONLY ?? ''
// a folder per run of each target: the gate runs the two targets at once, and a shared folder was wiped by one while
// the other built in it. The app keeps its name, `composemake`, in each
const APP = join(ROOT, 'tmp', 'compose-make', only || 'both', 'composemake')
// the line the program must print, read back from Compose after two presses
const WANT = '<main><button>2</button></main>'

const APP_TREE = `load @term/site/code/view/reactive
  find make-signal
  find read-signal
  find write-signal

load @term/site/code/dom/dom
  find view

load @term/site/code/dom/native/toolkit/dom
  find open-root
  find after-launch
  find run-app
  find exit-app
  find press
  find child-at
  find serialize
  find say

task shown
  take count, like signal number
  like text
  save value
    call read-signal
      bind self, read count
  send back, text <{value}>

view tally
  take host, like view
  save count
    call make-signal
      bind value, code 0
  view button
    seed click
      call write-signal
        bind self, read count
        bind value
          call add
            call read-signal
              bind self, read count
            code 1
    read
      call shown
        read count

task main
  save root
    call open-root
      text <Compose make>
      code 400
      code 300
  call tally
    read root
  call after-launch
    task check
      call press
        call child-at
          read root
          code 0
      call press
        call child-at
          read root
          code 0
      call say
        call serialize
          read root
      call exit-app
        code 0
  call run-app
`

function have(tool: string): boolean {
  return spawnSync('which', [tool], { encoding: 'utf8' }).status === 0
}

async function desktop(): Promise<void> {
  if (!have('jpackage') || !have('kotlinc')) {
    console.log('skip  compose: jpackage or kotlinc not installed')

    return
  }

  let app = ''

  try {
    app = (await makeCompose({ root: APP, target: 'compose' })).app
    ok('compose: `term make --target compose` builds an app image', existsSync(app), app)
  } catch (e) {
    ok('compose: `term make --target compose` builds an app image', false, String((e as Error).message ?? e).slice(0, 1600))

    return
  }

  // the launcher jpackage made, inside the image, running the JVM the image carries
  const launcher = process.platform === 'darwin' ? join(app, 'Contents', 'MacOS', 'composemake') : join(app, 'bin', 'composemake')
  ok('compose: the image carries its own JVM', existsSync(process.platform === 'darwin' ? join(app, 'Contents', 'runtime') : join(app, 'lib', 'runtime')))
  const ran = spawnSync(launcher, [], { encoding: 'utf8', env: { ...process.env, TERM_WINDOW_AWAY: '1' }, timeout: 180_000 })
  ok('compose: the packaged app runs, presses twice and reads it back from Compose', ran.stdout.split('\n').includes(WANT), `${ran.stdout}${ran.stderr}`.slice(-800))
  ok('compose: it exits 0', ran.status === 0 && ran.stdout.includes('native-view exit 0'), `status ${ran.status}`)
}

async function android(): Promise<void> {
  let apk = ''

  try {
    apk = (await makeCompose({ root: APP, target: 'compose-android' })).app
    ok('compose-android: `term make --target compose-android` builds an APK', existsSync(apk), apk)
  } catch (e) {
    const message = String((e as Error).message ?? e)

    if (/no Android platform|no Android build tools/.test(message)) {
      console.log(`skip  compose-android: ${message.slice(0, 200)}`)

      return
    }

    ok('compose-android: `term make --target compose-android` builds an APK', false, message.slice(0, 1600))

    return
  }

  const ran = runComposeAndroid({ apk, identifier: 'surf.term.composemake', shot: 'none.png', pulled: join(APP, 'none.png') })

  if (ran.form === 'skipped') {
    console.log(`skip  compose-android: ${ran.reason}`)

    return
  }

  ok('compose-android: it installs on the emulator', ran.installed)
  ok('compose-android: the app presses twice and reads it back from Compose', ran.output.split('\n').includes(WANT), ran.output.slice(-800))
  ok('compose-android: it exits 0', ran.exited, ran.output.slice(-400))
}

rmSync(APP, { recursive: true, force: true })
mkdirSync(APP, { recursive: true })
writeFileSync(join(APP, 'app.tree'), APP_TREE)

if (!only || only === 'compose') {
  await desktop()
}

if (!only || only === 'compose-android') {
  await android()
}

console.log(`\ncompose-make: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
