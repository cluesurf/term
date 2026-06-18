// Stdlib tests: compile real base.tree modules with this compiler (via the module loader) and RUN the emitted
// TypeScript, asserting the pure logic. This proves the stdlib in deck/base.tree/code/ parses, type-checks, and
// runs. Run: npx tsx test/stdlib/run.ts

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { compile } from '@/code/compile/compile'
import type { Source } from '@/code/compile/load'
import { render } from '@/code/parser/diagnostic'

const here = dirname(fileURLToPath(import.meta.url))
const baseTree = join(here, '..', '..', '..', 'base.tree') // deck/seed/deck/base.tree

// resolve `@cluesurf/base/code/<path>` to the stdlib .tree file on disk
function resolveStdlib(importPath: string): Source | undefined {
  const prefix = '@cluesurf/base/'
  if (!importPath.startsWith(prefix)) return undefined
  const file = join(baseTree, `${importPath.slice(prefix.length)}.tree`)
  if (!existsSync(file)) return undefined
  return { file, text: readFileSync(file, 'utf8') }
}

let pass = 0
let fail = 0
function expect(name: string, got: unknown, want: unknown): void {
  if (got === want) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`)
  }
}

async function loadProgram(source: string): Promise<Record<string, (...a: Array<unknown>) => unknown>> {
  const result = compile({ file: 'main.tree', text: source }, { resolve: resolveStdlib })
  if (!result.ok) {
    for (const d of result.diagnostics) console.log(render(d, source.split('\n'), false))
    throw new Error('compile failed')
  }
  const dir = mkdtempSync(join(tmpdir(), 'seed-stdlib-'))
  const file = join(dir, 'module.ts')
  writeFileSync(file, result.typescript)
  return (await import(pathToFileURL(file).href)) as Record<string, (...a: Array<unknown>) => unknown>
}

// a program that loads the real base.tree maybe and exercises it
const MAYBE = `load @cluesurf/base/code/maybe
  find maybe

task unwrap-present
  like number
  back
    call unwrap-or
      make some
        bind value, mark 42
      mark 0

task unwrap-absent
  like number
  back
    call unwrap-or
      make none
      mark 7

task present
  like boolean
  back
    call is-some
      make some
        bind value, mark 1

task absent
  like boolean
  back
    call is-some
      make none

task map-add-one
  like number
  back
    call unwrap-or
      call map
        make some
          bind value, mark 41
        increment
      mark 0

task increment
  take n, like number
  like number
  back
    call add
      loan n
      mark 1
`

async function main(): Promise<void> {
  const m = await loadProgram(MAYBE)
  expect('maybe/unwrap-or on some returns the value', m.unwrapPresent!(), 42)
  expect('maybe/unwrap-or on none returns the fallback', m.unwrapAbsent!(), 7)
  expect('maybe/is-some on some is true', m.present!(), true)
  expect('maybe/is-some on none is false', m.absent!(), false)
  expect('maybe/map applies the function under some', m.mapAddOne!(), 42)

  console.log(`\nstdlib: ${pass} pass, ${fail} fail`)
}

main()
