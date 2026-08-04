// Forwarding bounded generics: a bounded generic that forwards its dictionary to another bounded generic must
// compile AND be callable with a concrete type. Regression for the kernel metavariable-scoping limitation noted in
// note/term/compiler/trait-dictionary-passing.md. Run: npx tsx test/check/trait-forwarding.ts

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

const SRC = `mask sizer
  task measure
    take self
    like number

form box
  link n, like number
  wear sizer
    task measure
      take self
      like number
      send back
        read self/n

form circle
  link r, like number
  wear sizer
    task measure
      take self
      like number
      send back
        call add
          read self/r
          read self/r

task describe
  head t, need sizer
  take x, like t
  like number
  send back
    call measure
      read x

task twice
  head t, need sizer
  take x, like t
  like number
  send back
    call add
      call describe
        read x
      call describe
        read x

task run
  like number
  save a
    call twice
      make box
        bind n
          code 7
  save b
    call twice
      make circle
        bind r
          code 9
  send back
    call add
      read a
      read b
`

async function main(): Promise<void> {
  const r = compile({ file: 'f.tree', text: SRC }, {})

  if (!r.ok) {
    console.log(
      'FAIL compile',
      JSON.stringify(r.diagnostics.slice(0, 5), null, 2),
    )
    process.exit(1)
  }

  expect('forwarding generic compiles', r.ok, true)

  const js = transformSync(r.typescript, {
    loader: 'ts',
    format: 'esm',
  }).code

  const dir = mkdtempSync(join(tmpdir(), 'trait-fwd-'))
  const f = join(dir, 'f.mjs')
  writeFileSync(f, js)

  const m = (await import(pathToFileURL(f).href)) as { run(): number }

  // box: describe = 7, twice = 14. circle: describe = 18, twice = 36. run = 50.
  expect(
    'concrete calls through a forwarding bounded generic run',
    m.run(),
    50,
  )

  console.log(`\ntrait-forwarding: ${pass} pass, ${fail} fail`)

  if (fail) {process.exit(1)}
}

main()
