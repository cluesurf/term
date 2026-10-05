// What `pnpm term:distro` made, installed the way a stranger installs it, in containers that have never seen this
// machine, over HTTP shaped exactly like term.surf: a server here serves tmp/release/<version>/distro/public/ (the
// signed indexes --commit puts on the site) as static files, and answers every other path with the Worker's own
// redirect, mesh/site/term.surf/home/site/tool/release-redirect.ts, pointed at a stand-in for GitHub's release
// downloads that serves distro/packages/. So the package a container installs went through the redirect, and the
// test fails if it did not.
//
//   the redirect: the two shapes the indexes write, and nothing else
//   apt, Debian with a tarball Node (node:22-bookworm-slim), arm64 and amd64: `apt install term`, `term --version` as
//     an ordinary user, `term self update` refused naming apt
//   apt, stock Ubuntu 24.04 with no Node: it installs, and `term` names the Node it needs
//   apt, an InRelease whose signature does not match: refused
//   dnf, Fedora 42: `dnf install term` with Node as the weak dependency, `term --version`, update refused naming dnf
//   dnf, a repomd.xml whose signature does not match: refused
//   winget: each manifest's InstallerSha256 is its zip's, and each zip holds term\bin\term.exe for its architecture
//
// Needs Docker. Run `pnpm term:release --dry` and `pnpm term:distro` first. TERM_DISTRO_VERSION names a version packed
// earlier than package.json's.
// Run: npx tsx test/call/distro.ts
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, normalize } from 'node:path'
import { releaseRedirect } from '../../../../../../mesh/site/term.surf/home/site/tool/release-redirect'

const TERM = join(import.meta.dirname, '..', '..')
const VERSION = process.env.TERM_DISTRO_VERSION || (JSON.parse(readFileSync(join(TERM, 'package.json'), 'utf8')) as { version: string }).version
const DISTRO = join(TERM, 'tmp', 'release', VERSION, 'distro')
const PACKAGES = join(DISTRO, 'packages')

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

// ---- the redirect, on its own ----

const github = 'https://github.com/cluesurf/term/releases/download'
const shapes: [string, string | null][] = [
  ['/apt/pool/2.7.2/term_2.7.2_amd64.deb', `${github}/v2.7.2/term_2.7.2_amd64.deb`],
  ['/apt/pool/2.7.2/term_2.7.2_arm64.deb', `${github}/v2.7.2/term_2.7.2_arm64.deb`],
  ['/rpm/2.7.2/term-2.7.2-1.x86_64.rpm', `${github}/v2.7.2/term-2.7.2-1.x86_64.rpm`],
  ['/rpm/2.7.2/term-2.7.2-1.aarch64.rpm', `${github}/v2.7.2/term-2.7.2-1.aarch64.rpm`],
  ['/apt/pool/2.7.0/term_2.7.2_amd64.deb', null],
  ['/apt/pool/2.7.2/term_2.7.2_i386.deb', null],
  ['/apt/pool/2.7.2/term-2.7.2-windows-x64.zip', null],
  ['/apt/pool/2.7.2/../2.7.2/term_2.7.2_amd64.deb', null],
  ['/rpm/2.7.2/other-2.7.2-1.x86_64.rpm', null],
  ['/apt/dists/stable/InRelease', null],
]

for (const [pathname, want] of shapes) {
  ok(`redirect ${pathname}: ${want ? 'the release asset' : 'nothing'}`, releaseRedirect({ pathname }) === want, String(releaseRedirect({ pathname })))
}

// ---- term.surf, here ----

type Site = { base: string; asked: string[]; close: () => void }

// `public` as static files, the redirect for everything else, and GitHub's downloads under /releases
async function serveSite(publicDir: string): Promise<Site> {
  const asked: string[] = []
  let base = ''

  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://here').pathname

    asked.push(pathname)

    const file = normalize(join(publicDir, pathname))

    if (file.startsWith(publicDir) && existsSync(file) && statSync(file).isFile()) {
      response.writeHead(200).end(readFileSync(file))

      return
    }

    const release = releaseRedirect({ pathname, downloads: `${base}/releases` })

    if (release) {
      response.writeHead(302, { location: release }).end()

      return
    }

    // the stand-in for github.com/<repo>/releases/download/v<version>/<file>
    const asset = /^\/releases\/v[\d.]+\/([\w.-]+)$/.exec(pathname)

    if (asset && existsSync(join(PACKAGES, asset[1]!))) {
      response.writeHead(200).end(readFileSync(join(PACKAGES, asset[1]!)))

      return
    }

    response.writeHead(404).end()
  })

  await new Promise<void>(resolve => server.listen(0, '0.0.0.0', () => resolve()))
  base = `http://host.docker.internal:${(server.address() as AddressInfo).port}`

  return { base, asked, close: () => server.close() }
}

// one shell script in a fresh container that reaches this machine as host.docker.internal
function inside(input: { image: string; platform?: string; script: string }): Promise<{ status: number; text: string }> {
  return new Promise(resolve => {
    const child = spawn('docker', [
      'run',
      '--rm',
      '--add-host',
      'host.docker.internal:host-gateway',
      ...(input.platform ? ['--platform', input.platform] : []),
      input.image,
      'sh',
      '-c',
      input.script,
    ])
    const text: string[] = []

    child.stdout.on('data', chunk => text.push(String(chunk)))
    child.stderr.on('data', chunk => text.push(String(chunk)))
    child.on('close', status => resolve({ status: status ?? -1, text: text.join('') }))
  })
}

// the install steps the guide gives, with term.surf's address swapped for this server's
const aptSetup = (base: string) =>
  [
    'set -e',
    'export DEBIAN_FRONTEND=noninteractive',
    'apt-get update -qq >/dev/null 2>&1 || true',
    'command -v curl >/dev/null || apt-get install -y -qq curl >/dev/null 2>&1',
    'mkdir -p /etc/apt/keyrings',
    `curl -fsSLo /etc/apt/keyrings/term.asc ${base}/term.asc`,
    `curl -fsSL ${base}/apt/term.list | sed 's#https://term.surf#${base}#' > /etc/apt/sources.list.d/term.list`,
    'apt-get update -qq',
  ].join('\n')

const dnfSetup = (base: string) =>
  [
    'set -e',
    `curl -fsSL ${base}/rpm/term.repo | sed 's#https://term.surf#${base}#' > /etc/yum.repos.d/term.repo`,
    // `-y` accepts the key the repository file names, as a person answering the prompt does. Not -q, which hides the
    // signature verdict
    'dnf -y makecache --repo term',
  ].join('\n')

const AS_USER = (command: string) => `su -s /bin/sh dev -c '${command}'`

const site = await serveSite(join(DISTRO, 'public'))

for (const platform of ['linux/arm64', 'linux/amd64']) {
  site.asked.length = 0

  const debian = await inside({
    image: 'node:22-bookworm-slim',
    platform,
    script: [
      aptSetup(site.base),
      'apt-get install -y -qq term >/dev/null',
      'useradd -m dev',
      'echo "== version"',
      AS_USER('term --version'),
      'echo "== update"',
      `${AS_USER('term self update --plain')} || echo "exit $?"`,
    ].join('\n'),
  })
  const arch = platform === 'linux/arm64' ? 'arm64' : 'amd64'

  ok(`apt ${platform}: installs from the signed repository, and runs ${VERSION} as an ordinary user`, debian.status === 0 && new RegExp(`== version\\n[^\\n]*${VERSION.replace(/\./g, '\\.')}`).test(debian.text), debian.text)
  ok(
    `apt ${platform}: the package came through term.surf's redirect to the release`,
    site.asked.includes(`/apt/pool/${VERSION}/term_${VERSION}_${arch}.deb`) && site.asked.includes(`/releases/v${VERSION}/term_${VERSION}_${arch}.deb`),
    site.asked.join('\n'),
  )
  ok(`apt ${platform}: term self update is refused, naming apt`, /apt installed this copy, so apt updates it/.test(debian.text), debian.text)
}

const ubuntu = await inside({
  image: 'ubuntu:24.04',
  script: [aptSetup(site.base), 'apt-get install -y -qq term >/dev/null', 'command -v node || echo "no node"', 'term --version || echo "exit $?"'].join('\n'),
})

ok('apt, stock Ubuntu 24.04: term installs without a Node new enough, and names the one it needs', /no node/.test(ubuntu.text) && /term needs Node\.js 22\.3\.0 or newer/.test(ubuntu.text) && /exit 69/.test(ubuntu.text), ubuntu.text)

site.asked.length = 0

const fedora = await inside({
  image: 'fedora:42',
  script: [
    dnfSetup(site.base),
    'dnf install -y -q term >/dev/null',
    // the fedora image has no su; util-linux is only for this test's ordinary user
    'dnf install -y -q util-linux >/dev/null',
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
ok('dnf: the package came through term.surf\'s redirect to the release', site.asked.includes(`/rpm/${VERSION}/term-${VERSION}-1.aarch64.rpm`) && site.asked.includes(`/releases/v${VERSION}/term-${VERSION}-1.aarch64.rpm`), site.asked.join('\n'))
ok(`dnf: runs ${VERSION} as an ordinary user`, new RegExp(`== version\\n[^\\n]*${VERSION.replace(/\./g, '\\.')}`).test(fedora.text), fedora.text)
ok('dnf: term self update is refused, naming dnf', /dnf installed this copy, so dnf updates it/.test(fedora.text), fedora.text)

site.close()

// a copy of what term.surf serves, with indexes that say something their signatures do not
const forgedDir = mkdtempSync(join(tmpdir(), 'term-forged-'))
cpSync(join(DISTRO, 'public'), forgedDir, { recursive: true })
writeFileSync(join(forgedDir, 'apt', 'dists', 'stable', 'InRelease'), readFileSync(join(forgedDir, 'apt', 'dists', 'stable', 'InRelease'), 'utf8').replace('Label: term', 'Label: tampered'))
writeFileSync(join(forgedDir, 'rpm', 'repodata', 'repomd.xml'), `${readFileSync(join(forgedDir, 'rpm', 'repodata', 'repomd.xml'), 'utf8')}<!-- tampered -->\n`)

const forged = await serveSite(forgedDir)
const tamperedApt = await inside({ image: 'node:22-bookworm-slim', script: `${aptSetup(forged.base)}\necho reached` })

ok('apt: an InRelease that does not match its signature is refused', tamperedApt.status !== 0 && !/reached/.test(tamperedApt.text) && /(BADSIG|signature|not signed|invalid)/i.test(tamperedApt.text), tamperedApt.text)

const tamperedDnf = await inside({ image: 'fedora:42', script: `${dnfSetup(forged.base)}\ndnf install -y term\necho reached` })

// dnf skips a repository it cannot verify rather than failing the whole command, so the refusal is the message and a
// `term` that is no longer there to install
ok(
  'dnf: a repomd.xml that does not match its signature is refused',
  /Bad PGP signature/.test(tamperedDnf.text) && /No match for argument: term/.test(tamperedDnf.text) && !/reached/.test(tamperedDnf.text),
  tamperedDnf.text,
)

forged.close()

// ---- winget: what the manifests promise is what the zips are ----

const manifests = join(DISTRO, 'winget', 'manifests', 'c', 'ClueSurf', 'Term', VERSION)
const installer = readFileSync(join(manifests, 'ClueSurf.Term.installer.yaml'), 'utf8')

for (const arch of ['x64', 'arm64']) {
  const name = `term-${VERSION}-windows-${arch}.zip`
  const zip = readFileSync(join(PACKAGES, name))
  const sha = createHash('sha256').update(zip).digest('hex').toUpperCase()
  const entry = new RegExp(`Architecture: ${arch}\\n\\s+InstallerUrl: https://github\\.com/cluesurf/term/releases/download/v${VERSION.replace(/\./g, '\\.')}/${name.replace(/\./g, '\\.')}\\n\\s+InstallerSha256: ${sha}`)

  ok(`winget ${arch}: the manifest names the zip by its release URL and its sha256`, entry.test(installer), installer)

  const exe = spawnSync('unzip', ['-p', join(PACKAGES, name), 'term/bin/term.exe'], { maxBuffer: 64 * 1024 * 1024 }).stdout
  // a PE file: MZ, then at 0x3c the offset of `PE\0\0` and the machine type after it
  const pe = exe.length > 64 ? exe.readUInt32LE(0x3c) : 0
  const machine = pe ? exe.readUInt16LE(pe + 4) : 0

  ok(`winget ${arch}: the zip holds term\\bin\\term.exe for ${arch}`, exe.subarray(0, 2).toString() === 'MZ' && machine === (arch === 'x64' ? 0x8664 : 0xaa64), `machine 0x${machine.toString(16)}`)
}

ok('winget: the nested installer is term\\bin\\term.exe, aliased term, with Node from winget', /RelativeFilePath: term\\bin\\term\.exe\n\s+PortableCommandAlias: term/.test(installer) && /PackageIdentifier: OpenJS\.NodeJS\.LTS/.test(installer), installer)

console.log(`\ndistro: ${pass} pass, ${fail} fail`)

process.exit(fail > 0 ? 1 : 0)
