// The streaming reader and the whole-file reader agree, on every `.tree` in the repository.
//
// A streaming reader is only worth having if it is the SAME reader. This compares the groups `walkGroups` reports
// against the top-level groups `parse` produces for the same file, printed with the parser's own `printTree` so
// the comparison is on structure rather than on object identity. Any disagreement is a second grammar, which is
// the thing that must not exist (note/term/one-parser.md).
//
// It also holds the two properties the unit decision rests on (note/term/feed/tree-stream-unit.md):
//
//   STOPPING EARLY IS FREE. A consumer that wants the imports reads the first groups and abandons the generator.
//   The measured claim is that the import block is the first 6.4% of a file; this checks the mechanism that makes
//   it payable, which is that a caller can stop after any group and the reader does no work past it.
//
//   A TRUNCATED FILE IS NOT A WHOLE ONE. A source ending mid-construct yields `kink`, never `end`, so a consumer
//   cannot mistake "the input ran out" for "there was nothing more".
//
// Run: npx tsx test/parser/stream.ts

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { parse, printTree } from '@term/make/code/parser/tree'
import { walkGroups } from '@term/make/code/parser/stream'
import type { StreamResult } from '@term/make/code/parser/stream'
import type { GroupNode, RootNode } from '@term/make/code/parser/tree'

const HERE = import.meta.dirname ?? new URL('.', import.meta.url).pathname
const TERM = join(HERE, '../..')

let pass = 0
let fail = 0
const failures: string[] = []

function ok(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
  } else {
    fail++
    failures.push(`${name}${info ? `\n    ${info.slice(0, 300)}` : ''}`)
  }
}

// one group printed the way printTree prints a whole tree, so the two sides are directly comparable
function shapeOf(group: GroupNode): string {
  const root: RootNode = { kind: 'root', nodes: [group] }

  return printTree(root)
}

function treeFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) {
    return out
  }

  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'host' || entry.startsWith('.')) {
      continue
    }

    const full = join(dir, entry)

    if (statSync(full).isDirectory()) {
      treeFiles(full, out)
    } else if (entry.endsWith('.tree')) {
      out.push(full)
    }
  }

  return out
}

// ---- the differential, over the whole repository ----

const files = [
  ...treeFiles(join(TERM, 'deck')),
  ...treeFiles(join(TERM, 'test/parser/file')),
]

let compared = 0
let skipped = 0

for (const file of files) {
  const text = readFileSync(file, 'utf8')
  const whole = parse({ file, text })

  // a file the parser refuses has no groups to agree about; the kink fixtures are deliberately malformed
  if (!whole.ok) {
    skipped++
    continue
  }

  const streamed: string[] = []
  let truncated = false

  walkGroups({ file, text }, result => {
    if (result.kind === 'group') {
      streamed.push(shapeOf(result.group))
    } else if (result.kind === 'kink') {
      truncated = true
    }
  })

  const label = file.replace(`${TERM}/`, '')

  if (truncated) {
    ok(`${label}: parses whole, so it must not stream as truncated`, false)
    continue
  }

  compared++

  const want = whole.tree.nodes.map(shapeOf)

  ok(
    `${label}: same number of groups`,
    streamed.length === want.length,
    `streamed ${streamed.length}, whole ${want.length}`,
  )

  for (const [i, shape] of want.entries()) {
    if (streamed[i] !== shape) {
      ok(
        `${label}: group ${i + 1} is identical`,
        false,
        `--- streamed ---\n${streamed[i] ?? '(missing)'}\n--- whole ---\n${shape}`,
      )
      break
    }
  }
}

ok(`compared ${compared} files (${skipped} skipped: they do not parse)`, compared > 500)

// ---- stopping early ----

// STOPPING EARLY IS THE WHOLE POINT of the reader, and after the push rewrite (self-hosting-0002) it is a `false`
// from the consumer rather than an abandoned generator. Counting the calls is what proves it: a reader that
// ignored the stop would report all three groups and still pass a test that only looked at the first.
const taken: StreamResult[] = []

walkGroups(
  {
    file: 'x.tree',
    text: 'load @term/seed/code/list\n  find get\n\ntask a\n  call b\n\ntask c\n  call d\n',
  },
  result => {
    taken.push(result)

    return false
  },
)

const one = taken[0]

ok(
  'a consumer can take one group and stop',
  taken.length === 1 && one !== undefined && one.kind === 'group' && printTree({ kind: 'root', nodes: [one.group] }).startsWith('load'),
  `${taken.length} taken`,
)

// ---- a truncated file is not a whole one ----

const cut: StreamResult[] = []

walkGroups({ file: 'x.tree', text: 'task a\n  save s, text <unclosed\n' }, result => {
  cut.push(result)
})

ok(
  'a source ending mid-construct reports kink, not end',
  cut.some(r => r.kind === 'kink') && !cut.some(r => r.kind === 'end'),
  JSON.stringify(cut.map(r => r.kind)),
)

// ---- a file that ends in a comment is whole ----

const commented: StreamResult[] = []

walkGroups({ file: 'x.tree', text: 'task a\n  call b\n\n# a trailing note\n' }, result => {
  commented.push(result)
})

ok(
  'a file ending in a comment ends cleanly',
  commented.some(r => r.kind === 'end') && !commented.some(r => r.kind === 'kink'),
  JSON.stringify(commented.map(r => r.kind)),
)

for (const line of failures.slice(0, 10)) {
  console.log(`FAIL  ${line}`)
}

console.log(`\nparser-stream: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
