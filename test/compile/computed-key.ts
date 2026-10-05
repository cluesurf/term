// A computed path segment is its WHOLE value, on a read and on an assignment target. `grid/{multiply(i, 2)}` read
// and wrote `grid[multiply]` until 2026-10-05: the segment was its first word as a variable, and the word named a task,
// so every check took it as a value and the call went missing in silence (found pairing parser/diagnostic.tree).
// Fails without compile/mint-bridge.ts `dynamicPath` reading the group and `save` sending a braced target through it.
// Run: npx tsx test/compile/computed-key.ts
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { transformSync } from 'esbuild'
import { compile } from '@term/make/code/compile/compile'
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

const text = `load @term/base/list
  find list
  find get

task four-zeros
  like list, like number

  save grid, make list
  push(grid, 0)
  push(grid, 0)
  push(grid, 0)
  push(grid, 0)
  back grid

# writes 7 at 2i through a call, reads it back through the same call
task by-call
  take i, like number
  like number

  save grid, four-zeros()
  save grid/{multiply(i, 2)}, 7
  back read(grid/{multiply(i, 2)})

# the same through a plain variable, which always worked
task by-name
  take i, like number
  like number

  save grid, four-zeros()
  save grid/{i}, 5
  back read(grid/{i})

# a call nested in the call
task by-nested
  take i, like number
  like number

  save grid, four-zeros()
  save grid/{add(multiply(i, 2), 1)}, 9
  back get(grid, 3)
`

const built = compile({ file: 'computed-key.tree', text }, { resolve: withNativeEnv('node', stdlibResolver()!), library: true, leanOf: () => true } as never)

if (!built.ok) {
  ok('the program builds', false, built.diagnostics.map(d => d.message.split('\n').join(' ')).join(' | '))
} else {
  const ts = built.typescript
  ok('no segment indexes by a task', !/\[multiply\]|grid, multiply\b|\[add\]/.test(ts), ts.split('\n').filter(l => /multiply|add\(/.test(l)).join(' | '))

  const dir = mkdtempSync(join(tmpdir(), 'term-computed-key-'))
  const file = join(dir, 'module.mjs')
  writeFileSync(file, transformSync(ts, { loader: 'ts', format: 'esm' }).code)
  const mod = (await import(pathToFileURL(file).href)) as Record<string, (...a: unknown[]) => unknown>

  ok('a call as the key writes and reads the place it computes', mod.byCall!(1) === 7, String(mod.byCall!(1)))
  ok('a variable as the key still does', mod.byName!(3) === 5, String(mod.byName!(3)))
  ok('a nested call as the key does', mod.byNested!(1) === 9, String(mod.byNested!(1)))
}

console.log(`\ncomputed-key: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
