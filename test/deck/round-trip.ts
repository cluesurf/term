// A manifest read and written back must still say everything it said.
//
// WHY THIS EXISTS, and it is not a hypothetical. `writeManifest` emits the MODEL and nothing else, so a field the
// model does not carry is DELETED the next time anything writes the file. Every dependency verb round-trips the
// manifest, and `term toss @nothing` — removing a dependency that was never there — used to leave a scaffolded
// project unbuildable: it dropped `bear ./code` and `boot ./code/boot`, and the next `term make` failed on an
// entry that no longer resolved. Nine of the packages in this tree lost `bear` that way, and `text`, `mark`,
// `make` and `cite` went with them. Nothing failed. The manifest just quietly said less than it had.
//
// THE FAILURE IS STRUCTURAL, not a missing case. A reader that walks past what it does not know and a writer that
// emits only what it knows will lose the next field somebody adds to the grammar, on the same day, in the same
// silence. So this holds the property rather than the list: over EVERY real `deck.tree` in the tree, every
// top-level field the file declares must still be declared after a load and a write.
//
// It compares FIELD HEADS, not text. A manifest is rewritten canonically on purpose (field order, `sort tool`
// becoming `sort <tool>`), and demanding byte equality would fail on formatting and teach nobody anything. What
// must not change is what the file SAYS.
//
// Run: npx tsx test/deck/round-trip.ts

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { parseManifest, writeManifest } from '../../deck/deck/code/manifest'
import { parse } from '@term/make/code/parser/tree'
import { headWord } from '@term/make/code/compile/mill-run'

const HERE = import.meta.dirname ?? new URL('.', import.meta.url).pathname
const TERM = join(HERE, '../..')

// how many distinct field heads the tree's own manifests use, of the 27 the grammar knows. A new one is welcome;
// it just has to survive the trip.
const CHECKED = 14

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

function manifests(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'host' || entry === 'link' || entry.startsWith('.')) {
      continue
    }

    const full = join(dir, entry)

    if (statSync(full).isDirectory()) {
      manifests(full, out)
    } else if (entry === 'deck.tree') {
      out.push(full)
    }
  }

  return out
}

// The TOP-LEVEL field heads a manifest declares: the head of each direct child of the `deck` group. Read with the
// one parser, so this cannot disagree with the compiler about what the file contains, and top-level only, because
// a child word (`sort tool`) is a value and not a field.
//
// THE FIRST TWO NODES ARE NOT FIELDS. Every word after a head is a head of its own, so `deck @term/seed` parses as
// `deck > @term/seed`: node 0 is the head word and node 1 is the PACKAGE NAME, which read as a field called
// `@term/seed` and put fifteen package names into the count before this skipped them.
function fieldsOf(file: string, text: string): Set<string> {
  const parsed = parse({ file, text })
  const out = new Set<string>()

  if (!parsed.ok) {
    return out
  }

  for (const group of parsed.tree.nodes) {
    if (headWord(group) !== 'deck') {
      continue
    }

    for (const node of group.nodes.slice(2)) {
      if (node.kind !== 'group') {
        continue
      }

      const head = headWord(node)

      if (head) {
        out.add(head)
      }
    }
  }

  return out
}

const files = manifests(join(TERM, 'deck'))
const seen = new Set<string>()
const losses: string[] = []

let checked = 0

for (const file of files) {
  const text = readFileSync(file, 'utf8')
  const before = fieldsOf(file, text)

  // a `deck.tree` that is an ordinary code module rather than a manifest (deck/seed/code/deck.tree is one) has no
  // `deck @name` declaration and is not this test's business
  if (before.size === 0) {
    continue
  }

  let after: Set<string>

  try {
    after = fieldsOf(file, writeManifest({ manifest: parseManifest({ text }) }))
  } catch (error) {
    losses.push(`${relative(TERM, file)}: threw ${String((error as Error).message).slice(0, 80)}`)
    continue
  }

  checked++

  for (const field of before) {
    seen.add(field)

    if (!after.has(field)) {
      losses.push(`${relative(TERM, file)}: lost \`${field}\``)
    }
  }
}

ok(`${checked} manifests round trip`, checked > 10, `only ${checked}`)

ok(
  'no manifest loses a field it declares',
  losses.length === 0,
  `\n    ${losses.slice(0, 12).join('\n    ')}`,
)

// The count of DISTINCT field heads the REAL manifests exercise. Pinned, not checked for non-zero: the property
// above is only worth as much as the variety it runs over, and a change that stopped reading a field would
// otherwise pass here by never seeing it. Same lesson as feed-mill-coverage's rule count, and it fails in both
// directions, so a manifest that starts using a new field is a deliberate edit rather than a silent drift.
ok(
  `${seen.size} distinct field heads appear in the tree's own manifests`,
  seen.size === CHECKED,
  `${seen.size} not ${CHECKED}: ${[...seen].sort().join(' ')}`,
)

// ---- and the fields no real manifest here uses ----
//
// FOURTEEN OF TWENTY-SEVEN. The sweep above is over the manifests that happen to exist, and `boot` — the field
// whose loss left a scaffolded project unbuildable — is in none of them, because only `term wake` writes one. A
// gate that only sees what the tree already uses cannot catch the loss of what it does not, which is exactly how
// this survived. So one manifest below uses EVERY field the grammar knows.

const WHOLE = `deck @scope/whole
  mark <0.0.1>
  code <1.2.3>
  head <One line about the package>
  text <The long title of the package>
  hide true
  lock mit
  sort library
  site <https://example.com>
  view ./view/tree.gif
  term <Apache 2.0>
  make <security>
  make <parser>
  deck ./deck/load
  link @term/seed, code <0.x.x>
  host <https://registry.example.com>
    link @other/thing, code <1.x.x>
  case work
    link @term/test, code <0.x.x>
  task ./task
  book ./book
  role ./base/role
  line ./code/line
  call ./call
  test ./test
  bear ./code
  boot ./code/boot
  tool ./tool
  mind <A Person>, base <a@example.com>
    site <https://person.example.com>
  cite <Another Person>, base <b@example.com>
  hook build, task ./task/build
`

const wholeBefore = fieldsOf('whole.tree', WHOLE)
const wholeAfter = fieldsOf('whole.tree', writeManifest({ manifest: parseManifest({ text: WHOLE }) }))
const wholeLost = [...wholeBefore].filter(f => !wholeAfter.has(f))

ok(
  `a manifest using all ${wholeBefore.size} fields the grammar knows loses none of them`,
  wholeLost.length === 0,
  `lost: ${wholeLost.join(' ')}`,
)

// every field the tree uses is in the whole-surface manifest too, so the two halves cannot drift apart: a field
// that appears in a real manifest and not here would be guarded only by whichever manifest happens to carry it
ok(
  'the whole-surface manifest covers every field the real ones use',
  [...seen].every(f => wholeBefore.has(f)),
  `missing: ${[...seen].filter(f => !wholeBefore.has(f)).join(' ')}`,
)

console.log(`\ndeck-round-trip: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
