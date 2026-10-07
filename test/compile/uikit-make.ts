// `term make --target uikit` (swiftui-target-0004), through the CLI's own function, `makeUikit` in
// deck/call/code/uikit.ts: an app folder holding an `app.tree` becomes an Xcode project under `host/uikit/`, archived
// for an iPhone. Three things are held, and the third only where a team can sign:
//
//   1. the archive's executable is arm64 code built for iOS DEVICES, not the simulator (`vtool -show-build`)
//   2. the SAME generated project, built for the simulator by xcodebuild, runs: it presses a button twice, reads it
//      back from UIKit, and exits 0. So the project is a working app, not only a file Xcode accepts
//   3. with a signing identity in the keychain, the ad hoc .ipa is exported and its signature verifies
//
// A phone is not needed for any of the three. Installing on one is the install link (`--link`), which a person opens.
// The app folder is under this package's tmp/ (gitignored). Run: npx tsx test/compile/uikit-make.ts
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeUikit, signingTeam } from '@term/call/code/uikit'
import { holdDeviceSync } from './shared/device-hold'
import { bootedSimulator } from './shared/simulator'

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

if (process.platform !== 'darwin' || spawnSync('xcodebuild', ['-version']).status !== 0) {
  console.log('skip  uikit-make: needs macOS with Xcode')
  console.log('\nuikit-make: 0 pass, 0 fail, 1 skipped')
  process.exit(0)
}

const ROOT = join(import.meta.dirname, '../..')
const APP = join(ROOT, 'tmp', 'uikit-make', 'uikitmake')
const NAME = 'uikitmake'
const IDENTIFIER = 'surf.term.uikitmake'
// the line the program must print, read back from UIKit after two presses
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
      text <UIKit make>
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

rmSync(APP, { recursive: true, force: true })
mkdirSync(APP, { recursive: true })
writeFileSync(join(APP, 'app.tree'), APP_TREE)

const out = join(APP, 'host', 'uikit')
const project = join(out, `${NAME}.xcodeproj`)
const team = signingTeam()

// 1. the device build: unsigned whatever the keychain holds, so this half never waits on an identity
try {
  await makeUikit({ root: APP, team: '' })
  ok('uikit: `term make --target uikit` writes an Xcode project', existsSync(join(project, 'project.pbxproj')))
  const exe = join(out, `${NAME}.xcarchive`, 'Products', 'Applications', `${NAME}.app`, NAME)
  const build = spawnSync('vtool', ['-show-build', exe], { encoding: 'utf8' })
  const arch = spawnSync('lipo', ['-archs', exe], { encoding: 'utf8' })
  ok('uikit: the archive holds arm64 code built for iOS devices, not the simulator', /platform IOS\b/.test(build.stdout) && !/IOSSIMULATOR/.test(build.stdout) && arch.stdout.trim() === 'arm64', `${build.stdout}${build.stderr}${arch.stdout}`)
} catch (e) {
  ok('uikit: `term make --target uikit` builds for a device', false, String((e as Error).message ?? e))
}

// 2. the same project for the simulator, run, and read back
const found = bootedSimulator()

if ('missing' in found) {
  console.log(`skip  uikit: the project on the simulator (${found.missing})`)
} else if (existsSync(project)) {
  const derived = join(out, 'derived-simulator')
  const built = spawnSync(
    'xcodebuild',
    ['build', '-project', project, '-scheme', NAME, '-configuration', 'Release', '-destination', 'generic/platform=iOS Simulator', '-derivedDataPath', derived, 'CODE_SIGNING_ALLOWED=NO', '-quiet'],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  )
  const app = join(derived, 'Build', 'Products', 'Release-iphonesimulator', `${NAME}.app`)
  ok('uikit: the generated project builds for the simulator too', built.status === 0 && existsSync(app), `${built.stdout}${built.stderr}`.split('\n').filter(line => /error/.test(line)).join('\n'))

  if (existsSync(app)) {
    // the simulator is one device the whole machine shares: held from the first simctl call to the last (D017)
    const release = holdDeviceSync('simulator', 'uikit-make ios')

    try {
      spawnSync('xcrun', ['simctl', 'terminate', found.udid, IDENTIFIER], { stdio: 'ignore' })
      spawnSync('xcrun', ['simctl', 'uninstall', found.udid, IDENTIFIER], { stdio: 'ignore' })
      spawnSync('xcrun', ['simctl', 'install', found.udid, app], { stdio: 'ignore' })
      const ran = spawnSync('xcrun', ['simctl', 'launch', '--console', '--terminate-running-process', found.udid, IDENTIFIER], { encoding: 'utf8', timeout: 120_000 })
      const output = `${ran.stdout ?? ''}${ran.stderr ?? ''}`
      ok('uikit: that app presses twice and reads it back from UIKit', output.split('\n').map(line => line.trim()).includes(WANT), output.slice(-800))
      ok('uikit: it exits 0', output.includes('native-view exit 0'), output.slice(-400))
    } finally {
      release()
    }
  }
}

// 3. signed, where the keychain holds one team's identity
if (!team) {
  console.log('skip  uikit: the ad hoc .ipa (no Apple signing identity in the keychain: Xcode → Settings → Accounts)')
} else {
  try {
    const { app: ipa } = await makeUikit({ root: APP, team, link: 'https://example.invalid/uikit' })
    ok(`uikit: signed ad hoc for ${team}, exported as an .ipa`, existsSync(ipa), ipa)
    const unpacked = join(out, 'unpacked')
    rmSync(unpacked, { recursive: true, force: true })
    spawnSync('ditto', ['-x', '-k', ipa, unpacked])
    const verified = spawnSync('codesign', ['--verify', '--deep', '--strict', join(unpacked, 'Payload', `${NAME}.app`)], { encoding: 'utf8' })
    ok('uikit: its signature verifies', verified.status === 0, verified.stderr)
    ok('uikit: it carries the ad hoc profile', existsSync(join(unpacked, 'Payload', `${NAME}.app`, 'embedded.mobileprovision')))
    ok('uikit: the install page and manifest are written beside it', existsSync(join(out, 'export', 'index.html')) && existsSync(join(out, 'export', 'manifest.plist')))
  } catch (e) {
    ok('uikit: signed ad hoc', false, String((e as Error).message ?? e))
  }
}

console.log(`\nuikit-make: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
