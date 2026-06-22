// Collection helpers run on node: hash keys / values, set union / intersect / difference, range to-list. These are
// pure stdlib (the hash / set forms back onto the native map, range is plain arithmetic), so the test compiles small
// programs to TypeScript, imports them, and runs the operations. Run: npx tsx test/stdlib/collection.ts

import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { transformSync } from 'esbuild'
import { compile } from '@cluesurf/make/code/compile/compile'
import { withNativeEnv } from '@cluesurf/make/code/compile/native'
import type { Source } from '@cluesurf/make/code/compile/load'
import { render } from '@cluesurf/make/code/parser/diagnostic'

const here = dirname(fileURLToPath(import.meta.url))
const baseTree = join(here, '..', '..', 'deck', 'base')

const stdlib = (path: string): Source | undefined => {
  const prefix = '@cluesurf/base/'

  if (!path.startsWith(prefix)) {return undefined}

  const file = join(baseTree, `${path.slice(prefix.length)}.tree`)

  return existsSync(file)
    ? { file, text: readFileSync(file, 'utf8') }
    : undefined
}

const resolve = withNativeEnv('node', stdlib)

let pass = 0
let fail = 0

function expect(name: string, got: unknown, want: unknown): void {
  const same = JSON.stringify(got) === JSON.stringify(want)

  if (same) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(
      `FAIL  ${name}  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`,
    )
  }
}

async function load(
  source: string,
): Promise<Record<string, (...a: unknown[]) => unknown>> {
  const result = compile(
    { file: 'main.tree', text: source },
    { resolve },
  )

  if (!result.ok) {
    for (const d of result.diagnostics)
      {console.log(render(d, source.split('\n'), false))}

    throw new Error('compile failed')
  }

  const js = transformSync(result.typescript, {
    loader: 'ts',
    format: 'esm',
  }).code

  const dir = mkdtempSync(join(tmpdir(), 'seed-coll-'))
  const file = join(dir, 'module.mjs')
  writeFileSync(file, js)

  return (await import(pathToFileURL(file).href)) as Record<
    string,
    (...a: unknown[]) => unknown
  >
}

const HASH = `load @cluesurf/base/code/hash
  find hash

task build
  like hash
    like text
    like number
  save h
    make find
  call set
    read h
    text <a>
    code 1
  call set
    read h
    text <b>
    code 2
  send back, read h

task keys-of
  like list
    like text
  send back
    call keys
      call build

task values-of
  like list
    like number
  send back
    call values
      call build
`

const SET = `load @cluesurf/base/code/set
  find set

task set-a
  like set
    like number
  save a
    make set
      bind items
        make find
  call insert
    read a
    code 1
  call insert
    read a
    code 2
  call insert
    read a
    code 3
  send back, read a

task set-b
  like set
    like number
  save b
    make set
      bind items
        make find
  call insert
    read b
    code 2
  call insert
    read b
    code 3
  call insert
    read b
    code 4
  send back, read b

task union-list
  like list
    like number
  send back
    call to-list
      call union
        call set-a
        call set-b

task intersect-list
  like list
    like number
  send back
    call to-list
      call intersect
        call set-a
        call set-b

task difference-list
  like list
    like number
  send back
    call to-list
      call difference
        call set-a
        call set-b
`

const RANGE = `load @cluesurf/base/code/range
  find range

task list-of
  like list
    like number
  send back
    call to-list
      make range
        bind start, code 0
        bind end, code 5
        bind step, code 1
`

async function main(): Promise<void> {
  const h = await load(HASH)
  expect('hash: keys lists every key', h.keysOf(), ['a', 'b'])
  expect('hash: values lists every value', h.valuesOf(), [1, 2])

  const s = await load(SET)
  expect('set: union merges both sides', s.unionList(), [1, 2, 3, 4])
  expect(
    'set: intersect keeps shared items',
    s.intersectList(),
    [2, 3],
  )
  expect(
    'set: difference keeps only the left-only items',
    s.differenceList(),
    [1],
  )

  const r = await load(RANGE)
  expect(
    'range: to-list expands the range (end exclusive)',
    r.listOf(),
    [0, 1, 2, 3, 4],
  )

  console.log(`\ncollection: ${pass} pass, ${fail} fail`)

  if (fail > 0) {process.exit(1)}
}

main()
