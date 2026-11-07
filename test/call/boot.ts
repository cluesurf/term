// `pnpm term:boot` against a loopback registry, a throwaway key and a fresh HOME (item 0171, decision 126 of change
// 001-finish-self-host). Never a real registry, keychain or token.
//
//   1. publish a payload carrying term/host/compile.mjs as 2.10.0, and one without it as 2.10.2, signed by a throwaway
//      key that founds the key set of @term
//   2. a boot.tree pinning 2.10.0's index digest: term:boot --fetch-only fetches, verifies and keeps compile.mjs, those
//      bytes, under the HOME
//   3. refusals, each one line naming the digest and the reason: a tampered digest, a version the registry does not
//      hold, a signer outside the trusted key set, a release with no compile.mjs, a boot.tree that is no boot pin
//   4. with --only <text>: the whole chain, term:fixpoint --stage0 <the fetched folder> on that subset, which must read
//      `fixpoint ts ... 0 differ` (a smoke run; --out names where it goes)
//
//   npx tsx test/call/boot.ts                                   a payload made here, steps 1 to 3
//   npx tsx test/call/boot.ts --payload <term-<platform>.tar.gz> [--only <text> --out <dir>]
//
// Prints `boot: N pass, M fail`, exits 1 on a failure.
import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { generateKeypair } from '../../deck/deck/code/object/sign'
import { ensurePublisher } from '../../deck/deck/code/oci/keys'
import { currentPlatform, publishRelease, releaseRoute } from '../../deck/deck/code/oci/release'
import { httpTransport } from '../../deck/deck/code/oci/transport'
import { startOciServer } from '../../deck/deck/test/oci-server'
import { tempDir } from '../temp'

const TERM = join(import.meta.dirname, '..', '..')
const PLATFORM = currentPlatform()
const VERSION = '2.10.0'
const BARE = '2.10.2'

let pass = 0
let fail = 0

function ok(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  ${info}`)
  }
}

function flagValue(name: string): string | undefined {
  const at = process.argv.indexOf(name)

  return at < 0 ? undefined : process.argv[at + 1]
}

const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

if (!PLATFORM) {
  console.log(`boot: 0 pass, 0 fail (no release is built for ${process.platform}-${process.arch})`)
  process.exit(0)
}

const work = tempDir('term-boot-')
const given = flagValue('--payload')
const only = flagValue('--only')
const out = flagValue('--out')

if (only !== undefined && (given === undefined || out === undefined)) {
  console.log('boot: --only runs the whole chain, so it needs --payload <a real release payload> and --out <dir>')
  process.exit(2)
}

// a payload folder packed as a release packs one: term/ at the top of a .tar.gz
function pack(name: string, files: Record<string, string>): Buffer {
  const dir = join(work, name)

  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(dir, 'term', file, '..'), { recursive: true })
    writeFileSync(join(dir, 'term', file), text)
  }

  execFileSync('tar', ['-czf', join(dir, 'term.tar.gz'), '-C', dir, 'term'], { env: { ...process.env, COPYFILE_DISABLE: '1' } })

  return readFileSync(join(dir, 'term.tar.gz'))
}

const withStage0 = given ? readFileSync(resolve(given)) : pack('with', { 'package.json': '{}\n', 'host/compile.mjs': 'export const compile = () => 0\n' })
const withoutStage0 = pack('without', { 'package.json': '{}\n', 'host/line.js': '\n' })
// the compile.mjs the published payload carries, as term:boot must keep it
const listed = join(work, 'listed')
mkdirSync(listed, { recursive: true })
execFileSync('tar', ['-xzf', '-', '-C', listed, 'term/host/compile.mjs'], { input: withStage0 })
const stage0Id = sha(readFileSync(join(listed, 'term', 'host', 'compile.mjs')))

const server = await startOciServer()
const transport = httpTransport({
  host: server.host,
  credentials: async () => ({ kind: 'basic', username: 'tester', password: 'secret' }),
  retries: 0,
})
const route = releaseRoute({ package: '@term/code', env: { ...process.env, TERM_RELEASE_REGISTRY: `oci://${server.host}/cluesurf/term` } })
const keypair = generateKeypair()
const stranger = generateKeypair()

await ensurePublisher({ transport, repository: route.keysRepository, scope: route.scope, keypair })
const published = await publishRelease({
  transport,
  repository: route.repository.name,
  package: '@term/code',
  version: VERSION,
  payloads: [{ platform: PLATFORM, bytes: withStage0 }],
  keypair,
})
const bare = await publishRelease({
  transport,
  repository: route.repository.name,
  package: '@term/code',
  version: BARE,
  payloads: [{ platform: PLATFORM, bytes: withoutStage0 }],
  keypair,
})

function bootFile(name: string, text: string): string {
  const file = join(work, name)
  writeFileSync(file, text)

  return file
}

const site = (digest: string): string => `oci://${server.host}/${route.repository.name}@${digest}`
const pinned = bootFile('boot.tree', `boot\n  code <${VERSION}>\n  site <${site(published.index)}>\n`)
const tamperedDigest = `sha256:${'0'.repeat(64)}`
const tampered = bootFile('tampered.tree', `boot\n  code <${VERSION}>\n  site <${site(tamperedDigest)}>\n`)
const absentDigest = published.index
const absent = bootFile('absent.tree', `boot\n  code <9.9.8>\n  site <${site(absentDigest)}>\n`)
const noStage0 = bootFile('bare.tree', `boot\n  code <${BARE}>\n  site <${site(bare.index)}>\n`)
const broken = bootFile('broken.tree', `boot\n  code <${VERSION}>\n`)

// a fresh machine: its own HOME and trust pins, the loopback registry's credentials, nothing of this shell's
function machine(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}

  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('TERM_') || key === 'GHCR_TOKEN' || key.startsWith('npm_')) {
      continue
    }

    env[key] = value
  }

  return {
    ...env,
    HOME: home,
    TERM_OCI_HOST: server.host,
    TERM_OCI_USERNAME: 'tester',
    TERM_OCI_TOKEN: 'secret',
    TERM_TRUST_DIR: join(home, 'trust'),
    TERM_STORE: join(home, 'store'),
    ...extra,
  }
}

// term:boot as a child, async: the registry answers from this process, so a synchronous child would wait on itself
function boot(args: string[], env: NodeJS.ProcessEnv, timeout = 120_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(done => {
    execFile(
      process.execPath,
      [join(TERM, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(TERM, 'task', 'term', 'boot.ts'), ...args],
      { cwd: TERM, env, encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => done({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr }),
    )
  })
}

const refusalOf = (text: string): string[] => text.split('\n').filter(line => line.startsWith('term:boot: refused'))

// 2. the pinned release, fetched and verified
const home = join(work, 'home')
const fetched = await boot(['--boot', pinned, '--fetch-only'], machine(home))
const kept = join(home, '.base', '@term', 'code', 'boot', published.index.slice('sha256:'.length), PLATFORM, 'term', 'host', 'compile.mjs')
ok('term:boot --fetch-only fetches and verifies the pinned release', fetched.code === 0 && fetched.stdout.includes(`index ${published.index} as pinned`), `exit ${fetched.code}: ${fetched.stdout}${fetched.stderr}`)
ok('the release key set was trusted on first use', /signed by a key of @term \(first-use\)/.test(fetched.stdout), fetched.stdout)
ok('compile.mjs is kept under the HOME, the bytes the payload carries', existsSync(kept) && sha(readFileSync(kept)) === stage0Id, kept)
ok('term:boot names the stage0 it hands over by its bundle id', fetched.stdout.includes(`stage0 ${stage0Id} at `), fetched.stdout)
const again = await boot(['--boot', pinned, '--fetch-only'], machine(home))
ok('a second fetch keeps the folder the first one verified', again.code === 0 && existsSync(kept), `exit ${again.code}: ${again.stderr}`)

// 3. the refusals, one line each, naming the digest and the reason
const refusals: [string, string, NodeJS.ProcessEnv, RegExp][] = [
  ['a tampered digest', tampered, machine(join(work, 'home-tampered')), new RegExp(`^term:boot: refused ${tamperedDigest}: .* serves the index ${published.index}, not the pinned one$`)],
  ['a version the registry does not hold', absent, machine(join(work, 'home-absent')), new RegExp(`^term:boot: refused ${absentDigest}: @term/code@9\\.9\\.8 is not released$`)],
  [
    'a signer outside the trusted key set',
    pinned,
    machine(join(work, 'home-stranger'), { TERM_TRUSTED_KEYS: `@term=${stranger.publicKey}` }),
    new RegExp(`^term:boot: refused ${published.index}: @term/code@${VERSION.replace(/\./g, '\\.')} for ${PLATFORM} is signed by a key outside the key set of @term \\(env\\)$`),
  ],
  ['a release with no compile.mjs', noStage0, machine(join(work, 'home-bare')), new RegExp(`^term:boot: refused ${bare.index}: .* carries no term/host/compile\\.mjs, so it is no stage0`)],
  ['a boot.tree that is no boot pin', broken, machine(join(work, 'home-broken')), /^term:boot: refused .*broken\.tree: a boot pin is one boot with one code and one site$/],
]

for (const [name, file, env, line] of refusals) {
  const ran = await boot(['--boot', file, '--fetch-only'], env)
  const said = refusalOf(ran.stderr)
  ok(`term:boot refuses ${name} in one line`, ran.code === 1 && said.length === 1 && line.test(said[0]!) && !/stage0 [a-f0-9]{64} at /.test(ran.stdout), `exit ${ran.code}: ${ran.stdout}${ran.stderr}`)
}

ok('no Authorization header reached the storage host', server.leakedAuth.length === 0, server.leakedAuth.join(' '))

// 4. the whole chain on a subset
if (only !== undefined) {
  const chain = await boot(['--boot', pinned, '--only', only, '--out', resolve(out!), '--jobs', '2'], machine(join(work, 'home-chain')), 3_600_000)
  const lines = `${chain.stdout}${chain.stderr}`
  console.log(lines.split('\n').filter(line => /^term:boot|^term:fixpoint|^fixpoint|^stage0-stage1|^bundle|^status/.test(line)).join('\n'))
  ok(`term:boot runs term:fixpoint --stage0 <the fetched folder> --only ${only}`, lines.includes(`term:fixpoint --stage0 `) && lines.includes(`term:fixpoint stage0 ${stage0Id.slice(0, 12)}`), lines.slice(-600))
  const fixpointTs = /^fixpoint ts: (\d+) modules, identical/m.exec(lines)
  ok('the fixpoint holds on the subset: stage1 and stage2 emit identical TypeScript', fixpointTs !== null && Number(fixpointTs[1]) > 0, lines.slice(-600))
  const fixpointRust = /^fixpoint rust: (\d+) modules, identical/m.exec(lines)
  ok('and identical Rust', fixpointRust !== null && Number(fixpointRust[1]) > 0, lines.slice(-600))
}

await server.close()
console.log(`\nboot: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
