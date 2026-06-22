// First-class functions: a task passed as a value to a higher-order task, then called. Compiled to TypeScript and
// run (hot-module-reload style). Run: npx tsx test/compile/function.ts

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { compile } from '@cluesurf/make/code/compile/compile'
import { render } from '@cluesurf/make/code/parser/diagnostic'

// `apply-twice` takes a task (number -> number) as a first-class value and applies it twice
const SOURCE = `task increment
  take n, like number
  like number
  send back
    call add
      loan n
      code 1

task apply-twice
  take f
    like task
      take x, like number
      like number
  take n, like number
  like number
  send back
    call f
      call f
        loan n

task run-twice
  like number
  send back
    call apply-twice
      read increment
      code 5

task run-direct
  like number
  send back
    call apply-twice
      read double
      code 5

task double
  take n, like number
  like number
  send back
    call add
      loan n
      loan n
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
  const result = compile({ file: 'function.tree', text: SOURCE })

  if (!result.ok) {
    for (const d of result.diagnostics)
      {console.log(render(d, SOURCE.split('\n'), false))}

    console.log('\nfunction: 0 pass, 1 fail')

    return
  }

  console.log('--- emitted TypeScript ---')
  console.log(result.typescript)

  const dir = mkdtempSync(join(tmpdir(), 'seed-function-'))
  const file = join(dir, 'module.ts')
  writeFileSync(file, result.typescript)

  const mod = (await import(pathToFileURL(file).href)) as {
    runTwice: () => number
    runDirect: () => number
  }

  expect('apply-twice increment 5 === 7', mod.runTwice(), 7)
  expect('apply-twice double 5 === 20', mod.runDirect(), 20)

  console.log(`\nfunction: ${pass} pass, ${fail} fail`)
}

main()
