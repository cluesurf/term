// The entry rule of `term make --target uikit` and `--target compose` (beat-term-0017, spec D008): the program starts at
// the file the manifest's `boot` line names, at its `boot` task, else at `app.tree` beside the manifest, at its `main`.
// Four fixture apps, each printing one line `entry <name>` from the task it started:
//
//   booted     deck.tree `boot ./code/boot`, code/boot.tree `task boot`, AND an app.tree `task main`: the manifest wins
//   legacy     a deck.tree with no `boot` line, an app.tree `task main`: the fallback
//   main-only  `boot ./code/boot` whose file holds only `task main`: the older entry task
//   neither    `boot ./code/boot` whose file holds a task named `start` only: refused, naming the `boot` task
//
// UIKit: makeUikit emits the Swift whose start line is read back; booted and legacy are then built for the simulator,
// installed, and launched with `simctl launch --console`, whose own output names the entry that ran. Compose: the
// emitted Kotlin driver is read back, and the desktop app is NEVER run (it opens a window on the Mac). Android is not
// built. Nothing here plays or records a sound: the programs only print.
//
// The fixtures are under a fresh folder of the operating system's temp folder, never in the repository. Run:
// sh tmp/beat-tsx.sh test/compile/manifest-boot.ts
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { simulator } from '@term/call/code/cask'
import { makeCompose } from '@term/call/code/compose'
import { makeUikit, uikitIdentity } from '@term/call/code/uikit'

let pass = 0
let fail = 0

function ok(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  ${info.slice(-1600)}`)
  }
}

const HERE = mkdtempSync(join(tmpdir(), 'term-manifest-boot-'))

// a program whose started task prints `entry <said>` and exits 0, the toolkit's own way (test/compile/uikit-make.ts)
function program(task: string, said: string): string {
  return `load @term/site/code/dom/native/toolkit/dom
  find open-root
  find after-launch
  find run-app
  find exit-app
  find say

task ${task}
  save root
    call open-root
      text <Entry>
      code 400
      code 300
  call after-launch
    task check
      call say
        text <entry ${said}>
      call exit-app
        code 0
  call run-app
`
}

function manifest(name: string, boot: boolean): string {
  return `deck @cluesurf/${name}
  mark <0.0.2>${boot ? '\n  boot ./code/boot' : ''}

load @term/site
  mark <0.0.x>
`
}

// one fixture app folder, its name the folder's (the app's name and identifier follow it)
function fixture(name: string, files: Record<string, string>): string {
  const root = join(HERE, name)
  mkdirSync(join(root, 'code'), { recursive: true })

  for (const [file, text] of Object.entries(files)) {
    writeFileSync(join(root, file), text)
  }

  return root
}

const booted = fixture('bootedapp', {
  'deck.tree': manifest('bootedapp', true),
  'code/boot.tree': program('boot', 'boot'),
  'app.tree': program('main', 'app-main'),
})
const legacy = fixture('legacyapp', {
  'deck.tree': manifest('legacyapp', false),
  'app.tree': program('main', 'main'),
})
const mainOnly = fixture('mainonlyapp', {
  'deck.tree': manifest('mainonlyapp', true),
  'code/boot.tree': program('main', 'main-only'),
})
const neither = fixture('neitherapp', {
  'deck.tree': manifest('neitherapp', true),
  'code/boot.tree': program('start', 'start'),
})

console.log(`fixtures under ${HERE}`)

const swiftOf = (root: string): string => readFileSync(join(root, 'host', 'uikit', uikitIdentity(root).name, 'main.swift'), 'utf8')

// the last statement of the emitted Swift: the start line the program ends with
const startOf = (swift: string): string => swift.trimEnd().split('\n').pop() ?? ''

async function uikit(): Promise<void> {
  if (process.platform !== 'darwin' || spawnSync('xcodebuild', ['-version']).status !== 0) {
    console.log('skip  uikit: needs macOS with Xcode')

    return
  }

  const found = simulator()
  const launched: { root: string; want: string; never: string }[] = [
    { root: booted, want: 'entry boot', never: 'entry app-main' },
    { root: legacy, want: 'entry main', never: 'entry app-main' },
  ]

  // booted and legacy: emitted, built for a device, then built for the simulator and launched
  for (const { root, want, never } of launched) {
    const { name, identifier } = uikitIdentity(root)
    const call = root === booted ? 'boot()' : 'main()'

    try {
      await makeUikit({ root, team: '' })
    } catch (e) {
      ok(`uikit ${name}: makeUikit builds`, false, String((e as Error).message ?? e))
      continue
    }

    const start = startOf(swiftOf(root))
    ok(`uikit ${name}: the emitted start line calls ${call}`, start.includes(call) && !(root === booted && start.includes('main()')), start)

    if ('missing' in found) {
      console.log(`skip  uikit ${name}: the simulator (${found.missing})`)
      continue
    }

    const project = join(root, 'host', 'uikit', `${name}.xcodeproj`)
    const derived = join(root, 'host', 'uikit', 'derived-simulator')
    const built = spawnSync(
      'xcodebuild',
      ['build', '-project', project, '-scheme', name, '-configuration', 'Release', '-destination', 'generic/platform=iOS Simulator', '-derivedDataPath', derived, 'CODE_SIGNING_ALLOWED=NO', '-quiet'],
      { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
    )
    const app = join(derived, 'Build', 'Products', 'Release-iphonesimulator', `${name}.app`)
    ok(`uikit ${name}: the project builds for the simulator`, built.status === 0 && existsSync(app), `${built.stdout}${built.stderr}`.split('\n').filter(line => /error/.test(line)).join('\n'))

    if (!existsSync(app)) {
      continue
    }

    spawnSync('xcrun', ['simctl', 'terminate', found.udid, identifier], { stdio: 'ignore' })
    spawnSync('xcrun', ['simctl', 'uninstall', found.udid, identifier], { stdio: 'ignore' })

    try {
      spawnSync('xcrun', ['simctl', 'install', found.udid, app], { stdio: 'ignore' })
      const ran = spawnSync('xcrun', ['simctl', 'launch', '--console', '--terminate-running-process', found.udid, identifier], { encoding: 'utf8', timeout: 120_000 })
      const lines = `${ran.stdout ?? ''}${ran.stderr ?? ''}`.split('\n').map(line => line.trim())
      ok(`uikit ${name}: the simulator's console prints \`${want}\``, lines.includes(want), lines.join('\n').slice(-800))
      ok(`uikit ${name}: and never \`${never}\``, !lines.includes(never), lines.join('\n').slice(-800))
    } finally {
      spawnSync('xcrun', ['simctl', 'terminate', found.udid, identifier], { stdio: 'ignore' })
      spawnSync('xcrun', ['simctl', 'uninstall', found.udid, identifier], { stdio: 'ignore' })
    }
  }

  // main-only: the older entry task, emitted and not launched
  try {
    await makeUikit({ root: mainOnly, team: '' })
    const start = startOf(swiftOf(mainOnly))
    ok('uikit main-only: the emitted start line calls main()', start.includes('main()') && !start.includes('boot()'), start)
  } catch (e) {
    ok('uikit main-only: makeUikit builds', false, String((e as Error).message ?? e))
  }

  // neither: refused, naming the `boot` task
  try {
    await makeUikit({ root: neither, team: '' })
    ok('uikit neither: makeUikit refuses an entry with neither task', false, 'it did not throw')
  } catch (e) {
    const message = String((e as Error).message ?? e)
    ok('uikit neither: makeUikit refuses an entry with neither task, naming `boot`', message.includes('has no `boot` task'), message)
  }
}

// the emitted Kotlin of a Compose build: the program's own file in the build's work folder
async function emittedKotlin(root: string): Promise<string | undefined> {
  try {
    await makeCompose({ root, target: 'compose' })
  } catch (e) {
    ok(`compose ${root.split('/').pop()}: makeCompose builds`, false, String((e as Error).message ?? e))

    return undefined
  }

  return readFileSync(join(root, 'host', 'compose', 'work', 'app.kt'), 'utf8')
}

function have(tool: string): boolean {
  return spawnSync('which', [tool], { encoding: 'utf8' }).status === 0
}

async function compose(): Promise<void> {
  if (!have('jpackage') || !have('kotlinc')) {
    console.log('skip  compose: jpackage or kotlinc not installed')

    return
  }

  const first = await emittedKotlin(booted)

  if (first !== undefined) {
    ok('compose booted: the emitted driver is `fun main() { boot() }`', first.includes('fun main() { boot() }') && !first.includes('fun main() { main_() }'), first.split('\n').filter(line => line.startsWith('fun main')).join('\n'))
  }

  const second = await emittedKotlin(legacy)

  if (second !== undefined) {
    ok('compose legacy: the emitted driver is `fun main() { main_() }`', second.includes('fun main() { main_() }') && !second.includes('fun main() { boot() }'), second.split('\n').filter(line => line.startsWith('fun main')).join('\n'))
  }
}

await uikit()
await compose()

console.log(`\nmanifest-boot: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
