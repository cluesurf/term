// Backend registry test: the experimental emitters stamp their output with the registry's banner.
//
// The registry itself is Term (compile/backend-registry.tree) and so are its checks, deck/make/test/backend-registry.tree
// (self-hosting, 2026-10-04): which backends are stable, the notices, the banner in a given prefix, the order. What
// stays here runs the WGSL emitter, which is TypeScript, to see the banner reach what it writes.
// Run: npx tsx test/compile/backend-registry.ts

import { parse } from '@term/make/code/parser/tree'
import { mill } from '@term/make/code/compile/mill'
import { resolve } from '@term/make/code/check/resolve'
import { check } from '@term/make/code/check/infer'
import { emitWgsl } from '@term/make/code/compile/wgsl'
import type { Program } from '@term/make/code/compile/node'

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

function frontEnd(text: string): Program {
  const parsed = parse({ file: 'b.tree', text })

  if (!parsed.ok) {
    throw new Error('parse failed')
  }

  const built = mill(parsed.tree, 'b.tree')

  if (!built.ok) {
    throw new Error('mill failed')
  }

  resolve(built.program, 'b.tree')
  check(built.program, 'b.tree')

  return built.program
}

// the emitters actually stamp their output with the banner
const DOUBLE = `task double
  take n, like number
  like number
  send back
    call add
      read n
      read n
`
const program = frontEnd(DOUBLE)
ok(
  'emitted WGSL begins with the experimental banner',
  emitWgsl(program).startsWith('// EXPERIMENTAL backend: WGSL'),
)

console.log(`\nbackend-registry: ${pass} pass, ${fail} fail`)
