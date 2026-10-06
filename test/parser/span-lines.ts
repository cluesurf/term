// A span names the PHYSICAL line, after a text literal that spans lines too. The tokenizer counted `newline` tokens,
// and inside a literal a line's break is text, not a token, so every span after such a literal fell one line behind
// for each break it held, and a compiler error there pointed at the wrong line (2026-10-06: call/code/work/mind.tree,
// whose two literals held ten breaks between them, put its guard ten lines early). Run: npx tsx test/parser/span-lines.ts

import { parse } from '@term/make/code/parser/tree'
import { spanOfNode } from '@term/make/code/compile/mill-run'
import { compile } from '@term/make/code/compile/compile'

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

// the line each top-level group's head is on, as the span says and as the source says
function heads(text: string): { said: number | undefined; real: string }[] {
  const parsed = parse({ file: 's.tree', text })

  if (!parsed.ok) {
    return []
  }

  return (parsed.tree.nodes as unknown as { nodes: unknown[] }[]).map(node => {
    const said = spanOfNode(node.nodes[0] as never)?.start.line

    return { said, real: text.split('\n')[said ?? -1] ?? '' }
  })
}

const AFTER_LITERAL = `host a, <one
two
three>
host b, 2
host c, 3
`
const found = heads(AFTER_LITERAL)
ok('a group after a three-line literal is on its own line', found[1]?.real === 'host b, 2' && found[2]?.real === 'host c, 3', JSON.stringify(found))
ok('the literal itself still opens on its first line', found[0]?.said === 0, JSON.stringify(found))
ok('the tree is still three groups, the literal one value', found.length === 3, JSON.stringify(found))

// an interpolation inside a literal that spans lines, then a raw literal, then a code line
const MIXED = `host name, <x>
host page, <
  {name}
  and {name} again
>
host raw, <<a>b>>
host last, 1
`
const mixed = heads(MIXED)
ok('after a literal holding interpolations over lines, the next group is on its line', mixed[2]?.real.startsWith('host raw') === true && mixed[3]?.real === 'host last, 1', JSON.stringify(mixed))

// and the place a compiler error is reported: the line the name is on
const BROKEN = `host greeting, <hello
there>

task f
  like number
  send back, read missing-name
`
const result = compile({ file: 'b.tree', text: BROKEN })
const error = result.ok ? undefined : result.diagnostics.find(d => d.message.includes('missing-name'))
ok(
  'an error after a literal over two lines points at its own line',
  error?.span?.start.line === BROKEN.split('\n').findIndex(line => line.includes('missing-name')),
  `reported ${error?.span?.start.line}`,
)

// a column on the line a literal closes on counts from that line's start
const CLOSING = `host a, <one
two>
host b, 2
`
const parsed = parse({ file: 'c.tree', text: CLOSING })
const second = parsed.ok ? spanOfNode((parsed.tree.nodes[1] as unknown as { nodes: unknown[] }).nodes[0] as never) : undefined
ok('a group after the literal starts at column 0 of its line', second?.start.line === 2 && second?.start.column === 0, JSON.stringify(second))

console.log(`\nspan-lines: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
