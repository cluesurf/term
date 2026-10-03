// The `test` preprocessor. A test file is ordinary Seed plus `test <phrase>` blocks. This rewrites each block, before
// the compiler sees it, into a top-level async task that returns whether the test held: every assertion (`want hold` /
// `want miss`) becomes a fail-fast guard, and the task ends `send back, true`. Helper `task`/`form`/`load`/`host`
// declarations are passed through untouched. This is used by `term test` (the CLI runner). When the self-hosting mill
// consumes the `test` grammar (term.tree/code/code/test), this step folds into the mint with no change to any test
// file. See note/library/seed/test-dsl.md.

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
// fails when it holds (`hook hold`).
function guard(group: string[]): string[] {
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
    '      send back',
    '        false',
  ]
}

// `origin[n]` is the source line that output line `n` came from, so a diagnostic on the rewritten text can be put
// back on the line the author wrote. A line that passes through keeps its text, so its columns hold as well. The
// language server reads it: without it, every diagnostic in a test file landed on whatever line the expansion had
// pushed it to.
export type Preprocessed = {
  text: string
  labels: Map<string, string>
  origin: number[]
}

export function preprocessTests(source: string): Preprocessed {
  const lines = source.split('\n')
  const out: string[] = []
  const origin: number[] = []
  const labels = new Map<string, string>()

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
    const { slug, label } = parseName(header[1]!)
    labels.set(slug, label)
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
    emit('  note async', at)
    emit('  like boolean', at)

    for (const group of statements(lines, body, 2)) {
      const head = lines[group[0]!]!.trim().split(/[\s,]/)[0]!

      if (head === ASSERTION) {
        const written = guard(group.map(n => lines[n]!))
        // two lines of `fork test` / `hook test`, the condition, then three of the failing branch. The condition
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

  return { text: out.join('\n'), labels, origin }
}
