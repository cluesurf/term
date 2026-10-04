// The `test` preprocessor. A test file is ordinary Seed plus `test <phrase>` blocks. This rewrites each block, before
// the compiler sees it, into a top-level async task that returns whether the test held: every assertion (`want hold` /
// `want miss`) becomes a fail-fast guard, and the task ends `send back, true`. Helper `task`/`form`/`load`/`host`
// declarations are passed through untouched. This is used by `term test` (the CLI runner). When the self-hosting mill
// consumes the `test` grammar (term.tree/code/code/test), this step folds into the mint with no change to any test
// file. See note/library/seed/test-dsl.md.

import type { Diagnostic, Position, Span } from '@term/make/code/parser/diagnostic'

// the one assertion head, `want`, with a mode named for the fork branch it requires: `want hold` asserts its body (a
// boolean expression) is true (it holds), `want miss` asserts it is false (it misses). The body holds the actual
// `call` to whatever predicate (`is-equal`, `contains`, any boolean task) — `want` does not delegate to a comparator,
// it wraps the expression already written inside it.
const ASSERTION = 'want'

const indentOf = (line: string): number =>
  line.length - line.trimStart().length

const blank = (line: string): boolean => line.trim().length === 0

function slugify(phrase: string): string {
  return (
    phrase
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'case'
  )
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
function guard(group: string[], line: number): string[] {
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

  const failOn = mode === 'miss' ? 'hook hold' : 'hook miss'

  return [
    '  fork test',
    '    hook test',
    ...condition,
    `    ${failOn}`,
    `      halt <${WANT_FAILED}${line + 1}>`,
  ]
}

// the marker a failing `want` raises, and its reader: the source line the marker names, or undefined for any other
// raise, which is the test's own failure and reported as it is
const WANT_FAILED = 'want:'

export function wantFailed(note: string | undefined, source: string): string | undefined {
  const line = wantLine(note)

  return line !== undefined
    ? `line ${line + 1} did not hold: ${source.split('\n')[line]?.trim() ?? ''}`
    : undefined
}

// the line, counted from zero, of the `want` a failing test's marker names, or undefined for any other raise
export function wantLine(note: string | undefined): number | undefined {
  const line = note?.startsWith(WANT_FAILED) ? Number(note.slice(WANT_FAILED.length)) : NaN

  return Number.isInteger(line) && line > 0 ? line - 1 : undefined
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

export function preprocessTests(source: string): Preprocessed {
  const lines = source.split('\n')
  const out: string[] = []
  const origin: number[] = []
  const labels = new Map<string, string>()
  const heads = new Map<string, number>()
  const taken = takenNames(lines)

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
        const written = guard(group.map(n => lines[n]!), group[0]!)
        // two lines of `fork test` / `hook test`, the condition, then two of the failing branch. The condition
        // is the inline expression (one line, from the `want` line) or the lines under the `want`, one for one.
        const inline = /^want(?:\s+(?:hold|miss))?\s*,/.test(
          lines[group[0]!]!.trim(),
        )
        const conditionFrom = inline ? [group[0]!] : group.slice(1)

        const from = [
          group[0]!,
          group[0]!,
          ...conditionFrom,
          group[0]!,
          group[0]!,
        ]

        written.forEach((text, n) => emit(text, from[n] ?? group[0]!))
      } else {
        group.forEach(n => emit(lines[n]!, n))
      }
    }

    emit('  send back', at)
    emit('    true', at)
  }

  return { text: out.join('\n'), labels, origin, heads }
}
