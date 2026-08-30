// Parser robustness, over every .tree file in the repository rather than a fixture set.
//
// Three properties, each of which found a real defect the day it was written:
//
//   ROUND TRIP   parse(print(parse(x))) equals parse(x). `printTree` is the canonical expanded form, so a file
//                that survives a print/parse cycle unchanged proves the printer and the parser agree about the
//                tree. They did not: a decimal printed as `String(value)` turned `1.0` into `1`, silently
//                changing `like decimal` to `like number`.
//
//   NEVER THROWS Feeding the parser a mutation of a real file must give a result, never an exception. A parser
//                that throws cannot report where the problem is, and the caller gets a stack trace instead of a
//                diagnostic. The tree builder used to throw a TypeError on input that closed more frames than
//                it opened.
//
//   DETERMINISM  Parsing the same text twice gives the same tree. The parser mutates token text in place while
//                building (see `chunk` in event.ts), so a shared or re-walked token list could drift.
//
// Run: npx tsx test/parser/robust.ts   (FAST=1 to sample rather than sweep)

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { parse, printTree } from '@term/make/code/parser/tree'

const HERE = import.meta.dirname ?? new URL('.', import.meta.url).pathname
const TERM = join(HERE, '../..')

// Files whose canonical printed form does not re-read as the same tree. `printTree` is currently a DISPLAY
// form, not a round-trippable one: it prints a text literal's chunks raw, so a literal carrying an unbalanced
// angle or a `{{...}}` interpolation can come back different or not parse at all.
//
// This list is a BASELINE, not permission. The check fails if a file outside it breaks, and it fails if a file
// on it starts round-tripping, so the list cannot quietly grow or rot. Emptying it is tree-parser-0008.
//
// An earlier attempt to fix this by escaping the chunks made it WORSE (12 failures to 83, then 50): the
// tokenizer keeps `\<` in the chunk rather than unescaping it, so adding a backslash doubled one that was
// already there. Which layer unescapes what has to be settled before this is touched again.
// Files whose canonical printed form does not re-read as the same tree. EMPTY as of 2026-08-30: `printTree`
// now re-escapes an unescaped angle in a text chunk (see escapeTextChunk in the parser), which is what the 12
// entries here were. Kept as a set so a regression lands as a failure rather than a silent addition.
const KNOWN_ROUND_TRIP = new Set<string>([])

let pass = 0
let fail = 0
let known = 0
let unexpectedlyFixed = 0
const failures: string[] = []

function ok(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
  } else {
    fail++

    if (failures.length < 24) {
      failures.push(`${name}  ${info.slice(0, 300)}`)
    }
  }
}

function treeFiles(dir: string, out: string[] = []): string[] {
  let entries: string[]

  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }

  for (const entry of entries) {
    if (entry === 'node_modules' || entry === '.base' || entry.startsWith('.')) {
      continue
    }

    const path = join(dir, entry)

    // `host` is build output everywhere except the @term/host package, which carries a deck.tree
    if (entry === 'host' && !existsSync(join(path, 'deck.tree'))) {
      continue
    }

    if (statSync(path).isDirectory()) {
      treeFiles(path, out)
    } else if (entry.endsWith('.tree')) {
      out.push(path)
    }
  }

  return out
}

// a deterministic pseudo-random source, so a failure is reproducible from the seed alone
function rng(seed: number): () => number {
  let state = seed >>> 0

  return () => {
    state = (state * 1664525 + 1013904223) >>> 0

    return state / 0x100000000
  }
}

// mutations that produce plausible-but-broken source: the shapes a person actually types
const CHARS = ['<', '>', '{', '}', '(', ')', ',', '\\', ' ', '\n', '\t', '"', '#']

function mutate(text: string, next: () => number): string {
  const at = Math.floor(next() * text.length)
  const kind = Math.floor(next() * 4)

  if (kind === 0) {
    return text.slice(0, at) + text.slice(at + 1) // delete a character
  }

  if (kind === 1) {
    return text.slice(0, at) + CHARS[Math.floor(next() * CHARS.length)]! + text.slice(at) // insert one
  }

  if (kind === 2) {
    return text.slice(0, at) + CHARS[Math.floor(next() * CHARS.length)]! + text.slice(at + 1) // replace one
  }

  const cut = Math.floor(next() * Math.min(80, text.length - at))

  return text.slice(0, at) + text.slice(at + cut) // delete a run
}

const files = treeFiles(join(TERM, 'deck')).concat(treeFiles(join(TERM, 'test')))
const sample = process.env.FAST ? files.filter((_, i) => i % 7 === 0) : files

console.log(`${files.length} .tree files, checking ${sample.length}`)

let parsed = 0
let refused = 0

for (const file of sample) {
  const text = readFileSync(file, 'utf8')
  const label = file.slice(TERM.length + 1)
  const first = parse({ file, text })

  if (!first.ok) {
    refused++
    continue
  }

  parsed++

  const printed = printTree(first.tree)

  // ROUND TRIP: the canonical form re-parses to the same canonical form
  const again = parse({ file, text: printed })

  const roundTrips = again.ok && printTree(again.tree) === printed

  if (KNOWN_ROUND_TRIP.has(label)) {
    if (roundTrips) {
      unexpectedlyFixed++
      failures.push(`round trip: ${label} now round-trips, so take it off KNOWN_ROUND_TRIP`)
    } else {
      known++
    }
  } else {
    ok(
      `round trip: ${label}`,
      roundTrips,
      again.ok ? 'printed differs on the second pass' : `the printed form does not parse: ${again.diagnostics[0]?.message}`,
    )
  }

  // DETERMINISM: the same text twice gives the same tree
  const twice = parse({ file, text })

  ok(`deterministic: ${label}`, twice.ok && printTree(twice.tree) === printTree(first.tree))
}

// NEVER THROWS: mutations of real files, deterministic from the seed
const next = rng(20260830)
const fuzzTargets = sample.filter((_, i) => i % 3 === 0)
let mutations = 0

for (const file of fuzzTargets) {
  const text = readFileSync(file, 'utf8')

  for (let i = 0; i < 12; i++) {
    const broken = mutate(text, next)

    mutations++

    try {
      const result = parse({ file, text: broken })

      // whatever it decides, a result that says ok must carry a tree
      ok(`mutation of ${file.slice(TERM.length + 1)} #${i} returns a tree`, !result.ok || Boolean(result.tree))
    } catch (error) {
      ok(
        `mutation of ${file.slice(TERM.length + 1)} #${i} does not throw`,
        false,
        `${(error as Error).message} -- seed 20260830, mutation ${mutations}`,
      )
    }
  }
}

for (const line of failures) {
  console.log(`FAIL  ${line}`)
}

console.log(`\nfiles parsed ${parsed}, refused ${refused}, mutations ${mutations}, known round-trip gaps ${known}`)
console.log(`parser-robust: ${pass} pass, ${fail + unexpectedlyFixed} fail`)

if (fail > 0 || unexpectedlyFixed > 0) {
  process.exit(1)
}
