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
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs'
import { link as linkFile, lstat } from 'fs/promises'
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
import { frontOf, installedVersions } from '@term/call/code/need'

/** The toolchain's package name (09, "The name"). */
export const PACKAGE = '@term/code'

// the most a payload may be, so a hostile registry cannot make an install fill the disk
const PAYLOAD_LIMIT = 512 * 1024 * 1024

// how long a second install of one version waits for the first, and how often it looks
const LOCK_WAIT_MS = 5 * 60 * 1000
const LOCK_POLL_MS = 250

// On Windows the system's own tar.exe, by its full path: Git for Windows puts GNU tar on PATH, which reads the `C:` of
// `-C C:\...` as a remote host name and fails
const TAR = process.platform === 'win32' ? nodePath.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar'

export type Install = {
  version: string
  platform: string
  // the layer digest the payload was unpacked from
  hash: string
}

const NONE_SHARED = { files: 0, bytes: 0 }

// how many hard links an install makes at once: Node's thread pool is four, and APFS gained nothing past it
const LINK_WIDTH = 4

export type Verified =
  | { ok: true; layer: string; size: number; keys: string; config: ReleaseConfig }
  | { ok: false; reason: string }

export type Loaded =
  | {
      ok: true
      version: string
      platform: string
      layer: string
      keys: string
      bytes: number
      duration: number
      fresh: boolean
      // files hard-linked to the same file in a version already installed, and their bytes
      shared: { files: number; bytes: number }
    }
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
    return { ok: true, version, platform, layer: readInstall(installFile(version))?.hash ?? '', keys: '', bytes: 0, duration: 0, fresh: false, shared: NONE_SHARED }
  }

  return withInstallLock(version, () => install({ version: version!, platform, expect: input.expect, route, transport }))
}

/** `2,104 files shared, 37.9 MB`: what a new version did not cost, by linking to a version already installed */
export function sharedFacts(shared: { files: number; bytes: number }): string[] {
  return shared.files > 0 ? [`${shared.files.toLocaleString('en-US')} files shared, ${(shared.bytes / 1e6).toFixed(1)} MB`] : []
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
  return frontOf(userHome())
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
      shared: NONE_SHARED,
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

  const shared = await unpack({ version: input.version, bytes, install: { version: input.version, platform: input.platform, hash: verified.layer } })

  return {
    ok: true,
    version: input.version,
    platform: input.platform,
    layer: verified.layer,
    keys: verified.keys,
    bytes: bytes.length,
    duration: Date.now() - started,
    fresh: true,
    shared,
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
async function unpack(input: { version: string; bytes: Buffer; install: Install }): Promise<{ files: number; bytes: number }> {
  const code = userHome('code')
  const target = nodePath.join(code, input.version)
  const staging = nodePath.join(code, `.${input.version}.${randomUUID()}`)
  const archive = `${staging}.tar.gz`

  mkdirSync(staging, { recursive: true })

  try {
    writeFileSync(archive, input.bytes)
    const shared = await extractShared({ archive, into: staging, others: installedVersions(userHome()).map(version => nodePath.join(code, version, 'term')) })
    writeInstall({ file: nodePath.join(staging, 'install.tree'), install: input.install })
    rmSync(target, { recursive: true, force: true })
    renameSync(staging, target)

    return shared
  } finally {
    rmSync(archive, { force: true })
    rmSync(staging, { recursive: true, force: true })
  }
}

/** The list of every file in a release payload, `term/hash.tree`: written by `pnpm term:release`, read by every install. */
export const FILE_LIST = 'hash.tree'

/** One file of a payload, by its path under `term/`. */
export type ListedFile = { path: string; hash: string; mode: string }

/**
 * List every regular file under a payload root with its sha256 and mode, and write the list as `hash.tree` beside them.
 * `pnpm term:release` runs this before it packs each platform, so the list travels inside the signed layer.
 */
export function writeFileList(root: string): ListedFile[] {
  const listed = filesUnder(root)
    .filter(path => path !== FILE_LIST)
    .sort()
    .map(path => {
      const file = nodePath.join(root, path)

      return {
        path: path.split(nodePath.sep).join('/'),
        hash: createHash('sha256').update(readFileSync(file)).digest('hex'),
        mode: (statSync(file).mode & 0o777).toString(8),
      }
    })

  writeFileSync(
    nodePath.join(root, FILE_LIST),
    [
      '# Every file in this release, with its sha256 and mode. Written by `pnpm term:release`, inside the signed layer.',
      '# An install reads it to hard-link each file a version already installed holds alike (term self load).',
      ...listed.flatMap(one => [`file <${one.path}>`, `  hash <${one.hash}>`, `  mode <${one.mode}>`]),
      '',
    ].join('\n'),
  )

  return listed
}

/** A payload's file list, through the one `.tree` reader, keyed by path. Undefined when the payload has none. */
export function readFileList(file: string): Map<string, ListedFile> | undefined {
  let text: string

  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return undefined
  }

  const read = readTree({ file, text })

  if (!read.ok) {
    return undefined
  }

  const listed = new Map<string, ListedFile>()

  for (const form of read.forms) {
    const path = form.head === 'file' ? form.value : undefined
    const hash = valueOf(form, 'hash')
    const mode = valueOf(form, 'mode')

    if (path && hash && mode) {
      listed.set(path, { path, hash, mode })
    }
  }

  return listed
}

/**
 * Unpack a payload into `into`, hard-linking every file a version already installed holds alike instead of writing it
 * again (note/term/plan/term-versions.md, "Disk", V10). Two releases mostly hold the same standard library files and
 * the same esbuild binary, so a second version costs only what changed.
 *
 * THE LISTS DECIDE, not the disk. The new payload's `hash.tree` comes out first and alone; a file whose path, sha256
 * and mode match an installed version's own `hash.tree` is linked, and tar extracts only the rest, by name. One
 * operation per shared file and nothing hashed at install time. The first version of this extracted everything, hashed
 * both copies, linked and renamed: 7.7 s for 4,649 files where a plain extract takes 1.1 s. A payload without a list,
 * or a version without one, shares nothing and unpacks whole.
 *
 * No shared store and no reference count: a link IS the count, so `toss` and `wash` removing one version leave every
 * other version whole, and the last one removed frees the bytes. A link that fails (the file is gone, another
 * filesystem, one without links) is extracted after all.
 *
 * Returns how many files and bytes are shared.
 */
export async function extractShared(input: { archive: string; into: string; others: string[] }): Promise<{ files: number; bytes: number }> {
  const listFile = nodePath.join(input.into, 'term', FILE_LIST)

  try {
    execFileSync(TAR, ['-xzf', input.archive, '-C', input.into, `term/${FILE_LIST}`], { stdio: 'ignore' })
  } catch {
    // an older payload with no list: unpack it whole
  }

  const mine = readFileList(listFile)
  const theirs = mine ? input.others.map(root => ({ root, listed: readFileList(nodePath.join(root, FILE_LIST)) })).filter(one => one.listed) : []
  const links: { from: string; to: string; path: string }[] = []

  for (const file of mine?.values() ?? []) {
    // tar reads a name as a pattern, so a name with a glob character could match another file: it is extracted
    if (/[*?[\\]/.test(file.path)) {
      continue
    }

    const match = theirs.find(one => {
      const other = one.listed!.get(file.path)

      return other && other.hash === file.hash && other.mode === file.mode
    })

    if (match) {
      links.push({ from: nodePath.join(match.root, file.path), to: nodePath.join(input.into, 'term', file.path), path: file.path })
    }
  }

  if (links.length === 0) {
    execFileSync(TAR, ['-xzf', input.archive, '-C', input.into])

    return { files: 0, bytes: 0 }
  }

  let files = 0
  let bytes = 0
  const made = new Set<string>()
  const linked = new Set<string>()

  // the directories first, once each, then the links LINK_WIDTH at a time: a link is a metadata write, and on APFS four
  // in flight took 4,649 links from 2.6 s to 1.6 s where sixteen or sixty-four did no better
  for (const link of links) {
    const parent = nodePath.dirname(link.to)

    if (!made.has(parent)) {
      mkdirSync(parent, { recursive: true })
      made.add(parent)
    }
  }

  let next = 0

  await Promise.all(
    Array.from({ length: LINK_WIDTH }, async () => {
      while (next < links.length) {
        const link = links[next++]!

        try {
          const size = (await lstat(link.from)).size

          await linkFile(link.from, link.to)
          linked.add(`term/${link.path}`)
          files++
          bytes += size
        } catch {
          // the file is gone from that version, or the filesystem refuses a link: extracted below, from the archive
        }
      }
    }),
  )

  // EVERY OTHER ENTRY, from tar's own listing rather than the file list, so a symlink or anything else the list does not
  // name still arrives. Named with `-T`, never excluded with `-X`: tar matches each entry against every pattern, and
  // 4,600 exclusions took 5.4 s where the whole extract takes 1.1 s, while a few dozen names cost nothing
  const rest = execFileSync(TAR, ['-tzf', input.archive], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
    .split('\n')
    .filter(entry => entry !== '' && !entry.endsWith('/') && !linked.has(entry))

  if (rest.length > 0) {
    const names = `${input.archive}.names`

    writeFileSync(names, rest.map(entry => `${entry}\n`).join(''))

    try {
      execFileSync(TAR, ['-xzf', input.archive, '-C', input.into, '-T', names])
    } finally {
      rmSync(names, { force: true })
    }
  }

  return { files, bytes }
}

// every regular file under a directory, relative to it. Links and directories are not files to share
function filesUnder(dir: string): string[] {
  const found: string[] = []

  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) {
      found.push(nodePath.relative(dir, nodePath.join(entry.parentPath, entry.name)))
    }
  }

  return found
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
