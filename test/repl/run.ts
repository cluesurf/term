// REPL test: a Seed session that accumulates definitions and evaluates expressions through the real compiler (parse
// -> check -> emit -> transpile -> import -> run). Covers user definitions, stdlib loading, and error handling.
// Run: npx tsx test/repl/run.ts

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Repl } from '@term/call/code/walk'
import type { Source } from '@term/make/code/compile/load'

const here = dirname(fileURLToPath(import.meta.url))
const baseTree = join(here, '..', '..', 'deck', 'base')

const resolver = (path: string): Source | undefined => {
  const prefix = '@cluesurf/seed/'

  if (!path.startsWith(prefix)) {return undefined}

  const file = join(baseTree, `${path.slice(prefix.length)}.tree`)

  return existsSync(file)
    ? { file, text: readFileSync(file, 'utf8') }
    : undefined
}

let pass = 0
let fail = 0

function expect(name: string, got: unknown, want: unknown): void {
  if (got === want) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(
      `FAIL  ${name}  (got ${JSON.stringify(
        got,
      )}, want ${JSON.stringify(want)})`,
    )
  }
}

async function main(): Promise<void> {
  const repl = new Repl(resolver)

  // evaluate a bare expression
  const lit = await repl.feed('call add\n  code 40\n  code 2')
  expect(
    'evaluates a bare expression',
    lit.kind === 'value' && lit.text,
    '42',
  )

  // add a definition, then call it
  const def = await repl.feed(
    'task double\n  take n, like number\n  like number\n  send back\n    call multiply\n      read n\n      code 2',
  )

  expect(
    'accepts a definition',
    def.kind === 'definition' && def.text,
    'double',
  )

  const used = await repl.feed('call double\n  code 21')
  expect(
    'calls a user-defined task',
    used.kind === 'value' && used.text,
    '42',
  )

  // a definition can build on an earlier one
  await repl.feed(
    'task quadruple\n  take n, like number\n  like number\n  send back\n    call double\n      call double\n        read n',
  )

  const built = await repl.feed('call quadruple\n  code 3')
  expect(
    'definitions compose',
    built.kind === 'value' && built.text,
    '12',
  )

  // load the stdlib and use it
  const load = await repl.feed(
    'load @cluesurf/seed/code/maybe\n  find maybe',
  )

  expect('accepts a stdlib load', load.kind, 'definition')

  const unwrap = await repl.feed(
    'call unwrap-or\n  make some\n    bind value, code 7\n  code 0',
  )

  expect(
    'runs a stdlib method',
    unwrap.kind === 'value' && unwrap.text,
    '7',
  )

  // errors are reported, not thrown
  const bad = await repl.feed('read nope')
  expect('reports an unknown name as an error', bad.kind, 'error')

  // a broken definition is rejected and does not poison the session
  const broken = await repl.feed(
    'task oops\n  send back\n    read missing',
  )

  expect('rejects a broken definition', broken.kind, 'error')

  const stillWorks = await repl.feed('call double\n  code 5')
  expect(
    'session survives a rejected definition',
    stillWorks.kind === 'value' && stillWorks.text,
    '10',
  )

  console.log(`\nrepl: ${pass} pass, ${fail} fail`)

  if (fail > 0) {process.exit(1)}
}

main()
