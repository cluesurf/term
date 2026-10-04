// Phase 2 of note/term/gaps/plan.md: diagnostics that name the problem. Each block is a term.surf guide's own
// sample, held two ways: the message a reader could not act on is gone, and the one they can is there.
//
// Run: npx tsx test/check/diagnostics.ts

import { compile } from '@term/make/code/compile/compile'
import { showType } from '@term/make/code/compile/node'

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

// every message the build gave, joined, or '' when it built
function said(text: string): string {
  const out = compile({ file: '/gate/code/main.tree', text }, {})

  return out.ok ? '' : out.diagnostics.map(d => d.message).join(' | ')
}

// ---- types, basics/tour, basics/first-program: Term's names, not the checker's ----
{
  const argument = said(`task greet
  take name, like text
  like text
  send back, text <hello>

task welcome
  like text
  send back
    call greet
      code 36
`)
  ok('a number passed for text says `expected text`', /expected text, found number/.test(argument), argument)
  ok('and never the TypeScript name', !/string/.test(argument), argument)

  const nothing = said(`task greet
  take name, like text
  like text
  send back, text <hello>

task welcome
  take n, like void
  like text
  send back
    call greet
      read n
`)
  ok('a void is `void`, not `unit`', /found void/.test(nothing) && !/unit/.test(nothing), nothing)
}

// ---- the printer itself, one line per shape a message can hold ----
{
  const text = { kind: 'string' } as const
  const number = { kind: 'number' } as const

  ok('a list of text', showType({ kind: 'array', element: text }) === 'list, like text')
  ok('a hash from text to numbers', showType({ kind: 'map', key: text, value: number }) === 'hash, like text, like number')
  ok('a list whose element is not solved is a bare list, not `?2[]`', showType({ kind: 'array', element: { kind: 'variable', id: 2 } }) === 'list')
  ok('a generic form with its argument', showType({ kind: 'named', name: 'chain', args: [number] }) === 'chain, like number')
  ok(
    'a task, its compound parameter wrapped so its commas stay its own',
    showType({ kind: 'function', params: [{ kind: 'array', element: text }, number], result: { kind: 'unit' } }) ===
      'task((list, like text), number) -> void',
    showType({ kind: 'function', params: [{ kind: 'array', element: text }, number], result: { kind: 'unit' } }),
  )
}

console.log(`\ndiagnostics: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
