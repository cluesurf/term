// A task named like one of the kernel's own constants (`equal`, `add`, `not`, `and`, ...: check/elaborate.ts,
// BASE_SIGNATURE). The kernel lowers `is-equal` to its `equal` and arithmetic to its `add`, so a user task of that name
// took them over inside the kernel: every `is-equal` in the module failed as `expected <form>, found Type 0`, pointing
// at an unrelated task. Found by the check/cubical port (self-hosting, 2026-10-04). `kindsApart` now renames such a task
// on the kernel's copy. Each program is built AND run. Run: npx tsx test/check/builtin-name.ts

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

async function run(name: string, text: string, check: (mod: Record<string, () => unknown>) => boolean): Promise<void> {
  const built = compile({ file: `/gate/code/${name.replace(/\W+/g, '-')}.tree`, text })

  if (!built.ok) {
    ok(name, false, built.diagnostics.map(d => `${d.name}: ${d.message}`).join(' | '))

    return
  }

  const dir = mkdtempSync(join(tmpdir(), 'term-builtin-name-'))
  const file = join(dir, 'module.mjs')
  writeFileSync(file, transformSync(built.typescript, { loader: 'ts', format: 'esm' }).code)
  const mod = (await import(pathToFileURL(file).href)) as Record<string, () => unknown>
  ok(name, check(mod), JSON.stringify(Object.keys(mod)))
}

// a task named `equal` beside `is-equal` in other tasks
await run(
  'a task named equal, beside is-equal elsewhere',
  `form point
  link x, like number

task equal
  take a, like point
  take b, like point
  like boolean
  send back, call is-equal, read(a/x), read(b/x)

task same
  take n, like number
  like boolean
  send back, call is-equal, read(n), code 3

task run
  like boolean
  save p
    make point
      bind x, code 3
  send back, call and, call(equal, read(p), read(p)), call(same, code 3)
`,
  mod => mod.run!() === true,
)

// and the kernel's other names a task may take: `cond` and `notequal` are not surface words either. (`add`, `not`, `and`
// and the rest are Term's own arithmetic and logic at the SURFACE as well, refused there by the checker with
// "arithmetic operand: expected number", which is the language reserving them, not this defect)
await run(
  'tasks named cond and notequal, beside comparisons elsewhere',
  `task cond
  take n, like number
  like number
  send back, call add, read(n), code 1

task notequal
  take a, like text
  take b, like text
  like boolean
  send back, call is-unequal, read(a), read(b)

task run
  like boolean
  save a, text <a>
  save b, text <b>
  send back, call and, call(is-equal, call(cond, code 1), code 2), call(notequal, read(a), read(b))
`,
  mod => mod.run!() === true,
)

console.log(`\nbuiltin-name: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
