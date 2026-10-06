// Running a Term program built for Jetpack Compose on the Android emulator (compose-target-0006). The build itself is the
// CLI's, `buildComposeAndroid` in deck/call/code/compose.ts (what `term make --target compose-android` runs), so a test
// and an app build go through the same code. This installs the APK clean, launches it, reads its `native-dom` log until
// it says it exits, and pulls its PNG off the device. A helper, not a suite: shared/ is not walked by the runner. Used by
// test/compile/compose-view.ts and the `compose-android` leg of ./toolkit-run.ts.

import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { androidDevice, androidTools } from '@term/call/code/cask'
import { followAppLog } from './android-log'

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

  // this app's own lines, streamed (./android-log.ts)
  const output = followAppLog({ adb: tools.adb, serial: found.serial, identifier })
  const picture = spawnSync(tools.adb, ['-s', found.serial, 'exec-out', 'cat', `/sdcard/Android/data/${identifier}/files/${shot}`])

  if (picture.status === 0 && picture.stdout.length > 0) {
    writeFileSync(pulled, picture.stdout)
  }

  return { form: 'ran', installed, output, exited: output.includes('native-view exit 0') }
}
