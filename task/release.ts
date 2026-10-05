// `pnpm term:release`: build the `term` command for every platform, as the payload `@term/code` ships through the Term
// registry (note/term/plan/term-load-install.md, note/term/self-host/09-distribution.md).
//
//   pnpm term:release --dry      build tmp/release/<version>/term-<platform>.tar.gz and stop
//   pnpm term:release            build, then publish to ghcr.io/cluesurf/term/code under the version tag
//
// THE PAYLOAD IS THE NODE BUILD, for now. 09's target is a native binary per platform, which the self-hosting port
// has not produced yet, so each platform's tarball is `deck/call/code/line.ts` bundled for Node, and only the parts
// that cannot be bundled travel beside it:
//
//   term/bin/term            sh launcher: follows its own link to find the install, then `exec node host/line.js`
//   term/host/line.js        the CLI, every pure-JS dependency (yargs, chalk) BUNDLED
//   term/host/dock.mjs       the hook dispatcher, chalk bundled
//   term/package.json        the name and version `--version` and the build cache key read
//   term/deck/base/code/     the stdlib, found by the walk up from host/ (resolve.ts `stdlibBase`)
//   term/node_modules/       esbuild + @esbuild/<platform> (native, run by boot, test, walk, cast),
//                            hono + @hono/node-server (linked into every `term boot` app, which imports them)
//
// EVERY PACKAGE IN node_modules IS FETCHED FROM THE npm REGISTRY, at the exact version installed here, and checked
// against the registry's sha512 integrity. Never copied from this machine's node_modules: esbuild's install step
// replaces `bin/esbuild` with THIS machine's native binary, so a copied esbuild would carry darwin-arm64 into a
// linux-x64 tarball and fail only on that machine.

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs'
import path from 'node:path'
import { build } from 'esbuild'
import { ensurePublisher, publishRelease, releaseRoute, transportFor } from '@cluesurf/deck.tree'
import { loadPublishKeypair } from '@term/call/code/host'

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
exec node "$root/host/line.js" "$@"
`

type Built = { platform: string; file: string; digest: string; bytes: number }

function readVersion(): string {
  const manifest = JSON.parse(readFileSync(path.join(TERM, 'package.json'), 'utf8')) as { version?: string }

  if (!manifest.version) {
    throw new Error('package.json has no version')
  }

  return manifest.version
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

// line.js and dock.mjs, bundled once: they are the same for every platform
async function bundle(into: string): Promise<void> {
  // the ported toolchain modules line.ts imports, written by port-build (the step make:line runs first)
  execFileSync('pnpm', ['run', 'make:port'], { cwd: TERM, stdio: 'inherit' })

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
  const dry = process.argv.includes('--dry')
  const version = readVersion()
  const out = path.join(OUT_ROOT, version)
  const cache = path.join(OUT_ROOT, 'npm')
  const common = path.join(out, 'common')

  rmSync(out, { recursive: true, force: true })
  mkdirSync(cache, { recursive: true })

  console.log(`@term/code ${version}: bundling`)
  await bundle(common)

  const built: Built[] = []

  for (const platform of PLATFORMS) {
    const stage = path.join(out, platform.name)
    const root = path.join(stage, 'term')

    cpSync(path.join(common, 'host'), path.join(root, 'host'), { recursive: true })
    copyStdlib(root)

    writeFileSync(
      path.join(root, 'package.json'),
      `${JSON.stringify({ name: '@cluesurf/term', version, type: 'module', private: true }, null, 2)}\n`,
    )

    mkdirSync(path.join(root, 'bin'), { recursive: true })
    writeFileSync(path.join(root, 'bin', 'term'), LAUNCHER)
    chmodSync(path.join(root, 'bin', 'term'), 0o755)

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

    const file = path.join(out, `term-${platform.name}.tar.gz`)

    // COPYFILE_DISABLE keeps macOS tar from writing `._` resource-fork entries into the archive
    execFileSync('tar', ['-czf', file, '-C', stage, 'term'], { env: { ...process.env, COPYFILE_DISABLE: '1' } })

    const bytes = readFileSync(file)
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`

    built.push({ platform: platform.name, file, digest, bytes: statSync(file).size })
    console.log(`  ${platform.name}  ${(bytes.length / 1024 / 1024).toFixed(1)} MB  ${digest}`)
  }

  writeFileSync(path.join(out, 'release.json'), `${JSON.stringify({ package: '@term/code', version, built }, null, 2)}\n`)

  if (dry) {
    console.log(`\nbuilt ${built.length} platforms in ${path.relative(TERM, out)}, nothing published (--dry)`)

    return
  }

  await publish({ version, built })
}

// P2: push every platform under `@term/code`'s route, signed by this machine's publish key, which must be in (or will
// found) the scope's key set. Credentials come from GHCR_TOKEN, which `pnpm term:release` loads from zone
async function publish(input: { version: string; built: Built[] }): Promise<void> {
  const route = releaseRoute({ package: PACKAGE })
  const keypair = await loadPublishKeypair({ mint: false })

  if (!keypair) {
    throw new Error('there is no publish key on this machine; `term host` makes one on a first publish')
  }

  const transport = transportFor({ host: route.registry.host })
  const keys = await ensurePublisher({ transport, repository: route.keysRepository, scope: route.scope, keypair })

  if (keys.created) {
    console.log(`created the key set of ${route.scope} at ${route.registry.host}/${route.keysRepository}`)
  }

  const released = await publishRelease({
    transport,
    repository: route.repository.name,
    package: PACKAGE,
    version: input.version,
    payloads: input.built.map(one => ({ platform: one.platform, bytes: readFileSync(one.file) })),
    keypair,
    annotations: {
      'org.opencontainers.image.source': SOURCE,
      'org.opencontainers.image.licenses': 'MIT',
      'org.opencontainers.image.description': 'The term command: the Term compiler, package manager and toolchain',
    },
    log: message => console.log(`  ${message}`),
  })

  const [owner, ...rest] = route.repository.name.split('/')

  console.log(`\nreleased ${PACKAGE}@${input.version} as ${route.registry.host}/${route.repository.name}:${input.version}`)
  console.log(`  index ${released.index}`)
  console.log(
    `\nA new GHCR package is private, and nothing installs from a private one. If this is the first release, make it public once at`,
  )
  console.log(`  https://github.com/orgs/${owner}/packages/container/${encodeURIComponent(rest.join('/'))}/settings`)
}

await main()
