// One command for the phones a cask runs on: the iOS simulator and the Android emulator. Everything a build or a
// test needs from them, remembered here so nobody re-learns simctl and avdmanager.
//
//   pnpm term:device                        what is installed and what is running, both platforms
//   pnpm term:device boot ios               create the Term iPhone if needed, boot it headless, wait until ready
//   pnpm term:device boot android [avd]     start the emulator headless (default pixel_api_36), wait until booted
//   pnpm term:device stop ios|android       shut it down
//   pnpm term:device shot ios|android <png> screenshot the phone's screen
//   pnpm term:device log ios <bundle id>    launch the app with its console attached, until it exits
//   pnpm term:device log android            `adb logcat -s cask`, streamed until Ctrl-C
//
// Headless on purpose: nothing appears on the desk. `term make --target ios|android` and `pnpm term:app-smoke
// --target ios|android` find a booted device on their own; this is how one gets booted. Runs from
// the Term root, the way every other term task does.
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'

// the simulator device this tool makes when none exists, and the phone it is modelled on
const IOS_DEVICE_NAME = 'Term iPhone'
const IOS_DEVICE_TYPE = 'iPhone 17 Pro'

// the AVD the install script makes
const ANDROID_AVD = 'pixel_api_36'

// how long a boot may take before this gives up, in seconds
const BOOT_TIMEOUT = 240

const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? join(process.env.HOME ?? '', 'Library/Android/sdk')
const adb = join(sdk, 'platform-tools', 'adb')
const emulator = join(sdk, 'emulator', 'emulator')

function say(text: string): void {
  console.log(`device  ${text}`)
}

function fail(text: string): never {
  console.error(`device  ${text}`)
  process.exit(1)
}

function run(command: string, args: string[]): string {
  return execFileSync(command, args, { encoding: 'utf8' })
}

// ---- ios ----

type SimDevice = { udid: string; name: string; state: string }

function iosRuntimes(): { identifier: string; name: string }[] {
  const listed = JSON.parse(run('xcrun', ['simctl', 'list', 'runtimes', '--json'])) as {
    runtimes: { identifier: string; name: string; isAvailable: boolean; platform: string }[]
  }

  return listed.runtimes.filter(r => r.platform === 'iOS' && r.isAvailable).map(r => ({ identifier: r.identifier, name: r.name }))
}

function iosDevices(): SimDevice[] {
  const listed = JSON.parse(run('xcrun', ['simctl', 'list', 'devices', 'available', '--json'])) as {
    devices: Record<string, SimDevice[]>
  }

  return Object.values(listed.devices).flat()
}

function iosStatus(): void {
  const runtimes = iosRuntimes()
  say(`ios runtimes: ${runtimes.map(r => r.name).join(', ') || 'none. Run: xcodebuild -downloadPlatform iOS'}`)

  for (const device of iosDevices()) {
    say(`  ${device.state.padEnd(9)} ${device.name}  ${device.udid}`)
  }
}

function iosBoot(): string {
  const runtimes = iosRuntimes()

  if (runtimes.length === 0) {
    fail('no iOS runtime is installed. Run: xcodebuild -downloadPlatform iOS')
  }

  let device = iosDevices().find(d => d.name === IOS_DEVICE_NAME) ?? iosDevices().find(d => d.state === 'Booted')

  if (!device) {
    const newest = runtimes[runtimes.length - 1]
    const udid = run('xcrun', ['simctl', 'create', IOS_DEVICE_NAME, IOS_DEVICE_TYPE, newest.identifier]).trim()
    say(`created ${IOS_DEVICE_NAME} on ${newest.name}: ${udid}`)
    device = { udid, name: IOS_DEVICE_NAME, state: 'Shutdown' }
  }

  if (device.state !== 'Booted') {
    spawnSync('xcrun', ['simctl', 'boot', device.udid], { stdio: 'ignore' })
  }

  spawnSync('xcrun', ['simctl', 'bootstatus', device.udid, '-b'], { stdio: 'ignore', timeout: BOOT_TIMEOUT * 1000 })
  say(`booted ${device.name} ${device.udid}`)

  return device.udid
}

function iosStop(): void {
  for (const device of iosDevices().filter(d => d.state === 'Booted')) {
    spawnSync('xcrun', ['simctl', 'shutdown', device.udid], { stdio: 'ignore' })
    say(`shut down ${device.name}`)
  }
}

function iosShot(file: string): void {
  const booted = iosDevices().find(d => d.state === 'Booted')

  if (!booted) {
    fail('no simulator is booted. Run: pnpm term:device boot ios')
  }

  run('xcrun', ['simctl', 'io', booted.udid, 'screenshot', file])
  say(`wrote ${file}`)
}

function iosLog(identifier: string): void {
  const booted = iosDevices().find(d => d.state === 'Booted')

  if (!booted) {
    fail('no simulator is booted. Run: pnpm term:device boot ios')
  }

  spawnSync('xcrun', ['simctl', 'launch', '--console', booted.udid, identifier], { stdio: 'inherit' })
}

// ---- android ----

function androidAvds(): string[] {
  if (!existsSync(emulator)) {
    return []
  }

  return run(emulator, ['-list-avds']).split('\n').map(line => line.trim()).filter(line => line.length > 0 && !line.startsWith('INFO'))
}

function androidDevices(): { serial: string; state: string }[] {
  if (!existsSync(adb)) {
    return []
  }

  return run(adb, ['devices'])
    .split('\n')
    .slice(1)
    .map(line => line.trim().split(/\s+/))
    .filter(parts => parts.length === 2)
    .map(([serial, state]) => ({ serial, state }))
}

function androidStatus(): void {
  say(`android sdk: ${existsSync(sdk) ? sdk : 'none. Run: task/android/install-android-cli.sh'}`)
  say(`android avds: ${androidAvds().join(', ') || 'none yet'}`)

  for (const device of androidDevices()) {
    say(`  ${device.state.padEnd(9)} ${device.serial}`)
  }
}

function androidBoot(avd: string): void {
  if (!androidAvds().includes(avd)) {
    fail(`no AVD named ${avd}. Have: ${androidAvds().join(', ') || 'none'}. The install script makes ${ANDROID_AVD}`)
  }

  const online = androidDevices().find(d => d.state === 'device')

  if (online) {
    say(`already online: ${online.serial}`)

    return
  }

  // detached and headless: the emulator outlives this command, and nothing appears on the desk
  const child = spawn(emulator, ['-avd', avd, '-no-window', '-no-audio', '-no-boot-anim', '-no-snapshot-save'], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  say(`starting ${avd} headless (pid ${child.pid})`)

  spawnSync(adb, ['wait-for-device'], { stdio: 'ignore', timeout: BOOT_TIMEOUT * 1000 })

  const started = Date.now()

  while (Date.now() - started < BOOT_TIMEOUT * 1000) {
    const done = spawnSync(adb, ['shell', 'getprop', 'sys.boot_completed'], { encoding: 'utf8' }).stdout.trim()

    if (done === '1') {
      say(`booted: ${androidDevices().map(d => d.serial).join(', ')}`)

      return
    }

    spawnSync('sleep', ['2'])
  }

  fail(`${avd} did not finish booting in ${BOOT_TIMEOUT} seconds`)
}

function androidStop(): void {
  for (const device of androidDevices().filter(d => d.serial.startsWith('emulator-'))) {
    spawnSync(adb, ['-s', device.serial, 'emu', 'kill'], { stdio: 'ignore' })
    say(`killed ${device.serial}`)
  }
}

function androidLog(): void {
  spawnSync(adb, ['logcat', '-s', 'cask'], { stdio: 'inherit' })
}

function androidShot(file: string): void {
  const online = androidDevices().find(d => d.state === 'device')

  if (!online) {
    fail('no emulator is online. Run: pnpm term:device boot android')
  }

  const png = execFileSync(adb, ['-s', online.serial, 'exec-out', 'screencap', '-p'], { maxBuffer: 64 * 1024 * 1024 })
  writeFileSync(file, png)
  say(`wrote ${file}`)
}

// ---- the commands ----

// the platform argument every command takes first: `boot ios`, `log android`. One word each, so it reads as a sentence
type Platform = 'ios' | 'android'

const platformOption = (y: import('yargs').Argv) =>
  y.positional('platform', { type: 'string', choices: ['ios', 'android'] as const, demandOption: true })

void yargs(hideBin(process.argv))
  .scriptName('pnpm term:device')
  .command('$0', 'what is installed and what is running, both platforms', {}, () => {
    iosStatus()
    androidStatus()
  })
  .command(
    'boot <platform> [avd]',
    'boot a phone headless: the Term iPhone (made if needed), or the emulator (default pixel_api_36)',
    y => platformOption(y).positional('avd', { type: 'string', default: ANDROID_AVD }),
    argv => {
      if ((argv.platform as Platform) === 'ios') {
        iosBoot()
      } else {
        androidBoot(argv.avd)
      }
    },
  )
  .command('stop <platform>', 'shut the phone down', y => platformOption(y), argv => {
    if ((argv.platform as Platform) === 'ios') {
      iosStop()
    } else {
      androidStop()
    }
  })
  .command('shot <platform> <file>', "screenshot the phone's screen into a PNG", y => platformOption(y).positional('file', { type: 'string', demandOption: true }), argv => {
    if ((argv.platform as Platform) === 'ios') {
      iosShot(argv.file)
    } else {
      androidShot(argv.file)
    }
  })
  .command(
    'log <platform> [identifier]',
    'stream the cask log: on ios, launch the app by bundle identifier with its console attached; on android, logcat',
    y => platformOption(y).positional('identifier', { type: 'string' }),
    argv => {
      if ((argv.platform as Platform) === 'ios') {
        if (!argv.identifier) {
          fail('the bundle identifier to launch, for example surf.term.blog')
        }
        iosLog(argv.identifier)
      } else {
        androidLog()
      }
    },
  )
  .strict()
  .help()
  .parse()
