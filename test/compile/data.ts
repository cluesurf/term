// Compile test for the widened mill: a record type (form), construction (make), a list (make list), iteration
// (walk list), member access (read x/field), and a constant (host). Run: npx tsx test/compile/data.ts

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { compile } from '@cluesurf/make/code/compile/compile'
import { render } from '@cluesurf/make/code/parser/diagnostic'

const SOURCE = `form point
  link x, like u64
  link y, like u64

task sum-x-coords
  take items
  save total, code 0
  walk list, loan items
    hook next
      take site, name item
      save total
        call add
          loan total
          read item/x
  send back total

task run
  host points
    make list
      make point
        bind x, code 3
        bind y, code 0
      make point
        bind x, code 4
        bind y, code 0
  send back
    call sum-x-coords
      loan points
`

let pass = 0
let fail = 0

function expect(name: string, got: unknown, want: unknown): void {
  if (got === want) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(
      `FAIL  ${name}  (got ${JSON.stringify(
        got,
      )}, want ${JSON.stringify(want)})`,
    )
  }
}

async function main(): Promise<void> {
  const result = compile({ file: 'data.tree', text: SOURCE })

  if (!result.ok) {
    const lines = SOURCE.split('\n')

    for (const d of result.diagnostics)
      {console.log(render(d, lines, false))}

    console.log('\ncompile/data: 0 pass, 1 fail')

    return
  }

  console.log('--- emitted TypeScript ---')
  console.log(result.typescript)

  const dir = mkdtempSync(join(tmpdir(), 'seed-data-'))
  const file = join(dir, 'module.ts')
  writeFileSync(file, result.typescript)

  const mod = (await import(pathToFileURL(file).href)) as {
    run: () => number
  }

  expect('run() sums x coords', mod.run(), 7)

  console.log(`\ncompile/data: ${pass} pass, ${fail} fail`)
}

main()
