// STAGE0, THE FROZEN COMPILER make:port builds with (term-self-host-001-0018, decision 036 of
// note/project/term/self-host/change/001-finish-self-host/decision/).
//
// task/port-build.ts compiles every port with stage0, never with the working tree's compiler, so an edit to a
// compiler `.tree` rebuilds only the ports whose own text or imports changed, and a half-edited compiler cannot break
// the build that would rebuild it (traps.md T033). Stage0 is one esbuild bundle of the compile closure port-build
// calls (STAGE0_SOURCES below), taken from the working tree when it is PINNED and never again: a compiler edit never
// changes it. It is stored under the user home, `~/.base/@term/code/stage0/<id>/compile.mjs`, beside `source.json`
// (the HEAD commit the working tree sat on, a digest of its deck/make sources and of every bundled source). Its id is
// the sha256 of the bundle's bytes, since the working tree has edits no commit names, and port-build's compiler
// fingerprint is that same id. `task/stage0.json` names the pinned id.
//
//   npx tsx task/stage0.ts show     the pin, whether its bundle is installed, whether the working tree's compile
//                                   closure would bundle to it, and each name STAGE0_SOURCES lists with whether the
//                                   installed bundle exports it (exit 1 when the pinned bundle is missing or lacks one)
//   npx tsx task/stage0.ts pin      bundle the working tree's compile closure and pin it (the explicit re-pin, the one
//                                   thing that changes stage0). Every port compiles once more on the next make:port
//
// Every npm package is bundled in: the bundle lives under the user home, where no node_modules resolves. A `require` a
// bundled CommonJS package makes of a node builtin goes through the createRequire the banner defines.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { userHome } from '@term/call/code/home'

// run from the Term package root, the way every script under task/ is
const TERM = process.cwd()

export const PIN_FILE = join(TERM, 'task', 'stage0.json')

// what port-build loads from stage0. `--stage-check` loads the same specifiers from the working tree, from
// task/port-build.ts, so a specifier of this folder is written relative to task/ (bundle() resolves from there too).
// projectResolver is the port's (task/stage0-resolver.ts), never call/code/make.ts: that driver's closure carried
// deck/make's analyze.ts and compile/feed-mill.ts into the shipped stage0, outside decision 127's list (item 1026)
//
// THE UNIT ENGINE (spec-1339-separate-ports.md section 3, item 1341): port-build compiles each port entry through
// `term make`'s separate build (decision 162), so stage0 also carries compileSeparate, the CompileCache with the
// machine store's disk store and its home, the deck and role readers the engine is handed, and make-plan's unit slug
// and entry shim text with the Pascal spelling the shim's types take. None comes from call/code/make.ts: its unitSlug
// and entryShim are thin spellings over make-plan's two tasks, and port-build spells its own (it writes host/unit/,
// never make.ts's host/.unit/)
export const STAGE0_SOURCES: Record<string, string[]> = {
  '@term/make/code/compile/compile': ['compile'],
  '@term/make/code/compile/load': ['collectModules', 'makeParseMemo'],
  '@term/make/code/compile/native': ['nativePrelude'],
  './stage0-resolver': ['projectResolver'],
  '@term/call/code/role-of': ['projectLeanOf', 'projectRoleOf'],
  '@term/make/code/compile/typescript': ['toCamel', 'toPascal'],
  '@term/make/code/compile/separate': ['compileSeparate'],
  '@term/make/code/compile/cache': ['CompileCache'],
  '@term/call/code/cache-store': ['diskCacheStore', 'cacheHome'],
  '@term/call/code/deck-of': ['projectDeckOf'],
  '@term/call/code/make-plan': ['unitSlugOf', 'entryShimText'],
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

// the bundle of the working tree's compile closure, and the sources it was made from. task/release.ts ships these same
// bytes in every platform's payload as term/host/compile.mjs (decision 126), so a release is a stage0 term:boot fetches
export async function bundle(root: string = TERM): Promise<{ bytes: Buffer; inputs: string[] }> {
  const { build } = await import('esbuild')
  const contents = Object.entries(STAGE0_SOURCES)
    .map(([from, names]) => `export { ${names.join(', ')} } from '${from}'`)
    .join('\n')
  const result = await build({
    // from task/, where STAGE0_SOURCES' relative specifiers point. The `@term/*` ones go through tsconfig's paths
    stdin: { contents, resolveDir: join(root, 'task'), sourcefile: 'stage0-entry.ts', loader: 'ts' },
    absWorkingDir: root,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    tsconfig: join(root, 'tsconfig.json'),
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
      // the stdin entry is named from resolveDir, so task/stage0-entry.ts since 1026 (item 1040): it is no file
      .filter(input => input !== 'stage0-entry.ts' && input !== 'task/stage0-entry.ts' && !input.startsWith('<'))
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
    return
  }

  // each name port-build loads, and whether the installed bundle exports it: a pin made before a name joined
  // STAGE0_SOURCES lacks it, and port-build would read it as undefined
  const loaded = (await import(pathToFileURL(file).href)) as Record<string, unknown>
  let lacking = 0

  for (const [from, names] of Object.entries(STAGE0_SOURCES)) {
    const marked = names.map(name => {
      if (typeof loaded[name] === 'function') {
        return name
      }

      lacking++
      return `${name} (NOT EXPORTED)`
    })

    console.log(`  exports ${marked.join(', ')}  from ${from}`)
  }

  if (lacking > 0) {
    console.log(`  the pinned bundle lacks ${lacking} name(s) STAGE0_SOURCES lists: pin again`)
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
