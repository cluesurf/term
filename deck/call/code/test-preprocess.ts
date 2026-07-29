// The `test` preprocessor. A test file is ordinary Seed plus `test <phrase>` blocks. This rewrites each block, before
// the compiler sees it, into a top-level async task that returns whether the test held: every assertion (`want hold` /
// `want miss`) becomes a fail-fast guard, and the task ends `send back, true`. Helper `task`/`form`/`load`/`host`
// declarations are passed through untouched. This is used by `seed test` (the CLI runner). When the self-hosting mill
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
function statements(body: string[], base: number): string[][] {
  const groups: string[][] = []

  for (const line of body) {
    if (!blank(line) && indentOf(line) === base) {
      groups.push([line])
    } else if (groups.length > 0) {
      groups[groups.length - 1]!.push(line)
    }
  }

  return groups
}

// a fail-fast guard around one assertion. `want hold` / `want miss` followed by a boolean expression becomes a
// `fork test` whose condition is that expression (re-indented under `hook test`). The result is tracked into the test
// by failing the task on the wrong branch: `want hold` fails when the expression misses (`hook miss`), `want miss`
// fails when it holds (`hook hold`).
function guard(group: string[]): string[] {
  const mode = group[0]!.trim().split(/\s+/)[1] ?? 'hold'
  // the body (everything under the `want` line) is the boolean condition; shift it +2 to sit under `hook test`
  const condition = group
    .slice(1)
    .map(line => (blank(line) ? line : `  ${line}`))

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

export type Preprocessed = { text: string; labels: Map<string, string> }

export function preprocessTests(source: string): Preprocessed {
  const lines = source.split('\n')
  const out: string[] = []
  const labels = new Map<string, string>()

  let i = 0

  while (i < lines.length) {
    const line = lines[i]!
    const header = /^test (.+)$/.exec(line)

    if (!header || indentOf(line) !== 0) {
      out.push(line)
      i++
      continue
    }

    const { slug, label } = parseName(header[1]!)
    labels.set(slug, label)
    // gather the block body: the following lines that are blank or indented
    i++

    const body: string[] = []

    while (
      i < lines.length &&
      (blank(lines[i]!) || indentOf(lines[i]!) >= 2)
    ) {
      body.push(lines[i]!)
      i++
    }

    // emit the task: setup statements pass through, assertions become guards, then `send back, true`
    out.push(`task ${slug}`, '  mark async', '  like boolean')

    for (const group of statements(body, 2)) {
      const head = group[0]!.trim().split(/[\s,]/)[0]!

      if (head === ASSERTION) {
        out.push(...guard(group))
      } else {
        out.push(...group)
      }
    }

    out.push('  send back', '    true')
  }

  return { text: out.join('\n'), labels }
}
