// Control-flow-graph tests: a function body lowers to basic blocks wired by terminators. Run: npx tsx test/ir/cfg.ts

import { parse } from '@/code/parser/tree'
import { mill } from '@/code/compile/mill'
import { buildCfg, successors } from '@/code/ir/cfg'
import type { Statement } from '@/code/compile/node'

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

function bodyOf(text: string): Array<Statement> {
  const parsed = parse({ file: 'c.tree', text })
  if (!parsed.ok) throw new Error('parse failed')
  const built = mill(parsed.tree, 'c.tree')
  if (!built.ok) throw new Error('mill failed')
  const fn = built.program.find(s => s.form === 'function')
  if (!fn || fn.form !== 'function') throw new Error('no function')
  return fn.body
}

function main(): void {
  // straight line: no branches, the body reaches the exit
  const straight = buildCfg(
    bodyOf(`task f\n  take n\n  save a, mark 1\n  back a\n`),
  )
  ok(
    'straight-line has a return terminator',
    straight.blocks.some(b => b.terminator.kind === 'return'),
  )
  ok(
    'straight-line has no branch',
    !straight.blocks.some(b => b.terminator.kind === 'branch'),
  )

  // an if produces a branch with two distinct successors
  const branch = buildCfg(
    bodyOf(
      `task f\n  take n\n  fork test\n    hook test\n      call is-above\n        loan n\n        mark 0\n    hook hold\n      back n\n    hook miss\n      back, mark 0\n`,
    ),
  )
  const branchBlock = branch.blocks.find(
    b => b.terminator.kind === 'branch',
  )
  ok('an if produces a branch terminator', branchBlock !== undefined)
  ok(
    'the branch has two successors',
    branchBlock !== undefined &&
      successors(branchBlock.terminator).length === 2,
  )

  // a while loop has a back edge: the body returns to the header
  const loop = buildCfg(
    bodyOf(
      `task f\n  take n\n  walk test\n    hook test\n      call is-above\n        loan n\n        mark 0\n    hook step\n      save n\n        call subtract\n          loan n\n          mark 1\n  back n\n`,
    ),
  )
  const header = loop.blocks.find(b => b.terminator.kind === 'branch')
  let backEdge = false
  if (header) {
    for (const b of loop.blocks)
      if (
        successors(b.terminator).includes(header.id) &&
        b.id !== header.id
      )
        backEdge = true
  }
  ok('a while loop has a header branch', header !== undefined)
  ok('the loop body has a back edge to the header', backEdge)

  console.log(`\ncfg: ${pass} pass, ${fail} fail`)
}

main()
