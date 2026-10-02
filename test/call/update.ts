// Over-the-air page updates (native-dom-0016), end to end on Apple's runtime: the publisher (deck/call/code/update.ts)
// writes real signed updates into a directory served as file://, and the client (deck/cask/code/native/swift/runtime/
// cask-update.swift, built as is with a small driver) launches, checks, and is ready, one step per process the way an
// app's launches are separate processes. Between steps this test publishes, tampers, or crashes.
//
// What must hold:
//   - the first launch runs the page shipped in the app
//   - a published update is fetched, verified and staged, and runs from the NEXT launch, never under a running page
//   - a forged signature, a manifest for another runtime version, and an asset whose bytes do not match the signed
//     hash are each refused, and nothing they carry is ever launched
//   - a launch that crashes before its first render rolls back to the shipped page at the next launch, and that
//     update is never run again
// macOS only (swiftc and the Security framework). Run: npx tsx test/call/update.ts

import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { publishUpdate, signManifest, stampUpdateKey, updateKey } from '@term/call/code/update'

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

if (process.platform !== 'darwin') {
  console.log('skip  update  (the Apple client needs swiftc and the Security framework)')
  console.log('\nupdate: 0 pass, 0 fail, 1 skipped')
  process.exit(0)
}

const TERM = process.cwd()
const dir = mkdtempSync(join(tmpdir(), 'term-update-'))
const keyFile = join(dir, 'key.pem')
const identifier = 'surf.term.update-test'
const VERSION = 'a'.repeat(64)

// the app as built: a shipped page, its runtime version, and the public half of the update key
const resources = join(dir, 'app')
mkdirSync(join(resources, 'webview'), { recursive: true })
writeFileSync(join(resources, 'webview', 'index.html'), 'shipped')
writeFileSync(join(resources, 'runtime-version'), `${VERSION}\n`)
stampUpdateKey({ identifier, into: resources, keyFile })
const data = join(dir, 'data')
const served = join(dir, 'served')

// a page directory with this text as its index
function page(name: string, text: string): string {
  const at = join(dir, 'pages', name)
  mkdirSync(at, { recursive: true })
  writeFileSync(join(at, 'index.html'), text)
  writeFileSync(join(at, 'app.js'), `console.log(${JSON.stringify(text)})`)

  return at
}

function publish(name: string, text: string, runtimeVersion = VERSION) {
  return publishUpdate({ page: page(name, text), out: served, identifier, platform: 'macos', runtimeVersion, channel: 'main', keyFile })
}

// the driver: the real client file, plus a `main` that runs one step and prints what it answered
const driver = join(dir, 'driver.swift')
writeFileSync(
  driver,
  [
    readFileSync(join(TERM, 'deck/cask/code/native/swift/runtime/cask-update.swift'), 'utf8'),
    `let step = CommandLine.arguments[1]
let resources = ${JSON.stringify(resources)}
let data = ${JSON.stringify(data)}
switch step {
case "launch":
  let path = caskUpdate.launchPath(resources, "webview", data)
  print((try? String(contentsOfFile: path + "/index.html", encoding: .utf8)) ?? "missing")
case "check":
  // \`done\` arrives on the main thread, so the main queue must be running to hear it
  caskUpdate.check(resources, data, ${JSON.stringify(`file://${served}`)}, "main") { status in
    print(status)
    exit(0)
  }
  dispatchMain()
case "ready":
  caskUpdate.ready(data)
  print("ready")
default:
  print("no step \\(step)")
}
`,
  ].join('\n'),
)
const exe = join(dir, 'driver')
execFileSync('swiftc', ['-o', exe, driver], { stdio: 'pipe' })

// what the step printed, or, when it printed nothing, how it ended, so a crash reads as one
const run = (step: string): string => {
  const ran = spawnSync(exe, [step], { encoding: 'utf8' })
  const out = ran.stdout.trim()

  return out || `(nothing printed: exit ${ran.status} ${ran.signal ?? ''} ${ran.stderr.trim().slice(0, 300)})`
}

// 1. nothing published: the shipped page
ok('the first launch runs the shipped page', run('launch') === 'shipped')
ok('ready after a good launch', run('ready') === 'ready')
ok('nothing published reads none', run('check') === 'none')

// 2. a good update: fetched now, run next launch
const second = publish('second', 'second')
ok('a signed update is applied', run('check') === `applied ${second.manifest.id}`)
ok('the next launch runs it', run('launch') === 'second')
ok('ready', run('ready') === 'ready')
ok('checking again reads current', run('check') === 'current')

// 3. a forged signature: the third update's manifest under the second's signature
const third = publish('third', 'third')
const secondSignature = signManifest(Buffer.from(JSON.stringify(second.manifest, null, 2)), updateKey(identifier, keyFile).privatePem)
writeFileSync(`${third.file}.sig`, secondSignature)
ok('a forged signature is refused', run('check') === 'refused: the signature does not verify')
ok('and the running update is untouched', run('launch') === 'second')
run('ready')

// 4. a manifest built for another runtime version, put where this binary looks and signed with the real key
const other = publish('other', 'other', 'b'.repeat(64))
copyFileSync(other.file, third.file)
copyFileSync(`${other.file}.sig`, `${third.file}.sig`)
ok('another runtime version is refused', run('check') === 'refused: built for another runtime version')

// 5. an asset whose bytes are not the ones the signed manifest names
const fourth = publish('fourth', 'fourth')
writeFileSync(join(served, fourth.manifest.launchAsset.url), 'tampered')
ok('a tampered asset is refused', run('check') === 'refused: index.html does not match its hash')
ok('and nothing it carried runs', run('launch') === 'second')
run('ready')

// 6. a crash before the first render: launch, never ready, launch again
const fifth = publish('fifth', 'fifth')
ok('a fifth update is applied', run('check') === `applied ${fifth.manifest.id}`)
ok('the next launch runs it', run('launch') === 'fifth')
// no `ready`: this launch crashed before it drew anything
ok('the launch after a crash rolls back to the shipped page', run('launch') === 'shipped')
run('ready')
ok('the failed update is never offered again', run('check') === `refused: ${fifth.manifest.id} failed a launch`)

console.log(`\nupdate: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
