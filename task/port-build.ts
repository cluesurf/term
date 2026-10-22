// THE PORT SWITCH, the build half (note/term/self-host/04-the-port-switch.md, self-hosting-0018).
//
// A toolchain module ported to Term lives at `deck/<d>/code/<path>.tree`, and its TypeScript original is DELETED in
// the same change. The TypeScript that still imports `@term/<d>/code/<path>` then resolves through the second
// `paths` candidate in tsconfig.json (`./deck/<d>/host/port/*`) to the module this script writes. tsc, tsx and esbuild all
// read those paths, so nothing else has to know a module moved.
//
// WHY NOT `term make`. `term make` writes a module's TypeScript and nothing else, and a module that docks a native
// shim (`bit`, `clock`) then names a global nobody defines: `declare const bit: any`, and the first call is a
// ReferenceError. `term boot` prepends those shims for an app. A ported toolchain module is a LIBRARY imported by
// TypeScript, so it needs the same prelude written into the module itself, which is what makes it a drop-in. Doing
// that in `term make` would change every package's output, including emitted grammars other projects compile under
// `tsc --strict`, so it lives here, where only the toolchain's own ports go through it.
//
// It runs before the CLI is bundled (`pnpm run make:line`), so `host/line.js` always carries the current ports. A
// module is written only when its content changed.
//
// THE SKIP (term-cli-in-term-0002). Compiling all 321 modules to find them unchanged took 2.5 to 4 minutes of every
// make:line and release. A module is now skipped when its output is provably what a compile would write: the manifest
// at `.base/@term/code/port-build.json` holds, per module, a hash of its text, the COMPILER FINGERPRINT (the content of
// every file the bundle of this script reaches, which is the compiler, the CLI modules it calls and the ported modules
// it is built from, plus the lockfile, the Node version and the TERM_ / SEED_ environment), every observation the
// process had made of the disk by the end of its compile (task/port-trace.ts: each read's content hash, each existence,
// stat and directory listing), and its output's hash. A module is skipped only when all of them still hold and its
// output on disk is that output. Anything missing, unreadable or untrackable compiles. `--full` compiles everything.
//
//   npx tsx task/port-build.ts            build every port, report what changed
//   npx tsx task/port-build.ts --check    write nothing, exit 1 if any port's output is missing or stale
//   npx tsx task/port-build.ts --only dev/hmr    only the ports whose path holds the text, for a fast port loop
//   npx tsx task/port-build.ts --progress        also `progress <done> <total>` on stderr per module (task/release.ts)
//   npx tsx task/port-build.ts --full     compile every module, skipping none (the skip's own proof compares against it)
//   npx tsx task/port-build.ts --explain  also `  skip  <path>` for each module skipped
//
// The skip's proof: test/call/port-build-skip.ts (a copy of the tree, edits to a port, a stdlib file and the compiler,
// each skip run byte-identical to a --full run).

// FIRST, before the compiler loads: the trace must see every read a compiler module makes, including while it loads
import { observations, observationCount, observe, real, setRecording, sha, untraced, UNTRACKABLE } from './port-trace'
import traced, { writeSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, relative } from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { nativePrelude } from '@term/make/code/compile/native'
import { projectResolver } from '@term/call/code/make'
import { projectLeanOf } from '@term/call/code/role-of'
import { projectHome } from '@term/call/code/home'

const { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } = real

// run from the Term package root, the way every script under task/ is
const TERM = process.cwd()

// the toolchain LIBRARIES whose ports TypeScript imports, each with the code subtrees it ports. Of `@term/call`,
// `code/browser` is the browser compiler's in-memory disk, and `code/work/item` is a library, the terminal output standard every command prints through (note/project/term/output/): the
// rest of its .tree is the console (`line/base.tree`) and its verbs, which `term boot` builds as a program and
// nothing imports as a library.
const DECKS: Record<string, string[]> = {
  make: ['code'],
  deck: ['code'],
  flow: ['code'],
  scan: ['code'],
  test: ['code'],
  call: ['code/work/item', 'code/browser', 'code/*'],
}

// a subtree written `<dir>/*` takes the .tree files directly in that directory and none below it: `@term/call`'s own
// modules ported to Term sit in `code/` beside their TypeScript faces, where `code/line` and `code/work` hold the console
function shallow(dir: string, out: string[]): void {
  if (!existsSync(dir) || existsSync(join(dir, 'draft.tree'))) {
    return
  }

  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name)

    if (name.endsWith('.tree') && name !== 'draft.tree' && !lstatSync(full).isSymbolicLink() && lstatSync(full).isFile()) {
      out.push(full)
    }
  }
}

const check = process.argv.includes('--check')
const onlyAt = process.argv.indexOf('--only')
const only = onlyAt >= 0 ? process.argv[onlyAt + 1] : undefined

const SKIP = new Set(['node_modules', 'host', '.base', 'tmp', 'link', 'target', '.build'])

function trees(dir: string, out: string[]): void {
  if (!existsSync(dir) || existsSync(join(dir, 'draft.tree'))) {
    return
  }

  for (const name of readdirSync(dir).sort()) {
    if (SKIP.has(name) || name.endsWith('-cache')) {
      continue
    }

    const full = join(dir, name)
    const stat = lstatSync(full)

    if (stat.isSymbolicLink()) {
      continue
    }

    if (stat.isDirectory()) {
      trees(full, out)
    } else if (name.endsWith('.tree') && name !== 'draft.tree') {
      out.push(full)
    }
  }
}

// `--progress`: a `progress <done> <total>` line on STDERR after each module, for a caller that shows the step live
// (task/release.ts). Stderr, so the stdout this script has always printed, and the summary line make:port and the
// release read off it, stay as they were. It cannot print through the output library: it builds the ports that library
// is made of
const showProgress = process.argv.includes('--progress')
const full = process.argv.includes('--full')
// `--explain`: a `  skip  <path>` line per module skipped, which test/call/port-build-skip.ts reads
const explain = process.argv.includes('--explain')

// raised whenever what a manifest entry means changes, so an older manifest is read as no manifest
const SCHEMA = 1

// one module's last good build. `reads` are ranges [from, to) of rows of the manifest's `table`, each row an
// observation `[op\0path, what it saw]`: every observation the building process had made by the end of this compile
type Entry = { text: string; fingerprint: string; out: string; reads: [number, number][] }
type Manifest = { schema: number; table: [string, string][]; modules: Record<string, Entry> }

function readManifest(path: string): Manifest | undefined {
  try {
    const manifest = JSON.parse(untraced(() => readFileSync(path, 'utf8'))) as Manifest

    if (manifest.schema !== SCHEMA || !Array.isArray(manifest.table) || typeof manifest.modules !== 'object') {
      return undefined
    }

    return manifest
  } catch {
    return undefined
  }
}

// THE COMPILER, as content: every file esbuild's bundle of this script reaches through tsconfig.json's paths (the
// compiler, the CLI modules it calls, the ported modules it is built from, and this script with its prelude splice),
// which is the code tsx runs here, since make:line bundles the same graph the same way. Beside it the nearest lockfile
// (the packages left external), the tsconfig, Node, and every TERM_ / SEED_ / NODE_ variable. Undefined when any of it
// cannot be read, and then nothing is skipped
async function fingerprint(): Promise<string | undefined> {
  try {
    const { build } = await import('esbuild')
    const result = await build({
      entryPoints: [join(TERM, 'task', 'port-build.ts')],
      absWorkingDir: TERM,
      bundle: true,
      platform: 'node',
      format: 'esm',
      packages: 'external',
      tsconfig: join(TERM, 'tsconfig.json'),
      metafile: true,
      write: false,
      logLevel: 'silent',
    })
    const hash = createHash('sha256')

    hash.update(`schema ${SCHEMA}\nnode ${process.version} ${process.platform} ${process.arch}\n`)

    for (const name of Object.keys(process.env).sort()) {
      if (/^(TERM|SEED|NODE)_/.test(name)) {
        hash.update(`env ${name}=${process.env[name]}\n`)
      }
    }

    let lock: string | undefined

    for (let dir = TERM; ; dir = dirname(dir)) {
      if (existsSync(join(dir, 'pnpm-lock.yaml'))) {
        lock = join(dir, 'pnpm-lock.yaml')
        break
      }

      if (dirname(dir) === dir) {
        break
      }
    }

    const files = [...Object.keys(result.metafile.inputs).map(input => join(TERM, input)), join(TERM, 'tsconfig.json')]

    if (lock) {
      files.push(lock)
    }

    for (const file of files.sort()) {
      hash.update(`file ${file} ${sha(readFileSync(file))}\n`)
    }

    return hash.digest('hex')
  } catch {
    return undefined
  }
}

// sorted indexes as [from, to) ranges
function ranges(indexes: number[]): [number, number][] {
  const out: [number, number][] = []

  for (const index of [...indexes].sort((a, b) => a - b)) {
    const last = out[out.length - 1]

    if (last && last[1] === index) {
      last[1] = index + 1
    } else if (!last || last[1] < index) {
      out.push([index, index + 1])
    }
  }

  return out
}

async function main(): Promise<void> {
  let built = 0
  let unchanged = 0
  let stale = 0
  let failed = 0

  // port-build's own bookkeeping is no part of any module's trace. `settle` in home.ts reaches `fs` itself
  setRecording(false)
  const manifestPath = projectHome(TERM, 'port-build.json')
  const print = await fingerprint()
  const old = full || print === undefined ? undefined : readManifest(manifestPath)
  setRecording(true)

  // whether a row of the old manifest's table still sees what it saw, checked at most once a run
  const holds = new Map<number, boolean>()
  const stillHolds = (row: number): boolean => {
    let answer = holds.get(row)

    if (answer === undefined) {
      const entry = old!.table[row]

      if (!entry || entry[0] === UNTRACKABLE) {
        answer = false
      } else {
        const cut = entry[0].indexOf('\0')
        answer = observe(entry[0].slice(0, cut), entry[0].slice(cut + 1)) === entry[1]
      }

      holds.set(row, answer)
    }

    return answer
  }

  // the entries written this run, keyed by the module's path under the package; `reads` index THIS process's
  // observations. And those carried from the old manifest, whose `reads` still index its table
  const fresh: Record<string, Entry> = {}
  const carried: Record<string, Entry> = {}

  // every module first, so the progress has its total before the first one compiles
  const plan: { root: string; files: { file: string; text: string }[] }[] = []
  const every = new Set<string>()

  for (const [deck, subtrees] of Object.entries(DECKS)) {
    const root = join(TERM, 'deck', deck)
    const files: string[] = []

    for (const subtree of subtrees) {
      if (subtree.endsWith('/*')) {
        shallow(join(root, subtree.slice(0, -2)), files)
      } else {
        trees(join(root, subtree), files)
      }
    }

    const chosen: { file: string; text: string }[] = []

    for (const file of files) {
      const text = untraced(() => readFileSync(file, 'utf8'))

      // `mark draft` (or the old `note draft`) shelves a file out of every build, this one included, and out of the
      // progress total, which counts what is compiled or skipped
      if (/^(mark|note) draft\s*$/m.test(text.slice(0, 2000))) {
        continue
      }

      every.add(relative(TERM, file))

      if (only === undefined || relative(TERM, file).includes(only)) {
        chosen.push({ file, text })
      }
    }

    if (chosen.length > 0) {
      plan.push({ root, files: chosen })
    }
  }

  const total = plan.reduce((sum, one) => sum + one.files.length, 0)
  let done = 0
  // written at once with writeSync: the loop below is synchronous, and a `process.stderr.write` to a pipe may wait in
  // node's buffer until it ends, which is the silence this exists to fill
  const tell = (): void => {
    if (!showProgress) {
      return
    }

    const bytes = Buffer.from(`progress ${done} ${total}\n`)
    let at = 0

    while (at < bytes.length) {
      try {
        at += writeSync(2, bytes, at)
      } catch (error) {
        if ((error as { code?: string }).code !== 'EAGAIN') {
          throw error
        }
      }
    }
  }

  for (const { root, files } of plan) {
    const resolve = projectResolver(root)
    const leanOf = projectLeanOf(root)

    for (const { file, text } of files) {
      // the modules finished before this one, told as it starts: every way out of the turn below is a `continue`
      tell()
      done++

      const name = relative(TERM, file)
      const textHash = sha(text)
      // under `host/port/`, never `host/` itself: `term make` writes `host/<path>.ts` WITHOUT the prelude, and two
      // writers on one path left whichever ran last (found the same hour: the port worked, then a `term make` of
      // the compiler package overwrote it and the next import threw `bit is not defined`)
      const outPath = join(root, 'host', 'port', relative(root, file).replace(/\.tree$/, '.ts'))

      // THE SKIP: the same compiler, the same text, every observation the compile that wrote it made still seeing
      // the same thing, and that output on disk now
      const last = old?.modules[name]

      if (
        last &&
        last.fingerprint === print &&
        last.text === textHash &&
        last.reads.every(([from, to]) => {
          for (let row = from; row < to; row++) {
            if (!stillHolds(row)) {
              return false
            }
          }

          return true
        }) &&
        untraced(() => existsSync(outPath) && sha(readFileSync(outPath)) === last.out)
      ) {
        carried[name] = last
        unchanged++

        if (explain) {
          console.log(`  skip  ${name}`)
        }

        continue
      }

      // a port is a LIBRARY its TypeScript callers build values for: no case is tested by identity
      const result = compile({ file, text }, { resolve, leanOf, library: true })

      if (!result.ok) {
        failed++
        console.log(`  FAIL  ${name}`)

        for (const d of result.diagnostics.slice(0, 3)) {
          console.log(`        ${d.name}: ${d.message}`)
        }

        continue
      }

      // through the TRACED `fs`: what the prelude reads is an input of the output like any file the compile read
      const prelude = nativePrelude(result.program, 'node', path =>
        traced.existsSync(path) ? traced.readFileSync(path, 'utf8') : undefined,
      )
      // the emitted module declares each native global it calls (`declare const bit: any`) so it typechecks WITHOUT the
      // prelude, and the prelude defines it (`const bit = {...}`). Both in one file is TS2451 "Cannot redeclare", which
      // `tsc` reported on every port that docks a native until 2026-10-04, so the declaration of a name the prelude
      // defines is dropped
      const defined = new Set([...(prelude ?? '').matchAll(/^const ([A-Za-z_$][\w$]*) =/gm)].map(match => match[1]!))
      const body = result.typescript
        .split('\n')
        .filter(line => {
          const declared = /^declare const ([A-Za-z_$][\w$]*)\s*:/.exec(line)

          return !declared || !defined.has(declared[1]!)
        })
        .join('\n')
      const content = `${prelude ? `${prelude}\n` : ''}${body}`
      // the key of this output: every observation this process has made so far, since a compiler may cache across
      // the modules of one run, so this output can rest on a file an earlier module's compile read
      const entry: Entry | undefined =
        print === undefined
          ? undefined
          : { text: textHash, fingerprint: print, out: sha(content), reads: [[0, observationCount()]] }
      const existing = untraced(() => (existsSync(outPath) ? readFileSync(outPath, 'utf8') : undefined))

      if (existing === content) {
        if (entry) {
          fresh[name] = entry
        }

        unchanged++
        continue
      }

      if (check) {
        stale++
        console.log(`  STALE ${name}`)
        continue
      }

      untraced(() => {
        mkdirSync(join(outPath, '..'), { recursive: true })
        writeFileSync(outPath, content)
      })

      if (entry) {
        fresh[name] = entry
      }

      built++
      console.log(`  built ${relative(TERM, outPath)}`)
    }
  }

  tell()

  // the manifest: this run's observations first, so a fresh entry's ranges index them as they are, then each row a
  // carried entry needs. A carried entry, or an old one this run did not reach (`--only`), whose row now disagrees with
  // what this run saw (a file changed while it ran) is dropped, and compiles next time
  if (!check && print !== undefined) {
    setRecording(false)

    const table = observations()
    const at = new Map(table.map(([key], index) => [key, index]))
    const modules: Record<string, Entry> = { ...fresh }
    const reached = new Set([...plan.flatMap(one => one.files.map(({ file }) => relative(TERM, file)))])
    const keep: Record<string, Entry> = { ...carried }

    for (const [name, entry] of Object.entries(old?.modules ?? {})) {
      if (!reached.has(name) && every.has(name)) {
        keep[name] = entry
      }
    }

    for (const [name, entry] of Object.entries(keep)) {
      const rows: number[] = []
      let agrees = true

      for (const [from, to] of entry.reads) {
        for (let row = from; row < to && agrees; row++) {
          const seen = old!.table[row]

          if (!seen) {
            agrees = false
            break
          }

          let index = at.get(seen[0])

          if (index === undefined) {
            index = table.length
            table.push(seen)
            at.set(seen[0], index)
          } else if (table[index]![1] !== seen[1]) {
            agrees = false
          }

          rows.push(index)
        }
      }

      if (agrees) {
        modules[name] = { ...entry, reads: ranges(rows) }
      }
    }

    try {
      const manifest: Manifest = { schema: SCHEMA, table, modules }
      const temporary = `${manifestPath}.${process.pid}`

      untraced(() => {
        mkdirSync(dirname(manifestPath), { recursive: true })
        writeFileSync(temporary, JSON.stringify(manifest))
        real.renameSync(temporary, manifestPath)
      })
    } catch {
      // a manifest that cannot be written only means the next run compiles more
    }
  }

  console.log(
    `term port-build: ${built} built, ${unchanged} unchanged${check ? `, ${stale} stale` : ''}, ${failed} failed`,
  )

  if (failed > 0 || stale > 0) {
    process.exitCode = 1
  }
}

await main()
