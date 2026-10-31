// The kept corpus of a checker census (decision 096 rule 8 of note/project/term/self-host/change/001-finish-self-host,
// item term-self-host-001-0508). With TERM_CENSUS_KEEP=<dir> set for one `pnpm term:test` run, every Term program a
// suite builds outside the packages (deck/term/deck/term/deck) is copied into <dir>/<hash>/, with `suite.txt` naming
// each suite that built it (task/term/test.ts sets TERM_SUITE per suite while the switch is on). A census of a checker
// change then builds every kept program with the window's compiler (task/term/census-corpus.ts), where a census of the
// packages' `.tree` files never reads the programs written inside test/**/*.ts with `${}` holes the test fills.
//
// Two entries reach it, because no one of them sees every build:
//
//   keepProject   a `term make` run (call/code/output.ts openRun): the project root's `.tree` files from disk
//   keepSources   an in-process `compile()` (make/code/compile/compile.ts): the loaded graph's own texts, which a
//                 test's resolver may have served from memory under a path that is not on disk
//
// Off (TERM_CENSUS_KEEP unset) both answer at once. A program is keyed by the hash of its files' paths and texts, so
// one built by many suites is kept once, its suites listed. Nothing here ever throws into the build it watches.

import { createHash } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

// the packages: deck/term/deck/term/deck, two levels above this file's folder (deck/call/code)
const PACKAGES = resolve(
  dirname(new URL(import.meta.url).pathname),
  '..',
  '..',
)

// past this many files a root is not a test's program (a run from the repository root, a whole package tree)
const MOST_FILES = 400
const SKIP = new Set(['node_modules', 'host', '.base', '.git', 'tmp'])

function keepDir(): string | undefined {
  const dir = process.env.TERM_CENSUS_KEEP

  return dir !== undefined && dir !== '' ? dir : undefined
}

function inPackages(path: string): boolean {
  const from = relative(PACKAGES, resolve(path))

  return from === '' || (!from.startsWith('..') && !isAbsolute(from))
}

// the files of one program, path relative to its root, sorted
type Files = Array<{ path: string; text: string }>

function save(files: Files, origin: string): void {
  const dir = keepDir()

  if (dir === undefined || files.length === 0) {
    return
  }

  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : 1))
  const hash = createHash('sha256')

  for (const file of sorted) {
    hash.update(file.path)
    hash.update('\0')
    hash.update(file.text)
    hash.update('\0')
  }

  const home = join(dir, hash.digest('hex').slice(0, 32))
  const suite = process.env.TERM_SUITE ?? '(no suite)'

  if (!existsSync(home)) {
    for (const file of sorted) {
      const target = join(home, 'tree', file.path)

      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, file.text)
    }

    writeFileSync(join(home, 'origin.txt'), `${origin}\n`)
  }

  const named = join(home, 'suite.txt')
  const already = existsSync(named)
    ? readFileSync(named, 'utf8').split('\n')
    : []

  if (!already.includes(suite)) {
    appendFileSync(named, `${suite}\n`)
  }
}

function treeFiles(root: string): Files | undefined {
  const files: Files = []
  const walk = (dir: string): boolean => {
    for (const name of readdirSync(dir)) {
      if (SKIP.has(name)) {
        continue
      }

      const path = join(dir, name)
      const info = statSync(path)

      if (info.isDirectory()) {
        if (!walk(path)) {
          return false
        }
      } else if (name.endsWith('.tree')) {
        files.push({
          path: relative(root, path).split(sep).join('/'),
          text: readFileSync(path, 'utf8'),
        })

        if (files.length > MOST_FILES) {
          return false
        }
      }
    }

    return true
  }

  return walk(root) ? files : undefined
}

// a `term make` run's project: every `.tree` under its root, when the root lies outside the packages
export function keepProject(root: string, verb: string): void {
  if (keepDir() === undefined || verb !== 'make') {
    return
  }

  try {
    const at = resolve(root)

    if (inPackages(at) || !existsSync(at)) {
      return
    }

    const top = statSync(at).isDirectory() ? at : dirname(at)
    const files = treeFiles(top)

    if (files !== undefined) {
      save(files, `make ${top}`)
    }
  } catch {
    // the census never breaks the build it watches
  }
}

// an in-process build's graph: the entry and every module it loaded, the texts as the build read them, when the
// entry lies outside the packages. Paths are kept relative to the entry's folder, and a module of the packages is
// left out (the census reaches it through the packages, as the build did)
export function keepSources(
  entry: string,
  sources: ReadonlyArray<{ file: string; text: string }>,
): void {
  if (keepDir() === undefined) {
    return
  }

  try {
    if (inPackages(entry)) {
      return
    }

    const top = dirname(resolve(entry))
    const files: Files = []

    for (const source of sources) {
      if (inPackages(source.file) || !source.file.endsWith('.tree')) {
        continue
      }

      const path = relative(top, resolve(source.file)).split(sep).join('/')

      // a module outside the entry's folder is kept under `outside/`, its path from the root of the disk
      files.push({
        path: path.startsWith('..')
          ? `outside${resolve(source.file)}`
          : path,
        text: source.text,
      })
    }

    save(files, `compile ${resolve(entry)}`)
  } catch {
    // the census never breaks the build it watches
  }
}
