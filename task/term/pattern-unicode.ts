// pnpm term:pattern-unicode [--commit]
//
// The Unicode tables @term/base/pattern reads, so `\p{…}`, `\b` and the `i` flag mean the same thing on every backend
// rather than whatever each platform's own Unicode version says (note/project/term/stdlib/regex-engine.md). Written into
// deck/base/code/pattern/unicode.tree as data.
//
// The SOURCE is the V8 inside the Node running this, asked with its own `\p{…}` and `/iu`: the property NAMES come from
// @eslint-community/regexpp's validation tables (every name ECMAScript 2025 defines), and each name's code points come
// from V8, by running `\p{name}+` over one text holding every Unicode scalar value. Nothing here is typed by hand. The
// Unicode version is V8's, printed and written into the file.
//
// What is written:
//   category: every code point's General_Category, as runs (start, end, id) over the whole code space, the 30
//     two-letter categories numbered in a fixed order, and each category NAME (Lu, Uppercase_Letter, L, Letter, LC,
//     cntrl ...) as a bit mask over those 30, so a group like `L` is the union its mask says
//   script: runs (start, end, id) of the Script property, the names and their aliases. Script_Extensions is not read
//   binary: every binary property ECMAScript names, as runs (start, end) in one list, with each property's offset and
//     run count
//   fold: simple case folding as V8's `/iu` applies it: every code point that shares a case class with another, paired
//     with the smallest member of its class. Two code points match under `i` exactly when they map to the same member
//
// Reports by default, and exits 1 when the file on disk has drifted. `--commit` writes it.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TERM_ROOT } from './root'

const REPO = TERM_ROOT
// not `unicode.tree`: a module that loads this and @term/base/text/unicode both would hold two modules of one name
const OUT = join(TERM_ROOT, 'deck/base/code/pattern/unicode-table.tree')
const REGEXPP = join(
  REPO,
  'node_modules/.pnpm/@eslint-community+regexpp@4.12.1/node_modules/@eslint-community/regexpp/index.js',
)
const LAST = 0x10ffff
const commit = process.argv.includes('--commit')

// the property names, read out of regexpp's three DataSet tables. Each table is a list of space-separated groups,
// one per ECMAScript edition
function namesOf(table: string): string[] {
  const source = readFileSync(REGEXPP, 'utf8')
  const line = source.split('\n').find(l => l.startsWith(`const ${table} = new DataSet(`))

  if (!line) {
    throw new Error(`regexpp has no ${table}: the generator needs updating for its new layout`)
  }

  return [...line.matchAll(/"([^"]*)"/g)].flatMap(m => m[1]!.split(' ').filter(Boolean))
}

// one text holding every scalar value, and for each UTF-16 index the code point that starts there
const scalars: number[] = []

for (let c = 0; c <= LAST; c++) {
  if (c < 0xd800 || c > 0xdfff) {
    scalars.push(c)
  }
}

const all = scalars.map(c => String.fromCodePoint(c)).join('')
const pointAt = new Int32Array(all.length + 1)

{
  let unit = 0

  for (const c of scalars) {
    pointAt[unit] = c
    unit += c > 0xffff ? 2 : 1
  }

  pointAt[unit] = LAST + 1
}

type Run = [number, number]

// the code points a `\p{…}` holds, as runs. A surrogate is in no text, so the runs never cover one; the callers say
// where a surrogate belongs
function runsOf(property: string): Run[] | undefined {
  let pattern: RegExp

  try {
    pattern = new RegExp(`\\p{${property}}+`, 'gu')
  } catch {
    return undefined
  }

  const runs: Run[] = []

  for (const m of all.matchAll(pattern)) {
    const start = pointAt[m.index]!
    // the last code point of the match: its final unit, or the unit before when that one is a low surrogate
    let lastUnit = m.index + m[0].length - 1
    const low = all.charCodeAt(lastUnit)

    if (low >= 0xdc00 && low <= 0xdfff) {
      lastUnit--
    }

    const end = pointAt[lastUnit]!
    // a run that crosses the surrogate gap is two runs
    const crosses = start < 0xd800 && end > 0xdfff

    if (crosses) {
      runs.push([start, 0xd7ff], [0xe000, end])
    } else {
      runs.push([start, end])
    }
  }

  return runs
}

const equal = (a: Run[], b: Run[]) => a.length === b.length && a.every((r, i) => r[0] === b[i]![0] && r[1] === b[i]![1])

// General_Category: the 30 two-letter categories, in the order Unicode lists them
const CATEGORIES = [
  'Lu', 'Ll', 'Lt', 'Lm', 'Lo', 'Mn', 'Mc', 'Me', 'Nd', 'Nl', 'No', 'Pc', 'Pd', 'Ps', 'Pe', 'Pi', 'Pf', 'Po',
  'Sm', 'Sc', 'Sk', 'So', 'Zs', 'Zl', 'Zp', 'Cc', 'Cf', 'Cs', 'Co', 'Cn',
]

const categoryOf = new Uint8Array(LAST + 1).fill(CATEGORIES.indexOf('Cn'))
const categorySets: Run[][] = []

for (const [id, name] of CATEGORIES.entries()) {
  const runs = name === 'Cs' ? [[0xd800, 0xdfff] as Run] : runsOf(`General_Category=${name}`)!

  categorySets.push(runs)

  for (const [s, e] of runs) {
    categoryOf.fill(id, s, e + 1)
  }
}

const categoryRuns: number[][] = []

for (let c = 0; c <= LAST; c++) {
  const last = categoryRuns.at(-1)

  if (last && last[2] === categoryOf[c] && last[1] === c - 1) {
    last[1] = c
  } else {
    categoryRuns.push([c, c, categoryOf[c]!])
  }
}

// each category name as a mask over the 30: the categories whose code points it holds. Checked: the union of the
// masked categories is exactly the name's set, so a name that is not a union of categories is refused
const categoryNames: [string, number][] = []

for (const name of namesOf('gcValueSets')) {
  const runs = runsOf(`General_Category=${name}`)

  if (!runs) {
    continue
  }

  const held = new Set<number>()

  for (const [s, e] of runs) {
    for (let c = s; c <= e; c++) {
      held.add(categoryOf[c]!)
    }
  }

  // Cs is never in the text: a name whose every other category matched may hold it too
  if (name === 'C' || name === 'Other' || name === 'Cs' || name === 'Surrogate') {
    held.add(CATEGORIES.indexOf('Cs'))
  }

  let mask = 0

  for (const id of held) {
    mask += 2 ** id
  }

  const size = runs.reduce((n, [s, e]) => n + e - s + 1, 0)
  const expected = [...held].reduce(
    (n, id) => n + (id === CATEGORIES.indexOf('Cs') ? 0 : categorySets[id]!.reduce((m, [s, e]) => m + e - s + 1, 0)),
    0,
  )

  if (size !== expected) {
    throw new Error(`General_Category=${name} is not a union of categories (${size} against ${expected})`)
  }

  categoryNames.push([name, mask])
}

// Script: each name probed, aliases told apart by holding the same code points
const scriptOf = new Int16Array(LAST + 1).fill(-1)
const scripts: { names: string[]; runs: Run[] }[] = []

for (const name of namesOf('scValueSets')) {
  const runs = runsOf(`Script=${name}`)

  if (!runs || runs.length === 0) {
    continue
  }

  const same = scripts.find(s => equal(s.runs, runs))

  if (same) {
    same.names.push(name)
    continue
  }

  scripts.push({ names: [name], runs })
}

for (const [id, script] of scripts.entries()) {
  for (const [s, e] of script.runs) {
    scriptOf.fill(id, s, e + 1)
  }
}

const unknown = scripts.findIndex(s => s.names.includes('Unknown'))
let assignedWithoutScript = 0

for (let c = 0; c <= LAST; c++) {
  if (scriptOf[c] === -1) {
    // a code point no listed script holds: a script newer than regexpp's list. Counted, and given Unknown
    if (categoryOf[c] !== CATEGORIES.indexOf('Cn') && categoryOf[c] !== CATEGORIES.indexOf('Cs')) {
      assignedWithoutScript++
    }

    scriptOf[c] = unknown
  }
}

const scriptRuns: number[][] = []

for (let c = 0; c <= LAST; c++) {
  const last = scriptRuns.at(-1)

  if (last && last[2] === scriptOf[c] && last[1] === c - 1) {
    last[1] = c
  } else {
    scriptRuns.push([c, c, scriptOf[c]!])
  }
}

// the binary properties, aliases folded together the same way
const binaries: { names: string[]; runs: Run[] }[] = []

for (const name of namesOf('binPropertySets')) {
  const runs = runsOf(name)

  if (!runs) {
    continue
  }

  const same = binaries.find(b => equal(b.runs, runs))

  // two DIFFERENT properties can hold the same code points (Any and Assigned do not, but a pair might), so a name
  // joins an existing entry only when it is that entry's documented alias: the shorter spelling of the same thing
  if (same && same.names.some(n => n.length !== name.length)) {
    same.names.push(name)
    continue
  }

  binaries.push({ names: [name], runs })
}

// simple case folding, from V8's `/iu`. Candidates come from the single code point case mappings, each one checked
// with the engine, joined into classes
const parent = new Int32Array(LAST + 1).map((_, i) => i)
const findRoot = (c: number): number => {
  while (parent[c] !== c) {
    parent[c] = parent[parent[c]!]!
    c = parent[c]!
  }

  return c
}

const single = (s: string) => (s.length > 0 && [...s].length === 1 ? s.codePointAt(0)! : undefined)

for (const c of scalars) {
  const ch = String.fromCodePoint(c)
  const candidates = new Set<number>()

  for (const mapped of [ch.toLowerCase(), ch.toUpperCase()]) {
    const d = single(mapped)

    if (d !== undefined && d !== c) {
      candidates.add(d)

      for (const again of [mapped.toLowerCase(), mapped.toUpperCase()]) {
        const e = single(again)

        if (e !== undefined && e !== c) {
          candidates.add(e)
        }
      }
    }
  }

  for (const d of candidates) {
    const escaped = `\\u{${c.toString(16)}}`

    if (new RegExp(`^${escaped}$`, 'iu').test(String.fromCodePoint(d))) {
      const a = findRoot(c)
      const b = findRoot(d)

      if (a !== b) {
        parent[Math.max(a, b)] = Math.min(a, b)
      }
    }
  }
}

const members = new Map<number, number[]>()

for (const c of scalars) {
  const r = findRoot(c)
  const list = members.get(r)

  if (list) {
    list.push(c)
  } else {
    members.set(r, [c])
  }
}

const foldPairs: [number, number][] = []

for (const list of members.values()) {
  if (list.length < 2) {
    continue
  }

  const least = Math.min(...list)

  for (const c of list) {
    foldPairs.push([c, least])
  }
}

foldPairs.sort((a, b) => a[0] - b[0])

// write
const lines: string[] = []
const push = (line: string) => lines.push(line)
// A table is TEXT, not a list of `code` lines: a list of 40,000 numbers would be compiled into every program that loads
// the pattern module, where text is one constant decoded only when a pattern asks for that table (./unicode-read.tree).
// Numbers are base 36, separated by commas, and broken into chunks of at most 96 characters, one `text` line each,
// because a line stays under 120 columns. A table whose rows are tied together (one per binary property) separates
// them with `;`.
const CHUNK = 96

const chunked = (name: string, body: string) => {
  push(`host ${name}`)
  push('  make list')

  for (let i = 0; i < body.length; i += CHUNK) {
    push(`    text <${body.slice(i, i + CHUNK)}>`)
  }

  push('')
}

const encode = (list: number[]) => list.map(n => n.toString(36)).join(',')
// names are separated by commas too, so a chunk never starts or ends on a space a reader might trim
const texts = (name: string, list: string[]) => chunked(name, list.join(','))
const numbers = (name: string, list: number[]) => chunked(name, encode(list))

// runs over the whole code space as (length - 1, value) pairs: the start of each is where the last ended
const covering = (runs: number[][]) => runs.flatMap(([s, e, v]) => [e! - s!, v!])

// runs of a set as (gap, length - 1) pairs: the gap from the end of the run before, plus one
const gapped = (runs: Run[]) => {
  let next = 0

  return runs.flatMap(([s, e]) => {
    const pair = [s - next, e - s]

    next = e + 1

    return pair
  })
}

// a word character for `\b` and `\w` under Unicode: a letter, a mark, a number or connector punctuation (the spec's
// one definition, note/project/term/stdlib/regex-engine.md)
const wordRuns: Run[] = []

for (let c = 0; c <= LAST; c++) {
  const code = CATEGORIES[categoryOf[c]!]!
  const word = code[0] === 'L' || code[0] === 'M' || code[0] === 'N' || code === 'Pc'
  const last = wordRuns.at(-1)

  if (!word) {
    continue
  }

  if (last && last[1] === c - 1) {
    last[1] = c
  } else {
    wordRuns.push([c, c])
  }
}

push('')
push('# GENERATED by `pnpm term:pattern-unicode --commit` from the V8 in Node, asked through its own `\\p{…}` and `/iu`.')
push('# Do not edit: rerun. `pnpm term:pattern-unicode` fails when this file drifts. ./unicode-read.tree reads it.')
push('#')
push(`# Unicode ${process.versions.unicode}, V8 ${process.versions.v8}. Property names from @eslint-community/regexpp 4.12.1.`)
push('')
push(`host unicode-version, text <${process.versions.unicode}>`)
push('')
push('# the 30 two-letter General_Category codes, numbered from 0 in this order')
texts('category-codes', CATEGORIES)
push('# each General_Category name, and the bit mask over the 30 codes it covers, in the same order')
texts('category-names', categoryNames.map(n => n[0]))
numbers('category-masks', categoryNames.map(n => n[1]))
push(`# ${categoryRuns.length} runs covering U+0000 to U+10FFFF, each (length - 1, category)`)
numbers('category-table', covering(categoryRuns))
push(`# ${wordRuns.length} runs of word characters (L, M, N, Pc), each (gap, length - 1)`)
numbers('word-table', gapped(wordRuns))
push('# each Script name and alias, and the id of the script it names, in the same order')
texts('script-names', scripts.flatMap(s => s.names))
numbers('script-name-ids', scripts.flatMap((s, id) => s.names.map(() => id)))
push(`# ${scriptRuns.length} runs covering U+0000 to U+10FFFF, each (length - 1, script)`)
numbers('script-table', covering(scriptRuns))
push('# each binary property name and alias, and the index of its row in binary-table, in the same order')
texts('binary-names', binaries.flatMap(b => b.names))
numbers('binary-name-ids', binaries.flatMap((b, id) => b.names.map(() => id)))
push(`# ${binaries.length} rows separated by semicolons, each a property's runs as (gap, length - 1)`)
chunked('binary-table', binaries.map(b => encode(gapped(b.runs))).join(';'))
push(`# ${foldPairs.length} pairs, each (code point minus the one before, code point minus the least member of its case`)
push('# class), ordered by code point. Two code points match under `i` exactly when their least members are equal')
numbers(
  'fold-table',
  foldPairs.flatMap(([c, least], i) => [c - (i === 0 ? 0 : foldPairs[i - 1]![0]), c - least]),
)

// the same classes grouped, for closing a set under case: each class as its member count, its least member minus the
// least member of the class before, then each other member minus the least
const classes = new Map<number, number[]>()

for (const [c, least] of foldPairs) {
  classes.set(least, [...(classes.get(least) ?? []), c])
}

const classRows: number[] = []
let previousLeast = 0

for (const least of [...classes.keys()].sort((a, b) => a - b)) {
  const others = classes.get(least)!.filter(c => c !== least).sort((a, b) => a - b)

  classRows.push(others.length + 1, least - previousLeast, ...others.map(c => c - least))
  previousLeast = least
}

push(`# ${classes.size} case classes, each (member count, least member minus the least member of the class before,`)
push('# then each other member minus the least), ordered by least member')
numbers('fold-classes', classRows)

const text = `${lines.join('\n')}\n`
const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : undefined
const binaryRunCount = binaries.reduce((n, b) => n + b.runs.length, 0)

console.log(`pattern-unicode: Unicode ${process.versions.unicode} -> ${relative(REPO, OUT)}`)
console.log(`  category: ${categoryRuns.length} runs, ${categoryNames.length} names`)
console.log(`  script: ${scripts.length} scripts, ${scriptRuns.length} runs`)
console.log(`  assigned code points in no listed script (a script newer than the name list): ${assignedWithoutScript}`)
console.log(`  binary: ${binaries.length} properties, ${binaryRunCount} runs`)
console.log(`  fold: ${foldPairs.length} pairs in ${new Set(foldPairs.map(p => p[1])).size} classes`)
console.log(`  ${text.length} bytes`)

if (commit) {
  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, text)
  console.log('  written')
} else if (current !== text) {
  console.log(`  ${current === undefined ? 'missing' : 'DRIFTED'}: rerun with --commit`)
  process.exit(1)
} else {
  console.log('  in step')
}
