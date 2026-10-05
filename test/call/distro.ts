// What `pnpm term:distro` made, installed the way a stranger installs it, in containers that have never seen this
// machine: the signed apt and dnf repositories from tmp/release/<version>/distro/repo, read through `file:` exactly as
// apt and dnf read https://deck.clue.surf/term (the signature is checked the same way), and the winget zips against
// their manifests.
//
//   apt, Debian with a tarball Node (node:22-bookworm-slim), arm64 and amd64: `apt install term` from the signed
//     repository, `term --version` as an ordinary user, `term self update` refused naming apt
//   apt, stock Ubuntu 24.04 with no Node: it installs, and `term` names the Node it needs rather than failing obscurely
//   apt, a Release whose signature does not match: refused
//   dnf, Fedora 42: `dnf install term` pulls Node in as the weak dependency, `term --version`, update refused naming dnf
//   dnf, a repomd.xml whose signature does not match: refused
//   winget: each manifest's InstallerSha256 is its zip's, and each zip holds term\bin\term.exe, a Windows executable
//
// Needs Docker. Run `pnpm term:release --dry` and `pnpm term:distro` first.
// Run: npx tsx test/call/distro.ts
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TERM = join(import.meta.dirname, '..', '..')
const VERSION = (JSON.parse(readFileSync(join(TERM, 'package.json'), 'utf8')) as { version: string }).version
const DISTRO = join(TERM, 'tmp', 'release', VERSION, 'distro')
const REPO = join(DISTRO, 'repo')

let pass = 0
let fail = 0

function ok(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}\n${info.split('\n').slice(-25).map(line => `      ${line}`).join('\n')}`)
  }
}

// one shell script in a fresh container, the repository mounted read-only at /repo
function inside(input: { image: string; platform?: string; repo?: string; script: string }): { status: number; text: string } {
  const run = spawnSync(
    'docker',
    ['run', '--rm', ...(input.platform ? ['--platform', input.platform] : []), '-v', `${input.repo ?? REPO}:/repo:ro`, input.image, 'sh', '-c', input.script],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )

  return { status: run.status ?? -1, text: `${run.stdout}${run.stderr}` }
}

// the install steps the guide gives, with the key and the list read from the repository instead of the web
const APT_SETUP = [
  'set -e',
  'export DEBIAN_FRONTEND=noninteractive',
  'mkdir -p /etc/apt/keyrings',
  'cp /repo/pubkey.asc /etc/apt/keyrings/term.asc',
  "sed 's#https://deck.clue.surf/term#file:/repo#' /repo/term.list > /etc/apt/sources.list.d/term.list",
  'apt-get update -qq',
].join('\n')

const AS_USER = (command: string) => `su -s /bin/sh dev -c '${command}'`

for (const platform of ['linux/arm64', 'linux/amd64']) {
  const debian = inside({
    image: 'node:22-bookworm-slim',
    platform,
    script: [
      APT_SETUP,
      'apt-get install -y -qq term >/dev/null',
      'useradd -m dev',
      'echo "== version"',
      AS_USER('term --version'),
      'echo "== update"',
      `${AS_USER('term self update --plain')} || echo "exit $?"`,
      'echo "== arch"',
      'dpkg --print-architecture',
    ].join('\n'),
  })

  ok(`apt ${platform}: installs from the signed repository, and runs ${VERSION} as an ordinary user`, debian.status === 0 && new RegExp(`== version\\n[^\\n]*${VERSION.replace(/\./g, '\\.')}`).test(debian.text), debian.text)
  ok(`apt ${platform}: term self update is refused, naming apt`, /apt installed this copy, so apt updates it/.test(debian.text), debian.text)
}

const ubuntu = inside({
  image: 'ubuntu:24.04',
  script: [APT_SETUP, 'apt-get install -y -qq term >/dev/null', 'command -v node || echo "no node"', 'term --version || echo "exit $?"'].join('\n'),
})

ok('apt, stock Ubuntu 24.04: term installs without a Node new enough, and names the one it needs', /no node/.test(ubuntu.text) && /term needs Node\.js 22\.3\.0 or newer/.test(ubuntu.text) && /exit 69/.test(ubuntu.text), ubuntu.text)

// a copy of the repository whose Release says something its signature does not
const forged = mkdtempSync(join(tmpdir(), 'term-forged-'))
cpSync(REPO, forged, { recursive: true })
writeFileSync(join(forged, 'apt', 'dists', 'stable', 'InRelease'), readFileSync(join(forged, 'apt', 'dists', 'stable', 'InRelease'), 'utf8').replace('Label: term', 'Label: tampered'))
writeFileSync(join(forged, 'rpm', 'repodata', 'repomd.xml'), `${readFileSync(join(forged, 'rpm', 'repodata', 'repomd.xml'), 'utf8')}<!-- tampered -->\n`)

const tamperedApt = inside({ image: 'debian:trixie-slim', repo: forged, script: `${APT_SETUP}\necho reached` })

ok('apt: a Release that does not match its signature is refused', tamperedApt.status !== 0 && !/reached/.test(tamperedApt.text) && /(BADSIG|signature|not signed|NO_PUBKEY|invalid)/i.test(tamperedApt.text), tamperedApt.text)

const DNF_SETUP = [
  'set -e',
  "sed -e 's#https://deck.clue.surf/term#file:///repo#' /repo/term.repo > /etc/yum.repos.d/term.repo",
  // dnf reads gpgkey from the file, so a new key is trusted only through what the repository file names
  'dnf -q makecache --repo term',
].join('\n')

const fedora = inside({
  image: 'fedora:42',
  script: [
    DNF_SETUP,
    'dnf install -y -q term >/dev/null',
    'useradd -m dev',
    'echo "== node"',
    'rpm -q --qf "%{NAME} %{VERSION}\\n" nodejs',
    'echo "== version"',
    AS_USER('term --version'),
    'echo "== update"',
    `${AS_USER('term self update --plain')} || echo "exit $?"`,
  ].join('\n'),
})

ok('dnf: installs from the signed repository, with Node as its weak dependency', fedora.status === 0 && /== node\nnodejs (2[2-9]|[3-9]\d)\./.test(fedora.text), fedora.text)
ok(`dnf: runs ${VERSION} as an ordinary user`, new RegExp(`== version\\n[^\\n]*${VERSION.replace(/\./g, '\\.')}`).test(fedora.text), fedora.text)
ok('dnf: term self update is refused, naming dnf', /dnf installed this copy, so dnf updates it/.test(fedora.text), fedora.text)

const tamperedDnf = inside({ image: 'fedora:42', repo: forged, script: `${DNF_SETUP}\necho reached` })

ok('dnf: a repomd.xml that does not match its signature is refused', tamperedDnf.status !== 0 && !/reached/.test(tamperedDnf.text), tamperedDnf.text)

// winget: what the manifests promise is what the zips are
const manifests = join(DISTRO, 'winget', 'manifests', 'c', 'ClueSurf', 'Term', VERSION)
const installer = readFileSync(join(manifests, 'ClueSurf.Term.installer.yaml'), 'utf8')

for (const arch of ['x64', 'arm64']) {
  const name = `term-${VERSION}-windows-${arch}.zip`
  const zip = readFileSync(join(DISTRO, 'packages', name))
  const sha = createHash('sha256').update(zip).digest('hex').toUpperCase()
  const entry = new RegExp(`Architecture: ${arch}\\n\\s+InstallerUrl: https://github\\.com/cluesurf/term/releases/download/v${VERSION.replace(/\./g, '\\.')}/${name.replace(/\./g, '\\.')}\\n\\s+InstallerSha256: ${sha}`)

  ok(`winget ${arch}: the manifest names the zip by its release URL and its sha256`, entry.test(installer), installer)

  const listed = spawnSync('unzip', ['-p', join(DISTRO, 'packages', name), 'term/bin/term.exe'], { maxBuffer: 64 * 1024 * 1024 })
  const exe = listed.stdout
  // a PE file: MZ, then at 0x3c the offset of `PE\0\0` and the machine type after it
  const pe = exe.length > 64 ? exe.readUInt32LE(0x3c) : 0
  const machine = pe ? exe.readUInt16LE(pe + 4) : 0

  ok(`winget ${arch}: the zip holds term\\bin\\term.exe for ${arch}`, exe.subarray(0, 2).toString() === 'MZ' && machine === (arch === 'x64' ? 0x8664 : 0xaa64), `machine 0x${machine.toString(16)}`)
}

ok('winget: the nested installer is term\\bin\\term.exe, aliased term, with Node from winget', /RelativeFilePath: term\\bin\\term\.exe\n\s+PortableCommandAlias: term/.test(installer) && /PackageIdentifier: OpenJS\.NodeJS\.LTS/.test(installer), installer)

console.log(`\ndistro: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
