// The x86 instruction table reads through its mill, every instruction, no exceptions.
//
// `deck/bind/code/linux/operand.tree` is 11,489 lines describing 1,270 x86 instructions in its own dialect
// (`force adc` / `start 1, share al` / `write 0x14`). The house rule is that a custom `.tree` dialect is integrated
// by defining a MILL, never by teaching the core compiler its heads, so `deck/mill/code/operand/mine.tree` is that
// grammar and this is what holds it to the data.
//
// WHOLE-FILE AND PER-INSTRUCTION, both. The whole-file run proves the grammar describes the document; the
// per-instruction run is what makes a failure useful, because it names the line that stopped rather than reporting
// that 11,489 lines did not match.
//
// Every shape in the table was found by RUNNING it rather than by reading the file, and each one was a refusal
// first: a `write field` carrying its own `state` (644 refused), `force adc, shift white` on the head line (380), a
// `shift` action other than `write` (261: cloud, clear, mount), a `start` carrying a nested `slate` (124), and
// `start 2, share 1` where the operand is a literal rather than a register name (28).
//
// Run: npx tsx test/compile/operand-mill.ts

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from '@term/make/code/parser/tree'
import { readMineGrammar, runMine } from '@term/make/code/compile/mill-run'
import type { GroupNode } from '@term/make/code/parser/tree'

const HERE = import.meta.dirname ?? new URL('.', import.meta.url).pathname
const TERM = join(HERE, '../..')
const GRAMMAR = join(TERM, 'deck/mill/code/operand/mine.tree')
const TABLE = join(TERM, 'deck/bind/code/linux/operand.tree')

// the table on 2026-08-30. A count that changes is a table that changed, which is worth noticing either way.
const INSTRUCTIONS = 1270

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

const grammarParsed = parse({
  file: GRAMMAR,
  text: readFileSync(GRAMMAR, 'utf8'),
})

ok(
  'the operand grammar parses',
  grammarParsed.ok,
  grammarParsed.ok ? '' : grammarParsed.diagnostics[0]?.message ?? '',
)

if (!grammarParsed.ok) {
  console.log(`\noperand-mill: ${pass} pass, ${fail} fail`)
  process.exit(1)
}

const grammar = readMineGrammar(grammarParsed.tree)
const text = readFileSync(TABLE, 'utf8')
const lines = text.split('\n')
const parsed = parse({ file: TABLE, text })

ok('the instruction table parses', parsed.ok)

if (!parsed.ok) {
  console.log(`\noperand-mill: ${pass} pass, ${fail} fail`)
  process.exit(1)
}

ok('the whole table reads through the grammar', runMine(grammar, 'operand', parsed.tree).ok)

// per instruction, so a refusal names the line
const head = (group: GroupNode): string => {
  const first = group.nodes[0]

  return first?.kind === 'name'
    ? first.parts.map(p => (p.kind === 'chunk' ? p.text : '')).join('')
    : ''
}

let read = 0
let refused = 0
const misses: string[] = []

for (const group of parsed.tree.nodes) {
  if (head(group) !== 'force') {
    continue
  }

  if (runMine(grammar, 'force', { kind: 'root', nodes: [group] }).ok) {
    read++
    continue
  }

  refused++

  if (misses.length < 5) {
    const first = group.nodes[0]
    const line =
      first?.kind === 'name' && first.parts[0]?.kind === 'chunk'
        ? first.parts[0].token.span.start.line
        : 0

    misses.push(`line ${line + 1}: ${(lines[line] ?? '').trim()}`)
  }
}

ok(`every instruction reads (${read} of ${read + refused})`, refused === 0, misses.join('; '))
ok(`the table still holds ${INSTRUCTIONS} instructions`, read + refused === INSTRUCTIONS, `found ${read + refused}`)

console.log(`\noperand-mill: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
