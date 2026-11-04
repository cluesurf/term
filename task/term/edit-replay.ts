// THE INCREMENTAL BUILD EQUALS THE CLEAN BUILD (`pnpm term:edit-replay`, note/project/term/incremental-best-in-class.md,
// step 7).
//
// Every shortcut the build takes is a claim that skipping work changes nothing: a unit answered by a key of the names
// it reaches rather than everything it reaches (compile/names.tree), an entry replayed because no file its closure
// holds moved (compile/reach.tree), a module's walk and a load's answer kept across builds (`BuildSession`). Each test
// of them proves the case it names. This proves the claim on real packages, under edits nobody chose: a copy of each
// package is edited at random, one edit at a time, and after every edit two builds are compared:
//
//   INCREMENTAL   one `BuildSession` for the whole replay and one cache on disk, every shortcut taken
//   CLEAN         a session of its own and an empty cache. Only the standard library's units are kept between clean
//                 builds, under the whole-surface key the run's memo uses, since no edit here reaches them
//
// Both write the package's artifacts, so after the incremental build every artifact is read, and after the clean
// build again: a file the clean build rewrote is one the incremental build got wrong. Every error and warning is
// compared as well. Exit 1 on any difference, naming the edit, the file and both answers.
//
// The edits are what a person does: a comment, a task added, its body changed, its signature changed, it removed,
// a file saved unchanged, a file added that loads another, a file shelved with `mark draft`, a file put back as it
// was. Seeded, so a failure replays: the seed is printed.
//
//   pnpm term:edit-replay                       the packages below, 40 edits each
//   pnpm term:edit-replay --edits 400           more
//   pnpm term:edit-replay --seed 7 deck/zone    one package, one sequence
//
// Writes only under the system temporary directory.

import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { CompileCache } from '@term/make/code/compile/cache'
import type { UnitMemo } from '@term/make/code/compile/separate'
import { buildSession, compileProjectSeparate, findTreeFiles } from '@term/call/code/make'
import { diskCacheStore } from '@term/call/code/cache-store'
import { declaresDraft } from '@term/call/code/draft'
import { makeScratch, removeTree, scratchEnv, sweepStaleRuns } from './temp-run'
import { TERM_ROOT, parentPaths } from './root'

// run from the Term root, where the `@term/*` paths resolve (the pnpm alias and the gate both start there)
const REPO = TERM_ROOT

const PACKAGES = ['deck/host', ...parentPaths('deck/zone')]

const args = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const at = args.indexOf(`--${name}`)

  return at >= 0 ? args[at + 1] : undefined
}

const EDITS = Number(flag('edits') ?? 40)
const SEED = Number(flag('seed') ?? Date.now() % 100000)
const named = args.filter((arg, i) => !arg.startsWith('--') && !args[i - 1]?.startsWith('--'))
const packages = named.length > 0 ? named : PACKAGES

// a small seeded generator (mulberry32), so a sequence replays from its seed
let state = SEED >>> 0

const random = (): number => {
  state = (state + 0x6d2b79f5) >>> 0
  let t = state
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)

  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const pick = <T>(list: T[]): T => list[Math.floor(random() * list.length)]!

// every artifact under host/, path to text
const artifacts = (root: string): Map<string, string> => {
  const out = new Map<string, string>()
  const walk = (dir: string): void => {
    if (!existsSync(dir)) {
      return
    }

    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name)

      if (statSync(full).isDirectory()) {
        walk(full)
      } else {
        out.set(path.relative(root, full), readFileSync(full, 'utf8'))
      }
    }
  }

  walk(path.join(root, 'host'))

  return out
}

type Said = { errors: string[]; warnings: string[] }

const saidOf = (result: { errors: string[]; warnings: string[] }): Said => ({
  errors: [...result.errors].sort(),
  warnings: [...result.warnings].sort(),
})

let passed = 0
let failed = 0

// every copy and cache of the run in one scratch folder, removed at the end and swept by the next run if this one is
// killed: a direct run left edit-replay-* folders that a concurrent term:test read as its own temp-leak (item 0528)
sweepStaleRuns()
const SCRATCH = makeScratch('tp')

Object.assign(process.env, scratchEnv(SCRATCH))
process.on('exit', () => removeTree(SCRATCH))

console.log(`edit-replay: seed ${SEED}, ${EDITS} edits per package`)

for (const pkg of packages) {
  const source = path.resolve(REPO, pkg)
  // by its real path, as `term make` is run from one: the temporary directory is `/var` behind a link to `/private/var`,
  // and a module named both ways is two modules
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'edit-replay-')))

  for (const part of ['deck.tree', 'role.tree', 'code', 'test']) {
    if (existsSync(path.join(source, part))) {
      cpSync(path.join(source, part), path.join(root, part), { recursive: true })
    }
  }

  // the incremental side: one session, one cache on disk, for the whole replay
  const session = buildSession(root)
  const cache = new CompileCache(diskCacheStore(mkdtempSync(path.join(tmpdir(), 'edit-replay-cache-')), 'replay'), 'replay')

  // the clean side's only memory: units by their whole-surface key, which the standard library's never change under
  const kept: UnitMemo = new Map()

  const clean = (): { errors: string[]; warnings: string[] } =>
    compileProjectSeparate(root, new CompileCache(), 'node', buildSession(root, kept))

  const originals = new Map(findTreeFiles(path.join(root, 'code'), [], 'node').map(file => [file, readFileSync(file, 'utf8')]))
  const programs = [...originals.keys()].filter(file => !declaresDraft(originals.get(file)!))
  // the tasks and files this replay added, so later edits can change and remove them
  const added: { file: string; name: string; text: string }[] = []
  const files: string[] = []

  const edit = (n: number): string => {
    const kinds = ['comment', 'add-task', 'touch', 'add-file', 'revert']

    if (added.length > 0) {
      kinds.push('task-body', 'task-signature', 'remove-task')
    }

    if (files.length > 0) {
      kinds.push('shelve-file')
    }

    const kind = pick(kinds)
    const file = pick(programs)
    const text = readFileSync(file, 'utf8')
    const short = path.relative(root, file)

    switch (kind) {
      case 'comment':
        writeFileSync(file, `${text}\n# edit ${n}\n`)

        return `a comment in ${short}`
      case 'add-task': {
        const name = `replay-task-${n}`
        const task = `\ntask ${name}\n  like number\n  send back, code ${n}\n`
        added.push({ file, name, text: task })
        writeFileSync(file, `${text}${task}`)

        return `task ${name} added to ${short}`
      }
      case 'task-body': {
        const one = pick(added)
        const now = readFileSync(one.file, 'utf8')
        const changed = one.text.replace(/code (\d+)/, (_, value) => `code ${Number(value) + 1000}`)
        writeFileSync(one.file, now.replace(one.text, changed))
        one.text = changed

        return `the body of ${one.name} changed`
      }
      case 'task-signature': {
        const one = pick(added)
        const now = readFileSync(one.file, 'utf8')
        const changed = one.text.includes('take extra')
          ? one.text.replace('  take extra, like number, fall 0\n', '')
          : one.text.replace('  like number\n', '  take extra, like number, fall 0\n  like number\n')
        writeFileSync(one.file, now.replace(one.text, changed))
        one.text = changed

        return `the signature of ${one.name} changed`
      }
      case 'remove-task': {
        const one = added.splice(Math.floor(random() * added.length), 1)[0]!
        writeFileSync(one.file, readFileSync(one.file, 'utf8').replace(one.text, ''))

        return `task ${one.name} removed`
      }
      case 'touch':
        writeFileSync(file, text)

        return `${short} saved unchanged`
      case 'add-file': {
        const at = path.join(root, 'code', `replay-file-${n}.tree`)
        const load = path.relative(path.dirname(at), file).replace(/\.tree$/, '')
        writeFileSync(at, `load ./${load}\n\ntask replay-file-${n}\n  like number\n  send back, code ${n}\n`)
        files.push(at)

        return `file ${path.relative(root, at)} added, loading ${short}`
      }
      case 'shelve-file': {
        const at = files.splice(Math.floor(random() * files.length), 1)[0]!
        writeFileSync(at, `mark draft\n${readFileSync(at, 'utf8')}`)

        return `file ${path.relative(root, at)} shelved`
      }
      default: {
        writeFileSync(file, originals.get(file)!)

        for (let i = added.length - 1; i >= 0; i--) {
          if (added[i]!.file === file) {
            added.splice(i, 1)
          }
        }

        return `${short} put back as it was`
      }
    }
  }

  const compare = (what: string): boolean => {
    const incremental = saidOf(compileProjectSeparate(root, cache, 'node', session))
    const before = artifacts(root)
    const reference = saidOf(clean())
    const after = artifacts(root)

    const rewritten = [...after].filter(([file, text]) => before.get(file) !== text).map(([file]) => file)
    const errors = JSON.stringify(incremental.errors) !== JSON.stringify(reference.errors)
    const warnings = JSON.stringify(incremental.warnings) !== JSON.stringify(reference.warnings)

    if (rewritten.length === 0 && !errors && !warnings) {
      passed++

      if (args.includes('--verbose')) {
        console.log(`  same after ${what}`)
      }

      return true
    }

    failed++
    console.log(`  DIFFER after ${what}`)

    for (const file of rewritten.slice(0, 5)) {
      const ours = (before.get(file) ?? '').split('\n')
      const theirs = after.get(file)!.split('\n')
      const at = theirs.findIndex((line, i) => line !== ours[i])

      console.log(`    artifact ${file} differs from the clean build's, first at line ${at + 1}`)
      console.log(`      incremental: ${ours[at] ?? '(missing)'}`)
      console.log(`      clean:       ${theirs[at] ?? '(missing)'}`)
    }

    if (errors) {
      console.log(`    errors      incremental: ${incremental.errors.join(' | ') || 'none'}`)
      console.log(`                clean:       ${reference.errors.join(' | ') || 'none'}`)
    }

    if (warnings) {
      console.log(`    warnings    incremental ${incremental.warnings.length}, clean ${reference.warnings.length}`)
    }

    return false
  }

  const started = Date.now()
  console.log(`${pkg}: ${programs.length} modules`)
  compare('the first build')

  for (let n = 1; n <= EDITS; n++) {
    if (!compare(edit(n))) {
      break
    }
  }

  console.log(`  ${Date.now() - started} ms`)
}

// the gate's summary line (task/term/test.ts): one comparison per build
console.log(`\nedit-replay: ${passed} pass, ${failed} fail`)
process.exit(failed === 0 ? 0 : 1)
