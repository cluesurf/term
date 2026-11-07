// `pnpm term:boot`: fetch the stage0 boot.tree pins, verify it, and run the fixpoint chain with it (08-bootstrap.md
// "Stage0, after the port", decisions 123, 124 and 126 of change 001-finish-self-host, item 0171).
//
// boot.tree, at the Term root, read through its mill (deck/mill/code/tree/boot/mine.tree), never by hand:
//
//   boot
//     code <2.10.0>
//     site <oci://ghcr.io/cluesurf/term/code@sha256:…>
//
// THE DIGEST IS THE TRUST ANCHOR. It is the release's image index digest, which covers every platform at once. This
// tool reads the index under the version tag and refuses unless the registry serves exactly that digest, then reads
// this platform's manifest and config, checks the signature over the layer (toolchain-release.tree `read-release`) and
// the signer against the scope's key set (key-trust.tree `trusted-keys`), downloads the layer and checks its sha256,
// and takes term/host/compile.mjs out of it: stage0, task/stage0.ts's bundle of the release tree (decision 126). The
// folder holding it goes to `term:fixpoint --stage0 <dir>`, which builds stage1 and stage2 with it.
//
// A site with no digest pins no release yet (before 2.10.0 is published): stage0 is then task/stage0.json's bundle,
// checked against its id in the user home store, and term:fixpoint runs with that pin.
//
//   pnpm term:boot                       fetch, verify, then term:fixpoint --stage0 <the fetched folder>
//   pnpm term:boot --fetch-only          fetch and verify, print the folder, run nothing
//   pnpm term:boot --boot <file>         another boot.tree (a fixture)
//   --only <text>, --out <dir>, --jobs <n>, --targets ts,rust   handed to term:fixpoint as they are
//
// The registry, its credentials and the trust pins are the ones every `term` install uses: TERM_OCI_HOST,
// TERM_OCI_USERNAME, TERM_OCI_TOKEN, TERM_TRUST_DIR, TERM_TRUSTED_KEYS. The verified payload is kept in the user home,
// `.base/@term/code/boot/<index digest>/<platform>/term/host/compile.mjs`, never written over with other bytes.
//
// Exit 0 when term:fixpoint holds (or the fetch did, with --fetch-only), 1 when a pin is refused (one line naming the
// digest and the reason) or term:fixpoint finds a difference, 2 on usage, else term:fixpoint's own exit.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { CALLER_CWD, TERM_ROOT } from './root'

const PACKAGE = '@term/code'
const USAGE = 'usage: boot.ts [--boot <boot.tree>] [--fetch-only] [--only <text>] [--out <dir>] [--jobs <n>] [--targets ts,rust]'
// the flags handed to term:fixpoint, each with its value
const PASSED = ['--only', '--out', '--jobs', '--targets']
// the largest payload a release layer may be, as version-install.tree reads one
const LAYER_LIMIT = 536870912

const argv = process.argv.slice(2)

function flag(name: string): string | undefined {
  const at = argv.indexOf(name)
  return at >= 0 ? argv[at + 1] : undefined
}

const sha = (data: Buffer): string => createHash('sha256').update(data).digest('hex')

// a refusal: one line naming the pin and the reason
class Refusal extends Error {}

function usage(message: string): never {
  console.error(`${message}\n${USAGE}`)
  process.exit(2)
}

type Pin = { file: string; version: string; site: string; host: string; repository: string; digest?: string }

type MillCapture = { kind: string; value?: unknown; match?: Map<string, MillCapture[]> }

// boot.tree through its grammar: the one `boot` with its `code` and `site`
async function readBoot(file: string): Promise<Pin> {
  const { parse } = (await import('@term/make/code/parser/tree')) as unknown as {
    parse: (input: { file: string; text: string }) => { ok: boolean; tree?: unknown }
  }
  const { readMineGrammar, runMine } = (await import('@term/make/code/compile/mill-run')) as unknown as {
    readMineGrammar: (tree: unknown) => unknown
    runMine: (grammar: unknown, start: string, tree: unknown) => { ok: true; match: Map<string, MillCapture[]> } | { ok: false }
  }
  const grammarFile = join(TERM_ROOT, 'deck', 'mill', 'code', 'tree', 'boot', 'mine.tree')
  const grammar = readMineGrammar(parse({ file: 'boot-mine.tree', text: readFileSync(grammarFile, 'utf8') }).tree)

  if (!existsSync(file)) {
    throw new Refusal(`${file}: there is no boot.tree`)
  }

  const parsed = parse({ file: 'boot.tree', text: readFileSync(file, 'utf8') })
  const mined = parsed.ok ? runMine(grammar, 'boot-file', parsed.tree) : { ok: false as const }

  if (!mined.ok) {
    throw new Refusal(`${file}: not a boot pin (boot, then code <version> and site <oci://...>)`)
  }

  const boots = mined.match.get('boot') ?? []
  const one = boots.length === 1 && boots[0]!.kind === 'match' ? boots[0]!.match! : undefined
  const textAt = (match: Map<string, MillCapture[]> | undefined, site: string): string[] =>
    (match?.get(site) ?? []).flatMap(capture => {
      const inner = capture.kind === 'match' ? capture.match?.get('text')?.[0] : undefined
      return inner && typeof inner.value === 'string' ? [inner.value] : []
    })
  const codes = textAt(one, 'code')
  const sites = textAt(one, 'site')

  if (!one || codes.length !== 1 || sites.length !== 1) {
    throw new Refusal(`${file}: a boot pin is one boot with one code and one site`)
  }

  const version = codes[0]!
  const site = sites[0]!
  const at = /^oci:\/\/([^/@]+)\/([a-z0-9._/-]+?)(?:@(sha256:[a-f0-9]{64}))?$/.exec(site)

  if (!/^\d+\.\d+\.\d+$/.test(version) || !at) {
    throw new Refusal(`${file}: code <${version}> site <${site}> is not a version and an oci://<host>/<repository>[@sha256:<digest>] site`)
  }

  return { file, version, site, host: at[1]!, repository: at[2]!, digest: at[3] }
}

// the release the pin names, fetched and verified, its term/host/compile.mjs in the user home. Answers the folder
async function fetchPinned(pin: Pin & { digest: string }): Promise<string> {
  const deck = (await import('@cluesurf/deck.tree')) as unknown as typeof import('@cluesurf/deck.tree')
  const { userHome } = (await import('@term/call/code/home')) as { userHome: (...parts: string[]) => string }
  const refuse = (reason: string): never => {
    throw new Refusal(`${pin.digest}: ${reason}`)
  }

  if (!pin.repository.endsWith('/code')) {
    refuse(`the site ${pin.site} is not a ${PACKAGE} repository (<namespace>/code)`)
  }

  // the route a release of that registry and namespace has, so the key set is read where `term self load` reads it
  const namespace = pin.repository.slice(0, -'/code'.length)
  const route = deck.releaseRoute({ package: PACKAGE, env: { ...process.env, TERM_RELEASE_REGISTRY: `oci://${pin.host}/${namespace}` } })

  if (route.repository.name !== pin.repository) {
    refuse(`${PACKAGE} routes to ${route.repository.name} on ${pin.host}, not the pinned ${pin.repository}`)
  }

  const platform = deck.currentPlatform()

  if (!platform) {
    refuse(`no release is built for ${process.platform}-${process.arch}`)
  }

  // every read of the version tag must answer the pinned index, or the registry moved the tag. The port lifts what a
  // transport throws into its own failure, so the reason is kept here and said as it is
  const served = deck.transportFor({ host: pin.host })
  let moved: string | undefined
  const transport = {
    ...served,
    getManifest: async (asked: { repository: string; reference: string }) => {
      const got = await served.getManifest(asked)

      if (got && asked.repository === pin.repository && asked.reference === pin.version && got.digest !== pin.digest) {
        moved = `${pin.host}/${pin.repository}:${pin.version} serves the index ${got.digest}, not the pinned one`
        throw new Error(moved)
      }

      return got
    },
  }

  let release: Awaited<ReturnType<typeof deck.readRelease>> | undefined
  let trusted: Awaited<ReturnType<typeof deck.trustedKeys>> | undefined

  try {
    release = await deck.readRelease({ transport, repository: pin.repository, package: PACKAGE, version: pin.version, platform: platform! })
    trusted = await deck.trustedKeys({ transport, repository: route.keysRepository, scope: route.scope, host: pin.host, trustDir: deck.trustDir() })
  } catch (error) {
    refuse(moved ?? (error as Error).message)
  }

  if (!trusted) {
    refuse(`${route.scope} publishes no key set at ${pin.host}/${route.keysRepository}`)
  }

  if (!trusted!.keys.includes(release!.config.key)) {
    refuse(`${PACKAGE}@${pin.version} for ${platform} is signed by a key outside the key set of ${route.scope} (${trusted!.source})`)
  }

  let bytes: Buffer = Buffer.alloc(0)

  try {
    bytes = await transport.getBlob({ repository: pin.repository, digest: release!.layer, size: release!.size, limit: LAYER_LIMIT })
  } catch (error) {
    refuse(`the ${platform} layer ${release!.layer} could not be read: ${(error as Error).message}`)
  }

  if (`sha256:${sha(bytes)}` !== release!.layer) {
    refuse(`the ${platform} layer downloaded as sha256:${sha(bytes)}, and the signed manifest names ${release!.layer}`)
  }

  console.log(`term:boot: ${PACKAGE} ${pin.version} ${platform}: index ${pin.digest} as pinned, layer ${release!.layer} (${bytes.length} bytes), signed by a key of ${route.scope} (${trusted!.source})`)

  // only stage0 comes out of the payload, into a staging folder beside its place, renamed in whole
  const target = userHome('boot', pin.digest.slice('sha256:'.length), platform!)
  const staging = `${target}.${process.pid}`
  const archive = join(staging, 'layer.tar.gz')
  const inner = join('term', 'host', 'compile.mjs')

  mkdirSync(staging, { recursive: true })
  writeFileSync(archive, bytes)
  const untar = spawnSync('tar', ['-xzf', archive, '-C', staging, inner], { encoding: 'utf8' })
  rmSync(archive, { force: true })

  if (untar.status !== 0 || !existsSync(join(staging, inner))) {
    rmSync(staging, { recursive: true, force: true })
    refuse(`${PACKAGE}@${pin.version} for ${platform} carries no ${inner}, so it is no stage0 (decision 126)`)
  }

  const fetched = readFileSync(join(staging, inner))

  if (existsSync(target)) {
    const kept = join(target, inner)
    const same = existsSync(kept) && readFileSync(kept).equals(fetched)
    rmSync(staging, { recursive: true, force: true })

    if (!same) {
      refuse(`${target} holds other bytes than this release: left as it is`)
    }
  } else {
    mkdirSync(dirname(target), { recursive: true })
    renameSync(staging, target)
  }

  return join(target, 'term', 'host')
}

// no digest pinned yet: task/stage0.json's bundle, checked by its id in the user home store
async function pinnedStage0(pin: Pin): Promise<void> {
  const { readPin, stage0Path } = (await import('../stage0')) as {
    readPin: () => { id: string } | undefined
    stage0Path: (id: string, ...parts: string[]) => string
  }
  const held = readPin()

  if (!held) {
    throw new Refusal(`${pin.site}: boot.tree pins no digest yet, and task/stage0.json pins no stage0`)
  }

  const file = stage0Path(held.id, 'compile.mjs')

  if (!existsSync(file) || sha(readFileSync(file)) !== held.id) {
    throw new Refusal(`${held.id}: boot.tree pins no digest yet, and task/stage0.json's bundle is not installed as those bytes (pnpm stage0:show)`)
  }

  console.log(`term:boot: boot.tree pins ${PACKAGE} ${pin.version} with no digest yet: stage0 is task/stage0.json's bundle ${held.id}, checked`)
}

async function main(): Promise<void> {
  if (argv.includes('--help')) {
    console.log(USAGE)
    return
  }

  const file = resolve(CALLER_CWD, flag('--boot') ?? join(TERM_ROOT, 'boot.tree'))
  const passed: string[] = []

  for (const name of PASSED) {
    const value = flag(name)

    if (argv.includes(name) && (value === undefined || value.startsWith('--'))) {
      usage(`${name} takes a value`)
    }

    if (value !== undefined) {
      passed.push(name, name === '--out' ? resolve(CALLER_CWD, value) : value)
    }
  }

  let stage0: string | undefined

  try {
    const pin = await readBoot(file)

    if (pin.digest === undefined) {
      await pinnedStage0(pin)
    } else {
      stage0 = await fetchPinned({ ...pin, digest: pin.digest })
      console.log(`term:boot: stage0 ${sha(readFileSync(join(stage0, 'compile.mjs')))} at ${stage0}`)
    }
  } catch (error) {
    if (error instanceof Refusal) {
      console.error(`term:boot: refused ${error.message}`)
      process.exitCode = 1
      return
    }

    throw error
  }

  if (argv.includes('--fetch-only')) {
    return
  }

  const fixpoint = join(TERM_ROOT, 'task', 'term', 'fixpoint.ts')
  const args = [join(TERM_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), fixpoint, ...(stage0 ? ['--stage0', stage0] : []), ...passed]
  console.log(`term:boot: term:fixpoint${stage0 ? ` --stage0 ${stage0}` : ''}${passed.length ? ` ${passed.join(' ')}` : ''}`)
  const ran = spawnSync(process.execPath, args, { cwd: TERM_ROOT, stdio: 'inherit' })

  process.exitCode = ran.status ?? 3
}

main().catch(error => {
  console.error(error)
  process.exitCode = 3
})
