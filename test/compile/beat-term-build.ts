// beat-term as it ships (beat-term-0022): `term make --target uikit` writes the Xcode project, it builds for the
// simulator and, unsigned, for a device, and the BUILT Info.plist of each holds the keys the toolchain writes, read
// back with plutil. No simulator is touched: this builds, the drive installs. Run: npx tsx test/compile/beat-term-build.ts
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BEAT_TERM_ROOT, buildBeatTermForSimulator, xcodebuildBeatTerm } from './shared/beat-term-app'

let pass = 0
let fail = 0

function ok(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  ${info.slice(-1600)}`)
  }
}

if (process.platform !== 'darwin' || spawnSync('xcodebuild', ['-version']).status !== 0) {
  console.log('skip  beat-term-build: needs macOS with Xcode')
  console.log('\nbeat-term-build: 0 pass, 0 fail, 1 skipped')
  process.exit(0)
}

// one row per key (item 0018 adds its two rows here): `expected` is an exact text, `text` any non-empty text, or
// `absent` for a key the plist must not hold
type Row = { key: string; expected: string }
const ROWS: Row[] = [
  { key: 'CFBundleIdentifier', expected: 'surf.term.beatterm' },
  { key: 'NSMicrophoneUsageDescription', expected: 'text' },
  { key: 'NSLocalNetworkUsageDescription', expected: 'text' },
  { key: 'NSAllowsArbitraryLoads', expected: 'absent' },
]

// the key as plutil reads it from the built plist: its JSON value, or undefined when the key is not there
function read(plist: string, key: string): unknown {
  const ran = spawnSync('plutil', ['-extract', key, 'json', '-o', '-', plist], { encoding: 'utf8' })

  return ran.status === 0 ? JSON.parse(ran.stdout) : undefined
}

function check(label: string, app: string): void {
  const plist = join(app, 'Info.plist')

  ok(`${label}: the .app holds an Info.plist`, existsSync(plist), plist)

  for (const row of ROWS) {
    const value = read(plist, row.key)
    const good = row.expected === 'absent' ? value === undefined : row.expected === 'text' ? typeof value === 'string' && value.trim() !== '' : value === row.expected

    ok(`${label}: ${row.key} is ${row.expected === 'text' ? 'a non-empty text' : row.expected}`, good, `read ${JSON.stringify(value)}`)
  }
}

// 1. the simulator build, through the helper the drive uses
try {
  const built = await buildBeatTermForSimulator()

  ok('simulator: the shipped build is surf.term.beatterm', built.identifier === 'surf.term.beatterm', built.identifier)

  const swift = join(built.root, 'host', 'uikit', 'beatterm', 'main.swift')
  const source = existsSync(swift) ? readFileSync(swift, 'utf8') : ''
  const lines = source.split('\n').map(line => line.trim())

  ok('simulator: main.swift starts the boot task (its start line calls boot())', lines.some(line => /^(?:_ = )?(?:try )?(?:await )?boot\(\)$/.test(line)), source.slice(-400))

  check('simulator', built.app)
} catch (e) {
  ok('simulator: `term make --target uikit` and xcodebuild build the app', false, String((e as Error).message ?? e))
}

// 2. the same project for a device, unsigned
try {
  const app = xcodebuildBeatTerm({
    root: BEAT_TERM_ROOT,
    destination: 'generic/platform=iOS',
    derived: join(BEAT_TERM_ROOT, 'host', 'uikit', 'derived-device'),
    products: 'Release-iphoneos',
  })

  check('device', app)
} catch (e) {
  ok('device: xcodebuild builds the app unsigned', false, String((e as Error).message ?? e))
}

console.log(`\nbeat-term-build: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
