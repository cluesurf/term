// Installing a version of `term`, verified, beside the others (note/term/plan/term-versions.md, "Installing a
// version"). The ONE path every install takes: `term self load`, `pick`, `need` and `update`, and dispatch when a
// project needs a version that is not here. `self.ts` and `need-run.ts` both call it, so there is one set of checks.
//
//   1  the release's image index, under the version tag. A lock.tree pin's digest must equal it, or nothing installs
//   2  this platform's manifest and config, the signature over the layer, and the signer in the scope's key set
//   3  the layer, downloaded, its sha256 against the digest
//   4  unpacked into a staging directory and renamed into code/<version>/ whole, with its install.tree
//
// TWO INSTALLS OF ONE VERSION AT ONCE (two terminals, a CI job with parallel steps) are serialized by a lock directory
// beside the version, made with one atomic `mkdir`. The second waits, then finds the first one's result.
//
// THE LAYOUT, under ~/.base/@cluesurf/term/:
//
//   bin/term                   the FRONT: a link to the newest dispatching version, the one thing on PATH
//                              (bin\term.cmd on Windows, a one-line shim, because a symlink needs a privilege there)
//   code/<version>/term/       the unpacked payload
//   code/<version>/install.tree  version, platform, and the layer digest it was unpacked from
//   code/<version>/used        the day a command last ran on this version, which `term self wash` reads
//   need.tree                  the default request, written by `term self pick`

import { execFileSync } from 'child_process'
import { createHash, randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs'
import nodePath from 'path'

import {
  currentPlatform,
  newestMatching,
  readRelease,
  readTree,
  releaseRoute,
  releasedVersions,
  transportFor,
  trustDir,
  trustedKeys,
  valueOf,
} from '@cluesurf/deck.tree'
import type { OciRoute, OciTransport, ReleaseConfig } from '@cluesurf/deck.tree'
import type { CodeHold } from '@term/deck/code/form'

import { userHome } from '@term/call/code/home'

/** The toolchain's package name (09, "The name"). */
export const PACKAGE = '@term/code'

// the most a payload may be, so a hostile registry cannot make an install fill the disk
const PAYLOAD_LIMIT = 512 * 1024 * 1024

// how long a second install of one version waits for the first, and how often it looks
const LOCK_WAIT_MS = 5 * 60 * 1000
const LOCK_POLL_MS = 250

// a version's `used` stamp is rewritten at most this often, so recording a use costs nothing per command
const USED_EVERY_MS = 24 * 60 * 60 * 1000

// On Windows the system's own tar.exe, by its full path: Git for Windows puts GNU tar on PATH, which reads the `C:` of
// `-C C:\...` as a remote host name and fails
const TAR = process.platform === 'win32' ? nodePath.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar'

export type Install = {
  version: string
  platform: string
  // the layer digest the payload was unpacked from
  hash: string
}

export type Verified =
  | { ok: true; layer: string; size: number; keys: string; config: ReleaseConfig }
  | { ok: false; reason: string }

export type Loaded =
  | { ok: true; version: string; platform: string; layer: string; keys: string; bytes: number; duration: number; fresh: boolean }
  | { ok: false; reason: string }

/** Where releases are: the scope's route, or TERM_RELEASE_REGISTRY (release.ts `releaseRoute`). */
export function routeOf(): OciRoute {
  return releaseRoute({ package: PACKAGE })
}

/** Every released version, newest first. */
export async function listReleases(): Promise<string[]> {
  const route = routeOf()

  return releasedVersions({ transport: transportFor({ host: route.registry.host }), repository: route.repository.name })
}

/**
 * One release, verified in full: the index, the platform's manifest, the signature over the layer, and the signer in the
 * scope's key set
 */
export async function verifyRelease(input: { version: string; platform: string }): Promise<Verified> {
  const route = routeOf()
  const transport = transportFor({ host: route.registry.host })

  try {
    const release = await readRelease({
      transport,
      repository: route.repository.name,
      package: PACKAGE,
      version: input.version,
      platform: input.platform,
    })
    const trusted = await trustedKeys({
      transport,
      repository: route.keysRepository,
      scope: route.scope,
      host: route.registry.host,
      trustDir: trustDir(),
    })

    if (!trusted) {
      return { ok: false, reason: `${route.scope} publishes no key set at ${route.registry.host}/${route.keysRepository}` }
    }

    if (!trusted.keys.includes(release.config.key)) {
      return { ok: false, reason: `${PACKAGE}@${input.version} is signed by a key outside the key set of ${route.scope}` }
    }

    return {
      ok: true,
      layer: release.layer,
      size: release.size,
      config: release.config,
      keys: `the key set of ${route.scope} (${trusted.source})`,
    }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Install a version: an exact one, or the newest release in a range. `expect` is a lock.tree pin's index digest, which
 * the registry must still serve. Installing a version that is already here returns at once, `fresh: false`.
 */
export async function loadVersion(input: {
  version?: string
  hold?: CodeHold
  expect?: string
  platform?: string
}): Promise<Loaded> {
  const platform = input.platform ?? currentPlatform()

  if (!platform) {
    return { ok: false, reason: `No release is built for ${process.platform}-${process.arch}` }
  }

  const route = routeOf()
  const transport = transportFor({ host: route.registry.host })
  let version = input.version

  if (!version) {
    if (!input.hold) {
      return { ok: false, reason: 'loadVersion needs a version or a range' }
    }

    let versions: string[]

    try {
      versions = await releasedVersions({ transport, repository: route.repository.name })
    } catch (error) {
      return { ok: false, reason: `the releases at ${route.registry.host}/${route.repository.name} could not be read: ${(error as Error).message}` }
    }

    version = newestMatching({ versions, hold: input.hold })

    if (!version) {
      return { ok: false, reason: `${PACKAGE} has no release in that range${versions[0] ? `. The newest is ${versions[0]}: term self find` : ''}` }
    }
  }

  if (isInstalled(version)) {
    return { ok: true, version, platform, layer: readInstall(installFile(version))?.hash ?? '', keys: '', bytes: 0, duration: 0, fresh: false }
  }

  return withInstallLock(version, () => install({ version: version!, platform, expect: input.expect, route, transport }))
}

/** Is this version unpacked here, with its install.tree? */
export function isInstalled(version: string): boolean {
  return existsSync(installFile(version))
}

/** `install.tree`, through the one `.tree` reader. */
export function readInstall(file: string): Install | undefined {
  if (!existsSync(file)) {
    return undefined
  }

  const read = readTree({ file, text: readFileSync(file, 'utf8') })
  const form = read.ok ? read.forms.find(one => one.head === 'install') : undefined
  const version = form && valueOf(form, 'code')
  const platform = form && valueOf(form, 'form')
  const hash = form && valueOf(form, 'hash')

  return version && platform && hash ? { version, platform, hash } : undefined
}

/** A version's install.tree. */
export function installFile(version: string): string {
  return userHome('code', version, 'install.tree')
}

/**
 * Point the front (bin/term) at a version, atomically: a new link beside it, renamed over the old one.
 *
 * ON WINDOWS bin\term.cmd is a one-line shim instead, because a symlink there needs a privilege an ordinary user lacks.
 * The `& exit /b` on the SAME line is what makes replacing it safe while it runs: cmd.exe reads a batch file a line at
 * a time from where it left off, so a second line would be read out of the new file's bytes at the old offset
 */
export function linkFront(version: string): void {
  const windows = process.platform === 'win32'
  const bin = userHome('bin', windows ? 'term.cmd' : 'term')
  const next = `${bin}.${randomUUID()}`

  mkdirSync(nodePath.dirname(bin), { recursive: true })

  if (windows) {
    writeFileSync(next, `@"%~dp0..\\code\\${version}\\term\\bin\\term.cmd" %* & exit /b\r\n`)
  } else {
    symlinkSync(nodePath.join('..', 'code', version, 'term', 'bin', 'term'), next)
  }

  renameSync(next, bin)
}

/** The version the front points at, or undefined when there is no front here. */
export function frontVersion(): string | undefined {
  const windows = process.platform === 'win32'
  const bin = userHome('bin', windows ? 'term.cmd' : 'term')

  try {
    const text = windows ? readFileSync(bin, 'utf8') : (execFileSync('readlink', [bin], { encoding: 'utf8' }) as string)
    const found = /code[\\/](\d+\.\d+\.\d+)[\\/]/.exec(text)

    return found?.[1]
  } catch {
    return undefined
  }
}

/** Record that a command ran on a version today, so `wash` keeps it. At most one write a day. */
export function markUsed(version: string): void {
  const file = userHome('code', version, 'used')

  try {
    if (existsSync(file) && Date.now() - statSync(file).mtimeMs < USED_EVERY_MS) {
      return
    }

    writeFileSync(file, `${new Date().toISOString()}\n`)
  } catch {
    // a read-only home must never stop a command
  }
}

/** When a command last ran on a version, or when it was installed if never. */
export function lastUsed(version: string): Date | undefined {
  for (const file of [userHome('code', version, 'used'), installFile(version)]) {
    try {
      return statSync(file).mtime
    } catch {
      // try the next
    }
  }

  return undefined
}

// The download and the unpack, under the install lock
async function install(input: {
  version: string
  platform: string
  expect?: string
  route: OciRoute
  transport: OciTransport
}): Promise<Loaded> {
  // another install may have finished while this one waited for the lock
  if (isInstalled(input.version)) {
    return {
      ok: true,
      version: input.version,
      platform: input.platform,
      layer: readInstall(installFile(input.version))?.hash ?? '',
      keys: '',
      bytes: 0,
      duration: 0,
      fresh: false,
    }
  }

  const started = Date.now()

  if (input.expect) {
    const index = await input.transport.getManifest({ repository: input.route.repository.name, reference: input.version })

    if (!index) {
      return { ok: false, reason: `${PACKAGE}@${input.version} is not released` }
    }

    if (index.digest !== input.expect) {
      return {
        ok: false,
        reason: `lock.tree pins ${PACKAGE}@${input.version} as ${input.expect}, and the registry now serves ${index.digest}. Nothing ran`,
      }
    }
  }

  const verified = await verifyRelease({ version: input.version, platform: input.platform })

  if (!verified.ok) {
    return { ok: false, reason: verified.reason }
  }

  const bytes = await input.transport.getBlob({
    repository: input.route.repository.name,
    digest: verified.layer,
    size: verified.size,
    limit: PAYLOAD_LIMIT,
  })
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`

  if (digest !== verified.layer) {
    return { ok: false, reason: `The download hashes to ${digest}, not the signed ${verified.layer}` }
  }

  unpack({ version: input.version, bytes, install: { version: input.version, platform: input.platform, hash: verified.layer } })

  return {
    ok: true,
    version: input.version,
    platform: input.platform,
    layer: verified.layer,
    keys: verified.keys,
    bytes: bytes.length,
    duration: Date.now() - started,
    fresh: true,
  }
}

function writeInstall(input: { file: string; install: Install }): void {
  writeFileSync(
    input.file,
    [
      '# What this install of term is. Written by https://term.surf/load and `term self`; read by `term self`.',
      'install',
      `  code <${input.install.version}>`,
      `  form <${input.install.platform}>`,
      `  hash <${input.install.hash}>`,
      '',
    ].join('\n'),
  )
}

// Unpack a payload beside the others and write its install.tree. Into a temporary directory first, renamed into place
// whole, so a failed unpack never leaves a half-written version that anything could later run
function unpack(input: { version: string; bytes: Buffer; install: Install }): void {
  const code = userHome('code')
  const target = nodePath.join(code, input.version)
  const staging = nodePath.join(code, `.${input.version}.${randomUUID()}`)
  const archive = `${staging}.tar.gz`

  mkdirSync(staging, { recursive: true })

  try {
    writeFileSync(archive, input.bytes)
    execFileSync(TAR, ['-xzf', archive, '-C', staging])
    writeInstall({ file: nodePath.join(staging, 'install.tree'), install: input.install })
    rmSync(target, { recursive: true, force: true })
    renameSync(staging, target)
  } finally {
    rmSync(archive, { force: true })
    rmSync(staging, { recursive: true, force: true })
  }
}

// One install of a version at a time on this machine: an atomic `mkdir` of a lock directory beside it. A lock older
// than the wait is taken to be from a process that died, and is cleared
async function withInstallLock(version: string, work: () => Promise<Loaded>): Promise<Loaded> {
  const lock = userHome('code', `.${version}.lock`)
  const started = Date.now()

  mkdirSync(userHome('code'), { recursive: true })

  while (true) {
    try {
      mkdirSync(lock)
      break
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_WAIT_MS) {
          rmSync(lock, { recursive: true, force: true })
          continue
        }
      } catch {
        continue
      }

      if (Date.now() - started > LOCK_WAIT_MS) {
        return { ok: false, reason: `another install of ${PACKAGE}@${version} has held ${lock} for five minutes` }
      }

      await new Promise(resolve => setTimeout(resolve, LOCK_POLL_MS))
    }
  }

  try {
    return await work()
  } finally {
    rmSync(lock, { recursive: true, force: true })
  }
}
