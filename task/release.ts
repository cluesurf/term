// `pnpm term:release`: build the `term` command for every platform, as the payload `@term/code` ships through the Term
// registry (note/term/plan/term-load-install.md, note/term/self-host/09-distribution.md).
//
//   pnpm term:release --dry      build tmp/release/<version>/term-<platform>.tar.gz and stop
//   pnpm term:release            build, then publish to ghcr.io/cluesurf/term/code under the version tag, and tell
//                                the package index, which lists `@term/code` under /packages like any package
//   pnpm term:release --ping     build nothing: tell the index about every version already released, which is how the
//                                releases from before the index read them get listed
//
// Only the push needs a secret, so only the push runs under zone (`--push <version>`, a child of this run), and zone's
// own output nests under this run instead of opening the terminal before it (section 15)
//
// THE PAYLOAD IS THE NODE BUILD, for now. 09's target is a native binary per platform, which the self-hosting port
// has not produced yet, so each platform's tarball is `deck/call/code/line.ts` bundled for Node, and only the parts
// that cannot be bundled travel beside it:
//
//   term/bin/term            sh launcher: follows its own link to find the install, then `exec node host/need.mjs`
//                            (bin\term.cmd on the two Windows platforms, the same check and call in cmd.exe, and
//                            bin\term.exe beside it, task/launcher/term.go, for winget, which puts only an .exe on PATH)
//   term/host/need.mjs       the first module: which version runs here (note/term/plan/term-versions.md). It
//                            imports line.js in-process when the answer is this version, else hands over
//   term/host/need-hand.mjs  the slow half of that: installs a needed version, prints a refusal. Loaded only then
//   term/host/line.js        the CLI, every pure-JS dependency (yargs, chalk) BUNDLED
//   term/host/dock.mjs       the hook dispatcher, chalk bundled
//   term/package.json        the name and version `--version` and the build cache key read
//   term/hash.tree           every file with its sha256 and mode, so a second version installed shares the files the
//                            first holds alike (note/term/plan/term-versions.md, "Disk")
//   term/deck/base/code/     the stdlib, found by the walk up from host/ (resolve.ts `stdlibBase`)
//   term/node_modules/       esbuild + @esbuild/<platform> (native, run by boot, test, walk, cast),
//                            hono + @hono/node-server (linked into every `term boot` app, which imports them)
//
// EVERY PACKAGE IN node_modules IS FETCHED FROM THE npm REGISTRY, at the exact version installed here, and checked
// against the registry's sha512 integrity. Never copied from this machine's node_modules: esbuild's install step
// replaces `bin/esbuild` with THIS machine's native binary, so a copied esbuild would carry darwin-arm64 into a
// linux-x64 tarball and fail only on that machine.

import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs'
import path from 'node:path'
import { build } from 'esbuild'
import { ensurePublisher, publishRelease, releaseRoute, transportFor } from '@cluesurf/deck.tree'
import { announce, loadPublishKeypair } from '@term/call/code/host'
import { writeFileList } from '@term/call/code/need-load'
// the terminal output library, as a TYPE only: the module itself is loaded after the port build has run, because the
// port build is what writes the modules it is made of (see `main`)
import type * as Output from '@term/call/code/output'

// the release's run, once the library is loaded: every line goes through it, as every term command's does. Unset
// until `main` has run the port build
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

// The launcher on PATH. It follows its own symlink, because `~/.base/@cluesurf/term/bin/term` and a Homebrew
// `bin/term` are both links to it, and the install is beside the file, not beside the link
const LAUNCHER = `#!/bin/sh
# The term command. Installed by https://term.surf/load or Homebrew; see note/term/plan/term-load-install.md.
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
// `bin\term.cmd` under ~/.base/@cluesurf/term is a shim that calls this one (self.ts `link`), so this file is never the
// one replaced while it runs. CRLF, which cmd.exe reads either way and Notepad shows right
const WINDOWS_LAUNCHER = [
  '@echo off',
  'rem The term command. Installed by https://term.surf/load.ps1; see note/term/plan/term-load-install.md.',
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

// the ported toolchain modules line.ts imports, written by port-build (the step make:line runs first). Its output is
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

  const summary = /(\d+) built, (\d+) unchanged.*?(\d+) failed/.exec(text)

  return {
    ok,
    built: Number(summary?.[1] ?? 0),
    unchanged: Number(summary?.[2] ?? 0),
    failed: Number(summary?.[3] ?? (ok ? 0 : 1)),
    lines: text.split('\n').filter(line => line.trim() !== ''),
  }
}

// bin\term.exe, the Windows launcher winget links onto PATH (task/launcher/term.go), cross-compiled by Go with no C
// toolchain, stripped, and with no build paths in it, so two builds of one source are the same bytes
function buildWindowsExe(input: { out: string; arch: 'amd64' | 'arm64' }): void {
  execFileSync('go', ['build', '-trimpath', '-ldflags', '-s -w', '-o', input.out, path.join(TERM, 'task', 'launcher', 'term.go')], {
    env: { ...process.env, GOOS: 'windows', GOARCH: input.arch, CGO_ENABLED: '0' },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
}

// line.js, dock.mjs and the two dispatch modules, bundled once: they are the same for every platform
async function bundle(into: string): Promise<void> {
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

  await build({ ...common, entryPoints: ['deck/call/code/line.ts'], outfile: path.join(into, 'host', 'line.js') })
  await build({ ...common, entryPoints: ['deck/call/code/hook-dispatch.ts'], outfile: path.join(into, 'host', 'dock.mjs') })
  await build({ ...common, entryPoints: ['deck/call/code/need-run.ts'], outfile: path.join(into, 'host', 'need.mjs') })
  await build({ ...common, entryPoints: ['deck/call/code/need-hand.ts'], outfile: path.join(into, 'host', 'need-hand.mjs') })
}

// the stdlib as the npm package ships it: no native build output, no build info
function copyStdlib(into: string): void {
  const from = path.join(TERM, 'deck', 'base', 'code')

  cpSync(from, path.join(into, 'deck', 'base', 'code'), {
    recursive: true,
    filter: source => {
      const relative = path.relative(from, source)

      return !/(^|\/)native\/[^/]+\/(\.build|target)(\/|$)/.test(relative) && !/\.tsbuildinfo/.test(relative)
    },
  })
}

async function main(): Promise<void> {
  if (process.argv.includes('--ping')) {
    await pingReleased()

    return
  }

  const dry = process.argv.includes('--dry')
  const version = readVersion()
  const out = path.join(OUT_ROOT, version)
  const cache = path.join(OUT_ROOT, 'npm')
  const common = path.join(out, 'common')
  const started = Date.now()

  // THE REGISTRY FIRST. A release is write-once, so a version already there is refused before anything is built:
  // this asked it last, after a minute of packing six platforms. A dry run builds all the same, and says so at the end
  const taken = await releasedAlready(version)

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

  rmSync(out, { recursive: true, force: true })
  mkdirSync(cache, { recursive: true })

  // the port build first, on its own: the output library is loaded from the ports it writes
  const port = portBuild()
  output = await import('@term/call/code/output')
  output.openRun({ verb: 'release', root: TERM, facts: [`${PACKAGE} ${version}`, ...(dry ? ['--dry'] : [])], started })
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
    output.closeRun({ verdict: 'Nothing released', next: 'pnpm --dir deck/term/deck/term run make:port' })

    return
  }

  const bundled = Date.now()
  await bundle(common)
  output.report({ glyph: 'done', verb: 'bundle', subject: 'line.js, dock.mjs, need.mjs and need-hand.mjs', duration: Date.now() - bundled })

  const built: Built[] = []

  for (const platform of PLATFORMS) {
    const packed = Date.now()
    const stage = path.join(out, platform.name)
    const root = path.join(stage, 'term')

    cpSync(path.join(common, 'host'), path.join(root, 'host'), { recursive: true })
    copyStdlib(root)

    writeFileSync(
      path.join(root, 'package.json'),
      `${JSON.stringify({ name: '@cluesurf/term', version, type: 'module', private: true }, null, 2)}\n`,
    )

    mkdirSync(path.join(root, 'bin'), { recursive: true })

    if (platform.name.startsWith('windows-')) {
      writeFileSync(path.join(root, 'bin', 'term.cmd'), WINDOWS_LAUNCHER)
      buildWindowsExe({ out: path.join(root, 'bin', 'term.exe'), arch: platform.name === 'windows-arm64' ? 'arm64' : 'amd64' })
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

    // every file with its sha256 and mode, inside the signed layer, so an install shares what an installed version
    // holds alike (need-load.ts `extractShared`)
    writeFileList(root)

    const file = path.join(out, `term-${platform.name}.tar.gz`)

    // COPYFILE_DISABLE keeps macOS tar from writing `._` resource-fork entries into the archive
    execFileSync('tar', ['-czf', file, '-C', stage, 'term'], { env: { ...process.env, COPYFILE_DISABLE: '1' } })

    const bytes = readFileSync(file)
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`

    built.push({ platform: platform.name, file, digest, bytes: statSync(file).size })
    // the digest is an identifier of 71 characters: a field, on its own line, not a fact
    output.report({ glyph: 'done', verb: 'pack', subject: platform.name, duration: Date.now() - packed, bytes: bytes.length, fields: [output.field('digest', digest)] })
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

// P2: the push, run under zone for its one secret. The release stays the one run on the terminal, and zone, a Term
// program booted by `term boot`, prints its own run nested under it (section 15) rather than at the top level before it,
// which is what `zone load cluesurf -- pnpm run release` did. The child reports each step on stdout, and the release
// draws them as its own items
async function publish(input: { version: string; built: Built[]; first: boolean }): Promise<void> {
  const route = releaseRoute({ package: PACKAGE })
  const root = path.resolve(TERM, '../../../..')
  const child = spawn(path.join(root, 'deck/zone/bin/zone'), ['load', 'cluesurf', '--', 'pnpm', '-s', '--dir', TERM, 'exec', 'tsx', 'task/release.ts', '--push', input.version], {
    cwd: root,
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
    throw Object.assign(new Error(failed || `the push under zone exited ${status ?? 'on a signal'}`), { expected: true })
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

// `--push <version>`, the child `publish` starts under zone: push every platform built under tmp/release/<version>
// to `@term/code`'s route, signed by this machine's publish key, which must be in (or will found) the scope's key set.
// Credentials come from GHCR_TOKEN, which zone hands it. It opens no run: it says each step to the release as a line
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
