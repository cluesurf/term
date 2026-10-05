// `pnpm term:distro`: the `term` command for the package managers Linux and Windows already have, made from the
// payloads `pnpm term:release` built (note/term/plan/term-distro.md).
//
//   pnpm term:distro            build everything under tmp/release/<version>/distro/ and stop
//   pnpm term:distro --commit   also write the signed apt and dnf indexes into the term.surf site's public/ (served at
//                               https://term.surf/apt and /rpm) and the winget manifests into deck/fork-winget-pkgs/.
//                               It writes files and nothing else: the GitHub release, the deploy and every git step
//                               are printed for a person to run
//
// What it makes, all from tmp/release/<version>/term-<platform>.tar.gz, the bytes `@term/code` releases:
//
//   packages/term_<v>_{amd64,arm64}.deb          /usr/lib/term, the payload as released, and /usr/bin/term a link
//   packages/term-<v>-1.{x86_64,aarch64}.rpm     to its launcher (task/distro/debian.sh, fedora.sh, term.spec)
//   packages/term-<v>-windows-{x64,arm64}.zip    term\, with bin\term.exe (task/launcher/term.go) for winget
//   winget/manifests/c/ClueSurf/Term/<v>/        ClueSurf.Term
//   repo/                                        the repositories, packages included, as apt and dnf read them
//   public/                                      the same without the packages: what --commit puts on term.surf
//
// NO PACKAGE IS STORED ON term.surf. Every file in packages/ is an asset of the GitHub release `v<version>` on
// cluesurf/term, which winget downloads its zips from too. The indexes name each package under its version
// (`pool/<v>/...`, `<v>/...`), and the term.surf Worker answers such a path with a redirect to that release asset
// (mesh/site/term.surf/home/site/tool/release-redirect.ts). apt and dnf follow it and check the file against the
// signed index. So a release costs no storage and no git history, and the indexes a deploy carries are kilobytes.
//
// THE INDEXES KEEP THE NEWEST THREE VERSIONS. The older two are read back from their GitHub releases, so an index can
// be rebuilt on any machine from what is public, and a version whose release lacks its packages is not listed.
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

// the repository root, four folders above
const ROOT = path.resolve(TERM, '../../../..')

// the term.surf site's static files, which Cloudflare serves before its Worker runs
const SITE_PUBLIC = path.join(ROOT, 'mesh', 'site', 'term.surf', 'home', 'public')

// the fork of microsoft/winget-pkgs a pull request is opened from
const WINGET_FORK = path.resolve(TERM, '../../../fork-winget-pkgs')

const SITE_URL = 'https://term.surf'

// the GitHub repository whose releases hold every package
const REPOSITORY = 'cluesurf/term'

const RELEASES_URL = `https://github.com/${REPOSITORY}/releases/download`

// the generic agent this repository sends to a host that has not asked for ours (mesh/task/dataset/agent.ts)
const AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

// the oldest Node the CLI runs on (task/release.ts NODE_FLOOR)
const NODE_FLOOR = '22.3.0'

const SUMMARY = 'The Term language: compiler, package manager, test runner and language server'

// how many versions each index lists: this one and the two before it, a rollback's worth
const KEEP = 3

const KEY = process.env.TERM_DISTRO_KEY || '82273CF783C46701'

const IMAGES = { debian: 'term-distro-debian', fedora: 'term-distro-fedora' } as const

// the Linux packages of one version, by file name. A version's release must hold all four to be listed
const LINUX_PACKAGES = (version: string) => [
  { kind: 'apt', name: `term_${version}_amd64.deb` },
  { kind: 'apt', name: `term_${version}_arm64.deb` },
  { kind: 'rpm', name: `term-${version}-1.x86_64.rpm` },
  { kind: 'rpm', name: `term-${version}-1.aarch64.rpm` },
]

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
  container({ image: IMAGES.fedora, mounts: { '/in': release, '/out': packages, '/task': path.join(TERM, 'task', 'distro') }, env, args: ['sh', '/task/fedora.sh', 'build'] })
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

  // the repositories: this version's packages, and the versions before it read back from their releases
  const repo = path.join(out, 'repo')
  const fetched = Date.now()
  const earlier = await earlierVersions({ version, into: repo })

  for (const one of LINUX_PACKAGES(version)) {
    place({ kind: one.kind, version, name: one.name, from: path.join(packages, one.name), repo })
  }

  output.report({
    glyph: 'done',
    verb: 'keep',
    subject: earlier.length > 0 ? `${earlier.join(', ')} from their releases` : `no earlier release carries its packages`,
    duration: Date.now() - fetched,
    counts: [output.count(earlier.length + 1, 'versions listed', 'version listed')],
  })

  const indexed = Date.now()

  container({ image: IMAGES.debian, mounts: { '/repo': path.join(repo, 'apt'), '/task': path.join(TERM, 'task', 'distro') }, env, args: ['sh', '/task/debian.sh', 'index'] })
  container({ image: IMAGES.fedora, mounts: { '/repo': path.join(repo, 'rpm'), '/task': path.join(TERM, 'task', 'distro') }, env, args: ['sh', '/task/fedora.sh', 'index'] })

  const releaseFile = path.join(repo, 'apt', 'dists', 'stable', 'Release')

  gpg(['--armor', '--detach-sign', '--output', `${releaseFile}.gpg`, releaseFile])
  gpg(['--clearsign', '--output', path.join(repo, 'apt', 'dists', 'stable', 'InRelease'), releaseFile])
  gpg(['--armor', '--detach-sign', '--output', path.join(repo, 'rpm', 'repodata', 'repomd.xml.asc'), path.join(repo, 'rpm', 'repodata', 'repomd.xml')])

  // what term.surf serves: the indexes, the two source files and the key, and no package
  const site = path.join(out, 'public')

  cpSync(path.join(repo, 'apt', 'dists'), path.join(site, 'apt', 'dists'), { recursive: true })
  cpSync(path.join(repo, 'rpm', 'repodata'), path.join(site, 'rpm', 'repodata'), { recursive: true })
  writeFileSync(path.join(site, 'apt', 'term.list'), APT_LIST)
  writeFileSync(path.join(site, 'rpm', 'term.repo'), DNF_REPO)
  writeFileSync(path.join(site, 'term.asc'), run('gpg', ['--armor', '--export', KEY]))

  output.report({
    glyph: 'done',
    verb: 'index',
    subject: 'apt and dnf, signed',
    duration: Date.now() - indexed,
    fields: [output.field('key', KEY), output.location(output.showPath(site, TERM))],
  })

  if (!commit) {
    output.closeRun({ verdict: 'Packed, nothing published', counts: [output.count(made(packages, /./).length, 'files', 'file')], next: 'pnpm term:distro --commit' })

    return
  }

  // --commit: the files, and nothing in git
  for (const name of ['apt', 'rpm', 'term.asc']) {
    rmSync(path.join(SITE_PUBLIC, name), { recursive: true, force: true })
    cpSync(path.join(site, name), path.join(SITE_PUBLIC, name), { recursive: true })
  }

  output.report({ glyph: 'changed', kind: 'change', verb: 'write', subject: `${SITE_URL}/apt, /rpm and /term.asc`, fields: [output.location(output.showPath(SITE_PUBLIC, TERM))] })

  const wingetTo = path.join(WINGET_FORK, 'manifests', 'c', 'ClueSurf', 'Term', version)

  rmSync(wingetTo, { recursive: true, force: true })
  cpSync(manifests, wingetTo, { recursive: true })
  output.report({ glyph: 'changed', kind: 'change', verb: 'write', subject: `ClueSurf.Term ${version}`, fields: [output.location(output.showPath(wingetTo, TERM))] })

  const branch = `cluesurf-term-${version}`
  const assets = made(packages, /./).map(one => one.file)

  output.closeRun({
    verdict: 'Written. Publishing is three steps, in this order',
    message: [
      '1. the GitHub release, which holds every package the indexes and the winget manifests name:',
      `   gh release create v${version} --repo ${REPOSITORY} --title "term ${version}" --notes "term ${version}" ${assets.join(' ')}`,
      '2. term.surf, which then serves the new indexes (a deploy builds from what is pushed):',
      `   git -C ${path.join(ROOT, 'mesh')} add site/term.surf/home/public/apt site/term.surf/home/public/rpm site/term.surf/home/public/term.asc`,
      `   git -C ${path.join(ROOT, 'mesh')} commit -m "term ${version} for apt and dnf"`,
      `   git -C ${path.join(ROOT, 'mesh')} push`,
      `   pnpm --dir ${ROOT} host term:home`,
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

// ---- the repositories ----

// what a Fedora or RHEL machine saves as /etc/yum.repos.d/term.repo. The packages are not signed one by one:
// repomd.xml is, and it carries the sha256 of every package, so repo_gpgcheck covers each through the index
const DNF_REPO = `[term]
name=term
baseurl=${SITE_URL}/rpm
enabled=1
gpgcheck=0
repo_gpgcheck=1
gpgkey=${SITE_URL}/term.asc
`

// what a Debian or Ubuntu machine saves as /etc/apt/sources.list.d/term.list, beside the key at /etc/apt/keyrings
const APT_LIST = `deb [signed-by=/etc/apt/keyrings/term.asc] ${SITE_URL}/apt stable main
`

// One package where its index names it and the Worker's redirect expects it: apt's under pool/<v>/, dnf's under <v>/
function place(input: { kind: string; version: string; name: string; from: string; repo: string }): void {
  const dir = input.kind === 'apt' ? path.join(input.repo, 'apt', 'pool', input.version) : path.join(input.repo, 'rpm', input.version)

  mkdirSync(dir, { recursive: true })
  cpSync(input.from, path.join(dir, input.name))
}

// The KEEP - 1 newest versions before `version` whose GitHub release holds all four Linux packages, downloaded into
// the repository so the index lists them. A release without them (every one before term:distro existed) is passed
// over, and a GitHub that cannot be asked stops the run: an index that silently lost its older versions would take
// a rollback away from every machine that reads it
async function earlierVersions(input: { version: string; into: string }): Promise<string[]> {
  const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/releases?per_page=50`, { headers: { 'user-agent': AGENT } })

  if (!response.ok) {
    output.report({ glyph: 'failed', kind: 'problem', verb: 'keep', subject: `GitHub did not list the releases of ${REPOSITORY}`, http: response.status })
    output.closeRun({ verdict: 'Stopped', failure: 'environment' })
    process.exit(1)
  }

  const releases = (await response.json()) as { tag_name: string; draft: boolean; assets: { name: string }[] }[]
  const candidates = releases
    .filter(one => !one.draft && /^v\d+\.\d+\.\d+$/.test(one.tag_name))
    .map(one => ({ version: one.tag_name.slice(1), assets: new Set(one.assets.map(asset => asset.name)) }))
    .filter(one => compare(one.version, input.version) < 0 && LINUX_PACKAGES(one.version).every(file => one.assets.has(file.name)))
    .sort((a, b) => compare(b.version, a.version))
    .slice(0, KEEP - 1)

  const cache = path.join(TERM, 'tmp', 'release', 'distro-cache')

  mkdirSync(cache, { recursive: true })

  for (const candidate of candidates) {
    for (const one of LINUX_PACKAGES(candidate.version)) {
      const cached = path.join(cache, one.name)

      if (!existsSync(cached)) {
        const download = await fetch(`${RELEASES_URL}/v${candidate.version}/${one.name}`, { headers: { 'user-agent': AGENT } })

        if (!download.ok) {
          output.report({ glyph: 'failed', kind: 'problem', verb: 'keep', subject: `${one.name} did not download from its release`, http: download.status })
          output.closeRun({ verdict: 'Stopped', failure: 'environment' })
          process.exit(1)
        }

        writeFileSync(cached, Buffer.from(await download.arrayBuffer()))
      }

      place({ kind: one.kind, version: candidate.version, name: one.name, from: cached, repo: input.into })
    }
  }

  return candidates.map(one => one.version)
}

function compare(a: string, b: string): number {
  const [x, y] = [a, b].map(one => one.split('.').map(Number))

  return x![0]! - y![0]! || x![1]! - y![1]! || x![2]! - y![2]!
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
