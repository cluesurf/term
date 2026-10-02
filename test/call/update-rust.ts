// The Rust cask's update client (native-dom-0032), the twin of cask-update.swift and cask-update.kt, through its whole
// lifecycle: a Term program (deck/cask/test/update/rust.tree) calling the three update tasks, built by the cask's own
// Rust pipeline (buildRustProgram, which also `cargo check`s it against the runtime), then compiled and run on this
// machine, one launch per step, against an update the real publisher signed (deck/call/code/update.ts).
//
// Only the hop back to the UI thread differs by platform (glib on Linux, the cask's executor on Windows); everywhere
// else the future runs on the calling thread, which is what runs here. The statuses are the other clients' own.
// Skips without cargo. Run: npx tsx test/call/update-rust.ts

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRustProgram } from '@term/call/code/cask'
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

if (spawnSync('cargo', ['--version']).status !== 0) {
  console.log('skip  update-rust  (no cargo)')
  console.log('\nupdate-rust: 0 pass, 0 fail, 1 skipped')
  process.exit(0)
}

const TERM = process.cwd()
const CASK = join(TERM, 'deck/cask')
const dir = mkdtempSync(join(tmpdir(), 'term-update-rust-'))
const identifier = 'surf.term.update-rust-test'
const keyFile = join(dir, 'key.pem')
const runtimeVersion = 'a'.repeat(64)
// the publisher's platform name for this machine, the one the client builds its manifest path from
const platform = ({ darwin: 'macos', linux: 'linux', win32: 'windows' } as Record<string, string>)[process.platform]!

// the driver: one step per launch, as the arguments say
const driver = [
  'let args: Vec<String> = std::env::args().collect();',
  '  match args[1].as_str() {',
  '    "launch" => println!("page {}", launch(args[2].clone(), args[3].clone())),',
  '    "check" => fetch_update(args[2].clone(), args[3].clone(), args[4].clone(), std::rc::Rc::new(|status: String| println!("status {}", status))),',
  '    "ready" => mark_ready(args[2].clone()),',
  '    _ => {}',
  '  }',
].join('\n')

const built = buildRustProgram({ root: CASK, entry: join(CASK, 'test/update/rust.tree'), driver, work: join(dir, 'work'), crate: 'update_rust', target: 'linux' })
ok('the program builds through the cask pipeline, and cargo check holds it to the runtime', built.native.includes('mod cask_update'))
execFileSync('cargo', ['build', '--release', '--quiet'], { cwd: built.project, stdio: 'inherit' })
const exe = join(built.project, 'target/release/update_rust')

// the app as shipped: its runtime version and public key in its resources, and its own page
function resourcesWith(key: string): string {
  const resources = mkdtempSync(join(dir, 'resources-'))
  writeFileSync(join(resources, 'runtime-version'), runtimeVersion)
  stampUpdateKey({ identifier, into: resources, keyFile: key })
  mkdirSync(join(resources, 'webview'), { recursive: true })
  writeFileSync(join(resources, 'webview/index.html'), '<p>shipped</p>')

  return resources
}

// one update, published by the real publisher for this platform and runtime version
function published(name: string): { served: string; id: string } {
  const page = join(dir, `page-${name}`)
  mkdirSync(page, { recursive: true })
  writeFileSync(join(page, 'index.html'), `<p>${name}</p>`)
  writeFileSync(join(page, 'app.js'), `console.log(${JSON.stringify(name)})`)
  const served = join(dir, `served-${name}`)
  const result = publishUpdate({ page, out: served, identifier, platform, runtimeVersion, channel: 'main', keyFile })

  return { served, id: result.manifest.id }
}

const run = (...args: string[]): string => spawnSync(exe, args, { encoding: 'utf8', timeout: 60_000 }).stdout.trim()
const page = (resources: string, data: string) => run('launch', resources, data).replace(/^page /, '')
const check = (resources: string, data: string, served: string) => run('check', resources, data, `file://${served}`).replace(/^status /, '')

const resources = resourcesWith(keyFile)
const update = published('next')

{
  const data = mkdtempSync(join(dir, 'data-'))
  ok('with nothing downloaded the shipped page loads', page(resources, data) === join(resources, 'webview'))
  ok('a check applies the published update', check(resources, data, update.served) === `applied ${update.id}`)
  ok('a second check finds it current', check(resources, data, update.served) === 'current')
  const loaded = page(resources, data)
  ok('the next launch loads the update', loaded === join(data, 'updates', update.id) && readFileSync(join(loaded, 'index.html'), 'utf8') === '<p>next</p>', loaded)
  run('ready', data)
  ok('a launch that reached ready keeps it', page(resources, data) === join(data, 'updates', update.id))
  // this launch never says ready, so the one after it rolls back
  const after = page(resources, data)
  ok('a launch that never reached ready is rolled back to the shipped page', after === join(resources, 'webview'), after)
  ok('and the update it ran is refused from then on', check(resources, data, update.served) === `refused: ${update.id} failed a launch`)
}

{
  // the signature over other bytes: the manifest is edited after signing
  const data = mkdtempSync(join(dir, 'data-'))
  const tampered = published('tampered')
  const manifest = join(tampered.served, platform, runtimeVersion, 'main.json')
  writeFileSync(manifest, readFileSync(manifest, 'utf8').replace('"main"', '"main" '))
  ok('a manifest changed after signing is refused', check(resources, data, tampered.served) === 'refused: the signature does not verify')
}

{
  // an app holding another key refuses an update this key signed
  const data = mkdtempSync(join(dir, 'data-'))
  const stranger = resourcesWith(join(dir, 'other-key.pem'))
  ok('an update signed by another key is refused', check(stranger, data, update.served) === 'refused: the signature does not verify')
}

{
  // an asset changed on the server after publishing: the signed manifest still names the old hash
  const data = mkdtempSync(join(dir, 'data-'))
  const swapped = published('swapped')
  const manifest = JSON.parse(readFileSync(join(swapped.served, platform, runtimeVersion, 'main.json'), 'utf8')) as {
    assets: { key: string; url: string }[]
  }
  const script = manifest.assets.find(asset => asset.key === 'app.js')!
  writeFileSync(join(swapped.served, script.url), 'console.log("not what was signed")')
  ok('an asset that does not match its hash is refused', check(resources, data, swapped.served) === 'refused: app.js does not match its hash')
  ok('and nothing of it is current', page(resources, data) === join(resources, 'webview'))
}

{
  const data = mkdtempSync(join(dir, 'data-'))
  ok('a base with nothing published is none', check(resources, data, join(dir, 'nothing-here')) === 'none')
}

console.log(`\nupdate-rust: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
