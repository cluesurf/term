// The `test` preprocessor. A test file is ordinary Seed plus `test <phrase>` blocks. This rewrites each block, before
// the compiler sees it, into a top-level async task that returns whether the test held: every assertion (`want hold` /
// `want miss`) becomes a fail-fast guard, and the task ends `send back, true`. Helper `task`/`form`/`load`/`host`
// declarations are passed through untouched. This is used by `term test` (the CLI runner). When the self-hosting mill
// consumes the `test` grammar (term.tree/code/code/test), this step folds into the mint with no change to any test
// file. See note/library/seed/test-dsl.md.

import type { Diagnostic, Position, Span } from '@term/make/code/parser/diagnostic'
import { parseTolerant, renderHead } from '@term/make/code/parser/tree'
import { groupsOf } from '@term/make/code/parser/narrow'
import type { Node } from '@term/make/code/parser/tree'
import { tokenize } from '@term/make/code/parser/token'

// the one assertion head, `want`, with a mode named for the fork branch it requires: `want hold` asserts its body (a
// boolean expression) is true (it holds), `want miss` asserts it is false (it misses). The body holds the actual
// `call` to whatever predicate (`is-equal`, `contains`, any boolean task) — `want` does not delegate to a comparator,
// it wraps the expression already written inside it.
const ASSERTION = 'want'

const indentOf = (line: string): number =>
  line.length - line.trimStart().length

const blank = (line: string): boolean => line.trim().length === 0

// A slug that would start with a digit takes a leading `test-`: a name cannot, and `test <2a + 3b + 1 is found>`
// became `task 2a-3b-1-is-found`, emitted as an identifier esbuild refused ("Syntax error "a"", 2026-10-05,
// deck/test/test/affine-synthesis.tree). test/call/test-slug.ts
function slugify(phrase: string): string {
  const slug =
    phrase
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'case'

  return /^[0-9]/.test(slug) ? `test-${slug}` : slug
}

// the name a `test` header declares: a `<free text>` phrase, or a bare slug. Returns the slug (the task name) and the
// display label (the phrase verbatim, or the slug with dashes shown as spaces).
function parseName(rest: string): { slug: string; label: string } {
  const phrase = /^<(.+)>$/.exec(rest)

  if (phrase) {
    return { slug: slugify(phrase[1]!), label: phrase[1]! }
  }

  const bare = rest.trim()

  return { slug: bare, label: bare.replace(/-/g, ' ') }
}

// split a block body into its top-level statement groups: each starts at the body's base indent and includes the
// deeper lines under it (and trailing blank lines stay with the preceding group)
// Each group is the source LINE NUMBERS it holds, so the caller can say where every output line came from.
function statements(
  lines: string[],
  body: number[],
  base: number,
): number[][] {
  const groups: number[][] = []

  for (const at of body) {
    const line = lines[at]!

    if (!blank(line) && indentOf(line) === base) {
      groups.push([at])
    } else if (groups.length > 0) {
      groups[groups.length - 1]!.push(at)
    }
  }

  return groups
}

// a fail-fast guard around one assertion. `want hold` / `want miss` followed by a boolean expression becomes a
// `fork test` whose condition is that expression (re-indented under `hook test`). The result is tracked into the test
// by failing the task on the wrong branch: `want hold` fails when the expression misses (`hook miss`), `want miss`
// fails when it holds (`hook hold`). It fails by raising `want:<line>`, the `want`'s line in the file counted from
// one, which `term test` reads back as the line itself (`wantFailed`). It sent back `false`, and a failing test
// printed only its phrase (guides: commands/test, tests/writing, 2026-10-04).
//
// A CONDITION THAT COMPARES TWO VALUES (`is-equal double(0), 1`, any of COMPARISONS) saves each value first, compares
// the two saved, and raises them with the marker, as `want-missed` (WANT_PRELUDE), so the failure can say what it
// compared: `left 0, right 1`. It named the line and never the values (guides: commands/test, 2026-10-05). The two
// values are found by the compiler's own parser, never a pattern, and each is the source text of its node, so it
// means what it meant inside the comparison. Any other condition, or one whose value spans lines, raises the marker
// alone. Each line comes back with the source line it came from.
function guard(group: string[], numbers: number[], plain = false): { lines: string[]; from: number[] } {
  const line = numbers[0]!
  // the head line is `want <mode>` with the condition indented under it, or the one-line form
  // `want <mode>, <expr>` with the condition inline after the comma. The inline expression used to
  // be dropped on the floor (an empty condition, so the test failed no matter what it said).
  const head = /^want(?:\s+(hold|miss))?\s*(?:,\s*(.*))?$/.exec(
    group[0]!.trim(),
  )
  const mode = head?.[1] ?? 'hold'
  const inline = head?.[2]?.trim()
  // the body (everything under the `want` line) is the boolean condition; shift it +2 to sit under `hook test`
  const condition = inline
    ? [`      ${inline}`]
    : group.slice(1).map(line => (blank(line) ? line : `  ${line}`))
  const conditionFrom = inline ? [line] : numbers.slice(1)

  const failOn = mode === 'miss' ? 'hook hold' : 'hook miss'
  const compared = plain
    ? undefined
    : comparison(
        inline
          ? [{ text: inline, from: line }]
          : group.slice(1).map((text, at) => ({ text, from: numbers[at + 1]! })).filter(row => !blank(row.text)),
      )

  if (compared) {
    const left = `want-left-${line + 1}`
    const right = `want-right-${line + 1}`
    const saved = [...saveOf(left, compared.left, line), ...saveOf(right, compared.right, line)]
    const rest = [
      '  fork test',
      '    hook test',
      `      ${compared.head}`,
      `        read ${left}`,
      `        read ${right}`,
      `    ${failOn}`,
      '      halt want-missed',
      `        bind thing, <${WANT_FAILED}${line + 1}>`,
      `        bind left, read ${left}`,
      `        bind right, read ${right}`,
    ]

    // each value's lines keep their own source line, so an error inside a value is placed where it was written
    return {
      lines: [...saved.map(row => row.text), ...rest],
      from: [...saved.map(row => row.from), ...rest.map(() => line)],
    }
  }

  return {
    lines: [
      '  fork test',
      '    hook test',
      ...condition,
      `    ${failOn}`,
      `      halt <${WANT_FAILED}${line + 1}>`,
    ],
    from: [line, line, ...conditionFrom, line, line],
  }
}

// the comparisons whose two values a failing `want` reports
const COMPARISONS = new Set(['is-equal', 'is-unequal', 'is-above', 'is-below', 'is-minimum', 'is-maximum'])

// a condition that is ONE comparison of two values: the comparison and each value's own source text. The pieces are
// cut at the comparison's top-level commas (inline) or are its two lines (stacked), and each is then read again by
// the compiler's parser as `save x, <piece>` and must give back exactly the node the comparison holds. Where the
// comma rule nests a value differently from the cut, or a value spans lines, the check fails and the `want` keeps
// the plain marker, so the rewrite can never change what is compared
//
// The comparison is its word (`is-equal a, b`) or, in longhand, `call is-equal` with the two values on the lines under
// it. A value is the lines it was written on, one or several, dedented
type Row = { text: string; from: number }

function comparison(rows: Row[]): { head: string; left: Row[]; right: Row[] } | undefined {
  // the condition's lines at their own indent, so the comparison is a top-level group
  const base = Math.min(...rows.map(row => indentOf(row.text)))
  const flat = rows.map(row => ({ text: row.text.slice(base), from: row.from }))
  const source = flat.map(row => row.text).join('\n')
  const parsed = parseTolerant({ file: 'want.tree', text: source })

  if (parsed.diagnostics.length > 0 || parsed.tree.nodes.length !== 1) {
    return undefined
  }

  const group = groupsOf(parsed.tree.nodes)[0]

  if (!group) {
    return undefined
  }

  const head = group.nodes[0]
  const first = head?.kind === 'name' ? renderHead(head) : undefined
  // `call is-equal`: the comparison is the word under `call`, and the values follow it
  const inner = first === 'call' ? group.nodes[1] : undefined
  const named = inner?.kind === 'group' && inner.nodes.length === 1 && inner.nodes[0]?.kind === 'name' ? renderHead(inner.nodes[0]) : undefined
  const word = first === 'call' ? named : first
  const values = group.nodes.slice(first === 'call' ? 2 : 1)

  if (word === undefined || !COMPARISONS.has(word) || values.length !== 2) {
    return undefined
  }

  // inline, the pieces are cut at the commas. Stacked, each value starts at a line one level in and holds the deeper
  // lines after it
  // an inline value is a piece of the `want` line, and a stacked one is lines of its own, kept as written
  const pieces: Row[][] = []

  if (flat.length === 1) {
    pieces.push(...inlineArguments(source).map(piece => [{ text: piece, from: flat[0]!.from }]))
  } else {
    for (const row of flat.slice(1)) {
      if (indentOf(row.text) === 2) {
        pieces.push([{ text: row.text.slice(2), from: row.from }])
      } else if (indentOf(row.text) > 2 && pieces.length > 0) {
        pieces[pieces.length - 1]!.push({ text: row.text.slice(2), from: row.from })
      } else {
        return undefined
      }
    }
  }

  const stacked = flat.length > 1

  if (pieces.length !== 2 || !pieces.every((piece, at) => readsAs(piece, stacked, values[at]!))) {
    return undefined
  }

  return { head: first === 'call' ? `call ${word}` : word, left: pieces[0]!, right: pieces[1]! }
}

// `save <name>` of a value: on its line when it was written inline, else the value's own lines under it, each the
// text the person wrote at another indent, so a diagnostic on one is placed back on its line and column. The `save`
// line itself is placed on the `want`
function saveOf(name: string, value: Row[], want: number, stacked = value.length > 1 || value[0]!.from !== want): Row[] {
  return stacked
    ? [{ text: `  save ${name}`, from: want }, ...value.map(row => ({ text: `    ${row.text}`, from: row.from }))]
    : [{ text: `  save ${name}, ${value[0]!.text}`, from: want }]
}

// the text after the first word of a one-line call, cut at its top-level commas: outside parentheses, text and braces
function inlineArguments(line: string): string[] {
  const tokens = tokenize({ file: 'want.tree', text: line })

  if (tokens.diagnostics.length > 0) {
    return []
  }

  // each piece is the line between two cuts, as written, so an escape inside a text survives
  const cuts: number[] = []
  let start: number | undefined
  let depth = 0
  let past = false

  for (const token of tokens.tokens.list) {
    if (!past) {
      // the comparison's own word and the space after it
      past = token.kind === 'space'
      start = past ? token.span.end.column : undefined
      continue
    }

    if (token.kind === 'open-paren' || token.kind === 'open-angle' || token.kind === 'open-brace') {
      depth++
    } else if (token.kind === 'close-paren' || token.kind === 'close-angle' || token.kind === 'close-brace') {
      depth--
    }

    if (token.kind === 'comma' && depth === 0) {
      cuts.push(token.span.start.column)
    }
  }

  if (start === undefined) {
    return []
  }

  const ends = [...cuts, line.length]
  const begins = [start, ...cuts.map(cut => cut + 1)]

  return begins.map((begin, at) => line.slice(begin, ends[at]).trim()).filter(one => one.length > 0)
}

// does `save x` of a piece hold, beside `x`, exactly the node `want`
function readsAs(piece: Row[], stacked: boolean, want: Node): boolean {
  const written = saveOf('x', piece, -1, stacked).map(row => row.text.slice(2))
  const parsed = parseTolerant({ file: 'want.tree', text: written.join('\n') })
  const saved = parsed.diagnostics.length === 0 ? groupsOf(parsed.tree.nodes)[0]?.nodes.slice(2) : undefined

  return saved?.length === 1 && shapeOf(saved[0]!) === shapeOf(want)
}

// a node's structure, for comparing two parses: kinds and words, spans and comments aside
function shapeOf(node: Node): string {
  return node.kind === 'group' ? `(${node.nodes.map(shapeOf).join(' ')})` : `${node.kind}:${renderHead(node)}`
}

// declared once in a file whose `want`s compare values: the exception `guard` raises with the two values, a `failure`
// with two more fields. The alias keeps it apart from a `failure` the file imports itself
const WANT_PRELUDE = [
  'load @term/base/exception',
  '  find failure, name want-failure',
  '',
  'form want-missed',
  '  like want-failure',
  '    link left, like unknown',
  '    link right, like unknown',
  '',
]

// the marker a failing `want` raises, and its reader: the source line the marker names, or undefined for any other
// raise, which is the test's own failure and reported as it is
const WANT_FAILED = 'want:'

// The line a failing `want` names, and, for a comparison, the two values it compared:
// `line 12 did not hold: want hold, is-equal double(0), 1, left 0, right 1`. `raised` is what the test threw
export function wantFailed(raised: unknown, source: string): string | undefined {
  const line = wantLine(raised)

  if (line === undefined) {
    return undefined
  }

  const said = `line ${line + 1} did not hold: ${source.split('\n')[line]?.trim() ?? ''}`
  const link = linkOf(raised)

  return link && 'left' in link && 'right' in link ? `${said}, left ${shown(link.left)}, right ${shown(link.right)}` : said
}

// the line, counted from zero, of the `want` a failing test's marker names, or undefined for any other raise. The
// marker is the raise's `note` (`halt <want:12>`), or its `thing` when the raise carries the compared values
export function wantLine(raised: unknown): number | undefined {
  const note = (raised as { note?: unknown } | null)?.note
  const thing = linkOf(raised)?.thing
  const marker = typeof thing === 'string' && thing.startsWith(WANT_FAILED) ? thing : typeof note === 'string' ? note : undefined
  const line = marker?.startsWith(WANT_FAILED) ? Number(marker.slice(WANT_FAILED.length)) : NaN

  return Number.isInteger(line) && line > 0 ? line - 1 : undefined
}

function linkOf(raised: unknown): Record<string, unknown> | undefined {
  const link = (raised as { link?: unknown } | null)?.link

  return typeof link === 'object' && link !== null ? (link as Record<string, unknown>) : undefined
}

// a value as Term writes it: a text in angle brackets, a list in brackets, a hash or a record in braces, a `maybe` by
// its case. Tests run on node, so this reads the emitted TypeScript value
function shown(value: unknown, depth = 0): string {
  if (typeof value === 'string') {
    return `<${value}>`
  }

  if (typeof value !== 'object' || value === null) {
    return value === undefined ? 'void' : String(value)
  }

  if (depth > 3) {
    return '...'
  }

  if (value instanceof Uint8Array) {
    return `bytes(${value.length})`
  }

  if (Array.isArray(value)) {
    return `[${value.map(item => shown(item, depth + 1)).join(', ')}]`
  }

  if (value instanceof Map) {
    return `{${[...value].map(([key, item]) => `${shown(key, depth + 1)}: ${shown(item, depth + 1)}`).join(', ')}}`
  }

  if (value instanceof Set) {
    return `set[${[...value].map(item => shown(item, depth + 1)).join(', ')}]`
  }

  const record = value as Record<string, unknown>

  if (record.form === 'none' && Object.keys(record).length === 1) {
    return 'none'
  }

  return `{${Object.entries(record)
    .map(([key, item]) => `${key}: ${shown(item, depth + 1)}`)
    .join(', ')}}`
}

// `origin[n]` is the source line that output line `n` came from, so a diagnostic on the rewritten text can be put
// back on the line the author wrote. A line that passes through keeps its text, so its columns hold as well. The
// language server reads it: without it, every diagnostic in a test file landed on whatever line the expansion had
// pushed it to.
export type Preprocessed = {
  text: string
  labels: Map<string, string>
  origin: number[]
  // each test's `test <phrase>` line, counted from zero, by its task name: where a failing test points
  heads: Map<string, number>
}

// The names a test's task must not take: what the file defines (`task`, `form`, `rule`, `bind`, `host`) and what it
// finds. A test named `trim` beside `find trim` became `task trim` and replaced the import, so the call inside it
// reached the test itself ("trim" takes 0 arguments), and `test <name>` beside `rule <name>` filled the claim with a
// boolean task that proved nothing (guides: tests/writing, proofs/claims, 2026-10-03)
function takenNames(lines: string[]): Set<string> {
  const taken = new Set<string>()

  for (const line of lines) {
    const defined = /^(?:task|form|rule|bind|host)\s+([^\s,]+)/.exec(line)
    const found = /^\s+find\s+([^\s,]+)(?:.*,\s*name\s+([^\s,]+))?/.exec(line)

    if (defined) {
      taken.add(defined[1]!)
    }

    if (found) {
      taken.add(found[2] ?? found[1]!)
    }
  }

  return taken
}

// does a file carry `test <phrase>` blocks, and so need rewriting before the compiler can read it
export function carriesTests(source: string): boolean {
  return /^\s*test /m.test(source)
}

// One file as the compiler reads it: a file of `test` blocks rewritten, any other as written. `place` moves a
// diagnostic raised against the rewritten text back onto the lines the person wrote, and hands back the text its
// frame should quote. A test file's errors pointed into the rewritten text, a line the reader never wrote, until
// 2026-10-04 (guides: commands/test). `term make`, `test`, `roll`, `time` and `hold` all compile through this.
export function readable(source: string): {
  text: string
  place: (diagnostic: Diagnostic) => { diagnostic: Diagnostic; text: string }
} {
  if (!carriesTests(source)) {
    return { text: source, place: diagnostic => ({ diagnostic, text: source }) }
  }

  const rewritten = preprocessTests(source)
  const from = source.split('\n')
  const to = rewritten.text.split('\n')

  // a rewritten line keeps its source line's text, perhaps at another indent, so a column moves by the difference.
  // A line the rewrite made up (a guard, `send back, true`) points at the start of the line it came from
  const at = (position: Position): Position => {
    const line = rewritten.origin[position.line] ?? position.line
    const written = from[line] ?? ''
    const compiled = to[position.line] ?? ''
    const column =
      compiled.trim() === written.trim()
        ? position.column + indentOf(written) - indentOf(compiled)
        : indentOf(written)

    return { line, column: Math.max(0, Math.min(written.length, column)) }
  }
  const span = (s: Span): Span => ({ ...s, start: at(s.start), end: at(s.end) })

  return {
    text: rewritten.text,
    place: diagnostic => ({
      diagnostic: {
        ...diagnostic,
        span: span(diagnostic.span),
        markers: diagnostic.markers.map(m => ({ ...m, span: span(m.span) })),
      },
      text: source,
    }),
  }
}

// `plainWants`: every `want` raises the plain marker (`halt <want:12>`), never the two values it compared. A native
// backend's report reads a raise's `note` and cannot read the values a `want-missed` carries in its `link`, a generic
// field that is a boxed dynamic there, so a run on Rust, Swift or Kotlin (`term test --env`) names the line that did not
// hold and not the values (call/code/test-native.ts)
export function preprocessTests(source: string, options: { plainWants?: boolean } = {}): Preprocessed {
  const lines = source.split('\n')
  const out: string[] = []
  const origin: number[] = []
  const labels = new Map<string, string>()
  const heads = new Map<string, number>()
  const taken = takenNames(lines)
  // whether a `want` compares two values, so the file needs WANT_PRELUDE
  let compares = false

  const emit = (text: string, from: number): void => {
    out.push(text)
    origin.push(from)
  }

  let i = 0

  while (i < lines.length) {
    const line = lines[i]!
    const header = /^test (.+)$/.exec(line)

    if (!header || indentOf(line) !== 0) {
      emit(line, i)
      i++
      continue
    }

    const at = i
    const parsed = parseName(header[1]!)
    const label = parsed.label
    // a test whose name the file already uses for something else gets a task name of its own
    const slug = taken.has(parsed.slug) ? `${parsed.slug}-test` : parsed.slug
    labels.set(slug, label)
    heads.set(slug, at)
    // gather the block body: the following lines that are blank or indented
    i++

    const body: number[] = []

    while (
      i < lines.length &&
      (blank(lines[i]!) || indentOf(lines[i]!) >= 2)
    ) {
      body.push(i)
      i++
    }

    // emit the task: setup statements pass through, assertions become guards, then `send back, true`
    emit(`task ${slug}`, at)
    emit('  mark async', at)
    emit('  like boolean', at)

    for (const group of statements(lines, body, 2)) {
      const head = lines[group[0]!]!.trim().split(/[\s,]/)[0]!

      if (head === ASSERTION) {
        const written = guard(group.map(n => lines[n]!), group, options.plainWants === true)

        compares ||= written.lines.some(text => text.trim() === 'halt want-missed')
        written.lines.forEach((text, n) => emit(text, written.from[n] ?? group[0]!))
      } else {
        group.forEach(n => emit(lines[n]!, n))
      }
    }

    emit('  send back', at)
    emit('    true', at)
  }

  // the exception a comparing `want` raises, declared once above everything, each of its lines placed on line 1
  if (compares) {
    out.unshift(...WANT_PRELUDE)
    origin.unshift(...WANT_PRELUDE.map(() => 0))
  }

  return { text: out.join('\n'), labels, origin, heads }
}
