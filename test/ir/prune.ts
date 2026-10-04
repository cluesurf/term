// The reachability prune (ir/prune.ts), held both ways: a form reached only through its cases (`make one`, `case one`)
// is kept, which it was not until 2026-10-04 (every backend then wrote the cases as records nothing declared), and a
// form and a task nothing reaches are still dropped.
// Run: npx tsx test/ir/prune.ts

import { mill } from '@term/make/code/compile/mill'
import { parse } from '@term/make/code/parser/tree'
import { resolve as resolveNames } from '@term/make/code/check/resolve'
import { pruneToReachable } from '@term/make/code/ir/prune'
import type { Program } from '@term/make/code/compile/node'

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

function program(text: string): Program {
  const parsed = parse({ file: 'main.tree', text })

  if (!parsed.ok) throw new Error('parse failed')

  const built = mill(parsed.tree, 'main.tree')

  if (!built.ok) throw new Error(built.diagnostics.map(d => d.message).join(' | '))

  resolveNames(built.program, 'main.tree')

  return built.program
}

const kept = (p: Program): string[] => p.flatMap(n => ('name' in n && typeof n.name === 'string' ? [n.name] : []))

const shaped = pruneToReachable(
  program(`form knot
  case tip
  case one
    link value, like number
    link next, like knot

form unused
  case nothing

task stray
  like number
  send back, code 7

task use
  take n, like number
  like number
  host t
    make one
      bind value, read n
      bind next
        make tip
  fork case, read t
    case tip
      send back, code 0
    case one
      send back, read value
`),
  new Set(['use']),
)

ok('a form built and matched only by its cases is kept', kept(shaped).includes('knot'), kept(shaped).join(', '))
ok('a form nothing reaches is dropped', !kept(shaped).includes('unused'), kept(shaped).join(', '))
ok('a task nothing reaches is dropped', !kept(shaped).includes('stray'), kept(shaped).join(', '))
ok('the root is kept', kept(shaped).includes('use'), kept(shaped).join(', '))

console.log(`\nprune: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
