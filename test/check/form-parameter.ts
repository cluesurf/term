// A parameter named like its own form: `take box, like box` and a result `like box`. A task is a Π type to the kernel,
// so its result type sits under its parameters' binders, and the result's `box` found the PARAMETER where it named the
// form: `kernel: type mismatch: expected box, found box`, the same name printed twice. The ir/net port met it as
// `take net, like net` (self-hosting, 2026-10-04). check/elaborate.ts `kindsApart` now keeps the form apart on the
// kernel's copy, as it already did for a form and a task of one name. The program is built AND run. Before the fix the
// built CLI refused the same shape with exactly that message (2026-10-04).
// Run: npx tsx test/check/form-parameter.ts

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { transformSync } from 'esbuild'
import { compile } from '@term/make/code/compile/compile'

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

// the result is the form the parameter is named after; the second keeps a parameter of a DIFFERENT name beside it,
// and the third reads the parameter as a value inside, so a rename that reached values would break it
const text = `form box
  link size, like number

task grow
  take box, like box
  take by, like number
  like box
  save next, read box
  save next/size, call add, read(box/size), read by
  send back, read next

task size-of
  take box, like box
  like number
  send back, read box/size

task make-box
  take size, like number
  like box
  send back
    make box
      bind size, read size

task run
  like number
  send back, call size-of, call(grow, call(make-box, code 2), code 3)
`

const built = compile({ file: '/gate/code/form-parameter.tree', text })
ok(
  'a task whose parameter shares its form name, returning that form, builds',
  built.ok,
  built.ok ? '' : built.diagnostics.map(d => `${d.name}: ${d.message}`).join(' | '),
)

if (built.ok) {
  const dir = mkdtempSync(join(tmpdir(), 'term-form-parameter-'))
  const file = join(dir, 'module.mjs')
  writeFileSync(file, transformSync(built.typescript, { loader: 'ts', format: 'esm' }).code)
  const mod = (await import(pathToFileURL(file).href)) as { run: () => number }
  ok('and runs: grow(box 2, by 3) has size 5', mod.run() === 5, String(mod.run()))
}

// a genuine mismatch is still caught: a parameter named like the form, returning a number where the form is declared
const wrong = `form box
  link size, like number

task bad
  take box, like box
  like box
  send back, read box/size
`

const refused = compile({ file: '/gate/code/form-parameter-wrong.tree', text: wrong })
ok(
  'a real mismatch beside the same names is still refused',
  !refused.ok && refused.diagnostics.some(d => d.name === 'type-mismatch'),
  refused.ok ? 'it built' : refused.diagnostics.map(d => d.message).join(' | '),
)

console.log(`\nform-parameter: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
