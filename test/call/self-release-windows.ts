// `term` on Windows, end to end (note/term/plan/term-load-install.md, the Windows half): the Windows payload published
// to a loopback registry on THIS machine, reached from the Windows machine WINDOWS_VM names through an ssh reverse
// tunnel, installed there by THE LOADER term.surf serves at /load.ps1, and then the INSTALLED term run there:
//
//   1. the loader installs, checks the signature, writes bin\term.cmd and install.tree, and names the PATH line
//   2. `term --version`, and `term make` on a sample project: the CLI itself works on Windows
//   3. `term self check`, `update` (the shim moves to the next version), `check`, `update` again (nothing newer),
//      `back` (the shim returns)
//   4. a tampered install.tree: check refuses
//
// The machine needs Node 22.3+ on its PATH and nothing else: `pnpm term:ec2-windows --commit --term` rents one with it.
// The payload is the one `pnpm run release --dry` writes for the machine's own architecture, which the machine is
// asked for. Nothing is published anywhere but the loopback registry, which lives as long as this process.
// Run: WINDOWS_VM=user@address npx tsx test/call/self-release-windows.ts
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { generateKeypair } from '../../deck/deck/code/object/sign'
import { ensurePublisher } from '../../deck/deck/code/oci/keys'
import { publishRelease } from '../../deck/deck/code/oci/release'
import { httpTransport } from '../../deck/deck/code/oci/transport'
import { startOciServer } from '../../deck/deck/test/oci-server'
// as its default: the task/ scripts are CommonJS, whose exports Node finds only on `default`
import windows from '../../../../../../task/term/cask/windows'

const TERM = join(import.meta.dirname, '..', '..')
// the installer term.surf serves at /load.ps1
const LOADER = join(TERM, '..', '..', '..', '..', 'mesh', 'site', 'term.surf', 'home', 'public', 'load.ps1')
const VERSION = (JSON.parse(readFileSync(join(TERM, 'package.json'), 'utf8')) as { version: string }).version
const NEXT = VERSION.replace(/\.(\d+)$/, (_, patch: string) => `.${Number(patch) + 2}`)
// the machine's PROCESSOR_ARCHITECTURE, as the payload built for it
const PLATFORMS: Record<string, string> = { AMD64: 'windows-x64', ARM64: 'windows-arm64' }

let pass = 0
let fail = 0

function ok(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  ${info.slice(-1600)}`)
  }
}

// One PowerShell script on the machine. As -EncodedCommand (base64 of UTF-16LE), so no quote or `$` in it ever meets
// cmd.exe or ssh. A script ends with `exit $LASTEXITCODE` where the last program's status is the answer
async function ps(script: string): Promise<{ code: number; out: string }> {
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const ran = await windows.remoteAsync(`powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`, { timeout: 600_000 })

  return { code: ran.status, out: `${ran.stdout}${ran.stderr}` }
}

const asked = await windows.remoteAsync('echo %PROCESSOR_ARCHITECTURE%& echo %USERPROFILE%', { timeout: 60_000 })
const [machine = '', profile = ''] = asked.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
const platform = PLATFORMS[machine]

if (asked.status !== 0 || !platform || !profile) {
  console.log(`self-release-windows: the Windows machine did not answer with its architecture and profile: ${asked.stdout}${asked.stderr}`)
  process.exit(1)
}

const payloadFile = join(TERM, 'tmp', 'release', VERSION, `term-${platform}.tar.gz`)

if (!existsSync(payloadFile)) {
  console.log(`self-release-windows: no payload at ${payloadFile}; run \`pnpm run release --dry\` first`)
  process.exit(1)
}

// what the machine is sent, in a folder of its own: the loader, and a project for `term make`
const folder = `term-self-${Date.now()}`
const sent = join(TERM, 'tmp', 'self-release-windows')
rmSync(sent, { recursive: true, force: true })
mkdirSync(join(sent, 'sample', 'code'), { recursive: true })
copyFileSync(LOADER, join(sent, 'load.ps1'))
writeFileSync(join(sent, 'sample', 'deck.tree'), 'deck @sample/hello\nhead <A sample project the Windows install test builds>\nmark <0.0.0>\n')
writeFileSync(join(sent, 'sample', 'code', 'base.tree'), 'task greet\n  take name, like text\n  like text\n  send back, text <hello {name}>\n')
// before the registry starts: ship is synchronous, and nothing it does needs the registry
windows.ship(sent, folder)

const payload = readFileSync(payloadFile)
const digest = `sha256:${createHash('sha256').update(payload).digest('hex')}`
const server = await startOciServer()
const transport = httpTransport({
  host: server.host,
  credentials: async () => ({ kind: 'basic', username: 'tester', password: 'secret' }),
  retries: 0,
})
const keypair = generateKeypair()

await ensurePublisher({ transport, repository: 'cluesurf/term/name', scope: '@term', keypair })

for (const version of [VERSION, NEXT]) {
  await publishRelease({ transport, repository: 'cluesurf/term/code', package: '@term/code', version, payloads: [{ platform, bytes: payload }], keypair })
}

const port = Number(server.host.split(':')[1])
const tunnel = await windows.tunnel([
  [port, '127.0.0.1'],
  [server.storagePort, '127.0.0.1'],
])

// a fresh machine as far as term can tell: its own profile (Node's os.homedir() on Windows is USERPROFILE), trust pins
// and store, pointed at the registry through the tunnel, which answers at the same address there as here
const root = `${profile}\\${folder}`
const home = `${root}\\home`
const base = `${home}\\.base\\@cluesurf\\term`
const env = [
  `New-Item -ItemType Directory -Force -Path '${home}' | Out-Null`,
  `$env:USERPROFILE = '${home}'`,
  `$env:TERM_LOAD_REGISTRY = 'http://${server.host}'`,
  `$env:TERM_RELEASE_REGISTRY = 'oci://${server.host}/cluesurf/term'`,
  `$env:TERM_OCI_HOST = '${server.host}'`,
  "$env:TERM_OCI_USERNAME = 'tester'",
  "$env:TERM_OCI_TOKEN = 'secret'",
  `$env:TERM_TRUST_DIR = '${home}\\trust'`,
  `$env:TERM_STORE = '${home}\\store'`,
].join('\n')
const term = `& '${base}\\bin\\term.cmd'`
const shim = `Get-Content '${base}\\bin\\term.cmd'`

try {
  const loaded = await ps(`${env}\n$env:TERM_LOAD_VERSION = '${VERSION}'\n& '${root}\\load.ps1'\n${shim}\nGet-Content '${base}\\code\\${VERSION}\\install.tree'`)
  ok(`the loader installs ${VERSION} for ${platform}, checked, and writes bin\\term.cmd`, loaded.code === 0 && loaded.out.includes(`code\\${VERSION}\\term\\bin\\term.cmd`), loaded.out)
  ok('the loader wrote install.tree with the layer digest', loaded.out.includes(`hash <${digest}>`), loaded.out)
  ok('the loader names the PATH command, and changes nothing itself', /SetEnvironmentVariable\('Path'/.test(loaded.out), loaded.out)

  const version = await ps(`${env}\n${term} --version\nexit $LASTEXITCODE`)
  ok(`term --version runs on Windows and says ${VERSION}`, version.code === 0 && version.out.includes(VERSION), version.out)

  const made = await ps(`${env}\nSet-Location '${root}\\sample'\n${term} make --plain --color never\n$made = $LASTEXITCODE\nGet-ChildItem -Recurse -Name host\nexit $made`)
  ok('term make builds a project on Windows', made.code === 0 && /1 file built/.test(made.out) && /base\.(ts|js)/.test(made.out), made.out)

  const checked = await ps(`${env}\n${term} self check --plain --color never\nexit $LASTEXITCODE`)
  ok(`self check passes on the loader's install of ${VERSION}`, checked.code === 0 && /signed release/.test(checked.out), checked.out)

  const updated = await ps(`${env}\n${term} self update --plain --color never\n$code = $LASTEXITCODE\n${shim}\nexit $code`)
  ok(`self update installs ${NEXT} and moves bin\\term.cmd to it`, updated.code === 0 && updated.out.includes(`code\\${NEXT}\\term\\bin\\term.cmd`), updated.out)

  const again = await ps(`${env}\n${term} self check --plain --color never\nexit $LASTEXITCODE`)
  ok(`self check passes on ${NEXT}, run through the shim update rewrote`, again.code === 0 && again.out.includes(NEXT), again.out)

  const newest = await ps(`${env}\n${term} self update --plain --color never\nexit $LASTEXITCODE`)
  ok('a second update finds nothing newer', newest.code === 0 && /up to date/i.test(newest.out), newest.out)

  const back = await ps(`${env}\n${term} self back --plain --color never\n$code = $LASTEXITCODE\n${shim}\nexit $code`)
  ok(`self back returns bin\\term.cmd to ${VERSION}`, back.code === 0 && back.out.includes(`code\\${VERSION}\\term\\bin\\term.cmd`), back.out)

  const tree = `${base}\\code\\${VERSION}\\install.tree`
  const tampered = await ps(
    `${env}\n(Get-Content '${tree}' -Raw).Replace('${digest}', 'sha256:${'0'.repeat(64)}') | Set-Content -NoNewline '${tree}'\n${term} self check --plain --color never\nexit $LASTEXITCODE`,
  )
  ok('self check refuses an install whose digest is not the signed release', tampered.code !== 0 && /not the release/.test(tampered.out), tampered.out)

  // every blob GET above was redirected to the registry's separate storage host, which records any token it is sent
  ok('no pull token ever reached the storage host', server.leakedAuth.length === 0, server.leakedAuth.join(', '))
} finally {
  tunnel.kill()
  await windows.remoteAsync(`rmdir /s /q %USERPROFILE%\\${folder}`, { timeout: 120_000 })
  await server.close()
}

console.log(`\nself-release-windows: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
