// How much of @term/feed's 99 grammars can feed-mill actually read, and which rules does it drop on the floor?
//
// WHY THIS EXISTS. `readFeedMineRule` returns undefined for a shape it does not know, and the rule then VANISHES
// from the grammar without a word. The generated reader still parses, still mills, and is simply missing a rule.
// That is the failure mode this whole compiler keeps producing, and at 99 grammars it is not something anybody
// finds by reading.
//
// Measured 2026-08-31, across every `mine.tree` under deck/feed/code:
//
//   99 grammars   79 parse   30 read to rules (584 rule objects)   30 generate and mill
//   0 of those 30 are missing a rule they declare
//
// It was 397 rules and 18 incomplete when this measurement started. Every rule that HAS A BODY now reads. What
// remains unread is rules with no body at all — `mine aif`, gdef's `mine version`, thirteen of png's chunk rules
// are a name and a blank line — and those are stubs in the GRAMMAR, not gaps in the reader, so counting them here
// would blame the reader for work the grammar has not done.
//
// It was 397 rules and 18 incomplete an hour earlier. FOUR SPELLINGS closed most of the gap, and every one of them
// was a way these grammars had always been written that the reader simply did not know:
//   `mine text 13`      a literal as a CODE POINT, which is how a control character is spelled
//   `mine <rule-name>`  a bare reference to another rule, the short form of `mine form, form <name>`
//   `bind base, <0>`    a bound as a BARE literal rather than `text <0>`
//   `bind start`/`end`  the same two range bounds under different names from `base`/`head`
//   `mine <->`          a bare text literal as the whole body, no `text` or `char` keyword
//   `bind base, 0`      a bound as a bare INTEGER, neither `code 0` nor `<0>`
//   `look after`        an alternation, the same construct `mine any` spells (24 uses across feed)
//   `bind base, share 0`  and `bind base, text 0`, two more ways to write the same bound
//
// The counts are a BASELINE that fails in both directions: a grammar that stops reading fails this, and one that
// starts reading fails it too, so the numbers cannot drift and a fix cannot go unnoticed. Emptying the drop list
// is the rest of format-mill (0004 OTF, 0005 PDF, 0006 XML and ZIP, and whatever the remaining dialects need).
//
// Run: npx tsx test/compile/feed-mill-coverage.ts
//      npx tsx test/compile/feed-mill-coverage.ts --list   (every grammar and what it dropped)

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { parse } from '@term/make/code/parser/tree'
import { mill } from '@term/make/code/compile/mill'
import { resolve as resolveNames } from '@term/make/code/check/resolve'
import { check } from '@term/make/code/check/infer'
import { collectModules } from '@term/make/code/compile/load'
import type { Source } from '@term/make/code/compile/load'
import { withNativeEnv } from '@term/make/code/compile/native'
import { expandTemplates } from '@term/make/code/compile/template'
import { extendForms } from '@term/make/code/check/extend'
import { disambiguateOverloads } from '@term/make/code/check/overload'
import type { Program } from '@term/make/code/compile/node'
import {
  compileFeedMine,
  feedMineDrops,
  feedMineLoads,
  feedMineUnknownRefs,
  feedMineSubstrate,
  readFeedMineGrammar,
} from '@term/make/code/compile/feed-mill'

const HERE = import.meta.dirname ?? new URL('.', import.meta.url).pathname
const TERM = join(HERE, '../..')
const CODE = join(TERM, 'deck/feed/code')

// WHAT THE 20 THAT DO NOT PARSE ACTUALLY ARE, checked one by one on 2026-08-31 rather than assumed. None is a
// parser defect and none is a grammar with a small mistake in it. They are unfinished files in three states:
//
//   PASTED REFERENCE MATERIAL, never written in the DSL at all. `image/webp/mine.tree` is the WebP specification
//   in English prose ("The ASCII characters 'R' 'I' 'F' 'F'."), and `font/otf/table/cff/mine.tree` and
//   `font/otf/table/gsub/mine.tree` have JavaScript in them (`return new Parser(this.data, ...)`), half-ported
//   from some other implementation and left where the porting stopped.
//
//   A DRAFT IN AN OLDER NOTATION, which says so. `ansi/mine.tree` opens with "Stale pre-rename draft (regex, not
//   the mine DSL). Kept for reference only." and its body is `\x1b\[[0-9;]*m`.
//
//   REAL DSL USING A SPELLING TERM DOES NOT HAVE. `font/otf/table/shared/mine.tree` writes `bind front, share
//   #h0001` for a hex literal, and `#` opens a COMMENT in Term, so the rest of the line disappears. The spelling
//   is `0x0001`.
//
// This is written down because `79 parse` invites reading the other 20 as broken, and then as somebody's bug to
// find. They are grammars nobody has written yet, which is what format-mill-0004 through 0006 are for.
//
// TWO OF THE 20 WERE FIXED, and they were the third kind above. `x86/mine.tree` and
// `font/otf/table/shared/mine.tree` wrote hex as `#h0001` and binary as `#b100`, and `#` opens a COMMENT in
// Term, so the rest of every one of those 18 lines vanished and the file stopped parsing somewhere after. Term
// spells them `0x0001` and `0b100`, both of which parse. That took 79 to 81 and 584 rule objects to 661.
//
// AND IT PUT THE DROP COUNT UP TO 1, which is the counter doing its job rather than a regression. The
// newly-readable `font/otf/table/shared/mine.tree` declares `mine value-record`, and that rule needs two things
// the reader does not have:
//
//   `check <op>` with `bind start` / `bind front` children, a read gated on a condition. This is the same
//   construct `mine maybe` spells with an explicit `test`, which gzip already uses for exactly this case (a flag
//   bit read earlier, which no lookahead can know), written in another notation.
//
//   `start <name>`, a rule PARAMETER. `value-record` is read against a `value-format` its CALLER holds, and no
//   rule takes an argument today. Nothing calls `value-record` yet either, so there is not even a call site to
//   read the shape from.
//
// It is left dropped on purpose. Teaching the reader `check` alone would generate a reader referring to a
// `value-format` that does not exist, which compiles and is wrong, and a silently wrong reader is the exact
// failure this file was written to catch. Both constructs belong to format-mill-0004, which is the
// parameter-passing family (`mine at` takes an offset from its caller in the same way).
//
// `check` AND `start` ARE READ NOW, which took the drop count from 1 back to 0 and the rule objects from 661 to
// 699. Both were spellings these grammars had always used and the reader did not know, which is the same story
// as the seven before them:
//
//   `start separator, share <,>` is a rule PARAMETER with a default. A rule is not always readable from the
//   cursor alone: csv threads a separator through five rules, png's chunk needs its length, OTF's value-record is
//   read against a value-format its caller holds. `mine form, form row` with `bind separator, share separator`
//   children is the call that passes one.
//
//   `check <op> / bind start, <a> / bind front, <b>` is a read gated on a condition, which is `mine maybe` with
//   an explicit `test` in another notation. It compiles through the SAME helper, so the two cannot drift. 32
//   uses across 8 grammars.
//
// Two things that bit on the way, both worth keeping:
//   a rendered operand must be `read(name)`, PARENTHESISED. It lands in a comma-separated argument list, and a
//   comma pops exactly one level, so `call bitwise-and(read value-format, code 1)` puts the `code 1` INSIDE the
//   `read` and calls bitwise-and with one argument. Eleven check errors, from the trap CLAUDE.md names outright.
//   a `check` returns a maybe, like the construct it compiles to. Without saying so it fell to the `like number`
//   default and every rule ending in one declared a number for a maybe. Three more.
//
// the counts on 2026-08-31
const GRAMMARS = 99
const PARSES = 81
const READS = 32
const MILLS = 32
const DROPPING = 0
// of the MILLS that mill, how many survive the whole front end: resolve, extend, overloads, typecheck
const COMPILES = 9
// grammars that REFER to a rule they never define, and how many distinct names in total
const DANGLING = 23
const DANGLING_NAMES = 86

// how the 32 readable grammars split by substrate, INFERRED from the constructs they use. Zero use both, which is
// what makes `term make` able to compile a dialect without being told (format-mill-0009). The sixteen that infer
// as neither are pure combinators over rules that are still stubs, so they have no leaf to infer from yet.
const BYTE_ONLY = 6
const TEXT_ONLY = 8
const NEITHER = 18

// The TOTAL rule OBJECTS read across every grammar, counting nested children.
//
// The coarser numbers do not move when a construct is lost, and both weaker versions of this check were tried and
// rejected on evidence. Removing the `char` reader entirely changed neither the grammar counts (a grammar that
// loses some rules still reads others, and was already counted as incomplete) NOR a count of named rules
// (`grammar.size` counts top-level `mine <name>` entries, and losing a nested construct leaves the name in place
// with a shorter body). Counting every object, nested ones included, is what actually moves. Same lesson as the
// per-rule pin in feed-mill-json.ts, one level deeper.
const RULES = 699

let pass = 0
let fail = 0

function ok(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}${info ? `  ${info}` : ''}`)
  }
}

// every rule object in a list, including the children of a list / any / maybe / mark / span
function countRules(list: readonly unknown[]): number {
  let total = 0

  for (const rule of list) {
    total++

    const children = (rule as { children?: unknown[] }).children

    if (Array.isArray(children)) {
      total += countRules(children)
    }
  }

  return total
}

// the real front end, over a generated reader, against the real stdlib. The same phases `term make` runs, so a
// grammar that passes here is one a build can actually compile.
const PACKS: Record<string, string> = {
  seed: join(TERM, 'deck/seed'),
  feed: join(TERM, 'deck/feed'),
}

const resolver = (path: string, from: string): Source | undefined => {
  // a RELATIVE import resolves against the importing file, which is what the project resolver does and what a
  // grammar's own `load ./code` needs. Without it hex reported its own helper as undefined.
  if (path.startsWith('./') || path.startsWith('../')) {
    const base = join(dirname(from), path)

    for (const candidate of [`${base}.tree`, join(base, 'base.tree')]) {
      if (existsSync(candidate)) {
        return { file: candidate, text: readFileSync(candidate, 'utf8') }
      }
    }

    return undefined
  }

  const match = /^@term\/([^/]+)\/(.+)$/.exec(path)
  const root = match ? PACKS[match[1]!] : undefined

  if (!root || !match) {
    return undefined
  }

  for (const candidate of [join(root, `${match[2]}.tree`), join(root, match[2]!, 'base.tree')]) {
    if (existsSync(candidate)) {
      return { file: candidate, text: readFileSync(candidate, 'utf8') }
    }
  }

  return undefined
}

function compilesClean(source: string, at: string): boolean {
  try {
    const sources = collectModules(
      { file: at, text: source },
      withNativeEnv('node', resolver),
    ).sources
    const program: Program = []

    for (const unit of sources) {
      const parsed = parse(unit)

      if (!parsed.ok) {
        return false
      }

      const built = mill(expandTemplates(parsed.tree), unit.file)

      if (!built.ok) {
        return false
      }

      program.push(...built.program)
    }

    extendForms(program, at)
    disambiguateOverloads(program)

    // BOTH PASSES' DIAGNOSTICS. `resolve` is what reports an UNDEFINED NAME, and discarding its return value made
    // this check pass on a reader calling `read-crown`, a task nothing defines. `check` reports type mismatches
    // and never sees an unresolved name, so asking only `check` answers a narrower question than it appears to.
    const found = [
      ...resolveNames(program, at),
      ...check(program, at),
    ]

    return found.every(d => d.severity === 'warning')
  } catch {
    return false
  }
}

function mines(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)

    if (statSync(full).isDirectory()) {
      mines(full, out)
    } else if (entry === 'mine.tree') {
      out.push(full)
    }
  }

  return out
}

const files = mines(CODE)

let parses = 0
let reads = 0
let mills = 0
let compiles = 0
let rules = 0
let byteOnly = 0
let textOnly = 0
let neither = 0
const dropping: { file: string; dropped: string[]; declared: number }[] = []
const dangling: { file: string; names: string[] }[] = []

for (const file of files) {
  const parsed = parse({ file, text: readFileSync(file, 'utf8') })

  if (!parsed.ok) {
    continue
  }

  parses++

  const grammar = readFeedMineGrammar(parsed.tree)

  if (grammar.size === 0) {
    continue
  }

  reads++

  for (const list of grammar.values()) {
    rules += countRules(list)
  }

  const substrate = feedMineSubstrate(grammar)

  if (substrate === 'byte') {
    byteOnly++
  } else if (substrate === 'text') {
    textOnly++
  } else {
    neither++
  }

  const missing = feedMineUnknownRefs(grammar)

  if (missing.length > 0) {
    dangling.push({ file: relative(CODE, file), names: missing })
  }

  const drops = feedMineDrops(parsed.tree)

  if (drops.length > 0) {
    dropping.push({
      file: relative(CODE, file),
      dropped: drops,
      declared: grammar.size + drops.length,
    })
  }

  try {
    // THE GRAMMAR'S OWN `load` BLOCKS, exactly as `term make` passes them. Without them hex reports its own
    // `hex-digit-value` as undefined, which is an artefact of the harness rather than a fact about the grammar.
    const source = compileFeedMine(
      grammar,
      substrate ?? 'text',
      '@term/feed/code/base',
      feedMineLoads(file, readFileSync(file, 'utf8')),
    )
    const generated = parse({ file: 'generated.tree', text: source })

    if (generated.ok && mill(generated.tree, 'generated.tree').ok) {
      mills++
    }

    // AND THE STRONGER CLAIM. Milling only says the generated source is well-formed Term. It says nothing about
    // whether the names resolve or the types agree, and a reader that mills and does not typecheck is a reader
    // nobody can build. This runs the real front end over it, against the real stdlib, exactly as `term make`
    // does, and counts only the grammars that come back with no errors.
    if (compilesClean(source, file)) {
      compiles++
    }
  } catch {
    // did not generate; counted by omission
  }
}

if (process.argv.includes('--list')) {
  for (const entry of dropping) {
    console.log(`  ${entry.file}: ${entry.dropped.length}/${entry.declared} dropped (${entry.dropped.join(', ')})`)
  }

  for (const entry of dangling) {
    console.log(`  ${entry.file}: refers to ${entry.names.length} undefined (${entry.names.join(', ')})`)
  }
}

ok(`${files.length} grammars found`, files.length === GRAMMARS, `found ${files.length}`)
ok(`${parses} parse`, parses === PARSES, `${parses} not ${PARSES}`)
ok(`${reads} read to rules`, reads === READS, `${reads} not ${READS}`)
ok(`${mills} generate a reader that mills`, mills === MILLS, `${mills} not ${MILLS}`)

// THE CLAIM THAT MATTERS. Milling says the generated source is well-formed Term and nothing more: the names may
// not resolve and the types may not agree, and a reader that mills without typechecking is one no build can use.
// This is the same front end `term make` runs, against the real stdlib.
//
// NINE OF THIRTY-TWO, and the gap is the most useful number on this page.
//
// THIS CHECK WAS WRONG WHEN IT WAS FIRST WRITTEN, and it is worth saying so here rather than quietly fixing it.
// It ran `resolve` and then asked only `check` for diagnostics, DISCARDING what resolve returned. `check`
// reports type mismatches and never sees an unresolved name, so the question it answered was narrower than the
// one it appeared to answer, and it reported 32 of 32 while readers were calling `read-crown` — a task nothing
// defines. A check that answers a narrower question than its name claims is worth less than no check at all,
// because it is believed. Both passes' diagnostics are collected now.
//
// WHAT THE REAL NUMBER SHOWS: a SECOND CONSTRUCT VOCABULARY runs through these grammars that the reader does not
// know. `chunk` (565 uses), `bound` (262), `crown` (261), `chord` (250), `chain` (109), `sieve` (72), `count`
// (49), `shard` (39), `block` (21), `leave` (16), `flow`, `crest`, `shift`, `binary`. A `mine <word>` outside
// the construct set is the SHORT FORM of `mine form, form <word>`, a reference to another rule, so every one of
// these reads as a call to a rule the grammar never defines. Nothing fails: the grammar reads, the drop count
// stays at zero (it counts top-level rules that read to NOTHING, and these read to a reference), the reader
// generates, and it mills. It just calls tasks that are not there.
//
// So `mine crown` is not a bug in a grammar. It is a construct somebody meant, and deciding what each of the
// fourteen means — which are synonyms for `any` / `list` / `text` / `not`, and which are genuinely new — is the
// real content of the remaining format-mill items. Guessing the mapping and porting on the guess would produce
// grammars that read and generate and are silently wrong, which is what this whole file exists to prevent.
//
// The nine that pass are the ones written entirely in the vocabulary the reader has: aif, ascii, gzip, hex,
// ipv4, latin, latin/number, latin/whitespace, otf/table/head.
//
// THE MILLING CHECK ABOVE PASSES ALL 32, and passed them before any of this existed. That is the argument for
// this one in a sentence: milling is a claim about syntax, and none of these defects were syntactic.
ok(
  `${compiles} generate a reader that RESOLVES AND TYPECHECKS`,
  compiles === COMPILES,
  `${compiles} not ${COMPILES}`,
)
ok(
  `${rules} rules read in total`,
  rules === RULES,
  `${rules} not ${RULES}. This moves when a CONSTRUCT is added or lost, which the grammar counts do not.`,
)
ok(
  `the substrate infers unambiguously (${byteOnly} byte, ${textOnly} text, ${neither} with no leaf yet)`,
  byteOnly === BYTE_ONLY && textOnly === TEXT_ONLY && neither === NEITHER,
  `${byteOnly}/${textOnly}/${neither} not ${BYTE_ONLY}/${TEXT_ONLY}/${NEITHER}`,
)
// ---- rules a grammar REFERS TO and never defines ----
//
// `mine <word>` outside the construct set is the short spelling of `mine form, form <word>`, so an undocumented
// construct word and a genuinely forgotten rule are the same thing here: a reference to nothing.
//
// THE CONSEQUENCE IS SILENT, and this is what makes it visible at BUILD time rather than at read time.
// `compileAnyHelper` dispatches only branches whose FIRST set it can compute, and leaves the rest out on purpose,
// so that the helper refuses rather than calling the wrong reader (a refusal is a bug report, a wrong branch is a
// corrupted parse). That is the right call and it is not changed here. But a rule that does not exist has no
// FIRST set, so an alternation naming one QUIETLY LOSES that alternative and the loss shows up only as a runtime
// refusal on input that needed it.
//
// `latin/number` is the worked example, and it is one of the nine that RESOLVE AND TYPECHECK: `mine number` is an
// alternation of `decimal` and `integer`, `decimal` is never defined, and `read-decimal` is simply not in the
// emitted module. It typechecks because the branch is gone. Typechecking is not correctness.
//
// The 86 split into four kinds, and only the first is a language question:
//   UNDOCUMENTED CONSTRUCT WORDS: chunk, bound, crown, chord, chain, sieve, count, shard, block, leave, crest,
//   shift, binary. None appears in note/term/feed/01-grammar.md, so what each MEANS is genuinely open.
//   RULES THE GRAMMAR NEVER WROTE: month, sp, weekday, atom, word, date1, time, attach-list, lig-caret-list.
//   PASTED FOREIGN CODE: `p.parsePointer`, `leNames`, left where a port from another implementation stopped.
//   TYPE NAMES USED AS RULES: ushort, short, uint32, 2digit, 4digit.
ok(
  `${dangling.length} grammars refer to a rule they never define (${dangling.reduce((n, d) => n + d.names.length, 0)} names)`,
  dangling.length === DANGLING && dangling.reduce((n, d) => n + d.names.length, 0) === DANGLING_NAMES,
  `${dangling.length}/${dangling.reduce((n, d) => n + d.names.length, 0)} not ${DANGLING}/${DANGLING_NAMES}`,
)

ok(
  `${dropping.length} grammars are missing a rule they declare`,
  dropping.length === DROPPING,
  `${dropping.length} not ${DROPPING}. A grammar that stopped dropping is progress: lower the number.`,
)

// ---- the count-directed list actually counts ----
//
// `bind count, read table-count` was READ AS NOTHING: the bind fell through the rule reader and vanished, and the
// generated loop ran to end-of-input instead of stopping at the declared count. Nothing failed. A cmap table
// would simply have read every remaining byte of the font as encoding records.
//
// This checks the EMITTED LOOP, not the rule object, because reading the count into a field nobody emits is the
// same silence one layer up.

const counted = readFeedMineGrammar(
  parse({
    file: 'counted.tree',
    text: [
      'mine table',
      '  mine int',
      '    bind width, code 2',
      '    bind order, term big',
      '    bind sign, term unsigned',
      '    send total',
      '  mine list',
      '    bind count, read total',
      '    mine byte',
      '      send item',
      '',
    ].join('\n'),
  }).tree,
)
const countedSource = compileFeedMine(counted, 'byte', '@term/feed/code/base')

ok(
  'a count-directed list stops at its count',
  countedSource.includes('call is-below(call size(read(list-1)), read(total))'),
  countedSource.split('\n').filter(l => l.includes('hook test') || l.includes('is-below') || l.includes('at-end')).join(' | '),
)

// and it still stops at the end of the input, because a count read FROM that input is not to be trusted on its
// own: a truncated file must end the loop rather than read past the end
ok(
  'and still stops at the end of the input',
  countedSource.includes('call not, call at-end(read(cursor))'),
)

// a list with NO count reads to the end, which is right for a whole file
const uncounted = readFeedMineGrammar(
  parse({
    file: 'uncounted.tree',
    text: 'mine table\n  mine list\n    mine byte\n      send item\n',
  }).tree,
)

ok(
  'a list with no count reads to the end and asks about no count',
  !compileFeedMine(uncounted, 'byte', '@term/feed/code/base').includes('is-below'),
)

console.log(
  `\nfeed-mill-coverage: ${pass} pass, ${fail} fail` +
    `\n  ${files.length} grammars, ${parses} parse, ${reads} read (${rules} rules), ${mills} mill, ${dropping.length} incomplete`,
)

if (fail > 0) {
  process.exit(1)
}
