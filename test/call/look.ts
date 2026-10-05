// `term look` names the deck of every symbol it lists, from the module's nearest `deck.tree` (the same answer the
// roll gives an exception's `host`). A stdlib module is `@term/base`, a data-package module is `@term/host`, and the
// table, csv and json outputs all carry it. Run: npx tsx test/call/look.ts

import { readFileSync } from 'node:fs'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fillInferred, inspectModule, toCsv, toJson, toTable } from '@term/make/code/inspect'
import { compile } from '@term/make/code/compile/compile'
import { projectResolver } from '@term/call/code/make'
import { projectDeckOf } from '@term/call/code/deck-of'
import { showType } from '@term/make/code/compile/type-text'

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

const seedRoot = join(TERM, 'deck/base')
const maybe = look(seedRoot, join(seedRoot, 'code/maybe.tree'))
const maybeForm = maybe.symbols.find(s => s.kind === 'form' && s.name === 'maybe')

ok('a stdlib module lists its form', maybeForm !== undefined)
ok('the stdlib form belongs to @term/base', maybeForm?.deck === '@term/base', maybeForm?.deck)
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
ok('the stdlib it pulls in stays @term/base', pulled.length > 0 && pulled.every(s => s.deck === '@term/base'), pulled.map(s => s.deck).join(','))

const table = toTable(own)
ok('the table prints the deck beside the module', /@term\/host\s+code\/node/.test(table), table.split('\n')[0])
ok('the csv has a deck column', toCsv(own).startsWith('kind,name,deck,module,signature'))
ok('the json carries the deck', JSON.parse(toJson(own)).every((s: { deck: string }) => s.deck === '@term/host'))

// what a module offers is its own and what it passes on with `bear`, never what it only loads (guides:
// commands/look, 2026-10-04)
ok('the offer holds the module\'s own definitions', node.offered.some(s => s.module === 'code/node'), node.offered.map(s => s.module).join(','))
ok('and not the stdlib it only loads', !node.offered.some(s => s.module === 'text/string'), node.offered.map(s => s.module).join(','))

const exception = look(seedRoot, join(seedRoot, 'code/exception.tree'))
ok(
  'a module that offers nothing private lists every one of its own',
  exception.offered.length > 0 && exception.offered.every(s => s.module === 'code/exception'),
  exception.offered.map(s => s.module).slice(0, 5).join(','),
)

// `form.tree` holds nothing of its own and passes nine modules on with `bear`, of which two exist today, `maybe` and
// `result` (the other seven are named and missing, which `loadDiagnostics` counts)
const bears = look(seedRoot, join(seedRoot, 'code/form.tree'))
ok(
  'a module that passes others on with `bear` offers what they define, and nothing else',
  bears.offered.some(s => s.module === 'code/maybe' && s.name === 'maybe') &&
    bears.offered.every(s => s.module === 'code/maybe' || s.module === 'code/result') &&
    bears.offeredModules === 3,
  `${bears.offeredModules} modules: ${[...new Set(bears.offered.map(s => s.module))].join(',')}`,
)

// a definition's doc comment, the `#` lines above it, is listed with it (guides: commands/look, 2026-10-04)
const list = look(seedRoot, join(seedRoot, 'code/list.tree'))
const sort = list.offered.find(s => s.kind === 'task' && s.name === 'sort')
ok('a task carries the comment written above it', (sort?.note ?? '').startsWith('a new list holding the items in the order `compare` gives'), sort?.note)
ok('the table prints it under the task', toTable(sort ? [sort] : []).split('\n')[1]?.startsWith('      a new list holding') ?? false, toTable(sort ? [sort] : []))
ok('the csv and json carry it', toCsv(sort ? [sort] : []).includes('"a new list holding') && JSON.parse(toJson(sort ? [sort] : []))[0]?.note === sort?.note)
const sortBy = list.offered.find(s => s.kind === 'task' && s.name === 'sort-by')
ok('each task carries its own comment, not its neighbor\'s', (sortBy?.note ?? '').startsWith('a new list in the order of the number `key` gives'), sortBy?.note)
const zip = list.offered.find(s => s.kind === 'task' && s.name === 'zip')
ok('and one comment line is the whole note', zip?.note === 'pairs of the items at the same position, as long as the shorter list', zip?.note)

// a result the source does not write is filled from the checked program, and only that one (guides: commands/look)
{
  const file = join(TERM, 'tmp-look-infer.tree')
  const text = 'task twice\n  take n, like number\n\n  back multiply(n, 2)\n\ntask nothing\n  take n, like number\n  like void\n  save m, n\n'
  const seen = inspectModule({ file, text }, projectResolver(TERM), deckOf)
  const checked = compile({ file, text })
  const results = new Map<string, string>()

  if (checked.ok) {
    for (const node of checked.program) {
      if (node.form === 'function' && node.result) {
        results.set(node.name, showType(node.result))
      }
    }
  }

  fillInferred(seen.symbols, results)
  const twice = seen.symbols.find(s => s.name === 'twice')
  const nothing = seen.symbols.find(s => s.name === 'nothing')
  ok('an unwritten result is the inferred one, and says so', twice?.kind === 'task' && twice.result === 'number' && twice.inferred, JSON.stringify(twice))
  ok('a written one is left as written', nothing?.kind === 'task' && !nothing.inferred, JSON.stringify(nothing))
}

console.log(`\nlook: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
