// `pnpm term:release`: build the `term` command for every platform, as the payload `@term/code` ships through the Term
// registry (note/project/term/term-load-install.md, note/term/self-host/09-distribution.md).
//
//   pnpm term:release --dry      build tmp/release/<version>/term-<platform>.tar.gz and stop. windows-x64 is built and
//                                smoke-run on an EC2 Windows machine (task/release-windows.ts, about $0.02 a run);
//                                --windows-cross packs it here instead, run nowhere. `--platform <name>` builds that
//                                one platform and asks the registry nothing, `--out <dir>` (new or empty) puts it there
//   pnpm term:release            build, then publish to ghcr.io/cluesurf/term/code under the version tag, and tell
//                                the package index, which lists `@term/code` under /packages like any package
//   pnpm term:release --ping     build nothing: tell the index about every version already released, which is how the
//                                releases from before the index read them get listed
//
// SECRETS COME FROM THE ENVIRONMENT. The push (`--push <version>`, a child of this run) reads GHCR_TOKEN or
// TERM_OCI_TOKEN, and the Windows step the EC2 key and TERM_MACHINE_MODULE, all from the environment this run was given.
// This repository holds no secret store and spawns none: the publisher's alias runs the release inside its own.
//
// Every staged payload passes the payload gate (task/term/self-contained.ts --payload) before it is packed, and a leak
// refuses the release with nothing published.
//
// THE PAYLOAD IS THE NODE BUILD, for now. 09's target is a native binary per platform, which the self-hosting port
// has not produced yet, so each platform's tarball is the console's run entry
// (`deck/call/host/port/code/line/base-run.ts`, ported from `deck/call/code/line/base.tree`) bundled for Node, and only the parts
// that cannot be bundled travel beside it:
//
//   term/bin/term            sh launcher: follows its own link to find the install, then `exec node host/need.mjs`
//                            (bin\term.cmd on the two Windows platforms, the same check and call in cmd.exe, and
//                            bin\term.exe beside it, task/launcher/term.go, for winget, which puts only an .exe on PATH)
//   term/host/need.mjs       the first module: which version runs here (note/project/term/term-versions.md). It
//                            imports line.js in-process when the answer is this version, else hands over
//                            (work/need/version-dispatch.tree)
//   term/host/need-hand.mjs  the slow half of that: installs a needed version, prints a refusal. Loaded only then
//                            (work/need/choice-report.tree)
//   term/host/line.js        the CLI (the console's run entry), every pure-JS dependency BUNDLED; no chalk and no
//                            yargs since stage 1 (decisions cli-in-term/014 and 018)
//   term/host/dock.mjs       the hook dispatcher every booted console imports: the Term port work/hook/running.tree
//                            (runCommandLine, toCamel), term-cli-in-term-0225
//   term/host/build-worker.mjs, term/host/separate-worker.mjs
//                            the build pools' worker entries (work/workers/file-worker.tree, unit-worker.tree)
//   term/host/compile.mjs    stage0 of the fixpoint chain (decision 126 of change 001-finish-self-host): task/stage0.ts's
//                            bundle of the release tree's compile closure, the same bytes on every platform, which
//                            `pnpm term:boot` fetches by the release boot.tree pins and runs term:fixpoint with
//   term/package.json        the name and version `--version` and the build cache key read
//   term/hash.tree           every file with its sha256 and mode, so a second version installed shares the files the
//                            first holds alike (note/project/term/term-versions.md, "Disk")
//   term/deck/base/code/     the stdlib, found by the walk up from host/ (resolve.ts `stdlibBase`), and its deck.tree,
//                            which names its units `_term_base_...` in every project (unit-naming.tree `unit-slug`)
//   term/deck/host/          `@term/host`, the data dialect, and term/deck/call/ the files of `@term/call` a user's
//                            project compiles: the test report (test-running.tree `reporter-bundle`) and the printer
//                            a program reports through (`@term/call/item`), with term/deck/make/ the one file of the
//                            compiler that printer loads (`SHIPPED_CALL`, `SHIPPED_MAKE`)
//   term/deck/mill/          `@term/mill`, every grammar: the format readers (code/text, code/blob, the cursors in
//                            code/feed.tree) and the tree dialects (code/tree), its deck.tree and code/, reached by
//                            name beside the stdlib (resolve.ts `siblingResolver`). `@term/feed` until 2026-10-06
//   term/node_modules/       esbuild + @esbuild/<platform> (native, run by boot, test, walk, cast),
//                            hono + @hono/node-server (linked into every `term boot` app, which imports them)
//
// EVERY PACKAGE IN node_modules IS FETCHED FROM THE npm REGISTRY, at the exact version installed here, and checked
// against the registry's sha512 integrity. Never copied from this machine's node_modules: esbuild's install step
// replaces `bin/esbuild` with THIS machine's native binary, so a copied esbuild would carry darwin-arm64 into a
// linux-x64 tarball and fail only on that machine.

import { createHash } from 'node:crypto'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import path from 'node:path'
import { build } from 'esbuild'
import { ensurePublisher, publishRelease, releaseRoute, transportFor } from '@cluesurf/deck.tree'
import { announce, loadPublishKeypair } from '@term/call/code/host'
import { packPayload, SECRET_FILE } from './release-pack'
import { bundle as stage0Bundle } from './stage0'
// the terminal output library, as a TYPE only: the module itself is loaded by `loadOutput`, because the port build is
// what writes the modules it is made of, and a fresh clone has none until it runs (see `main`)
import type * as Output from '@term/call/code/output'

// the release's run, once the library is loaded: every line goes through it, as every term command's does. Unset
// until `main` loads it
let output = undefined as unknown as typeof Output

// the package a release is: the toolchain (09, "The name")
const PACKAGE = '@term/code'

// the repository the release links to on GHCR, the `site` line of this package's deck.tree
const SOURCE = 'https://github.com/cluesurf/term'

// the Term package root: this file is task/release.ts under it
const TERM = path.resolve(import.meta.dirname, '..')

const OUT_ROOT = path.join(TERM, 'tmp', 'release')

// the generic agent this repository sends to a host that has not asked for ours (mesh/task/dataset/agent.ts)
const AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const NPM_REGISTRY = 'https://registry.npmjs.org'

// The platforms a release carries, each named the way 09 names them, with the esbuild package that holds its binary
export const PLATFORMS = [
  { name: 'darwin-arm64', esbuild: '@esbuild/darwin-arm64' },
  { name: 'darwin-x64', esbuild: '@esbuild/darwin-x64' },
  { name: 'linux-x64', esbuild: '@esbuild/linux-x64' },
  { name: 'linux-arm64', esbuild: '@esbuild/linux-arm64' },
  { name: 'windows-x64', esbuild: '@esbuild/win32-x64' },
  { name: 'windows-arm64', esbuild: '@esbuild/win32-arm64' },
] as const

// What stays OUT of the bundle and travels in node_modules. `pg` is the optional Postgres driver `base-engine.ts`
// imports dynamically and names when it is missing; it is not shipped
const EXTERNAL = ['esbuild', 'hono', 'hono/*', '@hono/node-server', '@hono/node-server/*', 'pg']

// The packages fetched into node_modules for every platform, beside the platform's esbuild binary
const SHIPPED = ['esbuild', 'hono', '@hono/node-server']

// The oldest Node the CLI runs on: `process.getBuiltinModule`, which the terminal output writer calls on every run,
// arrived in 22.3.0 (and 20.16.0, which the check below also admits)
const NODE_FLOOR = '22.3.0'

// Top of line.js. The CommonJS dependencies bundled into an ES module still call `require` for node builtins, so one
// is made for them. Then the Node floor, checked before any bundled code runs, so an old Node gets a sentence instead
// of `process.getBuiltinModule is not a function` from deep inside the output writer
const BANNER = [
  '#!/usr/bin/env node',
  "import { createRequire as __termRequire } from 'node:module';",
  'const require = __termRequire(import.meta.url);',
  `if (typeof process.getBuiltinModule !== 'function') { process.stderr.write('term needs Node.js ${NODE_FLOOR} or newer, and this is ' + process.version + '.\\n'); process.exit(69) }`,
].join('\n')

// The launcher on PATH. It follows its own symlink, because `~/.base/@term/code/call/term` and a Homebrew
// `bin/term` are both links to it, and the install is beside the file, not beside the link
const LAUNCHER = `#!/bin/sh
# The term command. Installed by https://term.surf/load or Homebrew; see note/project/term/term-load-install.md.
self="$0"
while [ -L "$self" ]; do
  link="$(readlink "$self")"
  case "$link" in
    /*) self="$link" ;;
    *) self="$(dirname "$self")/$link" ;;
  esac
done
root="$(cd "$(dirname "$self")/.." && pwd)"
if ! command -v node >/dev/null 2>&1; then
  echo "term needs Node.js ${NODE_FLOOR} or newer on PATH: https://nodejs.org" >&2
  exit 69
fi
exec node "$root/host/need.mjs" "$@"
`

// The Windows launcher, bin\term.cmd: the same check and the same call. `%~dp0` is the folder this file is in, and
// `call\term.cmd` under ~/.base/@term/code is a shim that calls this one (self.ts `link`), so this file is never the
// one replaced while it runs. CRLF, which cmd.exe reads either way and Notepad shows right
const WINDOWS_LAUNCHER = [
  '@echo off',
  'rem The term command. Installed by https://term.surf/load.ps1; see note/project/term/term-load-install.md.',
  'where node >nul 2>nul',
  `if errorlevel 1 (echo term needs Node.js ${NODE_FLOOR} or newer on PATH: https://nodejs.org 1>&2 & exit /b 69)`,
  'node "%~dp0..\\host\\need.mjs" %*',
  '',
].join('\r\n')

type Built = { platform: string; file: string; digest: string; bytes: number }

function readVersion(): string {
  const manifest = JSON.parse(readFileSync(path.join(TERM, 'package.json'), 'utf8')) as { version?: string }

  if (!manifest.version) {
    throw new Error('package.json has no version')
  }

  return manifest.version
}

// the word after a flag on the command line, or undefined when the flag is not there. A flag with no word after it is
// an error, never read as absent
function flagValue(flag: string): string | undefined {
  const at = process.argv.indexOf(flag)

  if (at < 0) {
    return undefined
  }

  const value = process.argv[at + 1]

  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} needs a value`)
  }

  return value
}

/**
 * What the release says about itself, read from the same package.json as the
 * version: the description GHCR prints under the package's name, and the
 * license, as an SPDX id. Both were literals here until 2026-10-05, when the
 * image still said MIT after Term moved to Apache 2.0, and its description
 * said something package.json did not. One source, so they cannot drift.
 */

function readLabels(): { description: string; license: string } {
  const manifest = JSON.parse(readFileSync(path.join(TERM, 'package.json'), 'utf8')) as {
    description?: string
    license?: string
  }

  if (!manifest.description || !manifest.license) {
    throw new Error('package.json needs both a description and a license for the release to carry')
  }

  return { description: manifest.description, license: manifest.license }
}

// The version installed here, which is the version `pnpm-lock.yaml` resolved, so the release ships what was tested
// (read from the file itself, not through `require.resolve`: hono's `exports` does not list its package.json)
function installedVersion(name: string): string {
  const file = path.join(TERM, 'node_modules', name, 'package.json')

  return (JSON.parse(readFileSync(file, 'utf8')) as { version: string }).version
}

// One package from the npm registry, checked against its sha512 integrity and unpacked into `dir`
async function fetchPackage(input: { name: string; version: string; dir: string; cache: string }): Promise<void> {
  const metadataUrl = `${NPM_REGISTRY}/${input.name.replace('/', '%2f')}/${input.version}`
  const metadata = (await (await fetch(metadataUrl, { headers: { 'user-agent': AGENT } })).json()) as {
    dist?: { tarball?: string; integrity?: string }
  }
  const tarball = metadata.dist?.tarball
  const integrity = metadata.dist?.integrity

  if (!tarball || !integrity?.startsWith('sha512-')) {
    throw new Error(`${input.name}@${input.version}: the registry gave no tarball or sha512 integrity`)
  }

  const cached = path.join(input.cache, `${input.name.replace('/', '+')}-${input.version}.tgz`)

  if (!existsSync(cached)) {
    const response = await fetch(tarball, { headers: { 'user-agent': AGENT } })

    if (!response.ok) {
      throw new Error(`${tarball}: ${response.status}`)
    }

    const bytes = Buffer.from(await response.arrayBuffer())
    const actual = `sha512-${createHash('sha512').update(bytes).digest('base64')}`

    if (actual !== integrity) {
      throw new Error(`${input.name}@${input.version}: the tarball does not match the registry's integrity`)
    }

    writeFileSync(cached, bytes)
  }

  mkdirSync(input.dir, { recursive: true })
  // an npm tarball holds everything under `package/`
  execFileSync('tar', ['-xzf', cached, '-C', input.dir, '--strip-components=1'])
}

// the ported toolchain modules the console's run entry imports (and the entry itself), written by port-build (the step make:line runs first). Its output is
// captured, not inherited, so it is reported as an item and quoted under it only when it failed
function portBuild(): { ok: boolean; built: number; unchanged: number; failed: number; lines: string[] } {
  let text = ''
  let ok = true

  try {
    // `-s`: pnpm's own `$ ...` echo line is not this release's output
    text = execFileSync('pnpm', ['-s', 'exec', 'tsx', 'task/port-build.ts'], {
      cwd: TERM,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string }
    text = `${failed.stdout ?? ''}${failed.stderr ?? ''}`
    ok = false
  }

  return summarize(text, ok)
}

// the port build's stdout read for its summary line, `term port-build: N built, N unchanged, N failed`
type PortResult = { ok: boolean; built: number; unchanged: number; failed: number; lines: string[] }

function summarize(text: string, ok: boolean): PortResult {
  const summary = /(\d+) built, (\d+) unchanged.*?(\d+) failed/.exec(text)

  return {
    ok,
    built: Number(summary?.[1] ?? 0),
    unchanged: Number(summary?.[2] ?? 0),
    failed: Number(summary?.[3] ?? (ok ? 0 : 1)),
    lines: text.split('\n').filter(line => line.trim() !== ''),
  }
}

// the port build as a child the release watches while it runs (about 2.5 minutes, 2026-10-22): `--progress` makes it
// write `progress <done> <total>` on stderr per module, drawn as the running `port` step (section 10). Every other line
// it writes is kept, in order, for the quote under a failed item, exactly as `portBuild` keeps them
async function portBuildLive(): Promise<PortResult> {
  const child = spawn('pnpm', ['-s', 'exec', 'tsx', 'task/port-build.ts', '--progress'], { cwd: TERM, stdio: ['ignore', 'pipe', 'pipe'] })
  const out: string[] = []
  const errors: string[] = []

  child.stdout!.on('data', (chunk: Buffer) => out.push(chunk.toString('utf8')))
  const reading = (async () => {
    for await (const line of createInterface({ input: child.stderr! })) {
      const told = /^progress (\d+) (\d+)$/.exec(line)

      if (told) {
        output.progress({ verb: 'port', subject: 'toolchain modules', done: Number(told[1]), total: Number(told[2]), noun: 'modules', one: 'module' })
      } else {
        errors.push(`${line}\n`)
      }
    }
  })()
  const status = await new Promise<number | null>(resolve => {
    child.on('error', () => resolve(null))
    child.on('close', code => resolve(code))
  })
  await reading

  return summarize(`${out.join('')}${errors.join('')}`, status === 0)
}

// bin\term.exe, the Windows launcher winget links onto PATH (task/launcher/term.go), cross-compiled by Go with no C
// toolchain, stripped, and with no build paths in it, so two builds of one source are the same bytes
function buildWindowsExe(input: { out: string; arch: 'amd64' | 'arm64' }): void {
  execFileSync('go', ['build', '-trimpath', '-ldflags', '-s -w', '-o', input.out, path.join(TERM, 'task', 'launcher', 'term.go')], {
    env: { ...process.env, GOOS: 'windows', GOARCH: input.arch, CGO_ENABLED: '0' },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
}

// line.js, dock.mjs, the two dispatch modules, the two worker entries and stage0's compile.mjs, bundled once: they are
// the same for every platform
async function bundle(into: string, step: (done: number) => void = () => {}): Promise<void> {
  const common = {
    absWorkingDir: TERM,
    bundle: true,
    platform: 'node' as const,
    format: 'esm' as const,
    target: 'node20',
    external: EXTERNAL,
    banner: { js: BANNER },
    logLevel: 'warning' as const,
  }

  step(0)
  // the console's run entry, generated by port-build from deck/call/code/line/base.tree: the entry make:line bundles
  // as host/line.js since the switch (term-cli-in-term-0013, 0199)
  await build({ ...common, entryPoints: ['deck/call/host/port/code/line/base-run.ts'], outfile: path.join(into, 'host', 'line.js') })
  step(1)
  // the hook dispatcher's port, the dispatcher every console `term boot` writes imports (decision cli-in-term/018 part 2)
  await build({ ...common, entryPoints: ['deck/call/host/port/code/work/hook/running.ts'], outfile: path.join(into, 'host', 'dock.mjs') })
  step(2)
  // the version dispatch and its slow half, the need ports make:line bundles (integrate 0068, term-cli-in-term-0218)
  await build({ ...common, entryPoints: ['deck/call/host/port/code/work/need/version-dispatch.ts'], outfile: path.join(into, 'host', 'need.mjs') })
  step(3)
  await build({ ...common, entryPoints: ['deck/call/host/port/code/work/need/choice-report.ts'], outfile: path.join(into, 'host', 'need-hand.mjs') })
  step(4)
  // the build pools' worker entries, the Term ports make:line bundles beside line.js (integrate 0066, decision 003):
  // a pool starts host/build-worker.mjs or host/separate-worker.mjs, and without them it falls back to a sequential build
  await build({ ...common, entryPoints: ['deck/call/host/port/code/work/workers/file-worker.ts'], outfile: path.join(into, 'host', 'build-worker.mjs') })
  step(5)
  await build({ ...common, entryPoints: ['deck/call/host/port/code/work/workers/unit-worker.ts'], outfile: path.join(into, 'host', 'separate-worker.mjs') })
  step(6)
  // stage0 of the fixpoint chain (decision 126): task/stage0.ts's bundle of this tree's compile closure, the seven names
  // port-build loads (decision 036), made once and copied into every platform, so its sha256 is the same bundle id
  // everywhere. `pnpm term:boot` fetches the release boot.tree pins and hands this file to term:fixpoint --stage0
  writeFileSync(path.join(into, 'host', 'compile.mjs'), (await stage0Bundle(TERM)).bytes)
}

// What a payload never carries from the source tree: any dotfile or dot-folder (a build's `.base/` cache, `.env*`,
// `.git`, `.DS_Store`, Swift's `.build`), `node_modules`, Rust's `target`, build info, and a key file by its extension
function shipped(from: string): (source: string) => boolean {
  return source => {
    const relative = path.relative(from, source)
    if (relative === '') {
      return true
    }

    const parts = relative.split(path.sep)
    return (
      !parts.some(part => part.startsWith('.') || part === 'node_modules') &&
      !/(^|\/)native\/[^/]+\/target(\/|$)/.test(relative) &&
      !/\.tsbuildinfo$/.test(relative) &&
      !SECRET_FILE.test(parts[parts.length - 1])
    )
  }
}

// THE WINDOWS STEP (D8): windows-x64 staged here, all but its native part, then handed to task/release-windows.ts
// with this run's environment, which holds the EC2 key. It rents a Windows machine, builds bin\term.exe there with Windows' own Go, packs the
// stage here with packPayload, smoke-runs the tarball there, and destroys the machine. The child says each step as a
// JSON line on stdout, drawn here as the release's own items. `--windows-cross` packs windows-x64 here instead, cross
// built and not run anywhere, for a dry run with no EC2 key or network
async function windowsStep(input: { stage: string; file: string }): Promise<Built> {
  output.report({ glyph: 'info', verb: 'pack', subject: 'windows-x64 on an EC2 Windows machine' })
  // the machine and its key come from this run's environment (TERM_MACHINE_MODULE, and the EC2 key the publisher's
  // alias puts there): a child of this release, never a secret store of its own
  const child = spawn('pnpm', ['-s', '--dir', TERM, 'exec', 'tsx', 'task/release-windows.ts', '--stage', input.stage, '--out', input.file], {
    cwd: TERM,
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  let built: Built | undefined
  let failed = ''

  for await (const line of createInterface({ input: child.stdout! })) {
    let said: { form: string; [key: string]: unknown }

    try {
      said = JSON.parse(line) as typeof said
    } catch {
      if (line.trim()) output.report({ glyph: 'info', verb: 'pack', subject: line.trim() })
      continue
    }

    if (said.form === 'tools') {
      output.report({ glyph: 'done', verb: 'check', subject: 'the Windows toolchain: Node, Go, MSVC and Rust', fields: [output.field('crate', String(said.crate))] })
    } else if (said.form === 'native') {
      output.report({ glyph: 'done', verb: 'build', subject: 'bin\\term.exe on Windows', fields: [output.field('digest', String(said.digest)), output.field('cross', said.same ? 'the same bytes' : String(said.cross))] })
    } else if (said.form === 'smoke') {
      output.report({ glyph: 'done', verb: 'run', subject: `windows-x64 on Windows: ${String(said.version)}`, fields: [output.field('digest', String(said.digest)), output.field('make', String(said.made))] })
    } else if (said.form === 'built') {
      built = { platform: 'windows-x64', file: String(said.file), digest: String(said.digest), bytes: Number(said.bytes) }
    } else if (said.form === 'failed') {
      failed = String(said.message)
    }
  }

  const status = await new Promise<number | null>(resolve => child.on('close', code => resolve(code)))

  if (status !== 0 || !built) {
    throw Object.assign(new Error(failed || `the Windows step exited ${status ?? 'on a signal'}`), { expected: true })
  }

  return built
}

// THE PAYLOAD GATE (decision term/004): no staged payload may carry an absolute path of the machine that built it, a
// path that climbs out of it, or a name of the repository it was built in, which a stranger can neither open nor
// should see. The gate reads the staged folder and exits 0 when it is clean, 1 with one line per leak and a summary
// line, 2 on a usage error. Anything but 0 refuses the release, and so does a gate that is not there
const GATE = path.join(TERM, 'task', 'term', 'self-contained.ts')

// `name` keys the payload's entry in the gate's baseline: `oci` for the per-platform release images, `npm` for the npm
// package
function payloadLeaks(stage: string, name: 'oci' | 'npm'): { ok: boolean; lines: string[] } {
  if (!existsSync(GATE)) {
    return { ok: false, lines: [`the payload gate ${path.relative(TERM, GATE)} is not there, so nothing can be released`] }
  }

  const ran = spawnSync(process.execPath, ['--experimental-strip-types', GATE, '--payload', stage, '--name', name], {
    cwd: TERM,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })

  return {
    ok: ran.status === 0,
    lines: `${ran.stdout ?? ''}${ran.stderr ?? ''}`.split('\n').filter(line => line.trim() !== ''),
  }
}

// the stdlib as the npm package ships it: no native build output, no build info, no cache. WITH ITS MANIFEST: a
// separate build names a unit by the deck it belongs to (unit-naming.tree `unit-slug`), so without deck/base/deck.tree
// every stdlib unit was named by its path from the project, which climbs out of it into this install, a machine path
// in every user's host/.unit that also differed per project, so a unit stored by one build broke the next (zone-0144)
function copyStdlib(into: string): void {
  const from = path.join(TERM, 'deck', 'base', 'code')

  cpSync(path.join(TERM, 'deck', 'base', 'deck.tree'), path.join(into, 'deck', 'base', 'deck.tree'))
  cpSync(from, path.join(into, 'deck', 'base', 'code'), { recursive: true, filter: shipped(from) })
}

// the packages that ship beside the stdlib, each with its manifest so the sibling resolver (resolve.ts
// `siblingResolver`) reaches it by name from an installed `term`, as it does in this repository. `@term/mill` holds the
// format readers (JSON, hex, gzip, PDF and OpenType), which were `@term/feed` until 2026-10-06
// (note/project/term/mill-merge-and-role-scopes.md). `@term/host` is the data dialect the test report writes its
// lines in. Its tests stay here, and a shelved draft builds nothing
const SHIPPED_PACKAGES = ['mill', 'host']

// the files of `@term/call` a user's project compiles: the test report's own program, which `term test` builds
// (test-running.tree `reporter-sources`), and the printer a program reports through, `@term/call/item`, with what it
// loads (the run, work/output/printer.tree, its node face work/output/printer-input.tree, and the output library,
// work/item/), item term-self-host-001-0983. Only these ship, with the manifest that names the package and the role
// that reads them lean. A folder ships whole
const SHIPPED_CALL = [
  'role.tree',
  'code/test-report.tree',
  'code/test-report-node.tree',
  'code/work/preprocess/failure-reading.tree',
  'code/item.tree',
  'code/output-plan.tree',
  'code/draft-mark.tree',
  'code/work/output/printer.tree',
  'code/work/output/printer-input.tree',
  'code/work/item',
]

// the one file of `@term/make` the printer loads: the diagnostic record and its renderer, whose own loads are the
// stdlib's alone. Not the compiler: nothing else of the package ships
const SHIPPED_MAKE = ['role.tree', 'code/parser/diagnostic.tree']

function copyShippedPackages(into: string): void {
  for (const name of SHIPPED_PACKAGES) {
    const from = path.join(TERM, 'deck', name)

    cpSync(path.join(from, 'deck.tree'), path.join(into, 'deck', name, 'deck.tree'))
    cpSync(path.join(from, 'code'), path.join(into, 'deck', name, 'code'), { recursive: true, filter: shipped(path.join(from, 'code')) })
  }

  for (const [name, files] of [['call', SHIPPED_CALL], ['make', SHIPPED_MAKE]] as const) {
    const from = path.join(TERM, 'deck', name)

    cpSync(path.join(from, 'deck.tree'), path.join(into, 'deck', name, 'deck.tree'))

    for (const file of files) {
      cpSync(path.join(from, file), path.join(into, 'deck', name, file), { recursive: true, filter: shipped(path.join(from, file)) })
    }
  }
}

async function main(): Promise<void> {
  if (process.argv.includes('--ping')) {
    await pingReleased()

    return
  }

  const dry = process.argv.includes('--dry')
  // windows-x64 packed here and run nowhere, instead of by the Windows step: a dry run only
  const windowsCross = process.argv.includes('--windows-cross')

  if (windowsCross && !dry) {
    throw new Error('--windows-cross is for a dry run: a release builds windows-x64 on Windows (D8)')
  }

  // `--platform <name>`: a dry run of one platform's payload only, asking the registry nothing (task/term/release-user.ts
  // installs it as a person does). `--out <dir>` puts the build there instead of tmp/release/<version>
  const onlyPlatform = flagValue('--platform')
  const outGiven = flagValue('--out')

  if ((onlyPlatform !== undefined || outGiven !== undefined) && !dry) {
    throw new Error('--platform and --out are for a dry run')
  }

  if (onlyPlatform !== undefined && !PLATFORMS.some(platform => platform.name === onlyPlatform)) {
    throw new Error(`--platform names one of ${PLATFORMS.map(platform => platform.name).join(', ')}`)
  }

  const version = readVersion()
  const out = outGiven === undefined ? path.join(OUT_ROOT, version) : path.resolve(outGiven)
  const cache = path.join(OUT_ROOT, 'npm')
  const common = path.join(out, 'common')
  const started = Date.now()

  // THE REGISTRY FIRST. A release is write-once, so a version already there is refused before anything is built:
  // this asked it last, after a minute of packing six platforms. A dry run builds all the same, and says so at the end
  const taken: Awaited<ReturnType<typeof releasedAlready>> =
    onlyPlatform === undefined ? await releasedAlready(version) : { form: 'free', at: '', first: false }

  if (!dry && taken.form !== 'free') {
    output = await loadOutput()
    output.openRun({ verb: 'release', root: TERM, facts: [`${PACKAGE} ${version}`], started })
    output.report({
      glyph: 'failed',
      kind: 'problem',
      verb: 'release',
      subject:
        taken.form === 'released'
          ? `${PACKAGE}@${version} is already released, and releases are write-once`
          : `the registry could not say whether ${PACKAGE}@${version} is released: ${taken.reason}`,
      fields: [output.field('at', taken.at)],
    })
    output.closeRun({
      verdict: 'Nothing built, nothing released',
      failure: taken.form === 'released' ? 'usage' : 'environment',
      next: taken.form === 'released' ? 'raise the version to the next even patch in package.json and deck.tree' : undefined,
    })

    return
  }

  // a folder `--out` named is never emptied: it must be new or empty
  if (outGiven !== undefined && existsSync(out) && readdirSync(out).length > 0) {
    throw new Error(`--out ${out} is not empty`)
  }

  rmSync(out, { recursive: true, force: true })
  mkdirSync(cache, { recursive: true })

  // the run opens BEFORE the port build, so its two and a half minutes show as a running step (section 10). The
  // library is the ports of the last build, which `loadOutput` builds first on a fresh clone; the bundle below reads
  // the ones this build writes from disk
  output = await loadOutput()
  output.openRun({ verb: 'release', root: TERM, facts: [`${PACKAGE} ${version}`, ...(dry ? ['--dry'] : [])], started })
  output.progress({ verb: 'port', subject: 'toolchain modules' })
  const port = await portBuildLive()
  output.report({
    glyph: port.ok && port.failed === 0 ? 'done' : 'failed',
    verb: 'port',
    subject: 'toolchain modules',
    duration: Date.now() - started,
    counts: [output.count(port.built, 'built'), output.count(port.unchanged, 'unchanged'), ...(port.failed ? [output.count(port.failed, 'failed')] : [])],
    // a child's own lines nest under the item that ran it, only when they say why it failed
    quote: port.ok && port.failed === 0 ? [] : port.lines,
  })

  if (!port.ok || port.failed > 0) {
    output.closeRun({ verdict: 'Nothing released', next: 'pnpm run make:port' })

    return
  }

  const bundled = Date.now()
  const bundleSubject = 'line.js, dock.mjs, need.mjs, need-hand.mjs, the two worker entries and compile.mjs'
  await bundle(common, done => output.progress({ verb: 'bundle', subject: bundleSubject, done, total: 7, noun: 'files', one: 'file' }))
  output.report({ glyph: 'done', verb: 'bundle', subject: bundleSubject, duration: Date.now() - bundled })

  const built: Built[] = []

  const platforms = PLATFORMS.filter(platform => onlyPlatform === undefined || platform.name === onlyPlatform)

  for (const [at, platform] of platforms.entries()) {
    const packed = Date.now()
    // each platform is a running `pack` step with the platforms done so far, which its own ✓ item below replaces
    output.progress({ verb: 'pack', subject: platform.name, done: at, total: platforms.length, noun: 'platforms', one: 'platform' })
    const stage = path.join(out, platform.name)
    const root = path.join(stage, 'term')

    cpSync(path.join(common, 'host'), path.join(root, 'host'), { recursive: true })
    copyStdlib(root)
    copyShippedPackages(root)

    writeFileSync(
      path.join(root, 'package.json'),
      `${JSON.stringify({ name: '@cluesurf/term', version, type: 'module', private: true }, null, 2)}\n`,
    )

    // the license and the notice travel with the code, in every package made from this stage (Apache-2.0 section 4)
    for (const name of ['LICENSE', 'NOTICE']) {
      cpSync(path.join(TERM, name), path.join(root, name))
    }

    mkdirSync(path.join(root, 'bin'), { recursive: true })

    // windows-x64's term.exe is built on Windows by the Windows step, below
    const onWindows = platform.name === 'windows-x64' && !windowsCross

    if (platform.name.startsWith('windows-')) {
      writeFileSync(path.join(root, 'bin', 'term.cmd'), WINDOWS_LAUNCHER)

      if (!onWindows) {
        buildWindowsExe({ out: path.join(root, 'bin', 'term.exe'), arch: platform.name === 'windows-arm64' ? 'arm64' : 'amd64' })
      }
    } else {
      writeFileSync(path.join(root, 'bin', 'term'), LAUNCHER)
      chmodSync(path.join(root, 'bin', 'term'), 0o755)
    }

    for (const name of SHIPPED) {
      await fetchPackage({ name, version: installedVersion(name), dir: path.join(root, 'node_modules', name), cache })
    }

    // the binary package matches esbuild's own version exactly, or esbuild refuses to start
    await fetchPackage({
      name: platform.esbuild,
      version: installedVersion('esbuild'),
      dir: path.join(root, 'node_modules', platform.esbuild),
      cache,
    })

    // the payload gate, before anything is packed or sent: a leak refuses the release here, with nothing published
    const gate = payloadLeaks(stage, 'oci')

    if (!gate.ok) {
      output.report({
        glyph: 'failed',
        kind: 'problem',
        verb: 'check',
        subject: `the ${platform.name} payload names a path of this machine or of the repository it was built in`,
        quote: gate.lines.slice(0, 40),
      })
      output.closeRun({ verdict: 'Nothing released', next: `node --experimental-strip-types task/term/self-contained.ts --payload ${stage} --name oci` })

      return
    }

    const file = path.join(out, `term-${platform.name}.tar.gz`)
    // the file list, the secrets check and the tar (task/release-pack.ts), here or, for windows-x64, by the Windows
    // step once the machine has built term.exe
    const one = onWindows ? await windowsStep({ stage, file }) : { platform: platform.name, file, ...packPayload({ stage, file }) }

    built.push(one)
    // the digest is an identifier of 71 characters: a field, on its own line, not a fact
    output.report({ glyph: 'done', verb: 'pack', subject: platform.name, duration: Date.now() - packed, bytes: one.bytes, fields: [output.field('digest', one.digest)] })
  }

  writeFileSync(path.join(out, 'release.json'), `${JSON.stringify({ package: '@term/code', version, built }, null, 2)}\n`)

  if (dry) {
    if (taken.form === 'released') {
      output.report({ glyph: 'warning', verb: 'release', subject: `${PACKAGE}@${version} is already released, so a release of this version would be refused`, fields: [output.field('at', taken.at)] })
    }

    output.closeRun({
      verdict: 'Built, nothing published',
      counts: [output.count(built.length, 'platforms', 'platform')],
      next: `ls ${path.relative(process.cwd(), out) || out}`,
    })

    return
  }

  await publish({ version, built, first: taken.form === 'free' && taken.first })
}

// `--ping`: every released version, told to the package index by its index digest, oldest first, signed by this
// machine's key so a term.surf token credits them. Builds and pushes nothing
async function pingReleased(): Promise<void> {
  output = await loadOutput()

  const started = Date.now()
  const route = releaseRoute({ package: PACKAGE })
  const transport = transportFor({ host: route.registry.host })

  output.openRun({ verb: 'release', root: TERM, facts: [PACKAGE, '--ping'], started })

  const keypair = await loadPublishKeypair({ mint: false })
  const versions = (await transport.listTags({ repository: route.repository.name }))
    .filter(tag => /^\d+\.\d+\.\d+$/.test(tag))
    .sort((a, b) => {
      const [x, y] = [a, b].map(tag => tag.split('.').map(Number))

      return x![0]! - y![0]! || x![1]! - y![1]! || x![2]! - y![2]!
    })
  let sent = 0

  for (const version of versions) {
    const index = await transport.getManifest({ repository: route.repository.name, reference: version })

    if (!index) {
      continue
    }

    output.report({ glyph: 'info', verb: 'release', subject: `${PACKAGE}@${version}`, fields: [output.field('index', index.digest)] })

    if (keypair ? await announce({ route, digest: index.digest, keypair }) : false) {
      sent++
    }
  }

  output.closeRun({
    verdict: keypair ? `Told the index about ${sent} of ${versions.length} releases` : 'There is no signing key on this machine, so nothing was claimed',
    counts: [output.count(versions.length, 'releases', 'release')],
    ...(keypair ? {} : { failure: 'environment' }),
  })
}

// Is this version on the registry already? One request for the index under the version tag, the same question
// `publishRelease` asks, asked before the build instead of after it
async function releasedAlready(
  version: string,
): Promise<{ form: 'free'; at: string; first: boolean } | { form: 'released'; at: string } | { form: 'unknown'; at: string; reason: string }> {
  const route = releaseRoute({ package: PACKAGE })
  const at = `${route.registry.host}/${route.repository.name}:${version}`

  try {
    const transport = transportFor({ host: route.registry.host })
    const index = await transport.getManifest({ repository: route.repository.name, reference: version })

    if (index) {
      return { form: 'released', at }
    }

    // a repository with no version yet: this is the first release, which GHCR makes private
    const tags = await transport.listTags({ repository: route.repository.name }).catch(() => [] as string[])

    return { form: 'free', at, first: !tags.some(tag => /^\d+\.\d+\.\d+$/.test(tag)) }
  } catch (error) {
    return { form: 'unknown', at, reason: error instanceof Error ? error.message : String(error) }
  }
}

// The output library before the port build, for a release refused before it. The ports it is made of are there from
// the last build on any machine that has built before; on a fresh clone they are built first, so a refusal still
// prints through the one library and never through a second printer
async function loadOutput(): Promise<typeof Output> {
  try {
    return await import('@term/call/code/output')
  } catch {
    portBuild()

    return await import('@term/call/code/output')
  }
}

// What the push child tells the release, one JSON object a line on its stdout
type Pushed =
  | { form: 'key-set'; at: string }
  | { form: 'push'; platform: string; layer: string; manifest: string }
  | { form: 'note'; text: string }
  | { form: 'index'; at: string; index: string }
  | { form: 'failed'; message: string }

// P2: the push, a child of this run that reads its one secret from the environment. The release stays the one run on
// the terminal: the child reports each step on stdout, and the release draws them as its own items
async function publish(input: { version: string; built: Built[]; first: boolean }): Promise<void> {
  const route = releaseRoute({ package: PACKAGE })
  // the push's own item, before the child starts: whatever the child prints (a build that failed) nests under the item
  // last printed, and without this that was the last platform's `✓ pack`, which read as the pack having failed while it
  // showed green (2026-10-05)
  output.report({ glyph: 'info', verb: 'push', subject: `${PACKAGE}@${input.version}` })
  // the registry credential (GHCR_TOKEN, TERM_OCI_TOKEN) comes from this run's environment, which the publisher's alias
  // fills from its secret store: a child of this release, never a secret store of its own
  const child = spawn('pnpm', ['-s', '--dir', TERM, 'exec', 'tsx', 'task/release.ts', '--push', input.version], {
    cwd: TERM,
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  let index = ''
  let failed = ''

  for await (const line of createInterface({ input: child.stdout! })) {
    let said: Pushed

    try {
      said = JSON.parse(line) as Pushed
    } catch {
      output.report({ glyph: 'info', verb: 'push', subject: line })
      continue
    }

    if (said.form === 'key-set') {
      output.report({ glyph: 'added', kind: 'change', verb: 'add', subject: `the key set of ${route.scope}`, fields: [output.field('at', said.at)] })
    } else if (said.form === 'push') {
      output.report({ glyph: 'done', verb: 'push', subject: said.platform, fields: [output.field('layer', said.layer), output.field('manifest', said.manifest)] })
    } else if (said.form === 'note') {
      output.report({ glyph: 'info', verb: 'push', subject: said.text })
    } else if (said.form === 'index') {
      index = said.index
      output.report({ glyph: 'done', verb: 'push', subject: said.at, fields: [output.field('index', said.index)] })
    } else {
      failed = said.message
    }
  }

  const status = await new Promise<number | null>(resolve => child.on('close', code => resolve(code)))

  if (status !== 0 || !index) {
    output.report({ glyph: 'failed', verb: 'push', subject: `${PACKAGE}@${input.version}`, ...(status ? { exit: status } : {}) })
    throw Object.assign(new Error(failed || `the push exited ${status ?? 'on a signal'}`), { expected: true })
  }

  // the package index lists `@term/code` like any package. Told here, by the release, which holds the index digest the
  // child pushed and needs no registry credential for it: the ping carries only the reference and, beside a term.surf
  // token, a claim signed by this machine's key, which reads its own file
  const keypair = await loadPublishKeypair({ mint: false })

  if (keypair) {
    await announce({ route, digest: index, keypair })
  }

  const [owner, ...rest] = route.repository.name.split('/')

  // a FIRST release lands private on GHCR, and nothing installs from a private package, so it is made public once.
  // Every later release is public already, and saying so again on each one was noise
  output.closeRun({
    verdict: `Released ${PACKAGE}@${input.version}`,
    counts: [output.count(input.built.length, 'platforms', 'platform')],
    ...(input.first
      ? {
          message: ['A new GHCR package is private, and nothing installs from a private one. A first release is made public once.'],
          next: `https://github.com/orgs/${owner}/packages/container/${encodeURIComponent(rest.join('/'))}/settings`,
        }
      : { done: true, next: 'term self update, on an installed term' }),
  })
}

// `--push <version>`, the child `publish` starts: push every platform built under tmp/release/<version>
// to `@term/code`'s route, signed by this machine's publish key, which must be in (or will found) the scope's key set.
// Credentials come from GHCR_TOKEN (or TERM_OCI_TOKEN) in the environment. It opens no run: it says each step to the release as a line
async function push(version: string): Promise<void> {
  const say = (said: Pushed): void => {
    process.stdout.write(`${JSON.stringify(said)}\n`)
  }

  try {
    const { built } = JSON.parse(readFileSync(path.join(OUT_ROOT, version, 'release.json'), 'utf8')) as { built: Built[] }
    const route = releaseRoute({ package: PACKAGE })
    const keypair = await loadPublishKeypair({ mint: false })

    if (!keypair) {
      throw new Error('there is no publish key on this machine; `term host` makes one on a first publish')
    }

    const transport = transportFor({ host: route.registry.host })
    const keys = await ensurePublisher({ transport, repository: route.keysRepository, scope: route.scope, keypair })

    if (keys.created) {
      say({ form: 'key-set', at: `${route.registry.host}/${route.keysRepository}` })
    }

    const labels = readLabels()

    const released = await publishRelease({
      transport,
      repository: route.repository.name,
      package: PACKAGE,
      version,
      payloads: built.map(one => ({ platform: one.platform, bytes: readFileSync(one.file) })),
      keypair,
      annotations: {
        'org.opencontainers.image.source': SOURCE,
        'org.opencontainers.image.licenses': labels.license,
        'org.opencontainers.image.description': labels.description,
      },
      // `darwin-arm64: layer sha256:..., manifest sha256:...` is one platform pushed. Any other line is a note
      log: message => {
        const pushed = /^([\w-]+): layer (\S+), manifest (\S+)$/.exec(message.trim())

        say(pushed ? { form: 'push', platform: pushed[1]!, layer: pushed[2]!, manifest: pushed[3]! } : { form: 'note', text: message.trim() })
      },
    })

    say({ form: 'index', at: `${route.registry.host}/${route.repository.name}:${version}`, index: released.index })
  } catch (error) {
    say({ form: 'failed', message: error instanceof Error ? error.message : String(error) })
    process.exitCode = 1
  }
}

try {
  const pushing = process.argv.indexOf('--push')

  if (pushing >= 0) {
    await push(process.argv[pushing + 1] ?? '')
  } else {
    await main()
  }
} catch (error) {
  // a failure once the run is open ends it; before that there is no library to print through yet
  if (output) {
    process.exit(output.failRun(error, TERM))
  }

  throw error
}
