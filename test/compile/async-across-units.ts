// An INFERRED async task called from another file, in the separate (per-unit) build (term-self-host-001-0454). `mid`
// is never marked async: it is async because it calls `leaf`, which is. The stub a dependent checks against carries the
// `async` resolve-async gave `mid` in its own unit, and the dependent awaits the call. The port of the types step
// (compile/program-types.tree) stamps the call sites by building each statement afresh, so resolve-async, run after
// the stamps, marked the fresh copy and the unit's stub (built from the statements as milled) said `mid` was not
// async: the caller read a pending promise as the number (42 solver tests of deck/test, 1 ms each). A task marked
// `mark async` was never affected: its mark is written in the source.
// Run: npx tsx test/compile/async-across-units.ts

import { compileSeparate } from '@term/make/code/compile/separate'
import { CompileCache } from '@term/make/code/compile/cache'
import type { Resolver } from '@term/make/code/compile/load'

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

const LEAF = `task leaf
  take n, like number
  like number
  mark async
  send back, add(n, 1)
`

// async by inference alone
const MID = `load ./leaf
  find leaf

task mid
  take n, like number
  like number
  host found, leaf(n)
  send back, add(found, 1)
`

// a file that calls the inferred async task, and so is async itself
const ENTRY = `load ./mid
  find mid

task top
  take n, like number
  like number
  host found, mid(n)
  send back, add(found, 1)
`

const FILES: Record<string, string> = {
  './leaf': LEAF,
  './mid': MID,
}

const resolver: Resolver = path => {
  const text = FILES[path]
  return text === undefined
    ? undefined
    : { file: `${path.slice(2)}.tree`, text }
}

const slug = (file: string): string =>
  `./${file.replace(/\.tree$/, '').replace(/\W/g, '_')}.mjs`

const result = compileSeparate(
  { file: 'entry.tree', text: ENTRY },
  { resolve: resolver, cache: new CompileCache(), modules: slug },
)

ok(
  'the three files build',
  result.ok,
  result.ok
    ? ''
    : JSON.stringify(result.diagnostics.map(d => d.message)),
)

const code = (file: string): string =>
  result.ok ? (result.modules.get(file)?.code ?? '') : ''

ok(
  'the marked task is async in its own unit',
  /async function leaf\(/.test(code('leaf.tree')),
  code('leaf.tree'),
)
ok(
  'the inferred task is async in its own unit, and awaits the marked one',
  /async function mid\(/.test(code('mid.tree')) &&
    /await leaf\(/.test(code('mid.tree')),
  code('mid.tree'),
)
ok(
  'a caller in another unit awaits the inferred async task',
  /await mid\(/.test(code('entry.tree')) &&
    /async function top\(/.test(code('entry.tree')),
  code('entry.tree'),
)

console.log(`\nasync-across-units: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
