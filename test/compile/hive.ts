// The hive: the roll wakes into it, a raise reaches an ear, and the roster can be read back. Uses the real stdlib
// `exception` and `hive` modules through the stdlib resolver. Run: npx tsx test/compile/hive.ts

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { transformSync } from 'esbuild'
import { compile } from '@term/make/code/compile/compile'
import { stdlibResolver } from '@term/make/code/resolve'
import { withNativeEnv } from '@term/make/code/compile/native'
import { projectDeckOf } from '@term/call/code/deck-of'

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

const SOURCE = `load @term/seed/code/exception
  find exception
  find absence

load @term/seed/code/hive
  find hive-wake
  find hive-tell
  find hive-roll
  find hive-hear
  find hive-size

form user-absence
  like absence
    bind note, <No such user>
    bind thing, <user>
    link key, like text

task find-user
  take key, like text
  like text
  fork test
    hook test
      call is-equal
        read key
        text <a>
    hook hold
      send back, text <alice>
    hook miss
      halt user-absence
        bind key, read key

task exceptions
  like list
  send back
    call hive-roll
      text <exception>

task decks
  like number
  send back
    call hive-size

task listen
  take work, like task
    take entry, like unknown
  call hive-hear
    text <exception>
    read work
`

async function main(): Promise<void> {
  const result = compile(
    { file: '/tmp/hive-test/h.tree', text: SOURCE },
    { resolve: withNativeEnv('node', stdlibResolver()), deckOf: projectDeckOf() },
  )
  ok(
    'an app that loads the hive compiles',
    result.ok,
    result.ok ? '' : result.diagnostics.map(d => `${d.file}: ${d.message ?? d.name}`).join(' | '),
  )

  if (!result.ok) {
    console.log(`\nhive: ${pass} pass, ${fail} fail`)
    process.exit(1)
  }

  const ts = result.typescript
  ok('the wake chain is emitted', ts.includes('export function wakeHive()'))
  ok('the chain wakes the stdlib deck', ts.includes('hiveWake("@term/seed"'))
  ok('the chain hooks raises into the hive', ts.includes('__termRaise'))

  const dir = mkdtempSync(join(tmpdir(), 'term-hive-'))
  const file = join(dir, 'h.mjs')
  writeFileSync(
    file,
    transformSync(ts, { loader: 'ts', format: 'esm' }).code,
  )
  const mod = await import(pathToFileURL(file).href)

  mod.wakeHive()
  ok('decks woke', mod.decks() >= 1)

  const exceptions = mod.exceptions() as { host: string; name: string }[]
  ok('the roster lists the stdlib exceptions', exceptions.some(e => e.name === 'absence'))
  ok('the roster lists the app exception', exceptions.some(e => e.name === 'user-absence'))

  const heard: { name: string }[] = []
  mod.listen((entry: { name: string }) => heard.push(entry))

  try {
    mod.findUser('zed')
  } catch {
    // expected
  }

  ok('an ear hears the raise', heard.some(e => e.name === 'user-absence'))
  ok('the happy path is unheard', heard.length === 1 && mod.findUser('a') === 'alice' && heard.length === 1)

  console.log(`\nhive: ${pass} pass, ${fail} fail`)

  if (fail > 0) {
    process.exit(1)
  }
}

main()
