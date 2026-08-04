// Text-literal escapes: the delimiters (`\<` `\>` `\{` `\}`) and the standard characters (`\n` `\r` `\t` `\\`)
// parse inside `text <...>` and carry the right runtime value on the emitted TypeScript.
// Run: npx tsx test/compile/text-escapes.ts

import { compile } from '@term/make/code/compile/compile'
import { transformSync } from 'esbuild'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

let pass = 0
let fail = 0

function expect(name: string, got: unknown, want: unknown): void {
  if (got === want) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(
      `FAIL  ${name}  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`,
    )
  }
}

const SRC = `task newline
  like text
  send back, text <a\\nb>

task carriage
  like text
  send back, text <a\\rb>

task tab
  like text
  send back, text <a\\tb>

task backslash
  like text
  send back, text <a\\\\nb>

task angle
  like text
  send back, text <a\\<b\\>c>
`

async function main(): Promise<void> {
  const r = compile({ file: 'e.tree', text: SRC }, {})

  if (!r.ok) {
    console.log('FAIL compile', JSON.stringify(r.diagnostics.slice(0, 3)))
    process.exit(1)
  }

  const js = transformSync(r.typescript, {
    loader: 'ts',
    format: 'esm',
  }).code

  const dir = mkdtempSync(join(tmpdir(), 'escape-'))
  const f = join(dir, 'e.mjs')
  writeFileSync(f, js)

  const m = (await import(pathToFileURL(f).href)) as Record<
    string,
    () => string
  >

  expect('newline escape', m.newline!(), 'a\nb')
  expect('carriage-return escape', m.carriage!(), 'a\rb')
  expect('tab escape', m.tab!(), 'a\tb')
  expect('escaped backslash stays literal', m.backslash!(), 'a\\nb')
  expect('angle escapes', m.angle!(), 'a<b>c')

  console.log(`\ntext-escapes: ${pass} pass, ${fail} fail`)

  if (fail) {
    process.exit(1)
  }
}

main()
