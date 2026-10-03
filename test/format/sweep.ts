// The formatter, over every .tree file in the repository rather than a handful of cases.
//
// Two properties. Both are the kind that a per-case test cannot give you, because the interesting inputs are the
// ones nobody thought to write down.
//
//   MEANING PRESERVED  The mill's Program for a file is identical before and after formatting, with spans
//                      stripped. Compared at the MILL level, not on the raw tree, on purpose: `call f(a, b)`
//                      and `call f` with indented arguments build different trees that the mill resolves to the
//                      same call, and moving between those forms is exactly what a formatter is allowed to do.
//                      A tree-level comparison would refuse a correct formatter.
//
//   IMPORTS PRESERVED  The `load` / `bear` paths a file names are identical before and after. Compared SEPARATELY
//                      because a load directive never becomes a mill Statement: it is resolved by the loader, so
//                      the mill comparison above is blind to it. That blindness hid a real, meaning-changing bug
//                      for as long as the sweep has existed: the formatter re-emitted every name interpolation as
//                      `{{...}}` regardless of its actual brace depth, turning the compile-time substitution in
//                      `load @term/base/code/native/{platform}/atomic` into a runtime interpolation. Every
//                      platform-slot import in the stdlib, silently, the moment anyone ran `term form`.
//
//   IDEMPOTENT         format(format(x)) equals format(x). A formatter that keeps changing its mind cannot be
//                      run on save, and every diff carries noise that hides the real change.
//
// A file that does not parse is skipped, not failed: `term form` has nothing to say about a file the parser
// refuses, and the tree carries fixtures that are deliberately malformed.
//
// Run: npx tsx test/format/sweep.ts

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { format } from '@term/make/code/format/format'
import { parse } from '@term/make/code/parser/tree'
import { importPathsOf, makeParseMemo } from '@term/make/code/compile/load'
import { mill } from '@term/make/code/compile/mill'
import { makeMemo } from '../memo'

const HERE = import.meta.dirname ?? new URL('.', import.meta.url).pathname
const TERM = join(HERE, '../..')

// Files the formatter changes the meaning of, or cannot settle on. A BASELINE, not permission: the sweep fails
// if a file outside this set breaks, and fails if a file inside it starts working, so the list cannot grow
// quietly or rot. Emptying it is lint-and-format-0006.
const KNOWN_MEANING: string[] = []
const KNOWN_UNSTABLE: string[] = []

let pass = 0
let fail = 0
let knownMeaning = 0
let knownUnstable = 0
const failures: string[] = []

function note(line: string): void {
  fail++

  if (failures.length < 200) {
    failures.push(line)
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

// the `load` / `bear` paths a file names, through the compiler's own reader so this cannot disagree with the build
function importsOf(file: string, text: string): string {
  return importPathsOf({ file, text }, makeParseMemo()).join('|')
}

// Adjacent literal pieces of a template mean the same thing however they are split: `["<", "<", x]` and
// `["<<", x]` both render `<<` then x. The formatter re-emits a literal as one chunk where the source had two, so
// comparing the split would report a meaning change where there is none. Merged before comparing, for the same
// reason spans are dropped: this compares MEANING, not representation.
function mergeParts(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(mergeParts)
  }

  if (!value || typeof value !== 'object') {
    return value
  }

  const out: Record<string, unknown> = {}

  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    // `privateNote` is a span too, under its own name: where a `note private` line sits, for the warning
    // (check/private.ts). Formatting moves it as it moves every span, so it is position, not meaning
    if (key === 'span' || key === 'privateNote') {
      continue
    }

    if (key === 'parts' && Array.isArray(raw)) {
      const merged: unknown[] = []

      for (const part of raw) {
        const last = merged[merged.length - 1]

        if (typeof part === 'string' && typeof last === 'string') {
          merged[merged.length - 1] = last + part
        } else {
          merged.push(mergeParts(part))
        }
      }

      out[key] = merged
      continue
    }

    out[key] = mergeParts(raw)
  }

  return out
}

// the mill's Program with spans dropped and template pieces merged, so only the MEANING is compared
function program(file: string, text: string): string | undefined {
  const parsed = parse({ file, text })

  if (!parsed.ok) {
    return undefined
  }

  const built = mill(parsed.tree, file)

  if (!built.ok) {
    return undefined
  }

  // a walk's bound is held in a temporary the mill names after its POSITION (`walk-head-<line>-<column>`, in
  // compile/mint-bridge.ts), and position is exactly what formatting moves: a call compacted onto one line above a
  // walk renamed every temporary below it, and the sweep reported the meaning changed (2026-10-02, nine files). The
  // temporaries are renumbered in order of first appearance, so a consistent renaming compares equal and a different
  // structure still does not
  const temporaries = new Map<string, string>()

  return JSON.stringify(mergeParts(built.program)).replace(/walk-head-\d+-\d+/g, name => {
    if (!temporaries.has(name)) {
      temporaries.set(name, `walk-head-${temporaries.size}`)
    }

    return temporaries.get(name)!
  })
}

const files = treeFiles(join(TERM, 'deck')).concat(treeFiles(join(TERM, 'test')))

console.log(`${files.length} .tree files`)

// a file whose text, and the compiler and this sweep, are all unchanged since it last passed every property is not
// checked again (test/memo.ts). Everything a file's verdict depends on is in those: the formatter, the parser, the
// mill and its baked grammar, the import reader, and the sweep itself
const memo = makeMemo('format-sweep', ['deck/make/code', 'test/format'])

let checked = 0
let skipped = 0

for (const file of files) {
  const label = file.slice(TERM.length + 1)

  // test/parser/file holds fixtures written as `<source>` `---` `<expected tree>`, so the file as a whole is not
  // Term source and formatting it means nothing. They are checked by test/parser/fixture.ts instead.
  if (label.startsWith('test/parser/file/')) {
    skipped++
    continue
  }

  const text = readFileSync(file, 'utf8')

  // the three properties held last time, on these bytes, by this code
  if (memo.passed(label, text)) {
    checked++
    pass += 3
    continue
  }

  if (memo.passed(`skip:${label}`, text)) {
    skipped++
    continue
  }

  const before = program(file, text)

  // a file the parser or the mill refuses has no meaning to preserve
  if (before === undefined) {
    skipped++
    memo.pass(`skip:${label}`, text)
    continue
  }

  const passedBefore = pass
  const failedBefore = fail

  let once: string

  try {
    once = format({ file, text })
  } catch (error) {
    note(`${label}: the formatter threw: ${(error as Error).message.slice(0, 160)}`)
    continue
  }

  checked++

  // MEANING PRESERVED
  const after = program(file, once)
  const same = after !== undefined && after === before

  if (KNOWN_MEANING.includes(label)) {
    same ? note(`${label}: meaning is preserved now, so take it off KNOWN_MEANING`) : knownMeaning++
  } else if (!same) {
    note(`${label}: formatting changed the mill Program${after === undefined ? ' (the formatted file does not compile)' : ''}`)
  } else {
    pass++
  }

  // IMPORTS PRESERVED
  const importsBefore = importsOf(file, text)
  const importsAfter = importsOf(file, once)

  if (importsBefore !== importsAfter) {
    note(
      `${label}: formatting changed the import paths\n    before ${importsBefore}\n    after  ${importsAfter}`,
    )
  } else {
    pass++
  }

  // IDEMPOTENT
  let twice: string

  try {
    twice = format({ file, text: once })
  } catch (error) {
    note(`${label}: the formatter threw on its own output: ${(error as Error).message.slice(0, 160)}`)
    continue
  }

  const stable = twice === once

  if (KNOWN_UNSTABLE.includes(label)) {
    stable ? note(`${label}: formatting is stable now, so take it off KNOWN_UNSTABLE`) : knownUnstable++
  } else if (!stable) {
    note(`${label}: formatting is not idempotent`)
  } else {
    pass++
  }

  // remembered only when all three properties held and nothing was on a known list
  if (pass - passedBefore === 3 && fail === failedBefore) {
    memo.pass(label, text)
  }
}

const { reused } = memo.save()

if (reused > 0) {
  console.log(`${reused} file(s) unchanged since they last passed, not checked again (TERM_MEMO=off checks them)`)
}

for (const line of failures) {
  console.log(`FAIL  ${line}`)
}

console.log(
  `\nfiles ${files.length}, checked ${checked}, skipped ${skipped} (do not parse or do not mill), known meaning ${knownMeaning}, known unstable ${knownUnstable}`,
)
console.log(`format-sweep: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
