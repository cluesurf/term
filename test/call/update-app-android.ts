// A real Android app taking an over-the-air update (native-dom-0023): the update app (deck/cask/test/update) built as an
// APK with kotlinc and d8, its runtime version and update key in its assets, installed on the emulator, launched,
// updated, launched again. The same witness as test/call/update-app.ts: the exit status is decided by which page's
// code ran inside the WebView, 11 for the shipped page and 12 for the update.
//
// The emulator cannot read this machine's files, so the updates are served over HTTP by a small server in a second
// process, reached from the emulator through `adb reverse`. Skipped, with the reason, when no device is online.
// Run: npx tsx test/call/update-app-android.ts

import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { androidDevice, androidTools, assembleApk, buildAndroidProgram, buildPage, caskAndroidDriver, stampRuntimeVersion } from '@term/call/code/cask'
import { publishUpdate, stampUpdateKey } from '@term/call/code/update'

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

const found = androidDevice()

if ('missing' in found) {
  console.log(`skip  update-app-android  (${found.missing})`)
  console.log('\nupdate-app-android: 0 pass, 0 fail, 1 skipped')
  process.exit(0)
}

const TERM = process.cwd()
const CASK = join(TERM, 'deck/cask')
const APP = join(CASK, 'test/update')
const dir = mkdtempSync(join(tmpdir(), 'term-update-android-'))
const identifier = 'surf.term.updateandroid'
const keyFile = join(dir, 'key.pem')
const served = join(dir, 'served')
const PORT = 5287
const entry = `import { boot } from './app'\nboot()\n`
const tools = androidTools()
const adb = (...args: string[]) => spawnSync(tools.adb, ['-s', found.serial, ...args], { encoding: 'utf8' })

// the update server, its own process so it answers while this one waits on the emulator
const server = spawn(
  process.execPath,
  [
    '-e',
    `const http=require('http'),fs=require('fs'),path=require('path');const root=${JSON.stringify(served)};` +
      `http.createServer((q,s)=>{const f=path.join(root,decodeURIComponent(q.url.split('?')[0]));` +
      `if(!f.startsWith(root)||!fs.existsSync(f)||fs.statSync(f).isDirectory()){s.writeHead(404);s.end();return}` +
      `s.writeHead(200);fs.createReadStream(f).pipe(s)}).listen(${PORT},'127.0.0.1')`,
  ],
  { stdio: 'ignore' },
)

// launch, and read the status the page left with from the cask's log
function launch(): number | undefined {
  adb('logcat', '-c')
  adb('shell', 'am', 'start', '-W', '-n', `${identifier}/.TermActivity`)
  const deadline = Date.now() + 60_000

  while (Date.now() < deadline) {
    const log = adb('logcat', '-d', '-s', 'cask:I').stdout ?? ''
    const said = /cask exit (\d+)/.exec(log)

    if (said) {
      return Number(said[1])
    }

    spawnSync('sleep', ['1'])
  }

  return undefined
}

async function main(): Promise<void> {
  const work = join(dir, 'work')
  const assets = join(work, 'assets')
  mkdirSync(assets, { recursive: true })
  await buildPage({ root: TERM, page: join(APP, 'page.tree'), entry, into: join(assets, 'webview'), title: 'Term update', work: join(work, 'page') })
  const { dex, native } = buildAndroidProgram({
    root: CASK,
    entry: join(APP, 'main.tree'),
    identifier,
    // the app's own files directory as its resources, the update server through adb reverse
    driver: caskAndroidDriver(`boot(cask.bundlePath(), "http://localhost:${PORT}")`),
    work,
  })
  const version = stampRuntimeVersion({ target: 'android', native, into: assets })
  stampUpdateKey({ identifier, into: assets, keyFile })
  const apk = assembleApk({ out: work, name: 'TermUpdate', identifier, version: '0.0.2', dex, assets, work })
  ok('the APK builds with its runtime version and update key', version.hex.length === 64)

  const next = join(dir, 'next')
  await buildPage({ root: TERM, page: join(APP, 'page-next.tree'), entry, into: next, title: 'Term update', work: join(work, 'next') })
  const published = publishUpdate({ page: next, out: served, identifier, platform: 'android', runtimeVersion: version.hex, channel: 'main', keyFile })
  ok('the update is published for android', published.manifest.metadata.platform === 'android')

  adb('reverse', `tcp:${PORT}`, `tcp:${PORT}`)
  adb('uninstall', identifier)
  ok('the APK installs', adb('install', '-r', apk).status === 0)

  const first = launch()
  ok('the first launch runs the shipped page', first === 11, `exit ${first}`)
  const second = launch()
  ok('the second launch runs the update', second === 12, `exit ${second}`)
  const third = launch()
  ok('and keeps running it', third === 12, `exit ${third}`)

  adb('reverse', '--remove', `tcp:${PORT}`)
  server.kill()
  console.log(`\nupdate-app-android: ${pass} pass, ${fail} fail`)

  if (fail > 0) {
    process.exit(1)
  }
}

main().catch(error => {
  server.kill()
  console.log(`FAIL  update-app-android  ${String(error).slice(0, 1200)}`)
  process.exit(1)
})
