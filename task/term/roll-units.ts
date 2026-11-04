// The roll assembled from units against the rolls of every entry (`pnpm term:roll-units`,
// note/project/term/incremental-best-in-class.md, step 5).
//
// `term make` writes host/roll.json. It was the merge of every entry's own roll, each a typing of the entry's whole
// closure: 481 to 641 s of the pool's workers on a cold @term/bind. Now each unit's build lists its own definitions
// once (compile/roll.ts `own`), and the roll is every unit's of the build (call/code/roll.ts `projectRoll`): every
// definition of every module the entries load, where the entries' rolls held what each entry's shake happened to keep.
//
// What it must hold is everything the entries say, and the entries do not always agree: an unannotated task's inferred
// type is narrowed by callers in other files, which are in one entry's closure and not another's, so zone's `bank`
// returns `number` in one entry's roll and `void` in the next, and the merged roll kept whichever entry sorted first
// (task/term/roll-cover.ts counts these). A unit's answer is its own and the same in every build. So, per name: every
// name any entry's roll lists; where every entry agrees, exactly that entry; where they disagree, one of their answers;
// and each deck counting at least the files the entries kept. What no entry kept is counted, not refused. Exit 1 on
// anything else.
//
//   pnpm term:roll-units                          the packages below
//   pnpm term:roll-units deck/mill
//
// Writes what `term make` writes (each package's host/), and nothing else.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { buildable, buildResolver, buildSession, compileProjectSeparate, findTreeFiles, isWholeFile, projectResolver } from '@term/call/code/make'
import { entryRoll, projectRoll } from '@term/call/code/roll'
import { projectCache } from '@term/call/code/cache-store'
import { projectDeckOf } from '@term/call/code/deck-of'
import { projectLeanOf, projectRoleOf } from '@term/call/code/role-of'
import { makeParseMemo } from '@term/make/code/compile/load'
import type { Roll, RollEntry } from '@term/make/code/compile/roll'
import { TERM_ROOT, parentPaths } from './root'

// run from the Term root, where the `@term/*` paths resolve (the pnpm alias and the gate both start there)
const REPO = TERM_ROOT
const TERM = 'deck'

const PACKAGES = [`${TERM}/feed`, `${TERM}/host`, ...parentPaths('deck/zone'), `${TERM}/deck`]

const named = process.argv.slice(2)
const packages = named.length ? named : PACKAGES

let same = 0
let differ = 0

// an entry as it is written, without what only a merge reads
const shown = (entry: RollEntry): string =>
  JSON.stringify(Object.fromEntries(Object.entries(entry).filter(([key]) => !key.startsWith('__'))))

// the unit's entry is the entry's, or more general only where a type the unit left open the entry's callers filled in:
// `to-text` takes a `value` of no stated type, which an entry calling it with a number reads as `number` and its own
// unit, which no caller narrows, leaves unsolved
const UNSOLVED = 'an unsolved type'

function generalizes(unit: unknown, entry: unknown): boolean {
  if (unit === UNSOLVED && typeof entry === 'string') {
    return true
  }

  if (Array.isArray(unit) && Array.isArray(entry)) {
    return unit.length === entry.length && unit.every((one, at) => generalizes(one, entry[at]))
  }

  if (unit !== null && entry !== null && typeof unit === 'object' && typeof entry === 'object') {
    const a = Object.keys(unit)
    const b = Object.keys(entry)

    return a.length === b.length && a.every(key => generalizes((unit as Record<string, unknown>)[key], (entry as Record<string, unknown>)[key]))
  }

  return unit === entry
}

for (const pkg of packages) {
  const root = path.resolve(REPO, pkg)
  const built = compileProjectSeparate(root, undefined, 'node', buildSession(root))
  const units = projectRoll(root, built.rolls).roll

  // every entry's own roll, and each name's answers across them
  const link = path.join(root, 'link') + path.sep
  const resolve = buildResolver(projectResolver(root))
  const parsed = makeParseMemo()
  const cache = projectCache(root)
  const deckOf = projectDeckOf()
  const roleOf = projectRoleOf(root)
  const leanOf = projectLeanOf(root)
  const answers = new Map<string, Set<string>>()
  const deckFiles = new Map<string, Set<string>>()

  for (const file of findTreeFiles(root, [], 'node').filter(f => !f.startsWith(link))) {
    const unit = buildable(file, readFileSync(file, 'utf8'), roleOf(file))

    if ('faults' in unit || isWholeFile(file, unit.text, roleOf(file)) || !built.closures.has(file)) {
      continue
    }

    const one = entryRoll({ file, text: unit.text }, { resolve, cache, parsed, deckOf, roleOf, leanOf })
    const roll = (one.roll ?? {}) as Roll

    for (const kind of Object.keys(roll)) {
      for (const entry of roll[kind] ?? []) {
        if (kind === 'deck') {
          const files = deckFiles.get(entry.name) ?? new Set<string>()
          ;((entry.__files as string[] | undefined) ?? []).forEach(f => files.add(f))
          deckFiles.set(entry.name, files)
          continue
        }

        const key = `${kind} ${entry.host} ${entry.name} ${entry.site}`
        answers.set(key, (answers.get(key) ?? new Set()).add(shown(entry)))
      }
    }
  }

  const problems: string[] = []
  const unitKeys = new Set<string>()
  let contested = 0
  // definitions in the build that no entry's shake kept: the roll lists them, the entries' rolls did not
  let more = 0
  // and entries a unit left more general than the entries' callers made them
  let general = 0

  for (const kind of Object.keys(units)) {
    for (const entry of units[kind] ?? []) {
      if (kind === 'deck') {
        // the build's files, at least the files any entry kept
        const kept = deckFiles.get(entry.name)?.size ?? 0

        if (typeof entry.file !== 'number' || entry.file < kept) {
          problems.push(`deck ${entry.name}: ${String(entry.file)} files, fewer than the ${kept} the entries kept`)
        }

        continue
      }

      const key = `${kind} ${entry.host} ${entry.name} ${entry.site}`
      unitKeys.add(key)
      const said = answers.get(key)

      if (said === undefined) {
        more++
      } else if (!said.has(shown(entry)) && [...said].some(one => generalizes(JSON.parse(shown(entry)), JSON.parse(one)))) {
        general++
      } else if (!said.has(shown(entry))) {
        problems.push(`differs  ${key}\n      units ${shown(entry).slice(0, 240)}\n      entry ${[...said][0]!.slice(0, 240)}`)
      } else if (said.size > 1) {
        contested++
      }
    }
  }

  for (const key of answers.keys()) {
    if (!unitKeys.has(key)) {
      problems.push(`only entries  ${key}`)
    }
  }

  if (problems.length === 0) {
    same++
    console.log(
      `ok    ${pkg}  ${units.task.length} tasks, ${units.exception.length} exceptions, ${units.deck.length} decks; every entry's ${answers.size}, ${contested} the entries disagreed on and one of their answers for each, ${general} more general than a caller made them, ${more} no entry's shake kept`,
    )
  } else {
    differ++
    console.log(`FAIL  ${pkg}  ${problems.length} entries differ`)

    for (const one of problems.slice(0, 12)) {
      console.log(`    ${one}`)
    }
  }
}

console.log(`\nroll-units: ${same} pass, ${differ} fail`)
process.exit(differ > 0 ? 1 : 0)
