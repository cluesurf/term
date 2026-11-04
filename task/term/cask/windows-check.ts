// The Windows half of the Rust cask, typechecked on this machine: the data app's cargo project written for the
// windows target and `cargo check --target x86_64-pc-windows-msvc` run on it, which holds the Win32 and WebView2 code
// in deck/cask/code/native/rust/runtime/cask.rs to the `windows` and `webview2-com` crate APIs without a Windows
// box. A run still needs one. Item cask-0009.
//
//   pnpm term:cask-windows-check
//
// Needs the target's standard library, which rustup installs into the user's own toolchain:
//   rustup target add x86_64-pc-windows-msvc
// Runs from the Term root. Writes only under tmp/cask/.
import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { assembleRustBundle, buildRustProgram, crateOf } from '@term/call/code/cask'
import { generateBridge } from '@term/call/code/cask-generate'
import { TERM_ROOT } from '../root'

const TERM = TERM_ROOT
const CASK = join(TERM, 'deck/cask')
const APP = join(CASK, 'test/data')
const OUT = join(TERM, 'tmp/cask')
const TARGET = 'x86_64-pc-windows-msvc'

function fail(text: string): never {
  console.error(`cask  ${text}`)
  console.log('cask/windows-check: 0 pass, 1 fail')
  process.exit(1)
}

const installed = spawnSync('rustup', ['target', 'list', '--installed'], { encoding: 'utf8' })

if (installed.status !== 0 || !installed.stdout.includes(TARGET)) {
  fail(`the ${TARGET} target is not installed. Run: rustup target add ${TARGET}`)
}

mkdirSync(OUT, { recursive: true })
generateBridge({ page: join(APP, 'page.tree'), out: APP, commit: false })
assembleRustBundle({ out: join(OUT, 'windows'), name: 'TermData', target: 'windows' })
const { project } = buildRustProgram({
  root: CASK,
  entry: join(APP, 'main.tree'),
  driver: 'boot(format!("{}/webview", cask::bundle_path()));',
  work: join(OUT, 'work-data-windows'),
  crate: crateOf('TermData'),
  target: 'windows',
})

const checked = spawnSync('cargo', ['check', '--quiet', '--target', TARGET], { cwd: project, stdio: 'inherit' })

if (checked.status !== 0) {
  fail(`cargo check --target ${TARGET} failed in ${project}`)
}

console.log(`cask  the Windows half typechecks for ${TARGET}: ${project}`)
console.log('cask/windows-check: 1 pass, 0 fail')
