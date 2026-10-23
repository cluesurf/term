// work/need/running-install.tree finds the running toolchain by one walk (decision 006 of term-cli-in-term,
// term-cli-in-term-0156). Each case runs in its own node process, because the answer is held once per process:
//   - the port unbundled (deck/call/host/port/.../running-install.ts under tsx) answers this package, deck/term/deck/term
//   - the port bundled into <t>/term/host/line.js beside <t>/term/deck/base/code answers <t>/term and
//     <t>/term/host/line.js, also started through a symlinked file and through a symlinked folder
//   - a bundle under a folder with no marker answers through argv[1] (the install's host/line.js that imported it)
//   - the same bundle answers through TERM_STDLIB, and a pin with no code/ in it is passed over
//   - nothing found answers the empty text for both
//   - the answer is held: a TERM_STDLIB set after the first call changes nothing
//
// Run: npx tsx test/call/running-install.ts      (from deck/term/deck/term)

import { spawnSync } from 'node:child_process'
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildSync } from 'esbuild'
import { tempDir } from '../temp'

const TERM = realpathSync(process.cwd())
const PORT = join(TERM, 'deck/call/host/port/code/work/need/running-install.ts')
const TSX = join(TERM, '../../../../node_modules/tsx/dist/cli.mjs')

// a probe: both answers, then the root again after a new pin, printed as JSON
const PROBE = (from: string): string => `import { findInstallRoot, findRunningCli } from ${JSON.stringify(from)}
const root = findInstallRoot()
const cli = findRunningCli()
process.env.TERM_STDLIB = ${JSON.stringify(join(TERM, 'deck/base'))}
console.log(JSON.stringify({ root, cli, again: findInstallRoot() }))
`

function fresh(): string {
  return realpathSync(tempDir('running-install-'))
}

// the probe bundled with the port into one ESM file
function bundle(out: string): void {
  const built = buildSync({
    stdin: { contents: PROBE(PORT), resolveDir: TERM, sourcefile: 'probe.ts', loader: 'ts' },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
  })
  writeFileSync(out, built.outputFiles[0]!.text)
}

// an install payload: <t>/term with the marker, package.json typing host/*.js as ESM
function payload(t: string): string {
  const root = join(t, 'term')
  mkdirSync(join(root, 'deck/base/code'), { recursive: true })
  mkdirSync(join(root, 'host'), { recursive: true })
  writeFileSync(join(root, 'package.json'), '{ "type": "module", "version": "0.0.0" }\n')
  return root
}

type Answer = { root: string; cli: string; again: string }

function run(args: string[], env: Record<string, string | undefined> = {}): Answer {
  const base: Record<string, string | undefined> = { ...process.env, ...env }
  if (!('TERM_STDLIB' in env)) delete base.TERM_STDLIB
  const done = spawnSync(process.execPath, args, { encoding: 'utf8', env: base as NodeJS.ProcessEnv })
  if (done.status !== 0) throw new Error(`exit ${done.status}: ${done.stderr}`)
  return JSON.parse(done.stdout.trim().split('\n').at(-1)!) as Answer
}

let failed = 0
let passed = 0

function check(name: string, got: Answer, root: string, cli: string): void {
  const ok = got.root === root && got.cli === cli && got.again === root
  if (ok) passed++
  else failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n     got ${JSON.stringify(got)}\n     want root ${JSON.stringify(root)} cli ${JSON.stringify(cli)}`}`)
}

// 1. unbundled, under tsx: the walk from deck/call/host/port/code/work/need reaches this package
{
  const t = fresh()
  const probe = join(t, 'probe.mts')
  writeFileSync(probe, PROBE(pathToFileURL(PORT).href))
  check('the port unbundled', run([TSX, probe]), TERM, join(TERM, 'host/line.js'))
}

// 2. bundled into the payload's host/line.js, run directly, through a symlinked file and a symlinked folder
{
  const t = fresh()
  const root = payload(t)
  const line = join(root, 'host/line.js')
  bundle(line)
  check('bundled in host/line.js', run([line]), root, line)
  symlinkSync(line, join(t, 'linked.js'))
  check('bundled, started through a symlinked file', run([join(t, 'linked.js')]), root, line)
  symlinkSync(root, join(t, 'alias'))
  check('bundled, started through a symlinked folder', run([join(t, 'alias/host/line.js')]), root, line)
}

// 3. a bundle under a folder with no marker, imported by the install's host/line.js: found through argv[1]
{
  const t = fresh()
  const root = payload(t)
  mkdirSync(join(t, 'away'))
  const away = join(t, 'away/bundle.mjs')
  bundle(away)
  const line = join(root, 'host/line.js')
  writeFileSync(line, `await import(${JSON.stringify(pathToFileURL(away).href)})\n`)
  check('a bundle outside the install, through argv[1]', run([line]), root, line)
}

// 4. the same bundle started by itself: through TERM_STDLIB, a pin without code/ passed over, and nothing found
{
  const t = fresh()
  const root = payload(t)
  mkdirSync(join(t, 'away'))
  const away = join(t, 'away/bundle.mjs')
  bundle(away)
  check('a bundle outside the install, through TERM_STDLIB', run([away], { TERM_STDLIB: join(root, 'deck/base') }), root, join(root, 'host/line.js'))
  check('a pin with no code/ in it, nothing else', run([away], { TERM_STDLIB: join(t, 'away') }), '', '')
  check('nothing found', run([away]), '', '')
}

console.log(`running-install: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
