// The Rust device hosts (device-layer-0014): the clipboard, the battery, the network and open, through the platform's
// own tools from std (site/code/view/native/rust/runtime). One program compiled for the `rust` env, built with rustc
// and run, each answer read back from the platform where it keeps one: the clipboard by `pbpaste` (macOS) or the same
// tool the runtime wrote with, the battery against `pmset` or /sys/class/power_supply, an address nothing handles
// answering `unavailable`. On this machine it is the macOS branch of each runtime; the Linux branch runs on the work
// droplet through the Rust cask (task/term/app-smoke.ts --app device --target linux).
//
// The person's clipboard is kept and put back. Skips without rustc. Run: npx tsx test/compile/device-rust.ts
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runOn } from './shared/run-on'
import { projectResolver } from '@term/call/code/make'

const ROOT = join(import.meta.dirname, '..', '..')

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

const TOKEN = `term-rust-clipboard-${process.pid}`

const PROGRAM = `load @term/site/view/clipboard
  find read-clipboard
  find write-clipboard

load @term/site/view/battery
  find battery-status
  find watch-battery

load @term/site/view/network
  find network-status

load @term/site/view/open
  find open-address

task run
  like text
  save wrote
    call write-clipboard
      text <${TOKEN}>
  save held
    call read-clipboard
  save battery
    call battery-status
  save network
    call network-status
  save opened
    call open-address
      text <term-no-handler://nothing>
  save heard
    make list
  save drop
    call watch-battery
      task heard-battery
        take value, like text
        call push
          bind list, read heard
          bind item, read value
  call drop
  send back
    text <{wrote}|{held}|{battery}|{network}|{opened}|{join(heard, <,>)}>
`

// the battery the platform reports, as `<level> <state>`'s level, or undefined with no battery
function platformLevel(): number | undefined {
  if (process.platform === 'darwin') {
    const percent = /(\d+)%/.exec(spawnSync('pmset', ['-g', 'batt'], { encoding: 'utf8' }).stdout)?.[1]

    return percent === undefined ? undefined : Number(percent) / 100
  }

  const root = '/sys/class/power_supply'
  const battery = existsSync(root) ? readdirSync(root).find(one => readFileSync(join(root, one, 'type'), 'utf8').trim() === 'Battery') : undefined

  return battery ? Number(readFileSync(join(root, battery, 'capacity'), 'utf8')) / 100 : undefined
}

const kept = process.platform === 'darwin' ? spawnSync('pbpaste', [], { encoding: 'utf8' }).stdout : undefined

try {
  const dir = mkdtempSync(join(tmpdir(), 'device-rust-'))
  const program = PROGRAM.replace('load @term/site/view/open', 'load @term/base/list\n  find push\n\nload @term/base/text/util\n  find join\n\nload @term/site/view/open')
  const ran = runOn({ backend: 'rust', program, resolve: env => projectResolver(ROOT, env, ROOT), dir, name: 'device' })

  if (ran.form === 'skipped') {
    console.log(`skip  device-rust  (${ran.reason})`)
    process.exit(0)
  }

  ok('the device program builds and runs on Rust', ran.form === 'ran', ran.form === 'ran' ? '' : `${ran.stage}: ${ran.reason.slice(0, 1200)}`)

  if (ran.form === 'ran') {
    const [wrote = '', held = '', battery = '', network = '', opened = '', heard = ''] = ran.output.split('|')
    ok('the clipboard takes the line and gives it back', wrote === 'written' && held === TOKEN, `${wrote} ${held}`)

    if (process.platform === 'darwin') {
      const pasted = spawnSync('pbpaste', [], { encoding: 'utf8' }).stdout
      ok("and the Mac's pasteboard holds it (pbpaste)", pasted === TOKEN, pasted.slice(0, 80))
    }

    const level = platformLevel()
    ok(
      'the battery agrees with the platform',
      level === undefined ? battery === 'unavailable' : Math.abs(Number(battery.split(' ')[0]) - level) <= 0.01 && /^\d\.\d\d (charging|full|unplugged|unknown)$/.test(battery),
      `${battery} against ${level ?? 'no battery'}`,
    )
    ok('the network has a route out', network === 'online other', network)
    ok('an address nothing handles is unavailable', opened === 'unavailable', opened)
    ok('the battery watcher hears the reading once', heard === battery, `${heard} against ${battery}`)
  }
} finally {
  if (kept !== undefined) {
    execFileSync('pbcopy', [], { input: kept })
  }
}

console.log(`\ndevice-rust: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
