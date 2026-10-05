// Two member reads with different computed indexes are different places. A computed member's name is empty, and
// compile/expr-equal compared the name alone, so `grid/{i}` and `grid/{j}` were the same and L010 called
// `save grid/{i}, read grid/{j}` a self-assignment (found porting expr-equal to Term, 2026-10-05). Fails without the
// index comparison. Run: npx tsx test/lint/expr-equal-index.ts
import { lint } from '@term/make/code/lint/lint'
import { parse } from '@term/make/code/parser/tree'
import { mill } from '@term/make/code/compile/mill'

let pass = 0
let fail = 0

function ok(name: string, holds: boolean, detail = ''): void {
  if (holds) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}${detail ? `\n        ${detail}` : ''}`)
  }
}

function selfAssignments(text: string): number {
  const parsed = parse({ file: 't.tree', text })

  if (!parsed.ok) {
    throw new Error(`parse failed: ${JSON.stringify(parsed.diagnostics)}`)
  }

  const built = mill(parsed.tree, 't.tree')

  if (!built.ok) {
    throw new Error(`mill failed: ${JSON.stringify(built.diagnostics)}`)
  }

  return lint(built.program, 't.tree', text).filter(f => f.code === 'L010').length
}

const shape = (target: string, value: string): string =>
  `task go\n  take grid, like list, like number\n  take i, like number\n  take j, like number\n  save ${target}, read ${value}\n`

ok('two different indexes are two places', selfAssignments(shape('grid/{i}', 'grid/{j}')) === 0)
ok('the same index is one place, and is reported', selfAssignments(shape('grid/{i}', 'grid/{i}')) === 1)
ok('a plain field to itself is still reported', selfAssignments(shape('grid/size', 'grid/size')) === 1)

console.log(`\nexpr-equal-index: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
