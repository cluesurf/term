// Running a Term program built for Jetpack Compose on the Android emulator (compose-target-0006). The build itself is the
// CLI's, `buildComposeAndroid` in deck/call/code/compose.ts (what `term make --target compose-android` runs), so a test
// and an app build go through the same code. This installs the APK clean, launches it, reads its `native-dom` log until
// it says it exits, and pulls its PNG off the device. A helper, not a suite: shared/ is not walked by the runner. Used by
// test/compile/compose-view.ts and the `compose-android` leg of ./toolkit-run.ts.

import { spawn, spawnSync } from 'node:child_process'
import { closeSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { androidDevice, androidTools } from '@term/call/code/cask'

export type ComposeAndroidRan =
  | { form: 'skipped'; reason: string }
  | { form: 'ran'; installed: boolean; output: string; exited: boolean }

// install the APK on the emulator clean, launch it, read its `native-dom` log until it says it exits (two minutes at
// most), and pull the PNG it wrote under `shot`, a name in its external files directory, to `pulled`
export function runComposeAndroid({
  apk,
  identifier,
  shot,
  pulled,
  prepare,
}: {
  apk: string
  identifier: string
  shot: string
  pulled: string
  // run with the device's serial once the app is installed and before it starts: a grant, or a value the emulator is
  // told (device-features.ts)
  prepare?: (serial: string) => void
}): ComposeAndroidRan {
  const found = androidDevice()

  if ('missing' in found) {
    return { form: 'skipped', reason: found.missing }
  }

  const tools = androidTools()
  const adb = (...args: string[]) => spawnSync(tools.adb, ['-s', found.serial, ...args], { encoding: 'utf8' })
  adb('uninstall', identifier)
  const installed = adb('install', '-r', apk).status === 0
  prepare?.(found.serial)
  adb('shell', 'am', 'start', '-n', `${identifier}/.TermActivity`)

  // THIS APP'S lines only, by its process: another app on the emulator (another suite's) logs under the same
  // `native-dom` tag, and reading every process's lines judged this app on that one's output
  let pid = ''
  const started = Date.now() + 20_000

  while (!pid && Date.now() < started) {
    pid = (adb('shell', 'pidof', identifier).stdout ?? '').trim().split(/\s+/)[0] ?? ''

    if (!pid) {
      spawnSync('sleep', ['0.5'])
    }
  }

  // and STREAMED, from the moment the process is found, into a file of this run's own. The log is a ring buffer every
  // run on the emulator shares, and reading it by snapshot (`logcat -d`) lost this app's first lines whenever another
  // run cleared it meanwhile: every judgment read by line position then failed at once, in a full gate run and never
  // alone. Lines a reader has been sent are its own, whoever clears the buffer after. Nothing here clears it either
  const byProcess = pid ? ['--pid', pid] : []
  const file = join(tmpdir(), `term-compose-android-${identifier}-${process.pid}-${Date.now()}.log`)
  const into = openSync(file, 'w')
  const reader = spawn(tools.adb, ['-s', found.serial, 'logcat', ...byProcess, '-s', 'native-dom:I', 'AndroidRuntime:E'], { stdio: ['ignore', into, into] })
  let log = ''
  const deadline = Date.now() + 120_000

  while (Date.now() < deadline) {
    log = readFileSync(file, 'utf8')

    if (log.includes('native-view exit') || log.includes('FATAL EXCEPTION')) {
      break
    }

    spawnSync('sleep', ['1'])
  }

  reader.kill()
  closeSync(into)
  rmSync(file, { force: true })

  const output = log
    .split('\n')
    .map(line => (line.includes('native-dom:') ? line.slice(line.indexOf('native-dom:') + 'native-dom:'.length).trim() : line))
    .join('\n')
  const picture = spawnSync(tools.adb, ['-s', found.serial, 'exec-out', 'cat', `/sdcard/Android/data/${identifier}/files/${shot}`])

  if (picture.status === 0 && picture.stdout.length > 0) {
    writeFileSync(pulled, picture.stdout)
  }

  return { form: 'ran', installed, output, exited: output.includes('native-view exit 0') }
}
