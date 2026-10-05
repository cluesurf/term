// `pnpm term:distro`: the `term` command for the package managers Linux and Windows already have, made from the
// payloads `pnpm term:release` built (note/term/plan/term-distro.md).
//
//   pnpm term:distro            build everything under tmp/release/<version>/distro/ and stop
//   pnpm term:distro --commit   also write the signed apt and dnf repositories into deck/deck/docs/term/ (served at
//                               https://deck.clue.surf/term/) and the winget manifests into deck/fork-winget-pkgs/.
//                               It writes files and nothing else: every git step and the GitHub release are printed
//                               for a person to run
//
// What it makes, all from tmp/release/<version>/term-<platform>.tar.gz, the bytes `@term/code` releases:
//
//   term_<v>_{amd64,arm64}.deb           /usr/lib/term, the payload as released, and /usr/bin/term a link to its
//   term-<v>-1.{x86_64,aarch64}.rpm      launcher (task/distro/debian.sh, fedora.sh, term.spec, built in Docker)
//   term-<v>-windows-{x64,arm64}.zip     term\, with bin\term.exe (task/launcher/term.go) for winget to link onto PATH
//   winget/manifests/c/ClueSurf/Term/<v>/   ClueSurf.Term, its zips at a GitHub release of cluesurf/term
//   repo/apt/, repo/rpm/                 the repositories as --commit writes them, with the versions they kept
//
// THE KEY NEVER ENTERS A CONTAINER. The containers build packages and indexes and sign nothing; Release and repomd.xml
// are signed here, by gpg, with TERM_DISTRO_KEY (the key `deck/task`'s repositories were made for, by default), which
// asks for its passphrase once on the terminal. test/call/distro.ts signs with a throwaway key in its own GNUPGHOME.
//
// NODE IS RECOMMENDED, NOT REQUIRED, by the .deb and the .rpm. The launcher runs the `node` on PATH, so a Node from
// nvm, fnm or a tarball, which no package manager can see, works, and one too old is named by the launcher itself.
// winget has no such distinction and depends on OpenJS.NodeJS.LTS.

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type * as Output from '@term/call/code/output'

// the Term package root: this file is task/distro.ts under it
const TERM = path.resolve(import.meta.dirname, '..')

// the checkout of github.com/cluesurf/host, whose make branch GitHub Pages serves from docs/ at deck.clue.surf
const PAGES = path.resolve(TERM, '../../../deck')

// the fork of microsoft/winget-pkgs a pull request is opened from
const WINGET_FORK = path.resolve(TERM, '../../../fork-winget-pkgs')

const PAGES_URL = 'https://deck.clue.surf/term'

const RELEASES_URL = 'https://github.com/cluesurf/term/releases/download'

// the oldest Node the CLI runs on (task/release.ts NODE_FLOOR)
const NODE_FLOOR = '22.3.0'

const SUMMARY = 'The Term language: compiler, package manager, test runner and language server'

// how many versions each repository keeps. Pages serves at most a gigabyte, and every version is about 32 MB of .deb
// and 32 MB of .rpm, so three is a rollback's worth with room to spare
const KEEP = 3

const KEY = process.env.TERM_DISTRO_KEY || '82273CF783C46701'

const IMAGES = { debian: 'term-distro-debian', fedora: 'term-distro-fedora' } as const

let output = undefined as unknown as typeof Output

type Made = { name: string; file: string; bytes: number; sha256: string }

async function main(): Promise<void> {
  output = await import('@term/call/code/output')

  const commit = process.argv.includes('--commit')
  const version = (JSON.parse(readFileSync(path.join(TERM, 'package.json'), 'utf8')) as { version: string }).version
  const release = path.join(TERM, 'tmp', 'release', version)
  const out = path.join(release, 'distro')
  const started = Date.now()

  output.openRun({ verb: 'distro', root: TERM, facts: [`term ${version}`, ...(commit ? ['--commit'] : [])], started })

  // the payloads first: this packs what the release built, and builds nothing of its own
  const missing = [
    ...['linux-x64', 'linux-arm64'].map(name => path.join(release, `term-${name}.tar.gz`)),
    ...['windows-x64', 'windows-arm64'].map(name => path.join(release, name, 'term', 'bin', 'term.exe')),
  ].filter(file => !existsSync(file))

  if (missing.length > 0) {
    output.report({ glyph: 'failed', kind: 'problem', verb: 'distro', subject: `The ${version} payloads are not built`, message: missing.map(file => output.showPath(file, TERM)) })
    output.closeRun({ verdict: 'Nothing packed', failure: 'usage', next: 'pnpm term:release --dry' })
    process.exitCode = 1

    return
  }

  rmSync(out, { recursive: true, force: true })
  mkdirSync(path.join(out, 'packages'), { recursive: true })

  const imaged = Date.now()

  for (const [name, image] of Object.entries(IMAGES)) {
    run('docker', ['build', '--quiet', '-t', image, '-f', path.join(TERM, 'task', 'distro', `${name}.dockerfile`), path.join(TERM, 'task', 'distro')])
  }

  output.report({ glyph: 'done', verb: 'image', subject: Object.values(IMAGES).join(', '), duration: Date.now() - imaged })

  const env = { VERSION: version, NODE_FLOOR, SUMMARY }
  const packages = path.join(out, 'packages')

  const debs = Date.now()
  container({ image: IMAGES.debian, mounts: { '/in': release, '/out': packages, '/task': path.join(TERM, 'task', 'distro') }, env, args: ['sh', '/task/debian.sh', 'build'] })
  reportMade('deb', made(packages, /\.deb$/), Date.now() - debs)

  const rpms = Date.now()
  container({
    image: IMAGES.fedora,
    mounts: { '/in': release, '/out': packages, '/task': path.join(TERM, 'task', 'distro') },
    env,
    args: ['sh', '/task/fedora.sh', 'build'],
  })
  reportMade('rpm', made(packages, /\.rpm$/), Date.now() - rpms)

  // the Windows zips: the release's own staged folder, `term\` at the top, so winget's nested path is term\bin\term.exe
  const zipped = Date.now()

  for (const name of ['windows-x64', 'windows-arm64']) {
    // -X leaves out macOS extra attributes; cwd, not a path inside the archive, decides where `term\` sits
    run('zip', ['-qrX', path.join(packages, `term-${version}-${name}.zip`), 'term'], { cwd: path.join(release, name) })
  }

  const zips = made(packages, /\.zip$/)
  reportMade('zip', zips, Date.now() - zipped)

  const manifests = writeWinget({ version, zips, into: path.join(out, 'winget') })
  output.report({ glyph: 'done', verb: 'winget', subject: `ClueSurf.Term ${version}`, fields: [output.location(output.showPath(manifests, TERM))] })

  // the repositories: what is published now, the new packages beside it, the oldest dropped, indexed and signed
  const repo = path.join(out, 'repo')
  const published = path.join(PAGES, 'docs', 'term')
  const indexed = Date.now()

  for (const kind of ['apt', 'rpm'] as const) {
    const from = path.join(published, kind)

    if (existsSync(from)) {
      cpSync(from, path.join(repo, kind), { recursive: true })
    }
  }

  const pool = path.join(repo, 'apt', 'pool', 'main', 't', 'term')
  mkdirSync(pool, { recursive: true })
  mkdirSync(path.join(repo, 'rpm'), { recursive: true })

  for (const one of made(packages, /\.deb$/)) {
    cpSync(one.file, path.join(pool, one.name))
  }

  for (const one of made(packages, /\.rpm$/)) {
    cpSync(one.file, path.join(repo, 'rpm', one.name))
  }

  const dropped = [...prune(pool, /^term_(\d+\.\d+\.\d+)_/), ...prune(path.join(repo, 'rpm'), /^term-(\d+\.\d+\.\d+)-1\./)]

  container({ image: IMAGES.debian, mounts: { '/repo': path.join(repo, 'apt'), '/task': path.join(TERM, 'task', 'distro') }, env, args: ['sh', '/task/debian.sh', 'index'] })
  container({ image: IMAGES.fedora, mounts: { '/repo': path.join(repo, 'rpm'), '/task': path.join(TERM, 'task', 'distro') }, env, args: ['sh', '/task/fedora.sh', 'index'] })

  const releaseFile = path.join(repo, 'apt', 'dists', 'stable', 'Release')

  gpg(['--armor', '--detach-sign', '--output', `${releaseFile}.gpg`, releaseFile])
  gpg(['--clearsign', '--output', path.join(repo, 'apt', 'dists', 'stable', 'InRelease'), releaseFile])
  gpg(['--armor', '--detach-sign', '--output', path.join(repo, 'rpm', 'repodata', 'repomd.xml.asc'), path.join(repo, 'rpm', 'repodata', 'repomd.xml')])
  writeFileSync(path.join(repo, 'pubkey.asc'), run('gpg', ['--armor', '--export', KEY]))
  writeFileSync(path.join(repo, 'term.repo'), DNF_REPO)
  writeFileSync(path.join(repo, 'term.list'), APT_LIST)

  output.report({
    glyph: 'done',
    verb: 'index',
    subject: 'apt and dnf, signed',
    duration: Date.now() - indexed,
    counts: [output.count(versionsIn(pool, /^term_(\d+\.\d+\.\d+)_/).length, 'versions kept', 'version kept'), output.count(dropped.length, 'files dropped', 'file dropped')],
    fields: [output.field('key', KEY), output.location(output.showPath(repo, TERM))],
    message: dropped.map(file => `dropped ${file}`),
  })

  if (!commit) {
    output.closeRun({ verdict: 'Packed, nothing published', counts: [output.count(made(packages, /./).length, 'files', 'file')], next: 'pnpm term:distro --commit' })

    return
  }

  // --commit: the files, and nothing in git
  for (const name of ['apt', 'rpm', 'pubkey.asc', 'term.repo', 'term.list']) {
    rmSync(path.join(published, name), { recursive: true, force: true })
    cpSync(path.join(repo, name), path.join(published, name), { recursive: true })
  }

  output.report({ glyph: 'changed', kind: 'change', verb: 'write', subject: `${PAGES_URL}/`, fields: [output.location(output.showPath(published, TERM))] })

  const wingetTo = path.join(WINGET_FORK, 'manifests', 'c', 'ClueSurf', 'Term', version)

  rmSync(wingetTo, { recursive: true, force: true })
  cpSync(manifests, wingetTo, { recursive: true })
  output.report({ glyph: 'changed', kind: 'change', verb: 'write', subject: `ClueSurf.Term ${version}`, fields: [output.location(output.showPath(wingetTo, TERM))] })

  const branch = `cluesurf-term-${version}`
  const assets = made(packages, /./).map(one => one.file)

  output.closeRun({
    verdict: 'Written. Publishing is three steps, in this order',
    message: [
      '1. the GitHub release, which the winget manifests download from:',
      `   gh release create v${version} --repo cluesurf/term --title "term ${version}" --notes "term ${version}" ${assets.join(' ')}`,
      '2. the repositories, live at deck.clue.surf a minute after the push:',
      `   git -C ${PAGES} add docs/term`,
      `   git -C ${PAGES} commit -m "term ${version}"`,
      `   git -C ${PAGES} push origin make`,
      '3. the winget pull request, on a branch of its own from upstream:',
      `   git -C ${WINGET_FORK} fetch upstream master`,
      `   git -C ${WINGET_FORK} switch -c ${branch} upstream/master`,
      `   git -C ${WINGET_FORK} add manifests/c/ClueSurf/Term/${version}`,
      `   git -C ${WINGET_FORK} commit -m "New package: ClueSurf.Term version ${version}"`,
      `   git -C ${WINGET_FORK} push -u origin ${branch}`,
      `   https://github.com/microsoft/winget-pkgs/compare/master...cluesurf:fork-winget-pkgs:${branch}`,
    ],
    done: true,
  })
}

// ---- winget ----

// The three manifests of ClueSurf.Term <version>, in the fork's own layout: a zip per architecture, holding a portable
// term.exe that winget links onto PATH as `term`, and Node from winget itself
function writeWinget(input: { version: string; zips: Made[]; into: string }): string {
  const dir = path.join(input.into, 'manifests', 'c', 'ClueSurf', 'Term', input.version)
  const schema = (kind: string) => `# yaml-language-server: $schema=https://aka.ms/winget-manifest.${kind}.1.12.0.schema.json\n\n`
  const installers = input.zips.map(zip => {
    const arch = zip.name.includes('arm64') ? 'arm64' : 'x64'

    return [`  - Architecture: ${arch}`, `    InstallerUrl: ${RELEASES_URL}/v${input.version}/${zip.name}`, `    InstallerSha256: ${zip.sha256.toUpperCase()}`].join('\n')
  })

  mkdirSync(dir, { recursive: true })

  writeFileSync(
    path.join(dir, 'ClueSurf.Term.yaml'),
    `${schema('version')}PackageIdentifier: ClueSurf.Term\nPackageVersion: ${input.version}\nDefaultLocale: en-US\nManifestType: version\nManifestVersion: 1.12.0\n`,
  )

  writeFileSync(
    path.join(dir, 'ClueSurf.Term.installer.yaml'),
    [
      `${schema('installer')}PackageIdentifier: ClueSurf.Term`,
      `PackageVersion: ${input.version}`,
      'InstallerType: zip',
      'NestedInstallerType: portable',
      'NestedInstallerFiles:',
      '  - RelativeFilePath: term\\bin\\term.exe',
      '    PortableCommandAlias: term',
      'Commands:',
      '  - term',
      'Dependencies:',
      '  PackageDependencies:',
      '    - PackageIdentifier: OpenJS.NodeJS.LTS',
      `      MinimumVersion: ${NODE_FLOOR}`,
      `ReleaseDate: ${new Date().toISOString().slice(0, 10)}`,
      'Installers:',
      ...installers,
      'ManifestType: installer',
      'ManifestVersion: 1.12.0',
      '',
    ].join('\n'),
  )

  writeFileSync(
    path.join(dir, 'ClueSurf.Term.locale.en-US.yaml'),
    [
      `${schema('defaultLocale')}PackageIdentifier: ClueSurf.Term`,
      `PackageVersion: ${input.version}`,
      'PackageLocale: en-US',
      'Publisher: ClueSurf',
      'PublisherUrl: https://clue.surf',
      'PublisherSupportUrl: https://github.com/cluesurf/term/issues',
      'PackageName: term',
      'PackageUrl: https://term.surf',
      'License: Apache-2.0',
      'LicenseUrl: https://github.com/cluesurf/term/blob/make/LICENSE',
      `ShortDescription: ${SUMMARY}`,
      'Description: |-',
      '  The term command: the compiler, the package manager, the test runner and the language server of the Term',
      `  language, run on Node.js ${NODE_FLOOR} or newer.`,
      'Tags:',
      '  - compiler',
      '  - programming-language',
      '  - term',
      'ManifestType: defaultLocale',
      'ManifestVersion: 1.12.0',
      '',
    ].join('\n'),
  )

  return dir
}

// ---- the repositories ----

// what a Fedora, RHEL or openSUSE machine saves as /etc/yum.repos.d/term.repo. The packages are not signed one by one:
// repomd.xml is, and it carries the sha256 of every package, so repo_gpgcheck covers each through the index
const DNF_REPO = `[term]
name=term
baseurl=${PAGES_URL}/rpm
enabled=1
gpgcheck=0
repo_gpgcheck=1
gpgkey=${PAGES_URL}/pubkey.asc
`

// what a Debian or Ubuntu machine saves as /etc/apt/sources.list.d/term.list, beside the key at /etc/apt/keyrings
const APT_LIST = `deb [signed-by=/etc/apt/keyrings/term.asc] ${PAGES_URL}/apt stable main
`

// Drop every package older than the newest KEEP versions in `dir`, and return what was dropped
function prune(dir: string, pattern: RegExp): string[] {
  const keep = new Set(versionsIn(dir, pattern).slice(0, KEEP))
  const dropped: string[] = []

  for (const name of readdirSync(dir)) {
    const version = pattern.exec(name)?.[1]

    if (version && !keep.has(version)) {
      rmSync(path.join(dir, name))
      dropped.push(name)
    }
  }

  return dropped
}

// the versions packaged in `dir`, newest first
function versionsIn(dir: string, pattern: RegExp): string[] {
  const versions = new Set(readdirSync(dir).flatMap(name => pattern.exec(name)?.[1] ?? []))

  return [...versions].sort((a, b) => {
    const [x, y] = [a, b].map(one => one.split('.').map(Number))

    return y![0]! - x![0]! || y![1]! - x![1]! || y![2]! - x![2]!
  })
}

// ---- running things ----

function container(input: { image: string; mounts: Record<string, string>; env: Record<string, string>; args: string[] }): void {
  run('docker', [
    'run',
    '--rm',
    ...Object.entries(input.mounts).flatMap(([inside, outside]) => ['-v', `${outside}:${inside}`]),
    ...Object.entries(input.env).flatMap(([name, value]) => ['-e', `${name}=${value}`]),
    input.image,
    ...input.args,
  ])
}

// gpg asks for the key's passphrase through pinentry, which draws on the terminal GPG_TTY names. This run captures
// gpg's output, so it names the terminal itself; with no terminal (a test's throwaway key in GNUPGHOME has no
// passphrase) gpg runs in batch mode
function gpg(args: string[]): void {
  if (!process.env.GPG_TTY && process.stdin.isTTY) {
    try {
      process.env.GPG_TTY = execFileSync('tty', { stdio: ['inherit', 'pipe', 'ignore'], encoding: 'utf8' }).trim()
    } catch {
      // no terminal after all: batch mode below
    }
  }

  run('gpg', [...(process.env.GPG_TTY ? [] : ['--batch']), '--yes', '--local-user', KEY, ...args])
}

// A child's output is captured and shown only when it fails, under the item that ran it
function run(command: string, args: string[], options: { cwd?: string } = {}): string {
  try {
    return execFileSync(command, args, { cwd: options.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string; status?: number }

    output.report({
      glyph: 'failed',
      kind: 'problem',
      verb: 'run',
      subject: `${command} ${args.slice(0, 3).join(' ')}`,
      exit: failed.status ?? undefined,
      quote: `${failed.stdout ?? ''}${failed.stderr ?? ''}`.split('\n').filter(line => line.trim() !== ''),
    })
    output.closeRun({ verdict: 'Stopped', failure: 'environment' })
    process.exit(1)
  }
}

function made(dir: string, pattern: RegExp): Made[] {
  return readdirSync(dir)
    .filter(name => pattern.test(name))
    .sort()
    .map(name => {
      const file = path.join(dir, name)

      return { name, file, bytes: statSync(file).size, sha256: createHash('sha256').update(readFileSync(file)).digest('hex') }
    })
}

function reportMade(verb: string, files: Made[], duration: number): void {
  for (const [at, one] of files.entries()) {
    output.report({ glyph: 'done', verb, subject: one.name, bytes: one.bytes, ...(at === 0 ? { duration } : {}), fields: [output.field('sha256', one.sha256)] })
  }
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
