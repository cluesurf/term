// THE NATIVE TERM (item term-self-host-001-0161 requirement 1, 07-the-binary.md "Forwarding, during the transition"):
// the console, deck/call/code/line/base.tree, emitted for Rust by this checkout's CLI and built by cargo in release
// mode (`term make --emit rust --build`), the binary put at host/native/term, beside host/line.js, which is where its
// forward finds the node build (work/hook/console.tree `console-forward`). The lowering (item 0800) decides which
// verbs are native from the build's own closure, and writes the command line of every forwarded route as the program's
// `console-forwarded`. This reads that record back from the emitted Rust, and the task of each arm of the match, and
// writes host/native/build.json, the record `pnpm term:native-verbs` prints.
//
//   pnpm make:native
//
// The build writes under .base/@term/code/native/ (its Rust and its cargo target) and host/native/. Nothing else.

import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TERM_ROOT } from './root'

const LINE = join(TERM_ROOT, 'host', 'line.js')
const ENTRY = 'code/line/base.tree'
const CALL = join(TERM_ROOT, 'deck', 'call')
const WORK = join(TERM_ROOT, '.base', '@term', 'code', 'native')
const BUILD = join(WORK, 'build')
const HOST = join(TERM_ROOT, 'host', 'native')
const BINARY = join(HOST, 'term')
const RECORD = join(HOST, 'build.json')

export type NativeRecord = {
  // the console the binary was built from, relative to the Term root
  entry: string
  bytes: number
  // the command line of every route the build forwards to the node build, as the lowering wrote them
  forwarded: string[]
  // the task of every arm of the match: called directly (native), or forwarded
  nativeTasks: string[]
  forwardedTasks: string[]
  // what the binary answers --version with
  version: string
}

function fail(message: string): never {
  console.error(`make:native: ${message}`)
  process.exit(1)
}

// every file under a folder, the cargo target left out
function filesUnder(dir: string): string[] {
  const found: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (name !== 'target') found.push(...filesUnder(path))
    } else {
      found.push(path)
    }
  }
  return found
}

// the texts of the `console-forwarded` static in the emitted Rust (`static MODULE_CONSOLE_FORWARDED: ... =
// ...vec!["term base init".to_string(), ...]`): every string literal between its `=` and its `;`
export function forwardedOf(rust: string): string[] | undefined {
  const at = rust.search(/CONSOLE_FORWARDED\b/)
  if (at < 0) return undefined
  const start = rust.indexOf('=', at)
  const end = rust.indexOf(';', start)
  if (start < 0 || end < 0) return undefined
  return [...rust.slice(start, end).matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(m => m[1]!)
}

// the arms of `console_call`: each `task_name == "<task>"` branch, forwarded when its body calls console_forward
export function armsOf(rust: string): { native: string[]; forwarded: string[] } | undefined {
  const body = /fn console_call\b[\s\S]*?\n\}/.exec(rust)?.[0]
  if (body === undefined) return undefined
  const native: string[] = []
  const forwarded: string[] = []
  const arm = /"([^"]+)"[^{]*\{([^}]*)\}/g
  for (const hit of body.matchAll(arm)) {
    if (/\bconsole_forward\b/.test(hit[2]!)) forwarded.push(hit[1]!)
    else native.push(hit[1]!)
  }
  return { native, forwarded }
}

function main(): void {
  if (!existsSync(LINE)) fail(`there is no node build at ${LINE}: run pnpm run make:line first`)
  mkdirSync(WORK, { recursive: true })
  const env: NodeJS.ProcessEnv = { ...process.env }
  // the whole CLI's closure is read in one process: the default heap is too small for it
  if (!/max-old-space-size/.test(env.NODE_OPTIONS ?? '')) env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} --max-old-space-size=16384`.trim()
  for (const name of ['TERM_LINE_NAME', 'TERM_DEPTH']) delete env[name]
  const started = Date.now()
  console.log(`make:native: term make ${ENTRY} --emit rust --build (deck/call)`)
  const built = spawnSync('node', [LINE, 'make', ENTRY, '--emit', 'rust', '--build', '--out', BUILD, '--color', 'never', '--no-motion'], { cwd: CALL, env, stdio: 'inherit' })
  if (built.status !== 0) fail(`term make exited ${built.status ?? built.signal}`)

  const files = filesUnder(BUILD)
  const binaries = readdirSync(BUILD)
    .filter(name => name.endsWith('-cargo'))
    .map(name => join(BUILD, name, 'target', 'release', name.slice(0, -'-cargo'.length)))
    .filter(path => existsSync(path) && statSync(path).isFile())
  if (binaries.length !== 1) fail(`expected one release binary under ${BUILD}, found ${binaries.length}`)
  const sources = files.filter(path => path.endsWith('.rs')).filter(path => /CONSOLE_FORWARDED\b/.test(readFileSync(path, 'utf8')))
  if (sources.length === 0) fail(`no emitted Rust under ${BUILD} holds console-forwarded: the console was not lowered`)
  const rust = readFileSync(sources[0]!, 'utf8')
  const forwarded = forwardedOf(rust)
  const arms = armsOf(rust)
  if (forwarded === undefined) fail('the console-forwarded record does not read')
  if (arms === undefined) fail('the console-call match does not read')

  mkdirSync(HOST, { recursive: true })
  copyFileSync(binaries[0]!, BINARY)
  chmodSync(BINARY, 0o755)
  const asked = spawnSync(BINARY, ['--version'], { encoding: 'utf8', env })
  const record: NativeRecord = {
    entry: `deck/call/${ENTRY}`,
    bytes: statSync(BINARY).size,
    forwarded,
    nativeTasks: arms.native,
    forwardedTasks: arms.forwarded,
    version: (asked.stdout ?? '').trim(),
  }
  writeFileSync(RECORD, `${JSON.stringify(record, null, 2)}\n`)
  console.log(`make:native: host/native/term, ${record.bytes} bytes, in ${Math.round((Date.now() - started) / 1000)} s`)
  console.log(`make:native: ${record.nativeTasks.length} native verbs and --help, --version; ${record.forwarded.length} forwarded routes`)
  console.log(`make:native: --version prints ${record.version}`)
}

if (process.argv[1] && /native-build\.ts$/.test(process.argv[1])) main()
