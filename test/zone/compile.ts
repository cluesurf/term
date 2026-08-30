// View codegen test: compile a counter zone to a reactive component, then run it on the runtime.
// The generated module is written inside the project so the @/ alias resolves. Run: npx tsx test/zone/compile.ts

import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { compileZone } from '@term/make/code/view/compile'

const SOURCE = `view counter
  state count, code 0
  hook click
    save count
      call add
        loan count
        code 1
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
  const result = compileZone({ file: 'counter.tree', text: SOURCE })
  if (!result.ok) {
    console.log('FAIL  zone did not compile')
    console.log('\nzone-compile: 0 pass, 1 fail')
    return
  }
  console.log('--- emitted TypeScript ---')
  console.log(result.typescript)

  expect(
    'emits signal',
    result.typescript.includes('const [count, setCount] = signal(0)'),
    true,
  )
  expect(
    'emits handler',
    result.typescript.includes('function onClick()'),
    true,
  )
  expect(
    'emits setter call',
    result.typescript.includes('setCount(count() + 1)'),
    true,
  )

  // write inside the project so `@term/make/code/view/reactive` resolves under tsx, then run it
  const here = dirname(fileURLToPath(import.meta.url))
  const dir = join(here, 'generated')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'counter.ts')
  writeFileSync(file, result.typescript)
  const mod = (await import(pathToFileURL(file).href)) as {
    counter: () => { count: () => number; onClick: () => void }
  }

  const component = mod.counter()
  expect('initial state', component.count(), 0)
  component.onClick()
  expect('after one click', component.count(), 1)
  component.onClick()
  component.onClick()
  expect('after three clicks', component.count(), 3)

  console.log(`\nzone-compile: ${pass} pass, ${fail} fail`)
}

main()
