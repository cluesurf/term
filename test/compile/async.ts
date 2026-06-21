// Async test: `wait true` makes a task async and a call awaited. Compiles to native async/await, then runs.
// Run: npx tsx test/compile/async.ts

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { compile } from '@/code/compile/compile'
import { render } from '@/code/parser/diagnostic'

const SOURCE = `task fetch-answer
  wait true
  send back, code 42

task run
  wait true
  send back
    call fetch-answer
      wait true
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
  const result = compile({ file: 'async.tree', text: SOURCE })
  if (!result.ok) {
    for (const d of result.diagnostics)
      console.log(render(d, SOURCE.split('\n'), false))
    console.log('\nasync: 0 pass, 1 fail')
    return
  }
  console.log('--- emitted TypeScript ---')
  console.log(result.typescript)
  expect(
    'emits async function',
    result.typescript.includes('async function fetchAnswer'),
    true,
  )
  expect(
    'emits Promise return',
    result.typescript.includes('Promise<number>'),
    true,
  )
  expect(
    'emits await',
    result.typescript.includes('await fetchAnswer()'),
    true,
  )

  const dir = mkdtempSync(join(tmpdir(), 'seed-async-'))
  const file = join(dir, 'module.ts')
  writeFileSync(file, result.typescript)
  const mod = (await import(pathToFileURL(file).href)) as {
    run: () => Promise<number>
  }
  expect('async run() resolves to 42', await mod.run(), 42)

  console.log(`\nasync: ${pass} pass, ${fail} fail`)
}

main()
