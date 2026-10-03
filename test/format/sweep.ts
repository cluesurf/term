// The formatter, over every .tree file in the repository rather than a handful of cases.
//
// Four properties. All are the kind that a per-case test cannot give you, because the interesting inputs are the
// ones nobody thought to write down.
//
//   MEANING PRESERVED  The mill's Program for a file is identical before and after formatting, with spans
//                      stripped. Compared at the MILL level, not on the raw tree, on purpose: `call f(a, b)`
//                      and `call f` with indented arguments build different trees that the mill resolves to the
//                      same call, and moving between those forms is exactly what a formatter is allowed to do.
//                      A tree-level comparison would refuse a correct formatter. A file is milled with ITS OWN
//                      `mark lean` (projectLeanOf), since a lean file milled as longhand is another program. The
//                      comparison itself is format/meaning.ts, the one the formatter makes before it accepts a
//                      layout, so a file the formatter REFUSES (returns as written) is a failure here too.
//
//   COMMENTS KEPT      Every word of every comment, in order, before and after. A comment is not meaning, so the
//                      mill cannot see one go missing.
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
import { formatReport } from '@term/make/code/format/format'
import { parse } from '@term/make/code/parser/tree'
import { importsOf, programOf } from '@term/make/code/format/meaning'
import { projectLeanOf, projectRoleOf } from '@term/call/code/role-of'
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

// the mill's Program with spans dropped and template pieces merged, so only the MEANING is compared
function program(file: string, text: string, lean: boolean): string | undefined {
  const parsed = parse({ file, text })

  return parsed.ok ? programOf(parsed.tree, file, lean) : undefined
}

// every word of every comment, in order: COMMENTS KEPT. The formatter dropped the comment above a line that opens
// with a literal (`# the second` over `2`) until 2026-10-03. Compared as words because a long comment is re-wrapped.
function commentWords(file: string, text: string): string {
  const parsed = parse({ file, text })
  const words: string[] = []

  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') {
      return
    }

    const record = node as { comments?: { text: string }[]; nodes?: unknown[] }

    for (const comment of record.comments ?? []) {
      words.push(...comment.text.replace(/^\s*#+/, '').split(/\s+/).filter(Boolean))
    }

    for (const child of record.nodes ?? []) {
      visit(child)
    }
  }

  if (parsed.ok) {
    parsed.tree.nodes.forEach(visit)
  }

  return words.join(' ')
}

// each file's role and `mark lean`, as the build reads them
const roleOf = projectRoleOf(TERM)
const leanOf = projectLeanOf(TERM)

// files where the formatter's own meaning check refused its layout and it returned the file as written. Not a
// drift (the file is unchanged), but a layout the rules ask for and the formatter could not prove, so it is listed
let refused = 0

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

  // the four properties held last time, on these bytes, by this code
  if (memo.passed(label, text)) {
    checked++
    pass += 4
    continue
  }

  if (memo.passed(`skip:${label}`, text)) {
    skipped++
    continue
  }

  const lean = leanOf(file)
  const role = roleOf(file)
  const before = program(file, text, lean)

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
    const report = formatReport({ file, text }, { lean, role })

    once = report.text

    if (report.refused) {
      refused++
      note(`${label}: the formatter's meaning check refused its own layout (${report.refused})`)
    }
  } catch (error) {
    note(`${label}: the formatter threw: ${(error as Error).message.slice(0, 160)}`)
    continue
  }

  checked++

  // MEANING PRESERVED
  const after = program(file, once, lean)
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

  // COMMENTS KEPT
  if (commentWords(file, text) !== commentWords(file, once)) {
    note(`${label}: formatting dropped or reordered a comment`)
  } else {
    pass++
  }

  // IDEMPOTENT
  let twice: string

  try {
    twice = formatReport({ file, text: once }, { lean, role }).text
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

  // remembered only when all four properties held and nothing was on a known list
  if (pass - passedBefore === 4 && fail === failedBefore) {
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
  `\nfiles ${files.length}, checked ${checked}, skipped ${skipped} (do not parse or do not mill), known meaning ${knownMeaning}, known unstable ${knownUnstable}, refused by the formatter's own check ${refused}`,
)
console.log(`format-sweep: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
