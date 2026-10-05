// The samples in note/term/guides/commands/self.md and basics/install.md: real output of the version commands. A
// loopback registry holding two releases, each this machine's release payload with its own version, the loader's
// install of the older into a scratch home, and each command run as a person would, printed with its command line.
//
// Needs the payload `pnpm run release --dry` writes. Writes nothing outside the system temp directory.
// Run: npx tsx task/self-samples.ts
import { execFile, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { writeFileList } from '../deck/call/code/need-load'
import { generateKeypair } from '../deck/deck/code/object/sign'
import { ensurePublisher } from '../deck/deck/code/oci/keys'
import { currentPlatform, publishRelease } from '../deck/deck/code/oci/release'
import { httpTransport } from '../deck/deck/code/oci/transport'
import { startOciServer } from '../deck/deck/test/oci-server'

const TERM = join(import.meta.dirname, '..')
const LOADER = join(TERM, '..', '..', '..', '..', 'mesh', 'site', 'term.surf', 'home', 'public', 'load')
const VERSION = (JSON.parse(readFileSync(join(TERM, 'package.json'), 'utf8')) as { version: string }).version
const NEXT = VERSION.replace(/\.(\d+)$/, (_, patch: string) => `.${Number(patch) + 2}`)
const PLATFORM = currentPlatform()!
const payloadFile = join(TERM, 'tmp', 'release', VERSION, `term-${PLATFORM}.tar.gz`)

function payloadOf(version: string): Buffer {
  const dir = mkdtempSync(join(tmpdir(), `term-payload-${version}-`))
  const manifest = join(dir, 'term', 'package.json')

  execFileSync('tar', ['-xzf', payloadFile, '-C', dir])
  writeFileSync(manifest, readFileSync(manifest, 'utf8').replace(/"version": "[^"]+"/, `"version": "${version}"`))
  // the list a release carries is written last, over what it ships: rewritten here because package.json changed
  writeFileList(join(dir, 'term'))
  execFileSync('tar', ['-czf', join(dir, 'term.tar.gz'), '-C', dir, 'term'], { env: { ...process.env, COPYFILE_DISABLE: '1' } })

  return readFileSync(join(dir, 'term.tar.gz'))
}

const payloads = { [VERSION]: payloadOf(VERSION), [NEXT]: payloadOf(NEXT) }
const server = await startOciServer()
const transport = httpTransport({ host: server.host, credentials: async () => ({ kind: 'basic', username: 'tester', password: 'secret' }), retries: 0 })
const keypair = generateKeypair()

await ensurePublisher({ transport, repository: 'cluesurf/term/name', scope: '@term', keypair })

for (const version of [VERSION, NEXT]) {
  await publishRelease({ transport, repository: 'cluesurf/term/code', package: '@term/code', version, payloads: [{ platform: PLATFORM, bytes: payloads[version]! }], keypair })
}

const home = realpathSync(mkdtempSync(join(tmpdir(), 'term-samples-')))
const env = {
  ...process.env,
  HOME: home,
  TERM_RELEASE_REGISTRY: `oci://${server.host}/cluesurf/term`,
  TERM_OCI_HOST: server.host,
  TERM_OCI_USERNAME: 'tester',
  TERM_OCI_TOKEN: 'secret',
  TERM_TRUST_DIR: join(home, 'trust'),
  TERM_STORE: join(home, 'store'),
  COLUMNS: '76',
}
const bin = join(home, '.base', '@cluesurf', 'term', 'bin', 'term')

function run(file: string, args: string[], cwd: string, extra: Record<string, string> = {}): Promise<string> {
  return new Promise(resolve => {
    execFile(file, args, { env: { ...env, ...extra }, cwd, encoding: 'utf8', timeout: 120_000 }, (_error, stdout, stderr) => resolve(`${stdout}${stderr}`))
  })
}

async function show(args: string[], cwd: string, extra: Record<string, string> = {}): Promise<void> {
  const out = await run(bin, [...args, '--color', 'never'], cwd, extra)
  const prefix = Object.entries(extra).map(([key, value]) => `${key}=${value} `).join('')

  console.log(`\n$ ${prefix}term ${args.join(' ')}\n${out}`)
}

try {
  await run('sh', [LOADER], home, { TERM_LOAD_REGISTRY: `http://${server.host}`, TERM_LOAD_VERSION: VERSION })

  const app = join(home, 'code', 'app')

  mkdirSync(app, { recursive: true })
  writeFileSync(join(app, 'deck.tree'), 'deck @alice/app\n  mark <1.0.0>\n')

  await show(['self', 'find'], home)
  await show(['self', 'load', NEXT], home)
  await show(['self', 'list'], home)
  await show(['--version'], home)
  await show([`+${NEXT}`, '--version'], home)
  await show(['self', 'need', NEXT], app)
  console.log(`\n$ cat deck.tree\n${readFileSync(join(app, 'deck.tree'), 'utf8')}`)
  console.log(`$ cat lock.tree\n${readFileSync(join(app, 'lock.tree'), 'utf8')}`)
  await show(['--version'], app)
  await show(['self', 'show'], app)
  await show(['self', 'toss', NEXT], home)
  await show(['--version'], app, { TERM_NEED: 'local' })
  await show(['--version'], app)
  await show(['self', 'pick', VERSION], home)
  await show(['self', 'wash', '--days', '0'], home)
} finally {
  await server.close()
}
