// Does a diagnostic name the file the error is IN, when the error is in an imported module?
//
// `compileProgram` receives ONE flat program merged from every reachable unit. The entry file is the only file it is
// handed, so without per-statement provenance every diagnostic in every dependency is reported against the entry, and
// a person reading the error opens a file that does not contain the mistake.
//
// That provenance used to be a `WeakMap<Statement, string>` threaded through nine files. Term has no weak reference,
// so self-hosting-0002 moved it onto `Span.file` and deleted the map. THIS SUITE EXISTS BECAUSE NOTHING ASSERTED THE
// BEHAVIOUR THE MAP WAS FOR: the whole board stayed green through the change, and would have stayed green had every
// diagnostic silently started blaming `entry.tree`. A misattributed file is not a crash and not a failing test, it is
// a person looking in the wrong place, which is exactly the class of regression that survives a green board.
//
// Run: npx tsx test/compile/module-blame.ts

import { compile } from '@term/make/code/compile/compile'
import type { Source } from '@term/make/code/compile/load'

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

// ---- an error two modules deep ----
//
// `deep.tree` declares a task returning text and returns a number. It is imported by `middle.tree`, which the entry imports, so the
// statement carrying the mistake is three files from the one the compiler was given.

const deep: Source = {
  file: 'deep.tree',
  text: `task deep-task
  like text
  send back
    code 3
`,
}

const middle: Source = {
  file: 'middle.tree',
  text: `load @app/deep
  find deep-task

task middle-task
  like text
  send back
    call deep-task
`,
}

const entry = `load @app/middle
  find middle-task

task run
  like text
  send back
    call middle-task
`

const resolve = (path: string): Source | undefined =>
  path === '@app/deep' ? deep : path === '@app/middle' ? middle : undefined

const result = compile({ file: 'entry.tree', text: entry }, { resolve })

ok(
  'the type mismatch is reported at all',
  !result.ok && (result.diagnostics?.length ?? 0) > 0,
  result.ok ? 'compiled clean' : '',
)

const blamed = new Set((result.diagnostics ?? []).map(d => d.file))

ok(
  'the diagnostic names the file the mistake is in, not the entry',
  blamed.has('deep.tree'),
  `blamed ${[...blamed].join(', ')}`,
)

ok(
  "the entry file is not blamed for a dependency mistake",
  !blamed.has('entry.tree'),
  `blamed ${[...blamed].join(', ')}`,
)

// ---- a clean single-module program still reports against itself ----
//
// The merged path and the single-file path share one function, and the single-file path has no per-statement file to
// read. It must fall back to the file it was given rather than to nothing.

const alone = compile(
  {
    file: 'alone.tree',
    text: `task solo
  like text
  send back
    code 3
`,
  },
  {},
)

const aloneBlamed = new Set((alone.diagnostics ?? []).map(d => d.file))

ok(
  'a single-module program blames its own file',
  aloneBlamed.has('alone.tree') && aloneBlamed.size === 1,
  `blamed ${[...aloneBlamed].join(', ')}`,
)

console.log(`\nmodule-blame: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
