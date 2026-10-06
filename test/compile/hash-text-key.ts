// A `make hash` KEY THAT IS NOT A WORD (decisions-2026-10.md, D14). `save a, code 1` under `make hash` keys the entry
// by the word, and the `save` grammar took no text there, so a key with a space, a capital or a leading digit could not
// be written in the literal at all, only set afterwards with `m/set(<Two words>, v)`. Under `make hash` alone a `save`
// whose first part is any value is that key (mill: save/mine.tree `save-key`), a text literal or a computed `<{k}>`.
// Everywhere else `save` still binds a name, so `save <x>, 1` in a task body is refused as before.
// Run: sh tmp/run-term-ts.sh test/compile/hash-text-key.ts   (KEY_ONLY=typescript, rust, swift or kotlin runs one)

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { projectResolver } from '@term/call/code/make'
import { BACKENDS, runOn } from './shared/run-on'

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

const PROGRAM = `task run
  like text

  save which, <b>
  save table
    make hash
      save plain, 1
      save <Two words>, 2
      save <3rd>, 3
      save <{which}c>, 4
  back <{table/get(<plain>)} {table/get(<Two words>)} {table/get(<3rd>)} {table/get(<bc>)} {table/size}>
`

const EXPECTED = '1 2 3 4 4'

const dir = mkdtempSync(join(tmpdir(), 'term-hash-key-'))
const only = process.env.KEY_ONLY ?? ''

for (const backend of BACKENDS.filter(b => !only || b === only)) {
  const ran = runOn({ backend, program: PROGRAM, resolve: env => projectResolver(process.cwd(), env), dir, name: 'keys' })

  if (ran.form === 'skipped') {
    console.log(`skip  ${backend}: ${ran.reason}`)
    continue
  }

  ok(
    `${backend}: a word, a text and a computed key in one literal`,
    ran.form === 'ran' && ran.output === EXPECTED,
    ran.form === 'ran' ? `got ${JSON.stringify(ran.output)}` : `${ran.stage}: ${ran.reason}`,
  )
}

if (!only || only === 'typescript') {
  const outside = compile(
    { file: join(dir, 'outside.tree'), text: 'task run\n  like number\n\n  save <x>, 1\n  back 1\n' },
    { resolve: projectResolver(process.cwd(), 'node'), env: 'node' },
  )
  ok('outside make hash, save with a text first is still refused', !outside.ok, 'it built')
}

console.log(`\nhash-text-key: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
