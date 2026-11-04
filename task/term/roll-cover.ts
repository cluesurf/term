// Is a project's roll the roll of its ROOT entries alone? `projectRoll` merges every entry's roll, keeping the first
// entry of each name, and every entry's roll covers its whole closure, so on @term/bind 3,091 rolls are computed to
// keep one copy of each name (note/project/term/incremental-best-in-class.md, step 5). If an entry of one name is the same
// whichever entry computed it, the entries nothing else in the project imports cover every file, and the roll needs
// those alone. This computes every entry's roll, reports each name two entries disagree on, and compares the roll
// merged from every entry with the one merged from the roots. A deck's `file` count is the computing entry's closure
// and is compared apart: the merged roll's is whichever entry sorted first, and the right one is the build's.
//
// Run: pnpm term:roll-cover --dir deck/mill      exit 1 when two entries give one name two entries
//
// What it found, 2026-10-05, and what was fixed: a native shim raised `failure` only when its closure held the
// `failure` form (check/effects.ts), and the merge keyed by name without the site (compile/roll.ts), 51 names on
// @term/feed between them. Both now 0. The roots' roll does NOT equal the project's, since each entry's is shaken

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { buildable, buildResolver, findTreeFiles, isWholeFile, projectResolver } from '@term/call/code/make'
import { entryRoll } from '@term/call/code/roll'
import { projectCache } from '@term/call/code/cache-store'
import { projectDeckOf } from '@term/call/code/deck-of'
import { projectLeanOf, projectRoleOf } from '@term/call/code/role-of'
import { collectModules, makeParseMemo } from '@term/make/code/compile/load'
import { mergeRolls } from '@term/make/code/compile/roll'
import type { Roll } from '@term/make/code/compile/roll'
import { units as unitsOf } from '@term/make/code/compile/separate'

const at = process.argv.indexOf('--dir')
// `--dir`, else ROLL_COVER_DIR (the gate's way to name it), else here
const root = path.resolve(at === -1 ? (process.env.ROLL_COVER_DIR ?? process.cwd()) : process.argv[at + 1]!)
const link = path.join(root, 'link') + path.sep
const files = findTreeFiles(root, [], 'node').filter(f => !f.startsWith(link))
const resolve = buildResolver(projectResolver(root))
const parsed = makeParseMemo()
const cache = projectCache(root)
const deckOf = projectDeckOf()
const roleOf = projectRoleOf(root)
const leanOf = projectLeanOf(root)

const rolls = new Map<string, Roll>()
const edges = new Map<string, string[]>()
const walked = new Map()
const entries: string[] = []

for (const file of files) {
  const unit = buildable(file, readFileSync(file, 'utf8'), roleOf(file))

  if ('faults' in unit || isWholeFile(file, unit.text, roleOf(file))) {
    continue
  }

  entries.push(file)

  const closure = collectModules({ file, text: unit.text }, resolve, parsed, undefined, walked)

  for (const source of closure.sources) {
    edges.set(source.file, walked.get(source.file)?.edges ?? [])
  }

  const one = entryRoll({ file, text: unit.text }, { resolve, cache, parsed, deckOf, roleOf, leanOf })

  if (one.ok && one.roll) {
    rolls.set(file, one.roll)
  }
}

// the roots: one entry of each unit no other unit reaches
const units = unitsOf([...edges.keys()], edges)
const unitOf = new Map<string, number>()
units.forEach((unit, index) => unit.forEach(file => unitOf.set(file, index)))
const reached = new Set<number>()

for (const [file, to] of edges) {
  for (const edge of to) {
    if (unitOf.get(edge) !== unitOf.get(file) && unitOf.has(edge)) {
      reached.add(unitOf.get(edge)!)
    }
  }
}

const roots = entries.filter(file => !reached.has(unitOf.get(file)!) && units[unitOf.get(file)!]!.find(f => entries.includes(f)) === file)

// every name, and every distinct value two entries gave it
const values = new Map<string, Set<string>>()

for (const roll of rolls.values()) {
  for (const kind of Object.keys(roll)) {
    if (kind === 'deck') {
      continue
    }

    for (const entry of roll[kind] ?? []) {
      const key = `${kind} ${entry.host} ${entry.kind} ${entry.name} ${entry.site}`
      const seen = values.get(key) ?? new Set<string>()
      seen.add(JSON.stringify(entry))
      values.set(key, seen)
    }
  }
}

const split = [...values].filter(([, seen]) => seen.size > 1)

for (const [key, seen] of split.slice(0, 10)) {
  console.log(`differs  ${key}`)

  for (const value of seen) {
    console.log(`  ${value.slice(0, 300)}`)
  }
}

const strip = (roll: Roll): string => JSON.stringify({ ...roll, deck: (roll.deck ?? []).map(d => ({ ...d, file: 0 })) })
const all = mergeRolls([...rolls.values()])
const fromRoots = mergeRolls(roots.flatMap(file => (rolls.has(file) ? [rolls.get(file)!] : [])))
const same = strip(all) === strip(fromRoots)

// what the roots' roll lacks, and an entry that has it
const keyed = (roll: Roll): Set<string> =>
  new Set(Object.keys(roll).filter(k => k !== 'deck').flatMap(k => (roll[k] ?? []).map(e => `${k} ${e.host} ${e.name} ${e.site}`)))
const covered = keyed(fromRoots)
const missing = [...keyed(all)].filter(key => !covered.has(key))

for (const key of missing.slice(0, 10)) {
  const from = [...rolls].find(([, roll]) => keyed(roll).has(key))?.[0]
  console.log(`missing  ${key}  (from ${from ? path.relative(root, from) : '?'})`)
}

console.log(`${entries.length} entries, ${rolls.size} rolled, ${roots.length} roots, ${values.size} names, ${split.length} given two values, ${missing.length} missing from the roots' roll`)
// the roots' roll is information, not the gate: an entry's roll is tree-shaken to what it reaches, so a task nothing
// imports is on its own file's roll alone, and the roots miss it (note/project/term/incremental-best-in-class.md, step 5)
console.log(`the roots' roll ${same ? 'equals' : 'differs from'} every entry's, deck counts aside`)
process.exit(split.length === 0 ? 0 : 1)
