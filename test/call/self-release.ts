// `term self check | update | back` end to end, against a loopback registry and a fresh HOME, with the real release
// payload (note/term/plan/term-load-install.md, P3).
//
//   1. publish this machine's payload twice, as 2.6.0 and 2.6.2, signed by a throwaway key that founds the key set
//   2. install 2.6.0 by running THE LOADER term.surf serves (mesh/site/term.surf/home/public/load)
//   3. run the INSTALLED term: check passes, update moves the link to 2.6.2, check passes there, back returns to 2.6.0
//   4. dispatch (note/term/plan/term-versions.md): the front outside a project, `+range`, a project's `need` and its
//      lock.tree pin, TERM_VERSION, the handshake and the loop guard, TERM_NEED=local, an install on first use, and
//      `self list | find | pick | show | toss | wash`
//   5. tamper with install.tree's digest: check refuses
//
// EACH VERSION IS ITS OWN PAYLOAD: this machine's tarball with `term/package.json` rewritten to that version. With one
// set of bytes under both tags, the newer release would say it is the older one, and no handoff could be told apart.
//
// Needs the payload `pnpm run release --dry` writes; says so and stops when it is missing.
// Run: npx tsx test/call/self-release.ts
import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { writeFileList } from '../../deck/call/code/need-load'
import { generateKeypair } from '../../deck/deck/code/object/sign'
import { ensurePublisher } from '../../deck/deck/code/oci/keys'
import { currentPlatform, publishRelease } from '../../deck/deck/code/oci/release'
import { httpTransport } from '../../deck/deck/code/oci/transport'
import { startOciServer } from '../../deck/deck/test/oci-server'

const TERM = join(import.meta.dirname, '..', '..')
// the installer term.surf serves at /load
const LOADER = join(TERM, '..', '..', '..', '..', 'mesh', 'site', 'term.surf', 'home', 'public', 'load')
// the module the script hands over to, served beside it: `pnpm run make:load` writes it
const LOADER_MODULE = `${LOADER}.mjs`
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

// one payload per version, the version written into its package.json. Built before the registry starts: tar is a
// synchronous child, and nothing is listening yet for it to block
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
const digest = `sha256:${createHash('sha256').update(payloads[VERSION]!).digest('hex')}`
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
    payloads: [{ platform: PLATFORM, bytes: payloads[version]! }],
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
          TERM_LOAD_MODULE: LOADER_MODULE,
          // the profile the loader writes is the scratch home's, never the real one: one shell, and no ZDOTDIR leaking in
          SHELL: '/bin/zsh',
          ZDOTDIR: extra['HOME'] ?? home,
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
function term(args: string[], at: { cwd?: string; env?: Record<string, string> } = {}): Promise<{ code: number; out: string }> {
  return new Promise(resolve => {
    execFile(bin, [...args, '--plain', '--color', 'never'], { env: { ...env, ...at.env }, cwd: at.cwd, encoding: 'utf8', timeout: 120_000 }, (error, stdout, stderr) => {
      const code = error ? Number((error as { code?: number }).code ?? 1) : 0

      resolve({ code: Number.isFinite(code) ? code : 1, out: `${stdout}${stderr}` })
    })
  })
}

try {
  const loaded = await load({ TERM_LOAD_VERSION: VERSION })
  ok(`the loader installs ${VERSION}, checked and linked`, loaded.code === 0 && existsSync(bin) && readlinkSync(bin).includes(`/code/${VERSION}/`), loaded.out)
  ok('the loader wrote install.tree with the layer digest', existsSync(join(first, 'install.tree')) && readFileSync(join(first, 'install.tree'), 'utf8').includes(digest))
  ok('the loader names the PATH line for this terminal', /export PATH=/.test(loaded.out), loaded.out)

  const profile = () => (existsSync(join(home, '.zshrc')) ? readFileSync(join(home, '.zshrc'), 'utf8') : '')
  ok('the loader puts bin on PATH for new shells, one marked line in ~/.zshrc', profile().split('.base/@cluesurf/term/bin').length === 2 && /# term \(https:\/\/term\.surf\/load\)\nexport PATH="\$HOME\/\.base\/@cluesurf\/term\/bin:\$PATH"/.test(profile()) && /\+ path ~\/\.zshrc/.test(loaded.out), `${profile()}\n${loaded.out}`)

  const reloaded = await load({ TERM_LOAD_VERSION: VERSION })
  ok('   and a second install leaves it as it is', reloaded.code === 0 && profile().split('.base/@cluesurf/term/bin').length === 2 && /○ path ~\/\.zshrc/.test(reloaded.out), `${profile()}\n${reloaded.out}`)

  // eval "$(curl … | sh)": the one line on stdout puts term on THIS shell's PATH, so the same shell runs it next
  const evaluated = await new Promise<{ code: number; out: string; stdout: string }>(resolve => {
    execFile(
      'sh',
      ['-c', 'line="$(sh "$LOADER")" || exit 1; printf "%s\\n" "$line" > "$HOME/stdout.txt"; eval "$line"; term --version'],
      {
        env: { ...env, LOADER, TERM_LOAD_REGISTRY: `http://${server.host}`, TERM_LOAD_MODULE: LOADER_MODULE, SHELL: '/bin/zsh', ZDOTDIR: home, TERM_LOAD_VERSION: VERSION, PATH: '/usr/bin:/bin:' + dirname(process.execPath) },
        encoding: 'utf8',
        timeout: 120_000,
      },
      (error, stdout, stderr) => resolve({ code: error ? 1 : 0, out: `${stdout}${stderr}`, stdout: existsSync(join(home, 'stdout.txt')) ? readFileSync(join(home, 'stdout.txt'), 'utf8') : '' }),
    )
  })
  ok(
    'eval "$(… | sh)" puts term on the PATH of the shell that ran it, and stdout holds that one line alone',
    evaluated.code === 0 && evaluated.out.includes(`${VERSION}\n`) && /^export PATH="[^"]+\/\.base\/@cluesurf\/term\/bin:\$PATH"; hash -r 2>\/dev\/null \|\| true\n$/.test(evaluated.stdout),
    `${evaluated.stdout}\n${evaluated.out}`,
  )

  const kept = mkdtempSync(join(tmpdir(), 'term-kept-'))
  const off = await load({ HOME: kept, TERM_TRUST_DIR: join(kept, 'trust'), TERM_STORE: join(kept, 'store'), TERM_LOAD_VERSION: VERSION, TERM_LOAD_PATH: '0' })
  ok('   and TERM_LOAD_PATH=0 edits no profile', off.code === 0 && !existsSync(join(kept, '.zshrc')) && /no profile was edited/.test(off.out), off.out)
  ok(
    'the loader prints one run in the output standard: opening and closing `load` items, every other line an item or under one',
    // v3 (note/term/output/standard.md): `glyph verb subject` at column 0, every child line two cells in, and the
    // opening's clock only in a service (section 2), which an install is not
    /(^|\n)● load ~\/\.base\/@cluesurf\/term\n {2}(\d\d:\d\d:\d\d\.\d{3} · )?term\.surf\/load\n/.test(loaded.out) &&
      // ▲ when this machine has another `term` on PATH (an npm global), which the loader names: the worst glyph closes
      new RegExp(`[✓▲] load term ${VERSION.replace(/\./g, '\\.')} is installed`).test(loaded.out) &&
      loaded.out.split('\n').every(line => line === '' || /^[✓✗▲●○◐?+−~] [a-zA-Z]+ \S/.test(line) || line.startsWith('  ') || line.startsWith('export PATH=')),
    loaded.out,
  )

  const checked = await term(['self', 'check'])
  ok(`check passes on the loader's install of ${VERSION}`, checked.code === 0 && /signed release/.test(checked.out), checked.out)

  const updated = await term(['self', 'update'])
  ok(`update installs ${NEXT}`, updated.code === 0 && existsSync(join(base, 'code', NEXT, 'install.tree')), updated.out)
  ok(`update moves bin/term to ${NEXT}`, readlinkSync(bin).includes(`/code/${NEXT}/`), readlinkSync(bin))

  const again = await term(['self', 'check'])
  ok(`check passes on ${NEXT}`, again.code === 0 && again.out.includes(NEXT), again.out)

  const newest = await term(['self', 'update'])
  ok('a second update finds nothing newer', newest.code === 0 && /up to date/i.test(newest.out), newest.out)

  // `term update` is `term self update` (line.ts), answered by the front as `self` is (need-run.ts)
  const alias = await term(['update'])
  ok('   and `term update` is the same verb: it finds nothing newer', alias.code === 0 && /up to date/i.test(alias.out) && readlinkSync(bin).includes(`/code/${NEXT}/`), alias.out)

  const back = await term(['self', 'back'])
  ok(`back returns bin/term to ${VERSION}`, back.code === 0 && readlinkSync(bin).includes(`/code/${VERSION}/`), back.out)

  // ---- dispatch ----
  const outside = mkdtempSync(join(tmpdir(), 'term-outside-'))
  const project = mkdtempSync(join(tmpdir(), 'term-project-'))

  writeFileSync(join(project, 'deck.tree'), 'deck @alice/app\n  mark <1.0.0>\n')

  const front = await term(['--version'], { cwd: outside })
  ok(`outside a project the front runs, ${VERSION}, though ${NEXT} is installed`, front.code === 0 && front.out.includes(VERSION) && !front.out.includes(NEXT), front.out)

  const plus = await term([`+${NEXT}`, '--version'], { cwd: outside })
  ok(`+${NEXT} hands this one command to ${NEXT}`, plus.code === 0 && plus.out.includes(NEXT), plus.out)

  const needed = await term(['self', 'need', NEXT], { cwd: project })
  const manifest = readFileSync(join(project, 'deck.tree'), 'utf8')
  const lock = existsSync(join(project, 'lock.tree')) ? readFileSync(join(project, 'lock.tree'), 'utf8') : ''
  ok('self need writes the request into deck.tree', needed.code === 0 && manifest.includes(`need @term/code, mark <${NEXT}>`), `${needed.out}\n${manifest}`)
  ok('   and pins the release, with its index digest, in lock.tree', lock.includes('need @term/code') && lock.includes(`code <${NEXT}>`) && /hash <sha256:[0-9a-f]{64}>/.test(lock), lock)

  const inside = await term(['--version'], { cwd: project })
  ok(`in the project, ${NEXT} runs, from the same front`, inside.code === 0 && inside.out.includes(NEXT), inside.out)

  mkdirSync(join(project, 'code', 'deep'), { recursive: true })
  const deep = await term(['--version'], { cwd: join(project, 'code', 'deep') })
  ok('   and from a folder under it', deep.out.includes(NEXT), deep.out)

  const shown = await term(['self', 'show'], { cwd: project })
  ok('self show names the project rule, the file, and the pin', shown.code === 0 && /project/.test(shown.out) && /deck\.tree/.test(shown.out) && shown.out.includes(`${NEXT} runs here`) && /pinned in lock\.tree/.test(shown.out), shown.out)

  const overridden = await term(['--version'], { cwd: project, env: { TERM_VERSION: VERSION } })
  ok(`TERM_VERSION=${VERSION} wins over the project`, overridden.out.includes(VERSION) && !overridden.out.includes(NEXT), overridden.out)

  const looped = await term(['--version'], { cwd: project, env: { TERM_NEED_DEPTH: '3' } })
  ok('a fourth handoff is refused as a loop, and nothing runs', looped.code !== 0 && /handed over 4 times/.test(looped.out), looped.out)

  const handshake = await term(['--version'], { cwd: outside, env: { TERM_NEED_SWITCH: '9.9.9' } })
  ok('the handshake refuses a term asked to be another version', handshake.code !== 0 && /asked to run as term 9\.9\.9/.test(handshake.out), handshake.out)

  const listed = await term(['self', 'list'], { cwd: outside })
  ok('self list shows both versions and marks the front', listed.code === 0 && listed.out.includes(VERSION) && listed.out.includes(NEXT) && /front/.test(listed.out), listed.out)

  const found = await term(['self', 'find'], { cwd: outside })
  ok('self find lists the releases, newest first', found.code === 0 && found.out.indexOf(NEXT) >= 0 && found.out.indexOf(NEXT) < found.out.lastIndexOf(VERSION), found.out)

  const frontToss = await term(['self', 'toss', VERSION], { cwd: outside })
  ok('self toss refuses the front', frontToss.code !== 0 && /is the front/.test(frontToss.out), frontToss.out)

  const tossed = await term(['self', 'toss', NEXT], { cwd: outside })
  ok(`self toss removes ${NEXT}`, tossed.code === 0 && !existsSync(join(base, 'code', NEXT)), tossed.out)

  const local = await term(['--version'], { cwd: project, env: { TERM_NEED: 'local' } })
  ok('TERM_NEED=local refuses a pinned version that is not installed, naming the fix', local.code !== 0 && /TERM_NEED=local/.test(local.out) && /term self load/.test(local.out), local.out)

  const auto = await term(['--version'], { cwd: project })
  ok(`on first use the pin is installed, verified, and run`, auto.code === 0 && existsSync(join(base, 'code', NEXT, 'install.tree')) && /load/.test(auto.out) && auto.out.includes(NEXT), auto.out)

  const picked = await term(['self', 'pick', NEXT], { cwd: outside })
  const byDefault = await term(['--version'], { cwd: outside })
  ok(`self pick ${NEXT} makes it the default outside a project`, picked.code === 0 && byDefault.out.includes(NEXT), `${picked.out}\n${byDefault.out}`)
  await term(['self', 'pick', VERSION], { cwd: outside })

  // wash: both versions last used 100 days ago, past the 90-day window. The front is kept whatever its age, and the
  // project's pin is kept from inside the project
  const old = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000)

  for (const version of [VERSION, NEXT]) {
    for (const file of ['used', 'install.tree']) {
      const at = join(base, 'code', version, file)

      if (existsSync(at)) {
        utimesSync(at, old, old)
      }
    }
  }

  const washPlan = await term(['self', 'wash'], { cwd: outside })
  ok(`self wash lists ${NEXT}, unused for 100 days, and removes nothing`, washPlan.code === 0 && new RegExp(`term ${NEXT.replace(/\./g, '\\.')}.*would be removed`, 's').test(washPlan.out) && existsSync(join(base, 'code', NEXT)), washPlan.out)
  ok(`   and keeps ${VERSION}, as old, because it is the front`, new RegExp(`keep.*term ${VERSION.replace(/\./g, '\\.')}.*the front`, 's').test(washPlan.out), washPlan.out)

  const washHere = await term(['self', 'wash'], { cwd: project })
  ok(`   inside the project, ${NEXT} is kept as its pin`, /pinned here/.test(washHere.out) && /Nothing unused/.test(washHere.out), washHere.out)

  const washed = await term(['self', 'wash', '--commit'], { cwd: outside })
  ok(`self wash --commit removes ${NEXT}, and the front stays`, washed.code === 0 && !existsSync(join(base, 'code', NEXT)) && existsSync(join(base, 'code', VERSION)), washed.out)

  const loadedAgain = await term(['self', 'load', NEXT], { cwd: outside })
  ok(`self load ${NEXT} installs it, verified, and switches nothing`, loadedAgain.code === 0 && existsSync(join(base, 'code', NEXT, 'install.tree')) && /signed/.test(loadedAgain.out) && readlinkSync(bin).includes(`/code/${VERSION}/`), loadedAgain.out)

  // two versions share every file they hold alike: `du` counts a hard-linked file once
  const kilobytes = (dir: string) => Number(execFileSync('du', ['-sk', dir], { encoding: 'utf8' }).split(/\s/)[0])
  const one = kilobytes(join(base, 'code', VERSION))
  const both = kilobytes(join(base, 'code'))
  ok(`   and shares its files with ${VERSION}: code/ is ${both} KB for two versions of ${one} KB`, both < one * 1.2 && /files shared/.test(loadedAgain.out), `${both} of ${one}\n${loadedAgain.out}`)

  const loadedTwice = await term(['self', 'load', NEXT.replace(/\.\d+$/, '.x')], { cwd: outside })
  ok('   a range already satisfied installs nothing more', loadedTwice.code === 0 && /installed already/.test(loadedTwice.out), loadedTwice.out)

  const stillFront = await term(['--version'], { cwd: outside })
  ok(`   and outside a project the front, ${VERSION}, still runs`, stillFront.out.trim().endsWith(VERSION), stillFront.out)

  const removed = await term(['self', 'need', '--none'], { cwd: project })
  ok('self need --none removes the request and the pin', removed.code === 0 && !readFileSync(join(project, 'deck.tree'), 'utf8').includes('need') && !readFileSync(join(project, 'lock.tree'), 'utf8').includes('need'), removed.out)

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
  ok('the loader refuses a version that was never released', absent.code !== 0 && /9\.9\.9 is not released/.test(absent.out) && /Nothing was installed/.test(absent.out), absent.out)

  // every blob GET above was redirected to the registry's separate storage host, which records any token it is sent
  ok('no pull token ever reached the storage host', server.leakedAuth.length === 0, server.leakedAuth.join(', '))
} finally {
  await server.close()
}

console.log(`\nself-release: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
