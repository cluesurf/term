// The iPhone simulator a test may use, which is never one it started (beat-term spec.md 4 D017, 6). `simulator()` in
// @term/call/code/cask boots the first available iPhone when none is booted, which is right for a person's own
// `term make --target ios` and wrong for a test: the simulator is one device every session shares. A test takes this
// and skips its iOS leg, with the reason, when it answers `missing`.

import { execFileSync } from 'node:child_process'

// the shared simulator: iPhone 17 Pro
const SHARED = '0F8D6036-E209-4729-B96B-C4761B69ACA8'

type Device = { udid: string; name: string; state: string }

// the iPhone simulator a test may use: the shared one (TERM_SIMULATOR, else 0F8D6036-E209-4729-B96B-C4761B69ACA8)
// when it is Booted, else any Booted iPhone, else missing with the reason. Never boots, erases or shuts one down
export function bootedSimulator(): { udid: string } | { missing: string } {
  let devices: Device[]

  try {
    const list = execFileSync('xcrun', ['simctl', 'list', 'devices', 'available', '--json'], { encoding: 'utf8' })

    devices = Object.values(JSON.parse(list).devices as Record<string, Device[]>).flat()
  } catch (error) {
    return { missing: `simctl could not list the simulators: ${String((error as Error).message ?? error).split('\n')[0]}` }
  }

  const booted = devices.filter(device => device.state === 'Booted' && device.name.startsWith('iPhone'))
  const wanted = process.env.TERM_SIMULATOR || SHARED
  const found = booted.find(device => device.udid === wanted) ?? booted[0]

  if (!found) {
    return { missing: 'no iPhone simulator is booted, and a test never boots one: boot the shared simulator yourself, or run the test where it is booted' }
  }

  return { udid: found.udid }
}
