// Separate compilation + cross-boundary early cutoff (code/compile/separate.ts): units check against dependency
// interface STUBS and emit per module, cached by own content + dependency interface hashes. So: a body-only edit in
// a dependency rebuilds ONLY that dependency (dependents replay from cache), while a signature edit rebuilds the
// dependents too, and the emitted modules still run correctly end to end.
// Run: npx tsx test/compile/separate.ts

import { compileSeparate } from '@term/make/code/compile/separate'
import { CompileCache } from '@term/make/code/compile/cache'
import type { Resolver } from '@term/make/code/compile/load'
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

const DEP = `task double
  take value, like number
  like number
  send back
    call add
      read value
      read value
`

// same signature, different body (associativity shuffle): the interface hash must not move
const DEP_BODY_EDIT = `task double
  take value, like number
  like number
  send back
    call add
      call add
        read value
        code 0
      read value
`

// a signature edit: the parameter is renamed, which changes the observable interface
const DEP_SIGNATURE_EDIT = `task double
  take amount, like number
  like number
  send back
    call add
      read amount
      read amount
`

const ENTRY = `load ./dep
  find double

task run
  like number
  send back
    call double
      code 21
`

function resolver(dep: string): Resolver {
  return path => (path === './dep' ? { file: 'dep.tree', text: dep } : undefined)
}

const slug = (file: string): string =>
  `./${file.replace(/\.tree$/, '').replace(/\W/g, '_')}.mjs`

async function runEmitted(
  modules: Map<string, { code: string }>,
  dir: string,
): Promise<number> {
  for (const [file, emit] of modules) {
    const js = transformSync(emit.code, {
      loader: 'ts',
      format: 'esm',
    }).code

    writeFileSync(join(dir, slug(file).slice(2)), js)
  }

  const entry = (await import(
    `${pathToFileURL(join(dir, slug('entry.tree').slice(2))).href}?v=${Math.random()}`
  )) as { run(): number }

  return entry.run()
}

async function main(): Promise<void> {
  const cache = new CompileCache()

  const options = (dep: string) => ({
    resolve: resolver(dep),
    cache,
    modules: slug,
  })

  // cold build: both units built, program runs
  const first = compileSeparate(
    { file: 'entry.tree', text: ENTRY },
    options(DEP),
  )

  if (!first.ok) {
    console.log('FAIL cold build', JSON.stringify(first.diagnostics.slice(0, 3)))
    process.exit(1)
  }

  expect('cold build: both units built', first.built.length, 2)
  expect('cold build: nothing reused', first.reused.length, 0)

  const dir = mkdtempSync(join(tmpdir(), 'seed-separate-'))
  expect('emitted modules run (21 doubled)', await runEmitted(first.modules, dir), 42)

  // no-op rebuild: everything replays from cache
  const again = compileSeparate(
    { file: 'entry.tree', text: ENTRY },
    options(DEP),
  )

  expect('no-op rebuild ok', again.ok, true)

  if (again.ok) {
    expect('no-op rebuild: nothing rebuilt', again.built.length, 0)
    expect('no-op rebuild: both units reused', again.reused.length, 2)
  }

  // body-only dependency edit: the dependency rebuilds, the DEPENDENT replays from cache (early cutoff)
  const bodyEdit = compileSeparate(
    { file: 'entry.tree', text: ENTRY },
    options(DEP_BODY_EDIT),
  )

  if (!bodyEdit.ok) {
    console.log('FAIL body edit', JSON.stringify(bodyEdit.diagnostics.slice(0, 3)))
    process.exit(1)
  }

  expect('body edit: only the dependency rebuilt', bodyEdit.built.join(','), 'dep.tree')
  expect('body edit: the dependent was cut off early', bodyEdit.reused.join(','), 'entry.tree')

  const dir2 = mkdtempSync(join(tmpdir(), 'seed-separate-'))
  expect('body-edited build still runs', await runEmitted(bodyEdit.modules, dir2), 42)

  // signature edit: the dependent must rebuild too (its check ran against a changed interface)
  const sigEdit = compileSeparate(
    { file: 'entry.tree', text: ENTRY },
    options(DEP_SIGNATURE_EDIT),
  )

  if (!sigEdit.ok) {
    console.log('FAIL signature edit', JSON.stringify(sigEdit.diagnostics.slice(0, 3)))
    process.exit(1)
  }

  expect('signature edit: both units rebuilt', sigEdit.built.length, 2)

  const dir3 = mkdtempSync(join(tmpdir(), 'seed-separate-'))
  expect('signature-edited build still runs', await runEmitted(sigEdit.modules, dir3), 42)

  // a type error in the dependent against the dependency's INTERFACE is still caught (stubs carry real signatures)
  const BAD_ENTRY = `load ./dep
  find double

task run
  like number
  send back
    call double
      text <oops>
`

  const bad = compileSeparate(
    { file: 'entry.tree', text: BAD_ENTRY },
    options(DEP),
  )

  expect('interface violation is still a type error', bad.ok, false)

  console.log(`\nseparate: ${pass} pass, ${fail} fail`)

  if (fail) {
    process.exit(1)
  }
}

main()
