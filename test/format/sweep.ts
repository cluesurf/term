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
import { mill } from '@term/make/code/compile/mill'

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
    if (key === 'span') {
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

  return JSON.stringify(mergeParts(built.program))
}

const files = treeFiles(join(TERM, 'deck')).concat(treeFiles(join(TERM, 'test')))

console.log(`${files.length} .tree files`)

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
  const before = program(file, text)

  // a file the parser or the mill refuses has no meaning to preserve
  if (before === undefined) {
    skipped++
    continue
  }

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
