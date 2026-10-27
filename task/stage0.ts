// STAGE0, THE FROZEN COMPILER make:port builds with (term-self-host-001-0018, decision 036 of
// note/project/term/self-host/change/001-finish-self-host/decision/).
//
// task/port-build.ts compiles every port with stage0, never with the working tree's compiler, so an edit to a
// compiler `.tree` rebuilds only the ports whose own text or imports changed, and a half-edited compiler cannot break
// the build that would rebuild it (traps.md T033). Stage0 is one esbuild bundle of the compile closure port-build
// calls (the eight names below), taken from the working tree when it is PINNED and never again: a compiler edit never
// changes it. It is stored under the user home, `~/.base/@term/code/stage0/<id>/compile.mjs`, beside `source.json`
// (the HEAD commit the working tree sat on, a digest of its deck/make sources and of every bundled source). Its id is
// the sha256 of the bundle's bytes, since the working tree has edits no commit names, and port-build's compiler
// fingerprint is that same id. `task/stage0.json` names the pinned id.
//
//   npx tsx task/stage0.ts show     the pin, whether its bundle is installed, and whether the working tree's compile
//                                   closure would bundle to it (exit 1 when the pinned bundle is missing)
//   npx tsx task/stage0.ts pin      bundle the working tree's compile closure and pin it (the explicit re-pin, the one
//                                   thing that changes stage0). Every port compiles once more on the next make:port
//
// Every npm package is bundled in: the bundle lives under the user home, where no node_modules resolves. A `require` a
// bundled CommonJS package makes of a node builtin goes through the createRequire the banner defines.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { userHome } from '@term/call/code/home'

// run from the Term package root, the way every script under task/ is
const TERM = process.cwd()

export const PIN_FILE = join(TERM, 'task', 'stage0.json')

// what port-build loads from stage0. `--stage-check` loads the same specifiers from the working tree
export const STAGE0_SOURCES: Record<string, string[]> = {
  '@term/make/code/compile/compile': ['compile'],
  '@term/make/code/compile/load': ['collectModules', 'makeParseMemo'],
  '@term/make/code/compile/native': ['nativePrelude'],
  '@term/call/code/make': ['projectResolver'],
  '@term/call/code/role-of': ['projectLeanOf'],
  '@term/make/code/compile/typescript': ['toCamel'],
}

export type Pin = { id: string; pinned: string; head: string; make_digest: string; sources_digest: string; sources: number }

export function stage0Path(id: string, ...parts: string[]): string {
  return userHome('stage0', id, ...parts)
}

// the pin, or undefined when none was ever made
export function readPin(): Pin | undefined {
  if (!existsSync(PIN_FILE)) {
    return undefined
  }

  return JSON.parse(readFileSync(PIN_FILE, 'utf8')) as Pin
}

function sha(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

// the bundle of the working tree's compile closure, and the sources it was made from
async function bundle(): Promise<{ bytes: Buffer; inputs: string[] }> {
  const { build } = await import('esbuild')
  const contents = Object.entries(STAGE0_SOURCES)
    .map(([from, names]) => `export { ${names.join(', ')} } from '${from}'`)
    .join('\n')
  const result = await build({
    stdin: { contents, resolveDir: TERM, sourcefile: 'stage0-entry.ts', loader: 'ts' },
    absWorkingDir: TERM,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    tsconfig: join(TERM, 'tsconfig.json'),
    banner: { js: "import { createRequire as __stage0Require } from 'node:module'\nconst require = __stage0Require(import.meta.url)" },
    // optional packages a bundled dependency reaches for only when they are installed
    external: ['fsevents'],
    metafile: true,
    write: false,
    logLevel: 'silent',
  })

  return {
    bytes: Buffer.from(result.outputFiles[0]!.contents),
    inputs: Object.keys(result.metafile.inputs)
      .filter(input => input !== 'stage0-entry.ts' && !input.startsWith('<'))
      .sort(),
  }
}

// a digest of the listed sources, each by its path and content
function digestOf(inputs: string[]): string {
  const hash = createHash('sha256')

  for (const input of inputs) {
    hash.update(`${input} ${sha(readFileSync(join(TERM, input)))}\n`)
  }

  return hash.digest('hex')
}

async function pin(): Promise<void> {
  const { bytes, inputs } = await bundle()
  const id = sha(bytes)
  const dir = stage0Path(id)
  const file = join(dir, 'compile.mjs')
  const head = execFileSync('git', ['-C', TERM, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const make = inputs.filter(input => input.startsWith('deck/make/'))
  const record: Pin = {
    id,
    pinned: new Date().toISOString(),
    head,
    make_digest: digestOf(make),
    sources_digest: digestOf(inputs),
    sources: inputs.length,
  }

  // a stage0 already stored under this id is these bytes (the id is their hash): never written over
  if (existsSync(file)) {
    if (sha(readFileSync(file)) !== id) {
      console.error(`stage0: ${file} exists and is not the bundle its name says: left as it is`)
      process.exitCode = 1
      return
    }
  } else {
    mkdirSync(dir, { recursive: true })
    writeFileSync(`${file}.${process.pid}`, bytes)
    renameSync(`${file}.${process.pid}`, file)
    writeFileSync(join(dir, 'source.json'), `${JSON.stringify({ ...record, inputs }, null, 2)}\n`)
  }

  writeFileSync(`${PIN_FILE}.${process.pid}`, `${JSON.stringify(record, null, 2)}\n`)
  renameSync(`${PIN_FILE}.${process.pid}`, PIN_FILE)
  console.log(`stage0: pinned ${id}`)
  console.log(`  bundle  ${file} (${bytes.length} bytes, ${inputs.length} sources, ${make.length} under deck/make)`)
  console.log(`  source  HEAD ${head}, deck/make digest ${record.make_digest}`)
}

async function show(): Promise<void> {
  const pinned = readPin()

  if (!pinned) {
    console.log(`stage0: no pin. Pin one: pnpm --dir ${TERM} run stage0:pin`)
    process.exitCode = 1
    return
  }

  const file = stage0Path(pinned.id, 'compile.mjs')
  const installed = existsSync(file) && sha(readFileSync(file)) === pinned.id
  const { bytes } = await bundle()
  const now = sha(bytes)

  console.log(`stage0: pinned ${pinned.id} (${pinned.pinned}, HEAD ${pinned.head})`)
  console.log(`  bundle  ${installed ? 'installed' : 'MISSING'} at ${relative(TERM, file).startsWith('..') ? file : relative(TERM, file)}`)
  console.log(`  working tree ${now === pinned.id ? 'bundles to the pin' : `differs (it would bundle to ${now})`}`)

  if (!installed) {
    process.exitCode = 1
  }
}

const verb = process.argv[2]

if (process.argv[1]?.endsWith('stage0.ts')) {
  if (verb === 'pin') {
    await pin()
  } else if (verb === 'show' || verb === undefined) {
    await show()
  } else {
    console.error('usage: npx tsx task/stage0.ts show|pin')
    process.exitCode = 2
  }
}
