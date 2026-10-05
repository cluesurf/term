// The fixed-length list fact (backend.ts, `fixedLists`), held both ways: which integer lists Kotlin may hold as a plain
// `LongArray`, which cannot grow. A wrong answer here is a build error (a LongArray handed where a MutableList goes, or
// a push onto one) rather than a wrong result, but each rule still gets a case that must NOT be fixed.
// Run: npx tsx test/compile/fixed-lists.ts

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { stdlibResolver } from '@term/make/code/resolve'
import type { Source } from '@term/make/code/compile/load'
import { withNativeEnv } from '@term/make/code/compile/native'
import { emitKotlin } from '@term/make/code/compile/kotlin'
import { fixedLists, gatedTasks, listFacts } from '@term/make/code/compile/backend'
import type { Program, Type } from '@term/make/code/compile/node'

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

const TERM = join(import.meta.dirname, '../..')
const base = join(TERM, 'deck/base')
// the stdlib, by the package path rule every resolver calls (`stdlibResolver` in deck/make/code/resolve.ts)
const stdlib = stdlibResolver()!
const build = (file: string): Program => {
  const built = compile({ file, text: readFileSync(file, 'utf8') }, { resolve: withNativeEnv('kotlin', stdlib), env: 'kotlin' })

  if (!built.ok) {
    throw new Error(`${file}: ${built.diagnostics[0]?.message}`)
  }

  return built.program
}
const integer = (t: Type): boolean => t.kind === 'number' || (t.kind === 'named' && (t.name === 'number' || t.name === 'integer'))
const facts = (program: Program) => {
  const masks = new Set(program.flatMap(n => (n.form === 'mask' ? n.methods : [])))
  const { lend, fresh } = listFacts(program, gatedTasks(program, masks))

  return fixedLists(program, lend, fresh, integer)
}

// 1. fannkuch-redux: the three working lists come from fresh tasks and are only lent and indexed, so all are fixed,
// and `flip`, which every caller hands a fixed list, takes a LongArray
const fannkuch = build(join(TERM, 'mark/fannkuch-redux/term.tree'))
const f = facts(fannkuch)
ok(
  'fannkuch\'s perm, perm1 and count are fixed',
  ['perm', 'perm1', 'count'].every(n => f.locals.get('fannkuch')?.has(n)),
  JSON.stringify([...(f.locals.get('fannkuch') ?? [])]),
)
ok('flip\'s list parameter is fixed', f.params.get('flip')?.has(0) === true, JSON.stringify([...f.params]))
ok('Kotlin writes `fun flip(perm: LongArray`', /fun flip\(perm: LongArray/.test(emitKotlin(fannkuch)))

// 2. a list stored into a record escapes, so it is shared rather than owned: `bump`, which one caller hands it, takes
// a MutableList, and the owned `zs` another caller lends to `bump` stays one too. A list a task pushes onto never is
// fixed. (A copy like `host ys, read xs` is no alias: the simplifier propagates it, so it is not the shared case)
const shared = `load @term/base/list
  find list

form holder
  link items, like list, like number

task counting
  take n, like number
  like list, like number
  save out
    make list
  walk size
    bind base, code 0
    bind head, read n
    hook next
      take site, name i
      call push
        bind list, read out
        bind item, read i
  send back, read out

task bump
  take xs, like list, like number
  take by, like number
  save xs/{by}
    call add
      read xs/{by}
      read by

task compute
  like text
  host xs
    call counting
      code 3
  host h
    make holder
      bind items, read xs
  call bump
    read xs
    code 1
  host zs
    call counting
      code 3
  call bump
    read zs
    code 2
  host a, read h/items/1
  host b, read zs/2
  send back, text <{{a}} {{b}}>
`
const sharedFile = join(TERM, 'tmp/fixed-lists-shared.tree')
const sharedFacts = facts(
  (() => {
    const built = compile({ file: sharedFile, text: shared }, { resolve: withNativeEnv('kotlin', stdlib), env: 'kotlin' })

    if (!built.ok) {
      throw new Error(built.diagnostics[0]?.message)
    }

    return built.program
  })(),
)
ok('a parameter some caller passes a shared list is NOT fixed', sharedFacts.params.get('bump')?.has(0) !== true, JSON.stringify([...sharedFacts.params].map(([k, v]) => [k, [...v]])))
ok('an owned local lent to such a parameter is NOT fixed', sharedFacts.locals.get('compute')?.has('zs') !== true, JSON.stringify([...sharedFacts.locals].map(([k, v]) => [k, [...v]])))
ok(
  'a list a task pushes onto is NOT fixed',
  [...sharedFacts.locals.values()].every(names => !names.has('out')),
  JSON.stringify([...sharedFacts.locals].map(([k, v]) => [k, [...v]])),
)

console.log(`\nfixed-lists: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
