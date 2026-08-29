// `term look` names the deck of every symbol it lists, from the module's nearest `deck.tree` (the same answer the
// roll gives an exception's `host`). A stdlib module is `@term/seed`, a data-package module is `@term/host`, and the
// table, csv and json outputs all carry it. Run: npx tsx test/call/look.ts

import { readFileSync } from 'node:fs'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspectModule, toCsv, toJson, toTable } from '@term/make/code/inspect'
import { projectResolver } from '@term/call/code/make'
import { projectDeckOf } from '@term/call/code/deck-of'

const here = dirname(fileURLToPath(import.meta.url))
const TERM = resolvePath(here, '..', '..')

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

const deckOf = projectDeckOf()

function look(root: string, file: string) {
  const entry = { file, text: readFileSync(file, 'utf8') }

  return inspectModule(entry, projectResolver(root), deckOf)
}

const seedRoot = join(TERM, 'deck/seed')
const maybe = look(seedRoot, join(seedRoot, 'code/maybe.tree'))
const maybeForm = maybe.symbols.find(s => s.kind === 'form' && s.name === 'maybe')

ok('a stdlib module lists its form', maybeForm !== undefined)
ok('the stdlib form belongs to @term/seed', maybeForm?.deck === '@term/seed', maybeForm?.deck)
ok(
  'every symbol of the stdlib closure names a deck',
  maybe.symbols.every(s => s.deck.startsWith('@')),
  maybe.symbols.filter(s => !s.deck.startsWith('@')).map(s => `${s.name} ${s.deck}`).slice(0, 3).join(', '),
)

const hostRoot = join(TERM, 'deck/host')
const node = look(hostRoot, join(hostRoot, 'code/node.tree'))
const own = node.symbols.filter(s => s.module === 'code/node')
const pulled = node.symbols.filter(s => s.module === 'text/string')

ok('a data-package module belongs to @term/host', own.length > 0 && own.every(s => s.deck === '@term/host'), own.map(s => s.deck).join(','))
ok('the stdlib it pulls in stays @term/seed', pulled.length > 0 && pulled.every(s => s.deck === '@term/seed'), pulled.map(s => s.deck).join(','))

const table = toTable(own)
ok('the table prints the deck beside the module', /@term\/host\s+code\/node/.test(table), table.split('\n')[0])
ok('the csv has a deck column', toCsv(own).startsWith('kind,name,deck,module,signature'))
ok('the json carries the deck', JSON.parse(toJson(own)).every((s: { deck: string }) => s.deck === '@term/host'))

console.log(`\nlook: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
