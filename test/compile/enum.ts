// Enum + match tests: discriminated-union emit, tagged construction, exhaustiveness, and running it.
// Run: npx tsx test/compile/enum.ts

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { compile } from '@/code/compile/compile'
import { render } from '@/code/parser/diagnostic'

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

// an enum, a constructor, and an exhaustive match
const EXHAUSTIVE = `form color
  case red
  case green
  case blue

task name-of
  take c, like color
  like text
  fork case, read c
    case red
      send back, text <red>
    case green
      send back, text <green>
    case blue
      send back, text <blue>

task run
  back
    call name-of
      make green
`

// the same match, missing the `blue` case
const NON_EXHAUSTIVE = `form color
  case red
  case green
  case blue

task name-of
  take c, like color
  like text
  fork case, read c
    case red
      send back, text <red>
    case green
      send back, text <green>
`

async function main(): Promise<void> {
  const result = compile({ file: 'enum.tree', text: EXHAUSTIVE })
  if (!result.ok) {
    for (const d of result.diagnostics) console.log(render(d, EXHAUSTIVE.split('\n'), false))
    console.log('\nenum: 0 pass, 1 fail')
    return
  }
  console.log('--- emitted TypeScript ---')
  console.log(result.typescript)
  ok('emits discriminated union', result.typescript.includes('type Color ='))
  ok('emits variant tag', result.typescript.includes('form: "green"'))
  ok('emits match as form switch', result.typescript.includes('.form === "red"'))

  // run it: name-of(green) === "green"
  const dir = mkdtempSync(join(tmpdir(), 'seed-enum-'))
  const file = join(dir, 'module.ts')
  writeFileSync(file, result.typescript)
  const mod = (await import(pathToFileURL(file).href)) as { run: () => string }
  ok('run() returns "green"', mod.run() === 'green', `got ${mod.run()}`)

  // exhaustiveness: the missing-case version is a compile error
  const bad = compile({ file: 'enum.tree', text: NON_EXHAUSTIVE })
  ok(
    'non-exhaustive match caught',
    !bad.ok && bad.diagnostics.some((d) => d.name === 'non-exhaustive'),
    bad.ok ? 'compiled cleanly' : bad.diagnostics.map((d) => d.name).join(','),
  )
  if (!bad.ok) {
    const d = bad.diagnostics.find((x) => x.name === 'non-exhaustive')
    if (d) console.log(`      (${d.message})`)
  }

  console.log(`\nenum: ${pass} pass, ${fail} fail`)
}

main()
