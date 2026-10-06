// One app's log on the Android emulator, read until it says it exits: the one reader every Android leg uses (the views
// leg of ./toolkit-run.ts and ./compose-android.ts). A helper, not a suite: shared/ is not walked by the runner.
//
// THIS APP'S lines only, by its process: another app on the emulator (another suite's, another session's) logs under
// the same `native-dom` tag, and reading every process's lines judged this app on that one's output, stopping at the
// first `native-view exit` anybody printed. And STREAMED, from the moment the process is found, into a file of this
// run's own: the log is a ring buffer every run on the emulator shares, and a snapshot (`logcat -d`) lost this app's
// first lines whenever another run cleared it meanwhile. Lines a reader has been sent are its own, whoever clears the
// buffer after. Nothing here clears it either, which is what made two runs at once corrupt each other.

import { spawn, spawnSync } from 'node:child_process'
import { closeSync, openSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// the app's `native-dom` lines, each with logcat's prefix removed, once it has said it exits, crashed, or two minutes
// have gone. `adb` is the tool's path and `serial` the emulator's; the app must have been started already
export function followAppLog({ adb, serial, identifier }: { adb: string; serial: string; identifier: string }): string {
  const shell = (...args: string[]) => spawnSync(adb, ['-s', serial, ...args], { encoding: 'utf8' })
  let pid = ''
  const started = Date.now() + 20_000

  while (!pid && Date.now() < started) {
    pid = (shell('shell', 'pidof', identifier).stdout ?? '').trim().split(/\s+/)[0] ?? ''

    if (!pid) {
      spawnSync('sleep', ['0.5'])
    }
  }

  const byProcess = pid ? ['--pid', pid] : []
  const file = join(tmpdir(), `term-android-${identifier}-${process.pid}-${Date.now()}.log`)
  const into = openSync(file, 'w')
  const reader = spawn(adb, ['-s', serial, 'logcat', ...byProcess, '-s', 'native-dom:I', 'AndroidRuntime:E'], { stdio: ['ignore', into, into] })
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

  return log
    .split('\n')
    .map(line => (line.includes('native-dom:') ? line.slice(line.indexOf('native-dom:') + 'native-dom:'.length).trim() : line))
    .join('\n')
}
