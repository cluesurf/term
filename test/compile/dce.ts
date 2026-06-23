// Application dead-code elimination: with a declared entry point, a public function that nothing reaches from the entry
// is dropped from the output -- even the entry module's own public surface. Without an entry point (the library
// default), every top-level function is kept (its public API). Run: npx tsx test/compile/dce.ts

import { compile } from '@cluesurf/make/code/compile/compile'

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

// `main` calls `used`; `dead` is public but unreachable from `main`.
const SRC = `task main
  like number
  send back
    call used

task used
  like number
  send back
    code 1

task dead
  like number
  send back
    code 2
`

// 1. with no entry point (library build), every public function is kept -- including `dead`.
const lib = compile({ file: 'p.tree', text: SRC })
ok('library build keeps the whole public surface', lib.ok === true)
ok(
  'library build keeps an unreferenced public function',
  lib.ok && lib.typescript.includes('dead'),
  lib.ok ? lib.typescript : '',
)

// 2. with `main` as the entry point, `dead` is pruned but `main` and the reachable `used` remain.
const app = compile({ file: 'p.tree', text: SRC }, { entryPoints: ['main'] })
ok('application build compiles', app.ok === true)
ok(
  'application build keeps the entry point and what it reaches',
  app.ok && app.typescript.includes('main') && app.typescript.includes('used'),
  app.ok ? app.typescript : '',
)
ok(
  'application build DROPS the unreachable public function',
  app.ok && !app.typescript.includes('dead'),
  app.ok ? app.typescript : '',
)

console.log(`\ndce: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
