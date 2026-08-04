// Incremental parsing tests: a file parses definition-by-definition, reusing unchanged blocks, and the merged tree is
// identical to a whole-file parse (including spans). Run: npx tsx test/compile/incremental-parse.ts

import { parse } from '@term/make/code/parser/tree'
import {
  splitTopLevel,
  incrementalParse,
} from '@term/make/code/compile/incremental-parse'

let pass = 0
let fail = 0

function ok(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  ${info}`)
  }
}

// a cycle-safe serialization (the parse tree has parent / token linked-list back-pointers)
const drop = new Set(['parent', 'next', 'previous'])
const ser = (tree: unknown): string =>
  JSON.stringify(tree, (k, v) => (drop.has(k) ? undefined : v))

function main(): void {
  const src = `task one\n  send back, code 1\n\n# a note for two\ntask two\n  send back, code 2\n\nform point\n  link x, like number\n`

  // the splitter partitions the source exactly and attaches a leading comment to its definition
  const blocks = splitTopLevel(src)
  ok('splitTopLevel finds three definitions', blocks.length === 3)
  ok(
    'splitTopLevel partitions the source exactly',
    blocks.map(b => b.text).join('\n') === src,
  )
  ok(
    "the comment rides with `task two`'s block",
    !!blocks[1] &&
      blocks[1].text.includes('# a note for two') &&
      blocks[1].text.includes('task two'),
  )

  // a cold incremental parse equals a whole-file parse, byte for byte (spans included)
  const cold = incrementalParse('f.tree', src, new Map())
  ok(
    'incremental parse equals a whole-file parse',
    ser(cold.tree) === ser(parse({ file: 'f.tree', text: src }).tree),
  )
  ok(
    'cold pass parses every block',
    cold.parsed === 3 && cold.reused === 0,
  )

  // editing one definition re-parses only that one; the others are reused (re-positioned by a span shift)
  const cache = new Map()
  incrementalParse('f.tree', src, cache)

  const edited = src.replace('code 2', 'code 99')
  const re = incrementalParse('f.tree', edited, cache)
  ok(
    'an edit re-parses only the changed definition',
    re.parsed === 1 && re.reused === 2,
    `parsed=${re.parsed} reused=${re.reused}`,
  )
  ok(
    'the incremental result still equals a whole-file parse of the edit',
    ser(re.tree) === ser(parse({ file: 'f.tree', text: edited }).tree),
  )

  console.log(`\nincremental-parse: ${pass} pass, ${fail} fail`)
}

main()
