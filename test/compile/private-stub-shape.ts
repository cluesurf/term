// A STUB'S CARRIED SHAPE IS NOT THE IMPORTER'S CODE. `mid.tree` has a one-statement task `uses` whose body calls the
// public `pick` of `pub.tree`, while its closure also holds a private `pick` of `priv.tree`. In mid's own unit the two
// are split by file and the call is bound `pick__in0_1`, and mid's stub carries that body as its `stubShape`
// (compile/stub.ts) for the shape readers. The entry's unit splits three `pick`s (`early.tree`'s too), and there
// `pick__in0_1` is priv's private one, so check/private.tree read the carried call as the entry's own use of a private
// task: `private-name` in the separate build, nothing in the merged one (term-self-host-001-0313, found by
// separate-diff on compile/minting.tree, whose minting-flow.tree's `is-halt-take` calls `word-at`).
// The privacy check skips a stub's carried shape and body: their references were checked in their own unit.
// Run: npx tsx test/compile/private-stub-shape.ts

import { compile } from '@term/make/code/compile/compile'
import { compileSeparate } from '@term/make/code/compile/separate'
import { CompileCache } from '@term/make/code/compile/cache'
import type { Resolver } from '@term/make/code/compile/load'

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

type Built = {
  ok: boolean
  diagnostics?: { name: string; message: string }[]
}

const said = (r: Built): string =>
  r.ok
    ? 'ok'
    : (r.diagnostics ?? [])
        .map(d => `${d.name}: ${d.message}`)
        .join(' | ')

const slug = (file: string): string =>
  `./${file.replace(/\.tree$/, '').replace(/\W/g, '_')}.mjs`

const resolverOf =
  (files: Record<string, string>): Resolver =>
  path => {
    const name = path.replace(/^\.\//, '')
    const text = files[name]

    return text === undefined
      ? undefined
      : { file: `${name}.tree`, text }
  }

const EARLY = `task pick
  take a, like boolean
  take b, like boolean
  like text
  send back, <early>
`

const PRIV = `task pick
  mark private
  take kids, like list, like text
  take at, like number
  like text
  send back, <priv>

task other
  take kids, like list, like text
  like text
  send back, pick(kids, 0)
`

const PUB = `task pick
  take value, like text
  take field, like text
  like text
  send back, <pub>
`

const MID = `load ./priv
  find other

load ./pub
  find pick

task uses
  take x, like text
  like text
  send back, pick(x, <y>)
`

const ENTRY = `load ./early
  find pick

load ./priv
  find other

load ./mid
  find uses

task run
  take x, like text
  like text
  send back, uses(pick(true, false))
`

// the same closure reached in other orders, so whichever split name the entry's unit gives priv's task, one of them
// is the name mid's carried shape holds
const ENTRY_LATE = `load ./mid
  find uses

load ./priv
  find other

load ./early
  find pick

task run
  take x, like text
  like text
  send back, uses(pick(true, false))
`

const ENTRY_PRIV_FIRST = `load ./priv
  find other

load ./early
  find pick

load ./mid
  find uses

task run
  take x, like text
  like text
  send back, uses(pick(true, false))
`

const resolve = resolverOf({
  early: EARLY,
  priv: PRIV,
  pub: PUB,
  mid: MID,
})

for (const [how, entry] of [
  ['early, priv, mid', ENTRY],
  ['mid, priv, early', ENTRY_LATE],
  ['priv, early, mid', ENTRY_PRIV_FIRST],
] as const) {
  const merged = compile(
    { file: 'entry.tree', text: entry },
    { resolve, cache: new CompileCache() },
  ) as Built
  const separate = compileSeparate(
    { file: 'entry.tree', text: entry },
    { resolve, cache: new CompileCache(), modules: slug },
  ) as Built

  ok(`${how}: the merged build is clean`, merged.ok, said(merged))
  ok(
    `${how}: the separate build is clean, as the merged one`,
    separate.ok,
    said(separate),
  )
}

// the check still refuses a real use: an entry calling priv's private task through its own find
const REAL = `load ./priv
  find pick

task run
  take x, like list, like text
  like text
  send back, pick(x, 0)
`

for (const [how, build] of [
  [
    'merged',
    () =>
      compile(
        { file: 'entry.tree', text: REAL },
        { resolve, cache: new CompileCache() },
      ) as Built,
  ],
  [
    'separate',
    () =>
      compileSeparate(
        { file: 'entry.tree', text: REAL },
        { resolve, cache: new CompileCache(), modules: slug },
      ) as Built,
  ],
] as const) {
  const r = build()

  ok(
    `${how}: a find of the private task is still refused`,
    !r.ok && said(r).includes('private-name'),
    said(r),
  )
}

console.log(`\n${pass} passed, ${fail} failed`)

if (fail > 0) {
  process.exit(1)
}
