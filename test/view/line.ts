// `term view` end to end: the built CLI against a real document on disk.
//
// The reader and the manifest are covered by test/view/read.ts. This proves the VERB is wired: that the command
// exists, that its three modes print what they should, and that a document which does not read exits non-zero
// with a span and a named message. The save path and the editor call the same implementation, so this is the one
// place the three cannot drift.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const LINE = join(HERE, '../../host/line.js')

let pass = 0
let fail = 0

function ok(what: string, held: boolean, note = ''): void {
  if (held) {
    pass++
    console.log(`ok    ${what}`)
  } else {
    fail++
    console.log(`FAIL  ${what}  ${note}`)
  }
}

const root = mkdtempSync(join(tmpdir(), 'term-view-'))
mkdirSync(join(root, 'page'))

writeFileSync(
  join(root, 'page/quenya.tree'),
  `
host title, text <How Quenya sounds>

find vowel
  task <filter:phoneme>
  hold is-equal
    read self/kind
    text <vowel>
  size 50

view page
  view text/heading
    bind text
      call titlecase
        read title
  view sound/chart
    bind source, code <quenya>
    bind rows, read vowel
`,
)

writeFileSync(join(root, 'page/bad.tree'), 'view page\n  task main\n')

// `out` is stdout alone (the manifest and the JSON are data there), `all` both streams (what a document uses is a
// `read` item of the run, on stderr with the rest of the human view)
function run(args: string[]): { out: string; all: string; code: number } {
  const done = spawnSync('node', [LINE, ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

  return { out: done.status === 0 ? done.stdout : `${done.stdout}${done.stderr}`, all: `${done.stdout}${done.stderr}`, code: done.status ?? 1 }
}

const plain = run(['view', 'page/quenya.tree'])

ok('the verb exists and a document reads', plain.code === 0, plain.all)
// The EXACT line, not a substring. `includes` passed happily against `sound/chart>, <text/heading>, <text/item`
// when the CLI was regexing the serialized manifest and getting the delimiters back with the names. Since 2026-10-05
// each is a field of the document's `read` item, at the body column
// v3 (note/term/output/standard.md): `✓ read <file>` at column 0, each use a field two cells in
ok('it is a read item for the document', /^✓ read page\/quenya\.tree$/m.test(plain.all), plain.all)
ok(
  'it prints every component placed, and only the names',
  /^ {2}view sound\/chart, text\/heading$/m.test(plain.all),
  plain.all,
)
ok('it prints the query', /^ {2}find filter:phoneme$/m.test(plain.all), plain.all)
ok('it prints the operator', /^ {2}call titlecase$/m.test(plain.all), plain.all)
ok('it prints the node count and depth', /^ {2}node \d+$/m.test(plain.all) && /^ {2}deep \d+$/m.test(plain.all), plain.all)

const manifest = run(['view', 'page/quenya.tree', '--find'])

ok('--find prints the manifest', manifest.code === 0 && manifest.out.includes('host task, <filter:phoneme>'))
ok('the manifest carries the record reference', manifest.out.includes('list mark') && manifest.out.includes('<quenya>'))

const json = run(['view', 'page/quenya.tree', '-b', 'json'])

ok('--back json answers as json', json.code === 0 && json.out.trimStart().startsWith('['))

if (json.code === 0) {
  const parsed = JSON.parse(json.out) as { view: string[]; call: string[] }[]

  ok('the json carries the same lists', parsed[0]?.call.includes('titlecase') === true)
  ok('the json leaves the manifest out', !('manifest' in (parsed[0] ?? {})))
}

const bad = run(['view', 'page/bad.tree'])

ok('a document that does not read exits non-zero', bad.code !== 0)
// a Problem item: the message as its subject, the line and column in its `at` field (section 12)
ok('and says which word, with a line and column', /"task" is not part of a document[\s\S]*?\bat\s+page\/bad\.tree:2:3\b/.test(bad.out), bad.out)

const whole = run(['view', 'page'])

ok('a directory reads every document in it', whole.code !== 0 && whole.out.includes('quenya.tree') && whole.out.includes('bad.tree'))

console.log(`\nview-line: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
