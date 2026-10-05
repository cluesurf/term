// The Rust cask's update client on Linux and Windows themselves (native-dom-0032): the update app (deck/cask/test/update)
// built as a Rust cask, run on the target's own machine, launched, updated, launched again. The same witness as
// test/call/update-app.ts on macOS and update-app-android.ts: the exit status is decided by which page's code ran
// inside the WebView, 11 for the shipped page and 12 for the update. What only these platforms can show is the one
// per-platform part of the client: `done` called back on the UI thread, through glib on Linux and the cask's executor
// on Windows. update-rust.ts runs the client's whole lifecycle with no window, and cannot.
//
// The update rides inside the app: published into its own resources (`served`), and the driver points the client at
// `file://<bundle path>/served`, which the Rust client reads as it reads https. So the machine needs no server and no
// tunnel, and the update the first launch fetches stays in the app's files for the second.
//
//   UPDATE_REMOTE=linux     the work droplet, inside make/Dockerfile.linux (CASK_DROPLET, or the droplet's address
//                           through zone, as the Linux cask suites)
//   UPDATE_REMOTE=windows   the Windows machine WINDOWS_VM names, with MSVC, Rust and a logged-in desktop
//                           (`pnpm term:ec2-windows --commit --cask` rents one)
//
// Both build and launch through task/term/cask/rust-remote.ts, the code app-smoke uses.
// Run: UPDATE_REMOTE=windows npx tsx test/call/update-app-remote.ts
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assembleRustBundle, buildPage, buildRustProgram, crateOf, stampRuntimeVersion } from '@term/call/code/cask'
import { publishUpdate, stampUpdateKey } from '@term/call/code/update'
// as its default: the task/ scripts are CommonJS, whose exports Node finds only on `default`
import remoteRust from '../../../../../../task/term/cask/rust-remote'

type RemoteTarget = 'linux' | 'windows'

const target = process.env.UPDATE_REMOTE as RemoteTarget

if (target !== 'linux' && target !== 'windows') {
  console.log('update-app-remote: UPDATE_REMOTE=linux or windows names the machine')
  process.exit(1)
}

let pass = 0
let fail = 0

function ok(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  ${info.slice(-1200)}`)
  }
}

const TERM = process.cwd()
const CASK = join(TERM, 'deck/cask')
const APP = join(CASK, 'test/update')
const NAME = 'TermUpdate'
const identifier = `surf.term.update-${target}`
const dir = mkdtempSync(join(tmpdir(), `term-update-${target}-`))
const keyFile = join(dir, 'key.pem')
const entry = `import { boot } from './app'\nboot()\n`
// how long one launch may take before it counts as hung
const TIMEOUT = 60_000

// the status the page left with, from what the launch said
function statusOf(said: string): number | undefined {
  const found = /cask exit (\d+)/.exec(said)

  return found ? Number(found[1]) : undefined
}

async function main(): Promise<void> {
  const bundle = assembleRustBundle({ out: join(dir, 'app'), name: NAME, target })
  await buildPage({ root: TERM, page: join(APP, 'page.tree'), entry, into: join(bundle.resources, 'webview'), title: 'Term update', work: join(dir, 'work/page') })
  const crate = crateOf(NAME)
  const { project, native } = buildRustProgram({
    root: CASK,
    entry: join(APP, 'main.tree'),
    // the resources directory and the update "server": the app's own `served`, as a file URL
    driver: 'boot(cask::bundle_path(), format!("file://{}/served", cask::bundle_path()));',
    work: join(dir, 'work'),
    crate,
    target,
  })
  const version = stampRuntimeVersion({ target, native, into: bundle.resources })
  stampUpdateKey({ identifier, into: bundle.resources, keyFile })
  ok(`${target}: the app builds with its runtime version and update key`, version.hex.length === 64)

  // the update: the other page, built the same way, published for exactly this runtime version, inside the app
  const next = join(dir, 'next')
  await buildPage({ root: TERM, page: join(APP, 'page-next.tree'), entry, into: next, title: 'Term update', work: join(dir, 'work/next') })
  const published = publishUpdate({ page: next, out: join(bundle.resources, 'served'), identifier, platform: target, runtimeVersion: version.hex, channel: 'main', keyFile })
  ok(`${target}: the update is published for ${target}`, published.manifest.metadata.platform === target)

  const machine = remoteRust.buildRemoteRust({ target, term: TERM, project, name: NAME, crate })
  machine.ship(bundle.app)

  const first = machine.launch(TIMEOUT)
  ok(`${target}: the first launch runs the shipped page`, statusOf(first) === 11, first)
  const second = machine.launch(TIMEOUT)
  ok(`${target}: the second launch runs the update it fetched`, statusOf(second) === 12, second)
  const third = machine.launch(TIMEOUT)
  ok(`${target}: and keeps running it`, statusOf(third) === 12, third)

  console.log(`\nupdate-app-remote: ${pass} pass, ${fail} fail`)

  if (fail > 0) {
    process.exit(1)
  }
}

main().catch(error => {
  console.log(`FAIL  update-app-remote ${target}  ${String(error instanceof Error ? error.message : error).slice(0, 1600)}`)
  console.log(`\nupdate-app-remote: ${pass} pass, ${fail + 1} fail`)
  process.exit(1)
})
