// `term self check`, `term self update`, `term self back`: this install of the `term` command
// (note/term/plan/term-load-install.md, note/term/self-host/09-distribution.md R3).
//
// THE LAYOUT, written by https://term.surf/load and by `self update`:
//
//   ~/.base/@cluesurf/term/bin/term                 a link to code/<version>/term/bin/term, the one thing on PATH
//                                                   (on Windows bin\term.cmd, a one-line shim to that version's
//                                                   term.cmd, written by https://term.surf/load.ps1 and `link` below)
//   ~/.base/@cluesurf/term/code/<version>/term/     the unpacked release payload
//   ~/.base/@cluesurf/term/code/<version>/install.tree   version, platform, and the layer digest it was unpacked from
//
// WHAT `check` PROVES. The loader checked the download's sha256 against the digest GHCR served, and wrote that digest
// into install.tree. `check` closes the chain: the release config for this version and platform is signed over THAT
// digest, by a key in the scope's key set, verified and pinned the same way package installs pin it (`trustedKeys`).
// A digest alone says the bytes arrived intact; the signature says the scope stands behind them.
//
// `update` is the same check on the newest version, then the download, its sha256, an unpack beside the current
// version, and an atomic swap of the `bin/term` link. The previous version stays, so `back` is a link swap and never a
// download. Anything older than the previous one is removed after a successful update.
//
// A COPY THIS DID NOT INSTALL is said to be so. Homebrew updates its own (`brew upgrade cluesurf/tool/term`), and a
// source checkout is built, not installed, so `update` and `back` refuse both, naming the way that does work.

import { execFileSync } from 'child_process'
import { createHash, randomUUID } from 'crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import nodePath from 'path'
import { fileURLToPath } from 'url'

import {
  currentPlatform,
  readRelease,
  readTree,
  releaseRoute,
  transportFor,
  trustDir,
  trustedKeys,
  valueOf,
} from '@cluesurf/deck.tree'
import type { OciRoute, ReleaseConfig } from '@cluesurf/deck.tree'

import { userHome } from '@term/call/code/home'
import { closeRun, field, openRun, report } from '@term/call/code/output'

// the toolchain's package name (09, "The name")
const PACKAGE = '@term/code'

// the most a payload may be, so a hostile registry cannot make an update fill the disk
const PAYLOAD_LIMIT = 512 * 1024 * 1024

const VERSION = /^\d+\.\d+\.\d+$/

// On Windows the system's own tar.exe, by its full path: Git for Windows puts GNU tar on PATH, which reads the `C:` of
// `-C C:\...` as a remote host name and fails
const TAR = process.platform === 'win32' ? nodePath.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar'

type Install = {
  version: string
  platform: string
  // the layer digest the payload was unpacked from
  hash: string
}

type Held = { form: 'installed'; install: Install } | { form: 'homebrew'; version: string } | { form: 'source'; version: string }

export async function callSelfCheck(input: { root: string }): Promise<void> {
  openRun({ verb: 'self', root: input.root, subject: 'check' })

  const held = whatRuns()
  const platform = held.form === 'installed' ? held.install.platform : currentPlatform()
  const version = held.form === 'installed' ? held.install.version : held.version

  if (!platform) {
    report({ glyph: 'failed', kind: 'problem', verb: 'check', subject: `No release is built for ${process.platform}-${process.arch}` })
    closeRun({ verdict: 'Not checked', failure: 'environment' })

    return
  }

  const verified = await verify({ version, platform })

  if (!verified.ok) {
    report({ glyph: 'failed', kind: 'problem', verb: 'check', subject: verified.reason })
    closeRun({ verdict: `${PACKAGE}@${version} did not verify`, failure: 'environment' })

    return
  }

  if (held.form !== 'installed') {
    // a release exists for this version and is signed, but these bytes were not installed from it by term.surf/load
    report({
      glyph: 'info',
      verb: 'check',
      subject: `${PACKAGE}@${version} for ${platform} is released and signed by ${verified.keys}`,
      message: [
        held.form === 'homebrew'
          ? 'Homebrew installed this copy and checked its download against the same layer digest.'
          : 'This copy is a source build, so its bytes are not compared with the release.',
      ],
    })
    closeRun({ verdict: 'The release verifies' })

    return
  }

  if (verified.layer !== held.install.hash) {
    report({
      glyph: 'failed',
      kind: 'problem',
      verb: 'check',
      subject: `This install was unpacked from ${held.install.hash}, and the signed release is ${verified.layer}`,
    })
    closeRun({ verdict: 'This install is not the release', failure: 'environment' })

    return
  }

  report({
    glyph: 'done',
    verb: 'check',
    subject: `${PACKAGE}@${version} for ${platform}`,
    fields: [field('layer', verified.layer), field('signed', verified.keys)],
  })
  closeRun({ verdict: 'This install is the signed release' })
}

export async function callSelfUpdate(input: { root: string }): Promise<void> {
  openRun({ verb: 'self', root: input.root, subject: 'update' })

  const held = whatRuns()

  if (held.form !== 'installed') {
    refuseUnmanaged(held)

    return
  }

  const route = routeOf()
  const transport = transportFor({ host: route.registry.host })
  const tags = (await transport.listTags({ repository: route.repository.name })).filter(tag => VERSION.test(tag))
  const newest = tags.sort(compareVersions).at(-1)

  if (!newest || compareVersions(newest, held.install.version) <= 0) {
    report({ glyph: 'info', verb: 'update', subject: `${PACKAGE}@${held.install.version} is the newest release` })
    closeRun({ verdict: 'Already up to date' })

    return
  }

  const verified = await verify({ version: newest, platform: held.install.platform })

  if (!verified.ok) {
    report({ glyph: 'failed', kind: 'problem', verb: 'update', subject: verified.reason })
    closeRun({ verdict: `${PACKAGE}@${newest} was not installed`, failure: 'environment' })

    return
  }

  const started = Date.now()
  const bytes = await transport.getBlob({
    repository: route.repository.name,
    digest: verified.layer,
    size: verified.size,
    limit: PAYLOAD_LIMIT,
  })
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`

  if (digest !== verified.layer) {
    report({ glyph: 'failed', kind: 'problem', verb: 'update', subject: `The download hashes to ${digest}, not the signed ${verified.layer}` })
    closeRun({ verdict: `${PACKAGE}@${newest} was not installed`, failure: 'environment' })

    return
  }

  unpack({ version: newest, bytes, install: { version: newest, platform: held.install.platform, hash: verified.layer } })
  link(newest)
  prune([newest, held.install.version])

  report({
    glyph: 'changed',
    kind: 'change',
    verb: 'update',
    subject: `${PACKAGE} ${held.install.version} to ${newest}`,
    duration: Date.now() - started,
    bytes: bytes.length,
    fields: [field('layer', verified.layer), field('signed', verified.keys)],
  })
  closeRun({ verdict: `Updated to ${newest}`, done: true, next: 'term self back, to return to the previous version' })
}

export async function callSelfBack(input: { root: string }): Promise<void> {
  openRun({ verb: 'self', root: input.root, subject: 'back' })

  const held = whatRuns()

  if (held.form !== 'installed') {
    refuseUnmanaged(held)

    return
  }

  const previous = installedVersions()
    .filter(version => compareVersions(version, held.install.version) < 0)
    .at(-1)

  if (!previous) {
    report({ glyph: 'failed', kind: 'problem', verb: 'back', subject: `No version older than ${held.install.version} is kept on this machine` })
    closeRun({ verdict: 'Nothing to go back to', failure: 'usage' })

    return
  }

  link(previous)
  report({ glyph: 'changed', kind: 'change', verb: 'back', subject: `${PACKAGE} ${held.install.version} to ${previous}` })
  closeRun({ verdict: `Back on ${previous}`, done: true, next: 'term self update, to move forward again' })
}

// What is running: an install this layout owns (install.tree beside the payload), a Homebrew copy, or a source build
function whatRuns(): Held {
  const payload = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), '..')
  const version = readPackageVersion(payload)
  const install = readInstall(nodePath.join(payload, '..', 'install.tree'))

  if (install) {
    return { form: 'installed', install }
  }

  return { form: /[\\/](Caskroom|Cellar)[\\/]/.test(payload) ? 'homebrew' : 'source', version }
}

function refuseUnmanaged(held: Exclude<Held, { form: 'installed' }>): void {
  const subject =
    held.form === 'homebrew'
      ? 'Homebrew installed this copy, so Homebrew updates it: brew upgrade cluesurf/tool/term'
      : 'This copy is a source build, which is rebuilt, not updated: pnpm run make:line'

  report({ glyph: 'failed', kind: 'problem', verb: 'self', subject })
  closeRun({ verdict: 'Nothing was changed', failure: 'usage' })
}

// where releases are: the scope's route, or TERM_RELEASE_REGISTRY (release.ts `releaseRoute`)
function routeOf(): OciRoute {
  return releaseRoute({ package: PACKAGE })
}

// One release, verified in full: the index, the platform's manifest, the signature over the layer, and the signer in
// the scope's key set
async function verify(input: {
  version: string
  platform: string
}): Promise<{ ok: true; layer: string; size: number; keys: string; config: ReleaseConfig } | { ok: false; reason: string }> {
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

// `install.tree`, through the one `.tree` reader
function readInstall(file: string): Install | undefined {
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

function writeInstall(input: { file: string; install: Install }): void {
  writeFileSync(
    input.file,
    [
      '# What this install of term is. Written by https://term.surf/load and `term self update`; read by `term self`.',
      'install',
      `  code <${input.install.version}>`,
      `  form <${input.install.platform}>`,
      `  hash <${input.install.hash}>`,
      '',
    ].join('\n'),
  )
}

function readPackageVersion(payload: string): string {
  try {
    return (JSON.parse(readFileSync(nodePath.join(payload, 'package.json'), 'utf8')) as { version?: string }).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

// Unpack a payload beside the others and write its install.tree. Into a temporary directory first, renamed into place
// whole, so a failed unpack never leaves a half-written version that `back` could later link to
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

// Point bin/term at a version, atomically: a new link beside it, renamed over the old one.
//
// ON WINDOWS bin\term.cmd is a one-line shim instead, because a symlink there needs a privilege an ordinary user lacks.
// It is renamed over the old one the same way. The `& exit /b` on the SAME line is what makes replacing it safe while it
// runs: cmd.exe reads a batch file a line at a time from where it left off, and `term self update` is run THROUGH this
// file, so a second line would be read out of the new file's bytes at the old offset. One line is parsed whole before
// it runs, and `exit /b` keeps the exit code of the term it called
function link(version: string): void {
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

// Every installed version, oldest first: the directories under code/ that hold an install.tree
function installedVersions(): string[] {
  const code = userHome('code')

  if (!existsSync(code)) {
    return []
  }

  return readdirSync(code)
    .filter(name => VERSION.test(name) && existsSync(nodePath.join(code, name, 'install.tree')))
    .sort(compareVersions)
}

// Remove every installed version but these
function prune(keep: string[]): void {
  for (const version of installedVersions()) {
    if (!keep.includes(version)) {
      rmSync(userHome('code', version), { recursive: true, force: true })
    }
  }
}

function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)

  for (let at = 0; at < 3; at++) {
    const difference = (left[at] ?? 0) - (right[at] ?? 0)

    if (difference !== 0) {
      return difference
    }
  }

  return 0
}
