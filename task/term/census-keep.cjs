// The kept corpus of a checker census (decision 096 rule 8 of note/project/term/self-host/change/001-finish-self-host,
// item term-self-host-001-0508). Preloaded (`node --require`) into every Node process of a `pnpm term:test` run that
// has TERM_CENSUS_KEEP=<dir> set (task/term/test.ts adds it to NODE_OPTIONS and sets TERM_SUITE per suite). Two
// entries, because no one of them sees every build:
//
//   a `term` command   a process started as `node .../host/line.js make|run|test|check|hold`: its project's `.tree`
//                      files from disk, read from its own command line when it starts (`command` below)
//   sources(entry, list)   an in-process `compile()`, which make/code/compile/compile.ts hands the loaded graph's own
//                      texts through `globalThis.termCensusKeep`, since a test's resolver may serve them from memory
//                      under a path that is not on disk
//
// Each program outside the packages (deck) is copied into <dir>/<hash>/tree/, with origin.txt
// (how it was built) and suite.txt (each suite that built it). The hash is of its files' paths and texts, so a program
// many suites build is kept once. task/term/census-corpus.ts builds every kept program with a given compiler. Nothing
// here ever throws into the build it watches. With TERM_CENSUS_KEEP unset this file defines nothing.

'use strict'

const { createHash } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const KEEP = process.env.TERM_CENSUS_KEEP
const PACKAGES = path.resolve((process.env.TERM_ROOT || require('node:path').resolve(__dirname, '../..')), 'deck')
// past this many files a root is not a test's program (a run from the repository root, a whole package tree)
const MOST_FILES = 400
const SKIP = new Set(['node_modules', 'host', '.base', '.git'])

function inPackages(file) {
  const from = path.relative(PACKAGES, path.resolve(file))

  return from === '' || (!from.startsWith('..') && !path.isAbsolute(from))
}

function save(files, origin) {
  if (files.length === 0) {
    return
  }

  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const hash = createHash('sha256')

  for (const file of sorted) {
    hash.update(`${file.path}\0${file.text}\0`)
  }

  const home = path.join(KEEP, hash.digest('hex').slice(0, 32))
  const suite = process.env.TERM_SUITE || '(no suite)'

  if (!fs.existsSync(path.join(home, 'origin.txt'))) {
    for (const file of sorted) {
      const target = path.join(home, 'tree', file.path)

      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, file.text)
    }

    fs.writeFileSync(path.join(home, 'origin.txt'), `${origin}\n`)
  }

  const named = path.join(home, 'suite.txt')
  const already = fs.existsSync(named) ? fs.readFileSync(named, 'utf8').split('\n') : []

  if (!already.includes(suite)) {
    fs.appendFileSync(named, `${suite}\n`)
  }
}

function treeFiles(root) {
  const files = []
  const walk = dir => {
    for (const name of fs.readdirSync(dir)) {
      if (SKIP.has(name)) {
        continue
      }

      const full = path.join(dir, name)
      const info = fs.statSync(full)

      if (info.isDirectory()) {
        if (!walk(full)) {
          return false
        }
      } else if (name.endsWith('.tree')) {
        files.push({ path: path.relative(root, full).split(path.sep).join('/'), text: fs.readFileSync(full, 'utf8') })

        if (files.length > MOST_FILES) {
          return false
        }
      }
    }

    return true
  }

  return walk(root) ? files : undefined
}

function project(root, verb) {
  try {
    if (verb !== 'make') {
      return
    }

    const at = path.resolve(root)

    if (inPackages(at) || !fs.existsSync(at)) {
      return
    }

    const top = fs.statSync(at).isDirectory() ? at : path.dirname(at)
    const files = treeFiles(top)

    if (files !== undefined) {
      save(files, `make ${top}`)
    }
  } catch {
    // the census never breaks the build it watches
  }
}

function sources(entry, list) {
  try {
    if (typeof entry !== 'string' || inPackages(entry) || !entry.endsWith('.tree')) {
      return
    }

    const top = path.dirname(path.resolve(entry))
    const files = []

    for (const source of list ?? []) {
      if (!source || typeof source.file !== 'string' || typeof source.text !== 'string') {
        continue
      }

      if (inPackages(source.file) || !source.file.endsWith('.tree')) {
        continue
      }

      const from = path.relative(top, path.resolve(source.file)).split(path.sep).join('/')

      // a module outside the entry's folder is kept under `outside/`, by its absolute path
      files.push({ path: from.startsWith('..') ? `outside${path.resolve(source.file)}` : from, text: source.text })
    }

    save(files, `compile ${path.resolve(entry)}`)
  } catch {
    // the census never breaks the build it watches
  }
}

// a `term` command this process IS: `node .../host/line.js <verb> ...` (or need.mjs, which hands over to line.js in
// process). Its project is the folder of the first `.tree` named on the line, else the working directory, which is
// where every suite starts `term make`. Read here rather than from inside the CLI, whose make opens its run in a port
function command() {
  const script = path.basename(process.argv[1] ?? '')

  if (script !== 'line.js' && script !== 'need.mjs') {
    return
  }

  const verb = process.argv[2] ?? ''

  if (!['make', 'run', 'test', 'check', 'hold'].includes(verb)) {
    return
  }

  const named = process.argv.slice(3).find(word => word.endsWith('.tree'))

  project(named !== undefined ? path.dirname(path.resolve(named)) : process.cwd(), 'make')
}

if (KEEP) {
  globalThis.termCensusKeep = { project, sources }
  command()
}
