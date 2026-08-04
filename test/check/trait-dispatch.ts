// Trait dispatch: a `wear`/`suit` instance's method bodies are preserved (desugared to form-style methods) and a
// concrete trait-method call dispatches to them, end to end (compile -> run on node). Run: npx tsx test/check/trait-dispatch.ts

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

task direct
  like number
  save c
    make box
      bind n
        code 9
  send back
    call measure
      read c
`

async function main(): Promise<void> {
  const r = compile({ file: 'c.tree', text: SRC }, {})

  if (!r.ok) {
    console.log(
      'FAIL compile',
      JSON.stringify(r.diagnostics.slice(0, 3)),
    )
    process.exit(1)
  }

  expect(
    'instance method emitted as a function',
    /function boxMeasure/.test(r.typescript),
    true,
  )

  const js = transformSync(r.typescript, {
    loader: 'ts',
    format: 'esm',
  }).code

  const dir = mkdtempSync(join(tmpdir(), 'trait-'))
  const f = join(dir, 'm.mjs')
  writeFileSync(f, js)

  const m = (await import(pathToFileURL(f).href)) as {
    direct(): number
  }

  expect('concrete trait-method call dispatches + runs', m.direct(), 9)

  // generic trait-bounded dispatch: a generic function bounded by a trait calls a trait method on its type
  // parameter. The concrete instance is not known inside the body, so dictionary passing threads it from each call
  // site. Two different instances must dispatch to two different methods through the SAME generic function.
  const GENERIC = `mask sizer
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

task run
  like number
  save a
    call describe
      make box
        bind n
          code 7
  save b
    call describe
      make circle
        bind r
          code 9
  send back
    call add
      read a
      read b
`

  const g = compile({ file: 'g.tree', text: GENERIC }, {})

  if (!g.ok) {
    console.log(
      'FAIL generic compile',
      JSON.stringify(g.diagnostics.slice(0, 3)),
    )
    process.exit(1)
  }

  // the generic body resolves the trait call through a threaded dictionary, not a hard-wired concrete function
  expect(
    'generic trait call lowers to a dictionary member call',
    /\.measure\(/.test(g.typescript),
    true,
  )

  const gjs = transformSync(g.typescript, {
    loader: 'ts',
    format: 'esm',
  }).code

  const gf = join(dir, 'g.mjs')
  writeFileSync(gf, gjs)

  const gm = (await import(pathToFileURL(gf).href)) as { run(): number }
  // box.measure = 7, circle.measure = 9 + 9 = 18, through one generic `describe`
  expect(
    'two instances dispatch through one generic function',
    gm.run(),
    7 + 18,
  )

  console.log(`\ntrait-dispatch: ${pass} pass, ${fail} fail`)

  if (fail) {process.exit(1)}
}

main()
