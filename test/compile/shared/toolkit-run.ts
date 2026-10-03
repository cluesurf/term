// One Term program on the three toolkit hosts: built for macOS with swiftc and run, built for the iPhone simulator into
// a flat .app and launched on a booted simulator with its console read, and built for Android with kotlinc and d8 into
// an APK, installed on the emulator and its `native-dom` log read until it says it exits. Each run's output and the path
// of its PNG are handed to the caller's judge. A helper, not a suite: it sits under shared/, which the runner does not
// walk. Used by test/compile/blog-native.ts and test/compile/toolkit-words.ts.

import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { nativePrelude } from '@term/make/code/compile/native'
import { emitSwift } from '@term/make/code/compile/swift'
import { projectResolver } from '@term/call/code/make'
import {
  androidDevice,
  androidTools,
  assembleApk,
  assembleIosBundle,
  buildAndroidProgram,
  simulator,
} from '@term/call/code/cask'

// a macOS test app opens its window past the right edge of the screens and never takes focus (native-view.swift
// windowAway), run from the gate or by hand alike
process.env.TERM_WINDOW_AWAY ??= '1'

export type Leg = 'macos' | 'ios' | 'android'

export type ToolkitRun = {
  // the Term root, where `@term/*` resolves
  root: string
  // a scratch directory for sources, builds and default PNGs
  dir: string
  // the app's name on iOS and Android, and its identifiers there
  name: string
  iosIdentifier: string
  androidIdentifier: string
  // the program for one platform, writing its PNG at `shot`. Android writes a bare file name into the app's own
  // external files directory, which this then pulls
  program: (leg: Leg, shot: string) => string
  // files the Android app carries in its APK, by asset name, read as `asset:<name>` (a simulator and a Mac read host
  // paths, an emulator cannot)
  assets?: Record<string, string>

  // what the run must have shown, read from its output
  judge: (leg: Leg, toolkit: string, output: string, shot: string) => void
  ok: (name: string, cond: boolean, info?: string) => void
  // where each PNG goes, when set
  shots: Partial<Record<Leg, string>>
}

const TOOLKIT: Record<Leg, string> = { macos: 'AppKit', ios: 'UIKit', android: 'Android views' }

const readRuntime = (file: string): string | undefined => (existsSync(file) ? readFileSync(file, 'utf8') : undefined)

// compile the program for one Apple platform, with the prelude its natives dock, into one Swift file
function swiftFor(run: ToolkitRun, leg: 'macos' | 'ios', shot: string): string | undefined {
  const text = run.program(leg, shot)
  const entry = join(run.dir, `${leg}.tree`)
  writeFileSync(entry, text)
  const result = compile({ file: entry, text }, { resolve: projectResolver(run.root, leg), env: leg })
  run.ok(`${leg}: compiles with the toolkit host`, result.ok, result.ok ? '' : result.diagnostics.slice(0, 4).map(d => d.message).join(' | '))

  if (!result.ok) {
    return undefined
  }

  const swift = emitSwift(result.program)
  const prelude = nativePrelude(result.program, leg, readRuntime, swift)
  run.ok(`${leg}: no WebView, the program holds the toolkit's views and not a page`, prelude.includes('enum nativeView') && !swift.includes('loadBundle'))
  const file = join(run.dir, `${leg}.swift`)
  // `main` throws when anything it reaches can raise, and a raise nothing handles ends the program
  const start = /func main\(\)[^{]*throws/.test(swift) ? 'try main()' : 'main()'
  writeFileSync(file, ['import Foundation', prelude, swift, start, ''].join('\n'))

  return file
}

function builds(run: ToolkitRun, leg: Leg, command: string, args: string[]): boolean {
  try {
    execFileSync(command, args, { stdio: 'pipe' })
    run.ok(`${leg}: builds`, true)

    return true
  } catch (e) {
    const text = String((e as { stderr?: Buffer }).stderr ?? e)
    run.ok(`${leg}: builds`, false, text.split('\n').filter(l => /error:|e: /.test(l)).join('\n').slice(0, 1600) || text.slice(0, 800))

    return false
  }
}

function runMacos(run: ToolkitRun): void {
  const shot = run.shots.macos ?? join(run.dir, 'macos.png')
  const file = swiftFor(run, 'macos', shot)
  const exe = join(run.dir, 'macos')

  if (!file || !builds(run, 'macos', 'swiftc', ['-o', exe, file])) {
    return
  }

  const result = spawnSync(exe, [], { encoding: 'utf8', timeout: 60_000 })
  // an NSException states its reason near the top of stderr, before the backtrace
  const reason = result.stderr.split('\n').filter(l => /reason|Fatal error|\*\*\*/.test(l)).join('\n')
  run.ok('macos: the app exits 0', result.status === 0, `exit ${result.status} ${result.signal ?? ''}: ${reason || result.stderr.slice(0, 1200)}`)
  run.judge('macos', TOOLKIT.macos, result.stdout, shot)
}

// the simulator SDK, a flat .app, installed clean on a booted iPhone simulator, its console read until it exits
function runIos(run: ToolkitRun): void {
  const found = simulator()

  if ('missing' in found) {
    console.log(`skip  ios  (${found.missing})`)

    return
  }

  const shot = run.shots.ios ?? join(run.dir, 'ios.png')
  const file = swiftFor(run, 'ios', shot)
  const bundle = assembleIosBundle({ out: join(run.dir, 'ios'), name: run.name, identifier: run.iosIdentifier, version: '0.0.2' })
  const sdk = execFileSync('xcrun', ['-sdk', 'iphonesimulator', '--show-sdk-path'], { encoding: 'utf8' }).trim()

  if (!file || !builds(run, 'ios', 'xcrun', ['-sdk', 'iphonesimulator', 'swiftc', '-target', 'arm64-apple-ios17.0-simulator', '-sdk', sdk, '-o', bundle.exe, file])) {
    return
  }

  spawnSync('xcrun', ['simctl', 'terminate', found.udid, run.iosIdentifier], { stdio: 'ignore' })
  spawnSync('xcrun', ['simctl', 'uninstall', found.udid, run.iosIdentifier], { stdio: 'ignore' })
  execFileSync('xcrun', ['simctl', 'install', found.udid, bundle.app], { stdio: 'pipe' })
  const result = spawnSync('xcrun', ['simctl', 'launch', '--console', '--terminate-running-process', found.udid, run.iosIdentifier], {
    encoding: 'utf8',
    timeout: 120_000,
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  run.ok('ios: the app said it exits 0', output.includes('native-view exit 0'), output.slice(0, 600))
  run.judge('ios', TOOLKIT.ios, output, shot)
}

// kotlinc and d8, an APK with no assets, installed on the emulator, the `native-dom` log read until the app says it
// exits, and the PNG pulled out of the app's external files directory
function runAndroid(run: ToolkitRun): void {
  const found = androidDevice()

  if ('missing' in found) {
    console.log(`skip  android  (${found.missing})`)

    return
  }

  const tools = androidTools()
  const adb = (...args: string[]) => spawnSync(tools.adb, ['-s', found.serial, ...args], { encoding: 'utf8' })
  const work = join(run.dir, 'android')
  const assets = join(work, 'assets')
  mkdirSync(assets, { recursive: true })

  for (const [name, file] of Object.entries(run.assets ?? {})) {
    copyFileSync(file, join(assets, name))
  }

  const entry = join(run.dir, 'android.tree')
  writeFileSync(entry, run.program('android', 'native-dom.png'))

  let apk: string

  try {
    const { dex } = buildAndroidProgram({
      root: run.root,
      entry,
      identifier: run.androidIdentifier,
      // the Activity Android starts runs the program inside onCreate, once a view can be made
      driver: ['class TermActivity : TermViewActivity() {', '  override fun program() { main() }', '}'].join('\n'),
      work,
      env: 'android',
    })
    apk = assembleApk({ out: work, name: run.name, identifier: run.androidIdentifier, version: '0.0.2', dex, assets, work })
    run.ok('android: builds', true)
  } catch (e) {
    // kotlinc's lines, or else the whole message: a Term compile failure says neither `error` nor `e: `, and the
    // filtered note came back empty for it
    const text = String((e as { stderr?: Buffer }).stderr ?? e)
    const errors = text.split('\n').filter(l => /error|e: /.test(l)).join('\n')
    run.ok('android: builds', false, (errors || text).slice(0, 1600))

    return
  }

  adb('uninstall', run.androidIdentifier)
  adb('logcat', '-c')
  const installed = adb('install', '-r', apk)
  run.ok('android: installs', installed.status === 0, `${installed.stdout}${installed.stderr}`.slice(0, 400))
  adb('shell', 'am', 'start', '-n', `${run.androidIdentifier}/.TermActivity`)

  // the app logs every line under `native-dom` and says when it exits
  let log = ''
  const deadline = Date.now() + 120_000

  while (Date.now() < deadline) {
    log = adb('logcat', '-d', '-s', 'native-dom:I').stdout ?? ''

    if (log.includes('native-view exit')) {
      break
    }

    spawnSync('sleep', ['1'])
  }

  const said = log
    .split('\n')
    .map(line => line.slice(line.indexOf('native-dom:') + 'native-dom:'.length).trim())
    .join('\n')
  run.ok('android: the app said it exits 0', said.includes('native-view exit 0'), log.slice(-600))

  const shot = run.shots.android ?? join(run.dir, 'android.png')
  const pulled = spawnSync(tools.adb, ['-s', found.serial, 'exec-out', 'cat', `/sdcard/Android/data/${run.androidIdentifier}/files/native-dom.png`])

  if (pulled.status === 0 && pulled.stdout.length > 0) {
    writeFileSync(shot, pulled.stdout)
  }

  run.judge('android', TOOLKIT.android, said, shot)
}

// every leg `only` allows ('' for all three), each skipped with its reason where its toolchain or device is absent
export function runToolkits(run: ToolkitRun, only: string): void {
  const apple = process.platform === 'darwin'

  if (!only || only === 'macos') {
    apple ? runMacos(run) : console.log('skip  macos  (AppKit is macOS only)')
  }

  if (!only || only === 'ios') {
    apple ? runIos(run) : console.log('skip  ios  (the iOS simulator is macOS only)')
  }

  if (!only || only === 'android') {
    runAndroid(run)
  }
}
