// `term self check | update | back` end to end, against a loopback registry and a fresh HOME, with the real release
// payload (note/term/plan/term-load-install.md, P3).
//
//   1. publish this machine's payload twice, as 2.6.0 and 2.6.2, signed by a throwaway key that founds the key set
//   2. install 2.6.0 by running THE LOADER term.surf serves (mesh/site/term.surf/home/public/load)
//   3. run the INSTALLED term: check passes, update moves the link to 2.6.2, check passes there, back returns to 2.6.0
//   4. tamper with install.tree's digest: check refuses
//
// Needs the payload `pnpm run release --dry` writes; says so and stops when it is missing.
// Run: npx tsx test/call/self-release.ts
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { generateKeypair } from '../../deck/deck/code/object/sign'
import { ensurePublisher } from '../../deck/deck/code/oci/keys'
import { currentPlatform, publishRelease } from '../../deck/deck/code/oci/release'
import { httpTransport } from '../../deck/deck/code/oci/transport'
import { startOciServer } from '../../deck/deck/test/oci-server'

const TERM = join(import.meta.dirname, '..', '..')
// the installer term.surf serves at /load
const LOADER = join(TERM, '..', '..', '..', '..', 'mesh', 'site', 'term.surf', 'home', 'public', 'load')
const VERSION = (JSON.parse(readFileSync(join(TERM, 'package.json'), 'utf8')) as { version: string }).version
const NEXT = VERSION.replace(/\.(\d+)$/, (_, patch: string) => `.${Number(patch) + 2}`)
const PLATFORM = currentPlatform()

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

const payloadFile = join(TERM, 'tmp', 'release', VERSION, `term-${PLATFORM}.tar.gz`)

if (!PLATFORM || !existsSync(payloadFile)) {
  console.log(`self-release: no payload at ${payloadFile}; run \`pnpm run release --dry\` first`)
  process.exit(1)
}

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
  await publishRelease({
    transport,
    repository: 'cluesurf/term/code',
    package: '@term/code',
    version,
    payloads: [{ platform: PLATFORM, bytes: payload }],
    keypair,
  })
}

// a fresh machine: its own HOME, trust pins and store, pointed at the loopback registry
const home = mkdtempSync(join(tmpdir(), 'term-self-'))
const env = {
  ...process.env,
  HOME: home,
  TERM_RELEASE_REGISTRY: `oci://${server.host}/cluesurf/term`,
  TERM_OCI_HOST: server.host,
  TERM_OCI_USERNAME: 'tester',
  TERM_OCI_TOKEN: 'secret',
  TERM_TRUST_DIR: join(home, 'trust'),
  TERM_STORE: join(home, 'store'),
}
const base = join(home, '.base', '@cluesurf', 'term')
const bin = join(base, 'bin', 'term')

const first = join(base, 'code', VERSION)

// THE REAL LOADER, the script term.surf serves at /load, pointed at the loopback registry. Async for the reason below
function load(extra: Record<string, string>): Promise<{ code: number; out: string }> {
  return new Promise(resolve => {
    execFile(
      // TERM_LOAD_SHELL=dash runs it under Debian and Ubuntu's /bin/sh, which forgives no bashism
      process.env['TERM_LOAD_SHELL'] ?? 'sh',
      [LOADER],
      {
        env: {
          ...env,
          TERM_LOAD_REGISTRY: `http://${server.host}`,
          ...extra,
        },
        encoding: 'utf8',
        timeout: 120_000,
      },
      (error, stdout, stderr) => resolve({ code: error ? 1 : 0, out: `${stdout}${stderr}` }),
    )
  })
}

// ASYNC, never execFileSync: the registry runs in THIS process, and a synchronous child blocks the event loop the
// registry answers on, so the child waits on the registry and the registry on the child, forever
function term(args: string[]): Promise<{ code: number; out: string }> {
  return new Promise(resolve => {
    execFile(bin, [...args, '--plain', '--color', 'never'], { env, encoding: 'utf8', timeout: 120_000 }, (error, stdout, stderr) => {
      const code = error ? Number((error as { code?: number }).code ?? 1) : 0

      resolve({ code: Number.isFinite(code) ? code : 1, out: `${stdout}${stderr}` })
    })
  })
}

try {
  const loaded = await load({ TERM_LOAD_VERSION: VERSION })
  ok(`the loader installs ${VERSION}, checked and linked`, loaded.code === 0 && existsSync(bin) && readlinkSync(bin).includes(`/code/${VERSION}/`), loaded.out)
  ok('the loader wrote install.tree with the layer digest', existsSync(join(first, 'install.tree')) && readFileSync(join(first, 'install.tree'), 'utf8').includes(digest))
  ok('the loader names the PATH line, and edits no profile', /export PATH=/.test(loaded.out), loaded.out)

  const checked = await term(['self', 'check'])
  ok(`check passes on the loader's install of ${VERSION}`, checked.code === 0 && /signed release/.test(checked.out), checked.out)

  const updated = await term(['self', 'update'])
  ok(`update installs ${NEXT}`, updated.code === 0 && existsSync(join(base, 'code', NEXT, 'install.tree')), updated.out)
  ok(`update moves bin/term to ${NEXT}`, readlinkSync(bin).includes(`/code/${NEXT}/`), readlinkSync(bin))

  const again = await term(['self', 'check'])
  ok(`check passes on ${NEXT}`, again.code === 0 && again.out.includes(NEXT), again.out)

  const newest = await term(['self', 'update'])
  ok('a second update finds nothing newer', newest.code === 0 && /up to date/i.test(newest.out), newest.out)

  const back = await term(['self', 'back'])
  ok(`back returns bin/term to ${VERSION}`, back.code === 0 && readlinkSync(bin).includes(`/code/${VERSION}/`), back.out)

  const tree = join(first, 'install.tree')
  writeFileSync(tree, readFileSync(tree, 'utf8').replace(digest, `sha256:${'0'.repeat(64)}`))
  const tampered = await term(['self', 'check'])
  ok('check refuses an install whose digest is not the signed release', tampered.code !== 0 && /not the release/.test(tampered.out), tampered.out)

  // with no version named, the loader takes the newest, into a second machine
  const fresh = mkdtempSync(join(tmpdir(), 'term-load-'))
  const latest = await load({ HOME: fresh, TERM_TRUST_DIR: join(fresh, 'trust'), TERM_STORE: join(fresh, 'store') })
  ok(`the loader with no version installs the newest, ${NEXT}`, latest.code === 0 && existsSync(join(fresh, '.base', '@cluesurf', 'term', 'code', NEXT, 'install.tree')), latest.out)

  // a platform the release does not carry is named, and nothing is installed
  const absent = await load({ HOME: fresh, TERM_LOAD_VERSION: '9.9.9' })
  ok('the loader refuses a version that was never released', absent.code !== 0 && /term 9\.9\.9/.test(absent.out), absent.out)

  // every blob GET above was redirected to the registry's separate storage host, which records any token it is sent
  ok('no pull token ever reached the storage host', server.leakedAuth.length === 0, server.leakedAuth.join(', '))
} finally {
  await server.close()
}

console.log(`\nself-release: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
