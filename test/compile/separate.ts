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

// TWO statements: a body of one `send back` is part of the surface, since the provers unfold it in a caller
// (compile/stub.ts `stubShape`), so it is the longer body whose edit must not reach a dependent
const DEP = `task double
  take value, like number
  like number
  save twice
    call add
      read value
      read value
  send back, read twice
`

// same signature, different body (associativity shuffle): the surface must not move
const DEP_BODY_EDIT = `task double
  take value, like number
  like number
  save twice
    call add
      call add
        read value
        code 0
      read value
  send back, read twice
`

// a signature edit: the parameter is renamed, which changes the observable interface
const DEP_SIGNATURE_EDIT = `task double
  take amount, like number
  like number
  save twice
    call add
      read amount
      read amount
  send back, read twice
`

// a ONE-LINE body and an edit of it: the dependent is rebuilt, because what the provers read of `double` changed
const DEP_LINE = `task double
  take value, like number
  like number
  send back
    call add
      read value
      read value
`

const DEP_LINE_EDIT = `task double
  take value, like number
  like number
  send back
    call add
      call add
        read value
        code 0
      read value
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

  // a one-line body is surface: its edit rebuilds the dependent
  compileSeparate({ file: 'entry.tree', text: ENTRY }, options(DEP_LINE))
  const lineEdit = compileSeparate({ file: 'entry.tree', text: ENTRY }, options(DEP_LINE_EDIT))

  expect('one-line body edit: the dependent rebuilt too', lineEdit.ok ? lineEdit.built.join(',') : 'failed', 'dep.tree,entry.tree')

  // a name both files define: the entry's own keeps its name, the dependency's is imported under the name its own
  // module exported it by, whichever entry compiled that module first
  const SHARED_DEP = `task double
  take value, like number
  like number
  save twice
    call add
      read value
      read value
  send back, read twice

task label
  like text
  back <dep>
`
  const SHARED_ENTRY = `load ./dep
  find double

task label
  like text
  back <entry>

task run
  like number
  send back
    call double
      code 21
`
  const shared = compileSeparate({ file: 'entry.tree', text: SHARED_ENTRY }, options(SHARED_DEP))

  expect('a name two files define builds', shared.ok, true)

  if (shared.ok) {
    const dir4 = mkdtempSync(join(tmpdir(), 'seed-separate-'))
    expect('and runs', await runEmitted(shared.modules, dir4), 42)
  }

  // a constant of the dependency, read by the entry: its module exports it, and the entry imports it
  const CONSTANT_DEP = `host base, code 21

task double
  take value, like number
  like number
  save twice
    call add
      read value
      read value
  send back, read twice
`
  const CONSTANT_ENTRY = `load ./dep
  find double
  find base

task run
  like number
  send back
    call double
      read base
`
  const constant = compileSeparate({ file: 'entry.tree', text: CONSTANT_ENTRY }, options(CONSTANT_DEP))

  expect('a constant another module defines builds', constant.ok, true)

  if (constant.ok) {
    const dir5 = mkdtempSync(join(tmpdir(), 'seed-separate-'))
    const ran = await runEmitted(constant.modules, dir5).catch(e => String(e))

    expect('and runs, the constant imported', ran, 42)

    if (ran !== 42) {
      for (const [file, emit] of constant.modules) {
        console.log(`---- ${file}\n${emit.code.slice(0, 1200)}`)
      }
    }
  }

  // a bind of the dependency, called by the entry: a bind is written into its caller, so the entry's module needs it
  const BIND_DEP = `bind add-one, take n, like number
  like number
  case node
    <$n + 1>
`
  const BIND_ENTRY = `load ./dep
  find add-one

task run
  like number
  send back
    call add-one
      code 41
`
  const bound = compileSeparate({ file: 'entry.tree', text: BIND_ENTRY }, options(BIND_DEP))

  expect('a bind another module declares builds', bound.ok, true)

  if (bound.ok) {
    const dir6 = mkdtempSync(join(tmpdir(), 'seed-separate-'))
    expect('and runs, written into its caller', await runEmitted(bound.modules, dir6).catch(e => String(e)), 42)
  }

  // a record of a form another module declares is a value all the same: `save copy, one` and a field write through
  // `copy` leaves `one` as it was. The unit alone has no `record-type` for the form, and every such alias went
  // uncopied until recordCopies read the stubs (2026-10-05, item/run.tree's hidden tally reaching its caller's event)
  const FORM_DEP = `form box
  link count, like number, fall 0
`
  const FORM_ENTRY = `load ./dep
  find box

task bump
  take one, like box
  like box
  save copy, one
  save copy/count, 20
  send back, read copy

task run
  like number
  save first, make box
  save first/count, 1
  save second, bump(first)
  send back, add(second/count, first/count)
`
  const formed = compileSeparate({ file: 'entry.tree', text: FORM_ENTRY }, options(FORM_DEP))

  expect('a record of an imported form builds', formed.ok, true)

  if (formed.ok) {
    const dir7 = mkdtempSync(join(tmpdir(), 'seed-separate-'))
    expect('and an alias of it is a copy (20 + 1, not 20 + 20)', await runEmitted(formed.modules, dir7).catch(e => String(e)), 21)
  }

  console.log(`\nseparate: ${pass} pass, ${fail} fail`)

  if (fail) {
    process.exit(1)
  }
}

main()
