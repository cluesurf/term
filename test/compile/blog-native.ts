// The blog with no WebView (native-dom-0014): the blog app's own page entry (deck/site/test/site/face/base.tree, the
// same `boot` its cask runs inside a WebView) compiled with the toolkit host, so its views are AppKit views on macOS,
// UIKit views on the iOS simulator and Android views on the emulator, and its database is SQLite in the same process,
// with no bridge between them. The program opens a native window, launches `boot` (which opens the database in the
// app's data directory, reads the posts and mounts the blog on the window's root), types a post into the platform's
// own text fields, presses the platform's own button, and prints the tree as read back FROM THE VIEWS before and after,
// then writes a PNG of the screen.
//
// The check: the new post's title is in the tree after the press and not before, so the store (SQLite) and the
// renderer (the toolkit host) both ran natively. SNAPSHOT_BLOG, SNAPSHOT_BLOG_IOS and SNAPSHOT_BLOG_ANDROID name where
// each PNG goes; they are how the screenshots in note/term/project/native-dom/ are made. BLOG_ONLY=macos (or ios,
// android) runs one platform. Run: npx tsx test/compile/blog-native.ts

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

const ROOT = process.cwd()
const dir = mkdtempSync(join(tmpdir(), 'term-blog-native-'))

// a title no earlier run wrote: the database persists in the app's data directory between runs
const title = (env: string): string => `Native post ${env} ${Date.now()}`

const program = (heading: string, shot: string): string => `load @term/site/test/site/face/base
  find boot

load @term/site/code/dom/dom
  find view
  find page-body

load @term/site/code/dom/native/toolkit/dom
  find open-root
  find launch
  find run-app
  find exit-app
  find show-window
  find serialize
  find child-at
  find type-text
  find press
  find later
  find snapshot
  find say

task check
  note async
  like void
  call boot
    wait true
  save root
    call page-body
  call show-window
  call say
    text <before {{serialize(read root)}}>
  save blog
    call child-at
      read root
      code 0
  call type-text
    call child-at
      read blog
      code 0
    text <${heading}>
  call type-text
    call child-at
      read blog
      code 1
    text <Written natively, kept in SQLite>
  call press
    call child-at
      read blog
      code 2
  # the store is asynchronous: the post is drawn once it is kept, so the tree is read on a later turn
  call later
    task after
      save shown
        call serialize
          read root
      call say
        text <after {{shown}}>
      call snapshot
        text <${shot}>
      call exit-app
        code 0

task main
  call open-root
    text <Term blog>
    code 640
    code 480
  call launch
    read check
  call run-app
`

const readRuntime = (file: string): string | undefined => (existsSync(file) ? readFileSync(file, 'utf8') : undefined)

// compile the blog for one Apple platform, with the prelude its natives dock, into one Swift file
function swiftFor(env: 'macos' | 'ios', heading: string, shot: string): string | undefined {
  const text = program(heading, shot)
  const entry = join(dir, `${env}.tree`)
  writeFileSync(entry, text)
  const result = compile({ file: entry, text }, { resolve: projectResolver(ROOT, env), env })
  ok(`${env}: the blog compiles with the toolkit host`, result.ok, result.ok ? '' : result.diagnostics.slice(0, 4).map(d => d.message).join(' | '))

  if (!result.ok) {
    return undefined
  }

  const swift = emitSwift(result.program)
  const prelude = nativePrelude(result.program, env, readRuntime, swift)
  ok(`${env}: no WebView, the program holds the toolkit's views and not a page`, prelude.includes('enum nativeView') && !swift.includes('loadBundle'))
  const file = join(dir, `${env}.swift`)
  // `main` throws when anything it reaches can raise, and a raise nothing handles ends the program
  const start = /func main\(\)[^{]*throws/.test(swift) ? 'try main()' : 'main()'
  writeFileSync(file, ['import Foundation', prelude, swift, start, ''].join('\n'))

  return file
}

function builds(label: string, command: string, args: string[]): boolean {
  try {
    execFileSync(command, args, { stdio: 'pipe' })
    ok(`${label}: builds`, true)

    return true
  } catch (e) {
    const text = String((e as { stderr?: Buffer }).stderr ?? e)
    ok(`${label}: builds`, false, text.split('\n').filter(l => /error:|e: /.test(l)).join('\n').slice(0, 1600) || text.slice(0, 800))

    return false
  }
}

// what every platform must print: the blog read back from its own views, before and after the post
function judge(env: string, toolkit: string, output: string, heading: string, shot: string): void {
  const said = output.split('\n').map(l => l.slice(Math.max(0, l.indexOf('before '), l.indexOf('after '))).trim())
  const before = said.find(l => l.startsWith('before ')) ?? ''
  const after = said.find(l => l.startsWith('after ')) ?? ''
  ok(`${env}: the blog mounted on the window, inputs and a button read back from ${toolkit}`, /<input/.test(before) && /<button/.test(before), before.slice(0, 300))
  ok(`${env}: the new post was not there before`, !before.includes(heading))
  ok(`${env}: the post typed into the native fields and added by the native button is drawn`, after.includes(heading), after.slice(0, 400))
  ok(`${env}: a PNG of the screen was written`, existsSync(shot) && readFileSync(shot).subarray(1, 4).toString() === 'PNG', shot)
}

function runMacos(): void {
  const heading = title('macos')
  const shot = process.env.SNAPSHOT_BLOG ?? join(dir, 'macos.png')
  const file = swiftFor('macos', heading, shot)
  const exe = join(dir, 'macos')

  if (!file || !builds('macos', 'swiftc', ['-o', exe, file])) {
    return
  }

  const run = spawnSync(exe, [], { encoding: 'utf8', timeout: 60_000 })
  // an NSException states its reason near the top of stderr, before the backtrace
  const reason = run.stderr.split('\n').filter(l => /reason|Fatal error|\*\*\*/.test(l)).join('\n')
  ok('macos: the app exits 0', run.status === 0, `exit ${run.status} ${run.signal ?? ''}: ${reason || run.stderr.slice(0, 1200)}`)
  judge('macos', 'AppKit', run.stdout, heading, shot)
}

// the simulator SDK, a flat .app, installed clean on a booted iPhone simulator, its console read until it exits
function runIos(): void {
  const found = simulator()

  if ('missing' in found) {
    console.log(`skip  ios  (${found.missing})`)

    return
  }

  const heading = title('ios')
  const shot = process.env.SNAPSHOT_BLOG_IOS ?? join(dir, 'ios.png')
  const file = swiftFor('ios', heading, shot)
  const identifier = 'surf.term.blog-native-test'
  const bundle = assembleIosBundle({ out: join(dir, 'ios'), name: 'Blog', identifier, version: '0.0.2' })
  const sdk = execFileSync('xcrun', ['-sdk', 'iphonesimulator', '--show-sdk-path'], { encoding: 'utf8' }).trim()

  if (!file || !builds('ios', 'xcrun', ['-sdk', 'iphonesimulator', 'swiftc', '-target', 'arm64-apple-ios17.0-simulator', '-sdk', sdk, '-o', bundle.exe, file])) {
    return
  }

  spawnSync('xcrun', ['simctl', 'terminate', found.udid, identifier], { stdio: 'ignore' })
  spawnSync('xcrun', ['simctl', 'uninstall', found.udid, identifier], { stdio: 'ignore' })
  execFileSync('xcrun', ['simctl', 'install', found.udid, bundle.app], { stdio: 'pipe' })
  const run = spawnSync('xcrun', ['simctl', 'launch', '--console', '--terminate-running-process', found.udid, identifier], {
    encoding: 'utf8',
    timeout: 120_000,
  })
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
  ok('ios: the app said it exits 0', output.includes('native-view exit 0'), output.slice(0, 600))
  judge('ios', 'UIKit', output, heading, shot)
}

// kotlinc and d8, an APK with no assets, installed on the emulator, the `native-dom` log read until the app says it
// exits, and the PNG pulled out of the app's external files directory
function runAndroid(): void {
  const found = androidDevice()

  if ('missing' in found) {
    console.log(`skip  android  (${found.missing})`)

    return
  }

  const tools = androidTools()
  const adb = (...args: string[]) => spawnSync(tools.adb, ['-s', found.serial, ...args], { encoding: 'utf8' })
  const identifier = 'surf.term.blognative'
  const work = join(dir, 'android')
  const assets = join(work, 'assets')
  mkdirSync(assets, { recursive: true })
  const heading = title('android')
  const entry = join(dir, 'android.tree')
  writeFileSync(entry, program(heading, 'native-dom.png'))

  let apk: string

  try {
    const { dex } = buildAndroidProgram({
      root: ROOT,
      entry,
      identifier,
      // the Activity Android starts runs the program inside onCreate, once a view can be made
      driver: ['class TermActivity : TermViewActivity() {', '  override fun program() { main() }', '}'].join('\n'),
      work,
      env: 'android',
    })
    apk = assembleApk({ out: work, name: 'Blog', identifier, version: '0.0.2', dex, assets, work })
    ok('android: builds', true)
  } catch (e) {
    ok('android: builds', false, String((e as { stderr?: Buffer }).stderr ?? e).split('\n').filter(l => /error|e: /.test(l)).join('\n').slice(0, 1600))

    return
  }

  adb('uninstall', identifier)
  adb('logcat', '-c')
  const installed = adb('install', '-r', apk)
  ok('android: installs', installed.status === 0, `${installed.stdout}${installed.stderr}`.slice(0, 400))
  adb('shell', 'am', 'start', '-n', `${identifier}/.TermActivity`)

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
  ok('android: the app said it exits 0', said.includes('native-view exit 0'), log.slice(-600))

  const shot = process.env.SNAPSHOT_BLOG_ANDROID ?? join(dir, 'android.png')
  const pulled = spawnSync(tools.adb, ['-s', found.serial, 'exec-out', 'cat', `/sdcard/Android/data/${identifier}/files/native-dom.png`])

  if (pulled.status === 0 && pulled.stdout.length > 0) {
    writeFileSync(shot, pulled.stdout)
  }

  judge('android', 'Android views', said, heading, shot)
}

const only = process.env.BLOG_ONLY ?? ''
const apple = process.platform === 'darwin'

if (!only || only === 'macos') {
  apple ? runMacos() : console.log('skip  macos  (AppKit is macOS only)')
}

if (!only || only === 'ios') {
  apple ? runIos() : console.log('skip  ios  (the iOS simulator is macOS only)')
}

if (!only || only === 'android') {
  runAndroid()
}

console.log(`\nblog-native: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
