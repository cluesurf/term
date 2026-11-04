// The `pnpm term:test` result cache: a suite whose inputs have not changed since it last passed is not run again.
//
// WHY. The gate is ~150 suites and took over half an hour of wall clock on 2026-10-02, most of it re-proving what
// nothing had touched. A suite is a function of what it reads, so a suite that reads the same bytes answers the same
// way. This file decides "the same bytes" from three sources, because no one of them sees everything:
//
//   1. what each Node process the suite started actually read (task/term/gate/track.cjs, preloaded into all of them):
//      file contents as hashed AT READ TIME, directories listed, and paths found absent
//   2. the TypeScript the suite script imports, from esbuild's metafile, because tsx loads modules on a loader
//      thread the tracker cannot reach
//   3. for a suite that ran a non-Node program (rustc, swiftc, kotlinc, cargo, java), every native runtime file in
//      the tree and the toolchain's version, because those programs read files no Node process opened
//
// plus, for every suite, the lockfiles (node_modules is not hashed file by file) and the gate's own code.
//
// The direction of every doubt is to RUN: a suite with no record, a record from a different key, an input that
// cannot be read, or a tracker that failed to write, is run. A cached pass prints `cached` so it is never mistaken
// for a run. `--fresh` runs everything. A failure is never cached.
//
// Stored under .base/@term/code/gate/, one JSON file per suite, rebuildable by running.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'

export type Recorded = {
  // path (relative to the repository root) -> sha1 of its bytes, or `absent`
  file: Record<string, string>
  // directory (relative) -> sha1 of its sorted entry names
  list: Record<string, string>
  // non-Node programs the suite ran
  spawned: string[]
}

export type Entry = {
  key: string
  recorded: Recorded
  pass: number
  note: string
  seconds: number
  at: string
}

// programs whose reads the tracker cannot see. Running one pulls in the native runtime trees and its version
const NATIVE = ['rustc', 'cargo', 'swiftc', 'swift', 'kotlinc', 'java', 'xcrun', 'xcodebuild', 'hvm', 'clang', 'cc']

export function sha1(bytes: Buffer | string): string {
  return createHash('sha1').update(bytes).digest('hex')
}

export function makeCache(root: string, term: string) {
  const dir = join(term, '.base/@term/code/gate')
  const tracker = join(root, 'task/term/gate/track.cjs')
  const temp = [tmpdir(), '/tmp', '/private/tmp', '/private/var/folders', '/var/folders'].map(p => resolve(p))
  const fileHashes = new Map<string, string>()

  mkdirSync(dir, { recursive: true })

  // an input is a path inside the repository that is not a cache, a build scratch area, or an installed package
  // (those are covered by the lockfiles). Everything outside the repository is a toolchain or the system, which the
  // versions stand for, or a user-level cache.
  const isInput = (absolute: string): boolean => {
    if (temp.some(p => absolute.startsWith(p + sep))) {
      return false
    }

    if (!absolute.startsWith(root + sep)) {
      return false
    }

    return !/[\\/](node_modules|\.base|\.git|tmp)[\\/]|[\\/][^\\/]*-cache[\\/]/.test(absolute)
  }

  const hashFile = (absolute: string): string => {
    const known = fileHashes.get(absolute)

    if (known !== undefined) {
      return known
    }

    let hash: string

    try {
      const stat = statSync(absolute, { throwIfNoEntry: false })

      hash = !stat ? 'absent' : stat.isDirectory() ? 'directory' : sha1(readFileSync(absolute))
    } catch {
      hash = 'unreadable'
    }

    fileHashes.set(absolute, hash)

    return hash
  }

  const hashList = (absolute: string): string => {
    try {
      return sha1(readdirSync(absolute).sort().join('\n'))
    } catch {
      return 'absent'
    }
  }

  // the gate's own code and the dependency set: a change to either reruns everything. NOT task/term/test.ts, the
  // suite list: editing one suite's timeout must not rerun the other three hundred. A suite run by a function
  // written IN test.ts (a custom `run`) carries test.ts in its own key instead, because that code is its runner
  const runnerHash = sha1(readFileSync(join(root, 'task/term/test.ts')))
  const salt = sha1(
    [
      readFileSync(join(root, 'task/term/gate/cache.ts')),
      readFileSync(tracker),
      ...[join(root, 'pnpm-lock.yaml'), join(term, 'pnpm-lock.yaml')].map(f => (existsSync(f) ? readFileSync(f) : '')),
      process.version,
    ].join('\0'),
  )

  // every native runtime file in the tree, hashed once per run, for a suite that ran a native toolchain
  let nativeTree: Record<string, string> | undefined

  const nativeFiles = (): Record<string, string> => {
    if (nativeTree) {
      return nativeTree
    }

    nativeTree = {}

    const walk = (at: string, inside: boolean): void => {
      let entries: { name: string; isDirectory: () => boolean }[]

      try {
        entries = readdirSync(at, { withFileTypes: true })
      } catch {
        return
      }

      for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name === 'host' || entry.name === '.base' || entry.name === 'tmp' || entry.name.endsWith('-cache')) {
          continue
        }

        const path = join(at, entry.name)
        const native = inside || entry.name === 'native'

        if (entry.isDirectory()) {
          walk(path, native)
        } else if (native) {
          nativeTree![relative(root, path)] = hashFile(path)
        }
      }
    }

    walk(join(term, 'deck'), false)
    walk(join(term, 'test/native'), true)

    return nativeTree
  }

  const versions = new Map<string, string>()

  const versionOf = (tool: string): string => {
    const known = versions.get(tool)

    if (known !== undefined) {
      return known
    }

    let text: string

    try {
      text = execFileSync(tool, [tool === 'kotlinc' || tool === 'java' ? '-version' : '--version'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
        timeout: 60_000,
      })
    } catch (error) {
      // kotlinc and java print the version on stderr and some exit non-zero
      const e = error as { stdout?: string; stderr?: string }
      text = `${e.stdout ?? ''}${e.stderr ?? ''}`
    }

    const version = sha1(text.trim())
    versions.set(tool, version)

    return version
  }

  // the TypeScript a suite script imports: esbuild's metafile, packages left external (the lockfiles cover them)
  const require = createRequire(join(term, 'package.json'))
  const esbuild = require('esbuild') as typeof import('esbuild')
  const closures = new Map<string, string[]>()

  const closure = (script: string): string[] => {
    const known = closures.get(script)

    if (known) {
      return known
    }

    let files: string[]

    try {
      const built = esbuild.buildSync({
        entryPoints: [script],
        absWorkingDir: term,
        bundle: true,
        write: false,
        metafile: true,
        platform: 'node',
        format: 'esm',
        packages: 'external',
        // the root's paths for EVERY file: one under a package with a tsconfig of its own (deck/flow) otherwise leaves
        // its `@term/*` imports external, and what they reach drops out of the key
        tsconfig: 'tsconfig.json',
        logLevel: 'silent',
        // a `.tree` or text file pulled in by an import is still an input, read as text
        loader: { '.tree': 'text', '.md': 'text', '.txt': 'text', '.sql': 'text', '.html': 'text', '.css': 'text', '.wasm': 'binary', '.node': 'empty' },
      })

      files = Object.keys(built.metafile!.inputs).map(p => resolve(term, p.replace(/^[a-z-]+:/, '')))
    } catch {
      // a script esbuild cannot follow is never cached: its imports are unknown
      files = []
      closures.set(script, files)

      return ['\0unknown']
    }

    closures.set(script, files)

    return files
  }

  const keyOf = (suite: { name: string; file?: string; env?: Record<string, string>; sources?: string[]; run?: unknown }): string =>
    sha1(
      JSON.stringify({
        salt,
        name: suite.name,
        file: suite.file,
        env: suite.env ?? {},
        sources: suite.sources ?? [],
        runner: suite.run ? runnerHash : '',
      }),
    )

  const fileFor = (name: string): string => join(dir, `${sha1(name).slice(0, 16)}.json`)

  // is the suite's last pass still the answer? Every input must hash the same as when it ran
  const lookup = (suite: { name: string; file?: string; env?: Record<string, string>; sources?: string[] }): Entry | undefined => {
    const at = fileFor(suite.name)

    if (!existsSync(at)) {
      return undefined
    }

    let entry: Entry

    try {
      entry = JSON.parse(readFileSync(at, 'utf8')) as Entry
    } catch {
      return undefined
    }

    if (entry.key !== keyOf(suite)) {
      return undefined
    }

    for (const [path, hash] of Object.entries(entry.recorded.file)) {
      const current = path.startsWith('\0toolchain/')
        ? versionOf(path.slice('\0toolchain/'.length))
        : hashFile(join(root, path))

      if (current !== hash) {
        return undefined
      }
    }

    for (const [path, hash] of Object.entries(entry.recorded.list)) {
      if (hashList(join(root, path)) !== hash) {
        return undefined
      }
    }

    return entry
  }

  // a fresh tracking directory for one suite run
  const trackDir = (name: string): string => {
    const at = join(tmpdir(), `term-gate-${sha1(name).slice(0, 12)}-${process.pid}`)

    // a folder an earlier run's child still writes into is reused rather than ending this run (see `store`)
    try {
      rmSync(at, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch {
      // reused as it is
    }

    mkdirSync(at, { recursive: true })

    return at
  }

  // the environment a tracked suite runs under. The suite's own NODE_OPTIONS (a heap cap, `--expose-gc`) are KEPT
  // and the tracker added to them: replacing them took `parser-stream-memory`'s 32 MB cap away and failed it
  const trackEnv = (at: string, own: Record<string, string> = {}): Record<string, string> => ({
    TERM_GATE_TRACK: at,
    NODE_OPTIONS: `${own.NODE_OPTIONS ?? process.env.NODE_OPTIONS ?? ''} --require ${tracker}`.trim(),
  })

  // read what the suite's processes recorded, add its import closure and native inputs, and store the pass.
  // Answers why when the record cannot be trusted, and stores nothing then.
  const store = (
    suite: { name: string; file?: string; env?: Record<string, string>; sources?: string[] },
    at: string,
    result: { pass: number; note: string; seconds: number },
  ): { ok: true } | { ok: false; reason: string } => {
    const recorded: Recorded = { file: {}, list: {}, spawned: [] }
    const spawned = new Set<string>()
    const entries = new Set<string>()
    let processes = 0

    let names: string[]

    try {
      names = readdirSync(at)
    } catch {
      return { ok: false, reason: 'no tracking record' }
    }

    // the lines of every process, and the files the suite WROTE: a file a suite writes is its output, not an input,
    // even when it reads it back (a build reading its own emitted module, a test re-reading what it just wrote)
    const lines: string[][] = []
    const written = new Set<string>()

    for (const name of names) {
      for (const line of readFileSync(join(at, name), 'utf8').split('\n')) {
        const parts = line.split('\t')

        if (parts[0] === 'w' && parts[1] !== undefined) {
          written.add(parts[1])
        }

        lines.push(parts)
      }
    }

    for (const [kind, path, hash] of lines) {
      if (!kind || path === undefined) {
        continue
      }

      if (kind === 'b') {
        processes++
        continue
      }

      if (kind === 's') {
        spawned.add(path)
        continue
      }

      if (kind === 'e') {
        if (isInput(path)) {
          entries.add(path)
        }

        continue
      }

      // an output of the suite, or outside the repository's inputs
      if (kind === 'w' || written.has(path) || !isInput(path)) {
        continue
      }

      const rel = relative(root, path)

      if (kind === 'h') {
        // two different contents read from one path in one run: the suite saw a moving target, so do not cache
        if (recorded.file[rel] !== undefined && recorded.file[rel] !== hash) {
          return { ok: false, reason: `${rel} changed while the suite ran` }
        }

        recorded.file[rel] = hash!
      } else if (kind === 'r' || kind === 'a') {
        if (recorded.file[rel] === undefined) {
          recorded.file[rel] = hashFile(path)
        }
      } else if (kind === 'l') {
        recorded.list[rel] = hashList(path)
      }
    }

    // a custom runner that started no tracked process recorded nothing, which proves nothing
    if (processes === 0) {
      return { ok: false, reason: 'no Node process was tracked' }
    }

    for (const script of [
      ...(suite.file ? [join(term, suite.file)] : []),
      ...(suite.sources ?? []).map(s => join(root, s)),
      ...entries,
    ]) {
      const files = closure(script)

      if (files[0] === '\0unknown') {
        return { ok: false, reason: `esbuild cannot follow the imports of ${relative(root, script)}` }
      }

      for (const file of files) {
        if (isInput(file)) {
          recorded.file[relative(root, file)] = hashFile(file)
        }
      }
    }

    const native = [...spawned].filter(tool => NATIVE.includes(tool))

    if (native.length > 0) {
      Object.assign(recorded.file, nativeFiles())

      for (const tool of native) {
        recorded.file[`\0toolchain/${tool}`] = versionOf(tool)
      }
    }

    recorded.spawned = [...spawned].sort()

    const entry: Entry = {
      key: keyOf(suite),
      recorded,
      pass: result.pass,
      note: result.note,
      seconds: result.seconds,
      at: new Date().toISOString(),
    }

    writeFileSync(fileFor(suite.name), JSON.stringify(entry))

    // the suite's scratch folder, retried and then left: a child the suite started can still be writing into it, and
    // `ENOTEMPTY` here ended the whole run after 345 suites had passed, before its summary (2026-10-05). The record is
    // written above, so a folder left behind costs disk and nothing else
    try {
      rmSync(at, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch {
      // left for the system's temporary folder to clear
    }

    return { ok: true }
  }

  // seconds each suite took the last time it RAN (passed or not), so the pool starts the longest first by
  // measurement rather than by a hand-written guess
  const timingFile = join(dir, 'seconds.json')
  let timings: Record<string, number> = {}

  try {
    timings = JSON.parse(readFileSync(timingFile, 'utf8')) as Record<string, number>
  } catch {
    timings = {}
  }

  return {
    lookup,
    store,
    trackDir,
    trackEnv,
    forget: (name: string): void => rmSync(fileFor(name), { force: true }),
    lastSeconds: (name: string): number | undefined => timings[name],
    noteSeconds: (name: string, seconds: number): void => {
      timings[name] = seconds
    },
    saveSeconds: (): void => writeFileSync(timingFile, JSON.stringify(timings, null, 2)),
  }
}
