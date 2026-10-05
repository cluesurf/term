// A call through a FIELD typed as an async task is awaited, and makes its caller async. check/async-resolve.ts counted
// a call as waiting only when its callee was a NAME in the async set, so `call(each/propose, gap)` on a field declared
// `like task / mark async` handed back the promise unawaited: the caller was not async, and a `sift` on the result
// matched no case. Found by deck/test/code/model-proposer.tree, whose model proposals were silently passed over for
// synthesis (2026-10-05). Run: npx tsx test/compile/async-field-call.ts

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

// lean, as the port that found it is written
const text = `form asker
  link name, like text
  link ask
    like task
      mark async
      take n, like number
      like number

task doubled
  mark async
  take n, like number
  like number

  back add(n, n)

task ask-through
  take who, like asker
  take n, like number
  like number

  back call(who/ask, n)

task run
  like number

  host who
    make asker
      bind name, <d>
      bind ask, doubled

  back ask-through(who, 21)
`

const built = compile(
  { file: 'async-field.tree', text },
  { resolve: withNativeEnv('node', stdlibResolver()!), entryPoints: ['run'], leanOf: () => true } as never,
)

if (!built.ok) {
  ok('the program builds', false, built.diagnostics.map(d => d.message).join(' | '))
} else {
  ok('the caller of an async field is async', /async function askThrough/.test(built.typescript), built.typescript.split('\n').filter(l => /askThrough/.test(l)).join(' | '))
  ok('the call through the field is awaited', /await who\.ask\(n\)/.test(built.typescript), built.typescript.split('\n').filter(l => /who\.ask/.test(l)).join(' | '))

  const dir = mkdtempSync(join(tmpdir(), 'term-async-field-'))
  const file = join(dir, 'module.mjs')
  writeFileSync(file, transformSync(built.typescript, { loader: 'ts', format: 'esm' }).code)
  const mod = (await import(pathToFileURL(file).href)) as { run: () => Promise<number> }
  const answer = await mod.run()

  ok('and the answer is the number, not a promise', answer === 42, String(answer))
}

console.log(`\nasync-field-call: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
