// A lean call written under a callee the program does not define (`get`, dispatched on its receiver) is a nested
// call when it names a task, even a task two modules define and the binding renames apart. nestLeanLabels nested
// labels only under a call to a task the program defines, so `get(items, pick-index(items))` kept `pick-index` a label
// once both definitions were renamed, and the checker refused it: "get is not a task or a form this file can see, so
// its properties (pick-index) name nothing". Found by deck/test/test/struct-fuzz.tree on the native gate, which merges
// struct-fuzz.tree and coverage-fuzz.tree, each defining `draw-under` (2026-10-05).
// Run: npx tsx test/check/lean-label-unknown-callee.ts

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { transformSync } from 'esbuild'
import { compile } from '@term/make/code/compile/compile'
import type { Source } from '@term/make/code/compile/load'
import { stdlibResolver } from '@term/make/code/resolve'
import { withNativeEnv } from '@term/make/code/compile/native'

let pass = 0
let fail = 0

function ok(name: string, holds: boolean, detail = ''): void {
  if (holds) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}${detail ? `\n        ${detail}` : ''}`)
  }
}

const A = `load @term/base/list
  find list

task pick-index
  take items, like list, like number
  like number

  back subtract(items/length, 1)
`

const B = `load @term/base/list
  find list

task pick-index
  take items, like list, like number
  like number

  back 0

task first-of
  take items, like list, like number
  like number

  back get(items, pick-index(items))
`

const MAIN = `load @term/base/list
  find list

load @app/a
  find pick-index

load @app/b
  find first-of

task last-of
  take items, like list, like number
  like number

  back get(items, pick-index(items))

task run
  like number

  host items, make list(4, 5, 6)

  back add(last-of(items), first-of(items))
`

const files: Record<string, string> = { '@app/a': A, '@app/b': B }
const stdlib = withNativeEnv('node', stdlibResolver()!)
const resolve = (path: string, from: string): Source | undefined =>
  files[path] !== undefined ? { file: `${path.slice('@app/'.length)}.tree`, text: files[path]! } : (stdlib(path, from) as Source | undefined)

const built = compile({ file: 'main.tree', text: MAIN }, { resolve, entryPoints: ['run'], leanOf: () => true } as never)

ok('a task two modules define, written under `get`, is a nested call', built.ok, built.ok ? '' : built.diagnostics.map(d => d.message).join(' | '))

if (built.ok) {
  // each file reaches its own pick-index: a's is the last index, b's the first, so 6 + 4
  const dir = mkdtempSync(join(tmpdir(), 'term-lean-label-'))
  const file = join(dir, 'module.mjs')
  writeFileSync(file, transformSync(built.typescript, { loader: 'ts', format: 'esm' }).code)
  const mod = (await import(pathToFileURL(file).href)) as { run: () => number }

  ok('each file reaches its own pick-index: 6 + 4', mod.run() === 10, String(mod.run()))
}

console.log(`\nlean-label-unknown-callee: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
