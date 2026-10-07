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

const SOURCE = `load @term/base/code/exception
  find exception
  find absence

load @term/base/code/hive
  find hive-wake
  find hive-tell
  find hive-roll
  find hive-hear
  find hive-size
  find hive-wake-typed
  find hive-tells
  find hive-docks
  find hive-exceptions
  find hive-clear
  find hive-entry
  find exception-roll
  find tell-roll
  find dock-roll

load @term/base/list
  find push
  find length

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

form metric
  link name, like text
  link unit, like text

roll metric
  like metric

host request-count
  make metric
    bind name, text <requests>
    bind unit, text <count>

task metrics
  like list
  send back
    call hive-roll
      text <metric>

# the typed wake: one exception, one tell and one dock of the deck <typed-deck>
task wake-typed
  save exceptions
    make list
  save tells
    make list
  save docks
    make list
  call push
    read exceptions
    make hive-entry
      bind host, text <typed-deck>
      bind kind, text <exception>
      bind name, text <typed-absence>
      bind site, text <>
      bind base
        make exception-roll
          bind like, text <absence>
          bind chain
            make list
          bind note, text <Gone>
          bind link
            make list
  call push
    read tells
    make hive-entry
      bind host, text <typed-deck>
      bind kind, text <tell>
      bind name, text <typed-absence>
      bind site, text <>
      bind base
        make tell-roll
          bind note, text <Not here>
          bind hint, text <>
          bind link
            make list
          bind alias, text <>
  call push
    read docks
    make hive-entry
      bind host, text <typed-deck>
      bind kind, text <dock>
      bind name, text <typed-route>
      bind site, text <>
      bind base
        make dock-roll
          bind halt
            make list
  call hive-wake-typed
    text <typed-deck>
    read exceptions
    read tells
    read docks

# the first static tell, its note read as text through the typed roll
task first-tell-note
  like text
  save all
    call hive-tells
  send back, read all/0/base/note

task tell-count
  like number
  save all
    call hive-tells
  send back
    call length
      read all

task dock-count
  like number
  save all
    call hive-docks
  send back
    call length
      read all

task exception-note
  like text
  save all
    call hive-exceptions
      text <typed-deck>
  send back, read all/0/base/note

task clear-tells
  call hive-clear
    text <tell>

task tell-entries
  like list
  send back
    call hive-roll
      text <tell>

task listen-tell
  take work, like task
    take entry, like unknown
  call hive-hear
    text <tell>
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
  ok('the chain wakes the stdlib deck', ts.includes('hiveWake("@term/base"'))
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

  // a kind the app declares (`roll metric`): its constant is on the roster at boot, by reference, as a typed value
  const metrics = mod.metrics() as { name: string; kind: string; base: { name: string; unit: string } }[]
  ok('a declared kind wakes into the hive', metrics.length === 1 && metrics[0]!.kind === 'metric' && metrics[0]!.name === 'request-count', JSON.stringify(metrics))
  ok('its entry is the constant\'s value, typed', metrics[0]?.base.name === 'requests' && metrics[0]?.base.unit === 'count', JSON.stringify(metrics[0]?.base))

  // the typed wake: the three static kinds are kept in typed lists AND told, so the roster still sees them
  type Entry = { name: string; kind: string; base: Record<string, unknown> }
  const heardTells: Entry[] = []
  mod.listenTell((entry: Entry) => heardTells.push(entry))
  ok('the typed lists are empty before a typed wake', mod.tellCount() === 0 && mod.dockCount() === 0)
  mod.wakeTyped()
  ok('a tell reads back through hive-tells with its note as text', mod.firstTellNote() === 'Not here', String(mod.firstTellNote()))
  console.log(`      hive-tells note: ${mod.firstTellNote()}`)
  ok('an exception reads back through hive-exceptions', mod.exceptionNote() === 'Gone', String(mod.exceptionNote()))
  ok('a dock reads back through hive-docks', mod.dockCount() === 1, String(mod.dockCount()))
  const rolled = mod.tellEntries() as Entry[]
  ok('hive-roll answers the typed tell too', rolled.length === 1 && rolled[0]!.name === 'typed-absence' && rolled[0]!.base.note === 'Not here', JSON.stringify(rolled))
  ok('an ear on tell hears the typed tell once', heardTells.filter(e => e.kind === 'tell').length === 1, JSON.stringify(heardTells.map(e => e.kind)))
  mod.clearTells()
  ok('hive-clear on tell empties the roll and the typed list', mod.tellEntries().length === 0 && mod.tellCount() === 0)
  ok('hive-clear on tell leaves the other kinds', mod.dockCount() === 1)

  console.log(`\nhive: ${pass} pass, ${fail} fail`)

  if (fail > 0) {
    process.exit(1)
  }
}

main()
