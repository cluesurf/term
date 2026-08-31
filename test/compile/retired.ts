// The spellings this language has RETIRED, and the messages it retires them with.
//
// WHY THIS EXISTS. Retired syntax was documented in CLAUDE.md and enforced in the mill, and nothing held the two
// together, so neither side could be trusted. This is the join.
//
// `mark <annotation>` IS NOT RETIRED, whatever the docs say, and finding that out is why this file exists.
// CLAUDE.md calls `mark async` dead syntax and says all metadata is `note`. The mill accepts `mark` alongside
// `note`, and about thirty files rely on it — most of them `link <field>, mark private` on a record field, plus
// `mark async` in the stdlib's async tasks and several fixtures here. Refusing it was tried on 2026-08-31 and
// reverted the same day: the measurement behind it was a whole-line grep that matched none of the real uses,
// which are trailing modifiers, and the change was inconsistent besides — a field's `mark private` goes through
// another path and kept working, so it would have been legal on a field and refused on a task.
//
// The doc is aspirational, not descriptive. Making it true is a migration across those files, and one spelling
// that works everywhere beats two that disagree by position. Both spellings are asserted below so that whichever
// way that decision goes, it is a deliberate edit here rather than a drift.
//
// A RETIREMENT NAMES ITS REPLACEMENT. "the name `wave` is not defined" is what a retired literal says, which
// tells a reader nothing about what to write instead. That is recorded rather than papered over.
//
// Run: npx tsx test/compile/retired.ts

import { parse } from '@term/make/code/parser/tree'
import { mill } from '@term/make/code/compile/mill'

let pass = 0
let fail = 0

function ok(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}${info ? `  ${info.slice(0, 200)}` : ''}`)
  }
}

// mill a snippet, returning its first diagnostic message, or undefined when it mills clean
function refusal(text: string): string | undefined {
  const parsed = parse({ file: 'x.tree', text })

  if (!parsed.ok) {
    return parsed.diagnostics[0]?.message
  }

  const built = mill(parsed.tree, 'x.tree')

  return built.ok ? undefined : built.diagnostics[0]?.message
}

// each retired spelling, and the word its message must name so a reader learns the replacement
const RETIRED: [string, string, string][] = [
  ['bust', 'task t\n  like void\n  bust <nope>\n', 'halt'],
  ['send kink', 'task t\n  like void\n  send kink, text <nope>\n', 'halt'],
  ['find X as Y', 'load @term/seed/code/list\n  find get as list-get\n', 'name'],
  // retired 2026-08-31: one word meant both the native FFI binding and a URL route
  ['dock </path>', 'view page\n  view text, text <hi>\n\ndock /\n  view page\n', 'hook </path>'],
]

for (const [name, text, names] of RETIRED) {
  const message = refusal(text)

  ok(`\`${name}\` is refused`, message !== undefined, 'it milled clean')

  ok(
    `and the message names \`${names}\``,
    (message ?? '').includes(names),
    message ?? '',
  )
}

// ---- the live meanings of `mark` are untouched ----
//
// `mark` is a record's durable identity and a theorem's quantified variable. form.tree holds ~2600 of the second.
// Refusing `mark <annotation>` must not touch either, and the two are told apart by SHAPE: a uuid is a text node
// rather than a group, and a variable's name is the variable, not an annotation word.

// ---- `mark` as metadata is LIVE, both spellings ----
//
// Asserted in both directions so the docs and the compiler cannot drift apart again without a test moving.

ok(
  '`mark async` still marks a task async, the same as `note async`',
  refusal('task t\n  mark async\n  like void\n  send back\n') === undefined,
  refusal('task t\n  mark async\n  like void\n  send back\n') ?? '',
)

ok(
  '`link <field>, mark private` still mills, which is most of the real uses',
  refusal('form thing\n  link dock, mark private\n  link name, like text\n') === undefined,
  refusal('form thing\n  link dock, mark private\n  link name, like text\n') ?? '',
)

ok(
  '`mark <uuid>` still mills',
  refusal('form thing\n  mark <0f7c8a12-4b3e-4c1d-9a2f-6e5d4c3b2a19>\n  link name, like text\n') === undefined,
  refusal('form thing\n  mark <0f7c8a12-4b3e-4c1d-9a2f-6e5d4c3b2a19>\n  link name, like text\n') ?? '',
)

// ---- and the FFI forms are what `dock` means now ----

ok(
  '`dock load` and `dock type` still mill',
  refusal('dock load\n  load <global:console>, name console\n\ndock type\n  load <any>, name handle\n') === undefined,
  refusal('dock load\n  load <global:console>, name console\n\ndock type\n  load <any>, name handle\n') ?? '',
)

// ---- what is retired but reports poorly ----
//
// These two DO fail the build, so nothing wrong compiles. They fail at name resolution ("the name `wave` is not
// defined") rather than with a retirement message, so a reader is told what broke and not what to write. Recorded
// as the current behaviour, and a fair thing to improve.

for (const [name, text] of [
  ['wave true', 'task t\n  like boolean\n  send back, wave true\n'],
  ['mark 42', 'task t\n  like number\n  send back, mark 42\n'],
] as const) {
  ok(
    `\`${name}\` mills, and is caught later by name resolution rather than here`,
    refusal(text) === undefined,
    'it is refused in the mill now, which is better: give it a message and move this case up',
  )
}

console.log(`\nretired: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
