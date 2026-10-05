// A real app taking an over-the-air update (native-dom-0024): the update app (deck/cask/test/update) built the way
// the cask builds every macOS app, its runtime version and update key stamped in, launched, updated, launched again.
//
//   1. the app ships page.tree, which leaves with status 11
//   2. page-next.tree (status 12) is published as a signed update for the runtime version the build stamped
//   3. the first launch runs the shipped page (11) and, before it does, fetches the update for the next launch
//   4. the second launch runs the update (12)
//
// Twice: with the window opened at boot, and with it opened late inside the check's callback, where the window lives
// only because the cask holds every open window (native-dom-0028).
//
// The exit status is the witness: it is decided by which page's code ran inside the WebView, so 12 means the
// downloaded page was loaded and executed, not just that a file appeared somewhere. macOS only.
// Run: npx tsx test/call/update-app.ts

import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assembleBundle, buildPage, buildProgram, signBundle, stampRuntimeVersion } from '@term/call/code/cask'
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

if (process.platform !== 'darwin') {
  console.log('skip  update-app  (the update tasks are the Swift cask\'s, and this builds a macOS app)')
  console.log('\nupdate-app: 0 pass, 0 fail, 1 skipped')
  process.exit(0)
}

const TERM = process.cwd()
const CASK = join(TERM, 'deck/cask')
const APP = join(CASK, 'test/update')
const dir = mkdtempSync(join(tmpdir(), 'term-update-app-'))
const identifier = 'surf.term.update-app-test'
const keyFile = join(dir, 'key.pem')
const entry = `import { boot } from './app'\nboot()\n`

// one app, shipped, updated, launched three times. `cask` is the cask entry: ./main.tree opens its window at boot,
// ./main-late.tree inside the update check's callback, where only the cask holding open windows keeps it alive
async function scenario(label: string, cask: string): Promise<void> {
  const at = join(dir, label)
  const served = join(at, 'served')
  const bundle = assembleBundle({ out: join(at, 'app'), name: 'TermUpdate', identifier, version: '0.0.2' })
  const pageDir = join(bundle.resources, 'webview')
  await buildPage({ root: TERM, page: join(APP, 'page.tree'), entry, into: pageDir, title: 'Term update', work: join(at, 'work/page') })
  const program = buildProgram({
    root: CASK,
    entry: join(APP, cask),
    // the resources directory and the update server, the way an app carries its own address. Swift, so by label: a
    // task's inputs are labeled by name (compile/swift.ts)
    driver: `boot(resources: ${JSON.stringify(bundle.resources)}, base: ${JSON.stringify(`file://${served}`)})`,
    exe: bundle.exe,
    work: join(at, 'work'),
  })
  const version = stampRuntimeVersion({ target: 'macos', native: program.native, into: bundle.resources })
  stampUpdateKey({ identifier, into: bundle.resources, keyFile })
  signBundle({ app: bundle.app })
  ok(`${label}: the app builds with its runtime version and update key`, version.hex.length === 64)

  // the update: the other page, built the same way, published for exactly this runtime version
  const next = join(at, 'next')
  await buildPage({ root: TERM, page: join(APP, 'page-next.tree'), entry, into: next, title: 'Term update', work: join(at, 'work/next') })
  const published = publishUpdate({ page: next, out: served, identifier, platform: 'macos', runtimeVersion: version.hex, channel: 'main', keyFile })
  ok(`${label}: the update is published`, published.manifest.runtimeVersion === version.hex)

  const launch = () => spawnSync(bundle.exe, [], { encoding: 'utf8', timeout: Number(process.env.UPDATE_APP_TIMEOUT ?? 60_000) })
  const said = (run: ReturnType<typeof launch>) => `exit ${run.status} ${run.signal ?? ''}: ${(run.stdout + run.stderr).slice(-400)}`

  const first = launch()
  ok(`${label}: the first launch runs the shipped page`, first.status === 11, said(first))

  const second = launch()
  ok(`${label}: the second launch runs the update`, second.status === 12, said(second))

  const third = launch()
  ok(`${label}: and keeps running it`, third.status === 12, said(third))
}

async function main(): Promise<void> {
  await scenario('window at boot', 'main.tree')
  await scenario('window opened late', 'main-late.tree')

  console.log(`\nupdate-app: ${pass} pass, ${fail} fail`)

  if (fail > 0) {
    process.exit(1)
  }
}

void main()
