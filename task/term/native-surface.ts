// What a program can DO on each backend, as opposed to what compiles.
//
// `pnpm term:native-gate` answers a different question and answers it well: every stdlib module that exists builds
// on Rust, Swift and Kotlin, at 487 / 480 / 476 with zero failures. That is compile parity and it is done
// (stdlib-parity-0007).
//
// It cannot see the hole this reports. A module that has no native implementation at all is not a failing build, it
// is an ABSENT one: nothing imports `native/rust/file/asynchronous` because there is nothing to import, so the gate
// is green and a Term program that opens a file asynchronously simply cannot target Rust. Green, and not portable.
//
// So this compares the reachable SURFACE per backend: every non-shelved module under
// `deck/base/code/native/<platform>/`, plus everything in `shared/`, against what `node` offers.
//
// TWO DIRECTORIES ARE NOT PART OF THE COMPARISON.
//
// `javascript/` is an internal shim layer, not a platform a program targets: exactly one file in the stdlib
// references it, and the seven `line*` modules in it back the JavaScript list representation. Rust, Swift and Kotlin
// implement lists in the backend (Vec, Array, List), so counting `line` against them invents seven holes that do not
// exist. Counting it is what made an earlier pass report `line` as a Rust-only gap.
//
// `browser/` is a target, but it is the same language as `node` with a different host, so measuring it against node
// reports the difference between a browser and a server rather than a gap in a backend.
//
// Run from the repository root: `pnpm term:native-surface`. Reports by default and writes nothing.
// Design: note/project/term/archive/native-surface-parity.md.

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { DECIDED } from './native-decided'
import { TERM_ROOT } from './root'

// run from the Term root, the way every other term task is
const TERM = TERM_ROOT
const NATIVE = join(TERM, 'deck/base/code/native')

const verbose = process.argv.includes('--verbose')

// the platforms a program targets, and the one that sets the bar
const BASELINE = 'node'
const BACKENDS = ['rust', 'swift', 'kotlin']

// A module ABSENT ON PURPOSE, by a recorded decision, keyed `<backend>/<module>`: the table lives in native-decided.ts,
// shared with native-gate.ts. Each is printed on every run with its reason, and an entry whose module turns up (or
// whose baseline goes away) FAILS, so the list cannot outlive the decision

// `mark draft` (or the old `note draft`) on its own line shelves a file; a `draft.tree` shelves its whole directory. Both are honoured by the
// build walk, so a shelved module is not something any backend is asked to match.
function modulesOf(platform: string): Set<string> {
  const root = join(NATIVE, platform)
  const found = new Set<string>()

  if (!existsSync(root)) {
    return found
  }

  const walk = (at: string): void => {
    if (existsSync(join(at, 'draft.tree'))) {
      return
    }

    for (const name of readdirSync(at).sort()) {
      const full = join(at, name)

      try {
        if (statSync(full).isDirectory()) {
          walk(full)
          continue
        }
      } catch {
        continue
      }

      if (!name.endsWith('.tree') || name === 'draft.tree') {
        continue
      }

      try {
        if (/^(mark|note) draft\s*$/m.test(readFileSync(full, 'utf8').slice(0, 2000))) {
          continue
        }
      } catch {
        continue
      }

      found.add(relative(root, full).replace(/\.tree$/, ''))
    }
  }

  walk(root)

  return found
}

// group missing modules by their first path segment, which is the family that has to be written
function familiesOf(missing: string[]): [string, string[]][] {
  const families = new Map<string, string[]>()

  for (const module of missing) {
    const family = module.split('/')[0] ?? module
    families.set(family, [...(families.get(family) ?? []), module])
  }

  return [...families.entries()].sort((a, b) => b[1].length - a[1].length)
}

function main(): void {
  const shared = modulesOf('shared')
  const baseline = new Set([...modulesOf(BASELINE), ...shared])

  console.log(
    `term native-surface: ${baseline.size} modules reachable on ${BASELINE} (${shared.size} of them shared)`,
  )
  console.log('')

  let absent = 0
  // a module missing from EVERY backend is one piece of work, not three
  const everywhere = new Map<string, number>()

  for (const backend of BACKENDS) {
    const have = new Set([...modulesOf(backend), ...shared])
    const missing = [...baseline].filter(m => !have.has(m) && !DECIDED[`${backend}/${m}`]).sort()

    absent += missing.length

    for (const module of missing) {
      everywhere.set(module, (everywhere.get(module) ?? 0) + 1)
    }

    console.log(
      `  ${backend.padEnd(7)} ${String(have.size).padStart(3)} reachable, ${String(missing.length).padStart(3)} absent`,
    )

    for (const [family, members] of familiesOf(missing)) {
      console.log(
        `      ${family.padEnd(12)} ${String(members.length).padStart(2)}${verbose ? `  ${members.join(', ')}` : ''}`,
      )
    }
  }

  const universal = [...everywhere.entries()]
    .filter(([, n]) => n === BACKENDS.length)
    .map(([m]) => m)
    .sort()

  if (universal.length > 0) {
    console.log('')
    console.log(
      `  ${universal.length} of them are absent on ALL ${BACKENDS.length} backends, so each is one implementation to design and three to write:`,
    )

    for (const [family, members] of familiesOf(universal)) {
      console.log(`    ${family.padEnd(12)} ${members.length}`)
    }
  }

  // every decided absence, said, and each one still held to being absent from its backend and present on the baseline
  let stale = 0

  if (Object.keys(DECIDED).length > 0) {
    console.log('')
    console.log('  absent by decision:')

    for (const [key, reason] of Object.entries(DECIDED)) {
      const [backend, ...rest] = key.split('/')
      const module = rest.join('/')
      const still = baseline.has(module) && !new Set([...modulesOf(backend!), ...shared]).has(module)

      if (!still) {
        stale++
      }

      console.log(`    ${still ? '' : 'STALE '}${key}: ${still ? reason : 'no longer absent, or gone from the baseline: drop the entry'}`)
    }
  }

  console.log('')
  console.log(
    `term native-surface: ${absent} absent across ${BACKENDS.length} backends, ${universal.length} of them universal${stale ? `, ${stale} decided absence(s) stale` : ''}`,
  )

  // ZERO OR IT COMES BACK. This ran for weeks as a report nobody could fail, which is exactly how 80 absent
  // modules sat behind a green build gate: a module that is easy to not write is the one thing that needs a
  // gate, because nothing else in the tree breaks when it is missing (native-surface-parity-0007).
  if (absent > 0 || stale > 0) {
    process.exitCode = 1
  }
}

main()
