// A STUB'S CARRIED SHAPE IS A DEPENDENCY ONLY OF THE UNITS THAT CONSULT IT (decision 103 of
// term/self-host/change/001-finish-self-host, item term-self-host-001-0415). `bump.tree` holds a one-statement task,
// which its stub carries as `stubShape` to every importer. `sure.tree` states a hold over a call to it, which the ring
// prover proves by unfolding it (a consult); `plain.tree` only calls it. Each unit built tells the trace sink the carried
// shapes and bodies its program holds and those its trace holds:
//   - the consulting unit's trace holds bump's shape, the calling unit's holds nothing
//   - a hold memo hit (the same unit built again in this process, from an empty store) tells the walk's trace again
//   - TERM_CACHE_VERIFY=trace builds every unit again with what its trace does not hold stripped, and passes
//   - with the recorder silenced, the consulting unit's own consult is stripped, and the trace check fails naming it
// TypeScript, not a .tree test: `term test` cannot build a separate unit and read its trace (port debt P12).
// Run: npx tsx test/compile/carried-trace.ts

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

type Built = { ok: boolean; diagnostics?: { name: string; message: string }[] }
type Unit = { files: string[]; carried: string[]; traced: string[] }

const said = (r: Built): string =>
  r.ok ? 'ok' : (r.diagnostics ?? []).map(d => `${d.name}: ${d.message}`).join(' | ')

const slug = (file: string): string => `./${file.replace(/\.tree$/, '').replace(/\W/g, '_')}.mjs`

const BUMP = `task bump
  take n, like number
  like number
  send back
    call add
      read n
      code 1
`

const SURE = `load ./bump
  find bump

task sure
  take n, like number
  like number
  hold is-equal(bump(n), add(n, 1))
  send back, read n
`

const PLAIN = `load ./bump
  find bump

task plain
  take n, like number
  like number
  send back
    call bump
      read n
`

const FILES: Record<string, string> = { bump: BUMP }
const resolve: Resolver = path => {
  const name = path.replace(/^\.\//, '')
  const text = FILES[name]

  return text === undefined ? undefined : { file: `${name}.tree`, text }
}

const sink = globalThis as { termTraceSink?: (unit: Unit) => void; termCarriedTrace?: unknown }
let units: Unit[] = []
sink.termTraceSink = unit => units.push(unit)

function build(file: string, text: string): { r: Built; unit: Unit | undefined } {
  units = []
  const r = compileSeparate({ file, text }, { resolve, cache: new CompileCache(), modules: slug }) as Built

  return { r, unit: units.find(one => one.files.some(f => f.endsWith(file))) }
}

const shape = (unit: Unit | undefined, list: 'carried' | 'traced'): boolean =>
  (unit?.[list] ?? []).some(locator => locator.endsWith('#bump#shape'))

const sure = build('sure.tree', SURE)
ok('the consulting unit builds', sure.r.ok, said(sure.r))
ok('it carries bump\'s shape', shape(sure.unit, 'carried'), JSON.stringify(sure.unit))
ok('its trace holds bump\'s shape', shape(sure.unit, 'traced'), JSON.stringify(sure.unit))

const plain = build('plain.tree', PLAIN)
ok('the calling unit builds', plain.r.ok, said(plain.r))
ok('it carries bump\'s shape', shape(plain.unit, 'carried'), JSON.stringify(plain.unit))
ok('its trace holds nothing', (plain.unit?.traced.length ?? -1) === 0, JSON.stringify(plain.unit))

// the same unit again in this process: the hold memo answers the walk, and tells what the walk consulted
const again = build('sure.tree', SURE)
ok('a memo hit keeps the walk\'s trace', shape(again.unit, 'traced'), JSON.stringify(again.unit))

// A MEMO ENTRY KEEPS WHAT ITS OWN WALK ASKED, even of a name an earlier task of the unit asked first. `second`'s walk is
// kept, then answered from the memo in a unit of its own, whose trace must hold what `second` consults (the replay's
// seed 1 failed here while the tables told a name once per table)
const TWO = `load ./bump
  find bump

task first
  take n, like number
  like number
  hold is-equal(bump(n), add(n, 1))
  send back, read n

task second
  take m, like number
  like number
  hold is-equal(bump(m), add(m, 1))
  send back, read m
`
const SECOND = `load ./bump
  find bump

task second
  take m, like number
  like number
  hold is-equal(bump(m), add(m, 1))
  send back, read m
`
const two = build('two.tree', TWO)
ok('two consulting tasks build', two.r.ok, said(two.r))
const second = build('second.tree', SECOND)
ok('a memo hit on the later task keeps its trace', shape(second.unit, 'traced'), JSON.stringify(second.unit))

process.env.TERM_CACHE_VERIFY = 'trace'

for (const [name, text] of [['sure.tree', SURE], ['plain.tree', PLAIN]] as const) {
  let raised = ''

  try {
    const r = build(name, text).r
    ok(`${name} under the trace check builds`, r.ok, said(r))
  } catch (error) {
    raised = String(error)
  }

  ok(`${name} passes the trace check`, raised === '', raised)
}

// FAIL FIRST: a recorder told nothing leaves the consult out of the trace, and the check must name it
const recorder = sink.termCarriedTrace
sink.termCarriedTrace = () => true
let caught = ''

try {
  build('sure.tree', SURE.replace('task sure', 'task sure-unrecorded').replace('send back, read n', 'send back, read n\n'))
} catch (error) {
  caught = String(error)
} finally {
  sink.termCarriedTrace = recorder
  delete process.env.TERM_CACHE_VERIFY
}

ok('an untraced consult fails the trace check', caught.includes('TERM_CACHE_VERIFY trace') && caught.includes('#bump#shape'), caught.slice(0, 300))

// A CARRIED BODY, THE KERNEL'S CONSULT: a theory's tasks carry their bodies, a rule in another file runs one and cites
// another. Traced, and under the trace check; silenced, the check must fail on the body it strips
const THEORY = `form flag
  case yes
  case no

task both
  take a, like flag
  take b, like flag

  like flag

  sift a
    case yes
      back b
    case no
      back make no

task flip
  take a, like flag

  like flag

  sift a
    case yes
      back make no
    case no
      back make yes

rule flip-twice
  seat a, like flag
  show hold, is-equal flip(flip(a)), a
  fold a
`

const USE = `load ./theory
  find flag
  find both
  find flip
  find flip-twice

rule computes-across-files
  seat a, like flag
  show hold
    is-equal
      both
        make yes
        a
      a

rule cites-across-files
  seat a, like flag
  seat b, like flag
  show hold, is-equal both(flip(flip(a)), b), both(a, b)
  cite flip-twice
`

const buildUse = (): { r: Built; unit: Unit | undefined } => {
  units = []
  const r = compileSeparate(
    { file: 'use.tree', text: USE },
    {
      resolve: path => (path === './theory' ? { file: 'theory.tree', text: THEORY } : undefined),
      cache: new CompileCache(),
      modules: slug,
      leanOf: () => true,
    },
  ) as Built

  return { r, unit: units.find(one => one.files.some(f => f.endsWith('use.tree'))) }
}

const body = (unit: Unit | undefined, list: 'carried' | 'traced', name: string): boolean =>
  (unit?.[list] ?? []).some(locator => locator.endsWith(`#${name}#body`))

const used = buildUse()
ok('the rule-stating unit builds', used.r.ok, said(used.r))
ok('it carries both\'s body', body(used.unit, 'carried', 'both'), JSON.stringify(used.unit))
ok('its trace holds both\'s body', body(used.unit, 'traced', 'both'), JSON.stringify(used.unit))
ok('its trace holds the cited rule\'s body', body(used.unit, 'traced', 'flip-twice'), JSON.stringify(used.unit))

process.env.TERM_CACHE_VERIFY = 'trace'
let usedRaise = ''

try {
  buildUse()
} catch (error) {
  usedRaise = String(error)
}

ok('the rule-stating unit passes the trace check', usedRaise === '', usedRaise.slice(0, 600))

sink.termCarriedTrace = () => true
let silenced = ''

try {
  buildUse()
} catch (error) {
  silenced = String(error)
} finally {
  sink.termCarriedTrace = recorder
  delete process.env.TERM_CACHE_VERIFY
}

ok('a body the kernel reads, untraced, fails the trace check', silenced.includes('TERM_CACHE_VERIFY trace'), silenced.slice(0, 300))

// A STORED ANSWER HOLDS WHAT ITS UNIT CONSULTED, AND NOTHING IT ONLY NAMED (decision 103 item 4 of
// term/self-host/change/001-finish-self-host, item term-self-host-001-0526). A unit's answer is stored under its name
// key plus the sorted (locator, print) list its trace holds, found through an advisory `trace:` pointer. A miss here is a
// wrong answer, so each kind of consult has its own case, each in a FRESH CompileCache over one kept store (what a new
// process sees), where the edit to the carried shape or body must turn the importer's verdict:
//   - a stale answer reads ok true where the edit makes the goal false: the case fails
//   - an importer that only calls the edited task must not be built at all
// Then the pointer's own cases: gone, overwritten by a second trace, a locator that no longer resolves, a store that
// holds a damaged pointer, and a revert, each a miss or a right hit, never a wrong answer.
{
type Built = {
  ok: boolean
  built?: string[]
  reused?: string[]
  diagnostics?: { name: string; message: string }[]
}

const said = (r: Built): string =>
  r.ok
    ? `built ${(r.built ?? []).join(',')} reused ${(r.reused ?? []).join(',')}`
    : (r.diagnostics ?? []).map(d => `${d.name}: ${d.message}`).join(' | ')

const slug = (file: string): string =>
  `./${file.replace(/\.tree$/, '').replace(/\W/g, '_')}.mjs`

// one store, kept across caches, as the disk is across processes
type Kept = Map<string, string>
const storeOf = (kept: Kept) => ({
  load: (kind: string, key: string) => kept.get(`${kind}/${key}`),
  save: (kind: string, key: string, text: string) => {
    kept.set(`${kind}/${key}`, text)
  },
})

function make(
  kept: Kept,
  dep: string,
  entry: string,
  extra: { leanOf?: () => boolean } = {},
): Built {
  const resolve: Resolver = path =>
    path === './dep' ? { file: 'dep.tree', text: dep } : undefined

  return compileSeparate(
    { file: 'entry.tree', text: entry },
    {
      resolve,
      cache: new CompileCache(storeOf(kept) as never),
      modules: slug,
      ...extra,
    },
  ) as Built
}

const IMPORT = (name: string) => `load ./dep\n  find ${name}\n\n`

type Case = {
  name: string
  dep: string
  edited: string
  consults: string
  // only calls the task, and must be cut off from the edit
  calls: string
  // the edit also moves what the name's own print holds: a push or a pop writes its list and whatever replaces it in a
  // list's table writes it otherwise or mentions another name (tried: slice, shift, push of a sum), so a unit that only
  // calls it is built too, and the print alone would turn the verdict. For these two the pointer's own proof is that its
  // list names the shape (the assert below), and the mutant with prints left out of the key turns only the other kinds
  factsMove?: boolean
}

const CASES: Case[] = [
  {
    name: 'the one-line unfolding',
    dep: 'task bump\n  take n, like number\n  like number\n  send back\n    call add\n      read n\n      code 1\n',
    edited:
      'task bump\n  take n, like number\n  like number\n  send back\n    call add\n      read n\n      code 2\n',
    consults: `${IMPORT('bump')}task sure\n  take n, like number\n  like number\n  hold is-equal(bump(n), add(n, 1))\n  send back, read n\n`,
    calls: `${IMPORT('bump')}task plain\n  take n, like number\n  like number\n  send back\n    call bump\n      read n\n`,
  },
  {
    name: 'a task that is a list push',
    dep: 'load @term/base/list\n  find list\n  find push\n\ntask grow\n  take xs, like list, like number\n  take x, like number\n  send back\n    call xs/push\n      read x\n',
    edited:
      'load @term/base/list\n  find list\n  find push\n\ntask grow\n  take xs, like list, like number\n  take x, like number\n  send back\n    call xs/slice\n      read x\n',
    consults: `load @term/base/list\n  find list\n\n${IMPORT('grow')}task sure\n  take xs, like list, like number\n  like number\n  call grow\n    read xs\n    code 1\n  hold is-above(xs/length, 0)\n  send back, read xs/length\n`,
    calls: `load @term/base/list\n  find list\n\n${IMPORT('grow')}task plain\n  take xs, like list, like number\n  like number\n  call grow\n    read xs\n    code 1\n  send back, read xs/length\n`,
    factsMove: true,
  },
  {
    name: 'a task that is a list pop',
    dep: 'load @term/base/list\n  find list\n  find pop\n\ntask drop-last\n  take xs, like list, like number\n  send back\n    call xs/slice\n',
    edited:
      'load @term/base/list\n  find list\n  find pop\n\ntask drop-last\n  take xs, like list, like number\n  send back\n    call xs/pop\n',
    consults: `load @term/base/list\n  find list\n  find push\n\n${IMPORT('drop-last')}task sure\n  take xs, like list, like number\n  like number\n  call xs/push\n    code 1\n  call drop-last\n    read xs\n  hold is-above(xs/length, 0)\n  send back, read xs/length\n`,
    calls: `load @term/base/list\n  find list\n\n${IMPORT('drop-last')}task plain\n  take xs, like list, like number\n  like number\n  call drop-last\n    read xs\n  send back, read xs/length\n`,
    factsMove: true,
  },
  {
    name: 'a task that is an extremum',
    dep: 'dock load\n  load <global:Math>, name math\n\ntask top\n  take a, like number\n  take b, like number\n  like number\n  send back\n    call math/max\n      read a\n      read b\n',
    edited:
      'dock load\n  load <global:Math>, name math\n\ntask top\n  take a, like number\n  take b, like number\n  like number\n  send back\n    call math/min\n      read a\n      read b\n',
    consults: `${IMPORT('top')}task sure\n  take a, like number\n  take b, like number\n  like number\n  save m, top(a, b)\n  hold is-minimum(m, a)\n  send back, read m\n`,
    calls: `${IMPORT('top')}task plain\n  take a, like number\n  take b, like number\n  like number\n  send back\n    call top\n      read a\n      read b\n`,
  },
]

for (const one of CASES) {
  const kept: Kept = new Map()
  const consulted = make(kept, one.dep, one.consults)
  ok(`${one.name}: the consulting unit builds`, consulted.ok, said(consulted))
  const lists = [...kept.values()].filter(text => text.includes('"portable":"trace:'))
  ok(
    `${one.name}: its pointer names the shape it consulted`,
    lists.some(text => text.includes('dep.tree#') && text.includes('#shape')),
    lists.join(' '),
  )
  const same = make(kept, one.dep, one.consults)
  ok(
    `${one.name}: nothing changed, nothing built`,
    same.ok && (same.built ?? ['?']).length === 0,
    said(same),
  )
  const edited = make(kept, one.edited, one.consults)
  ok(
    `${one.name}: the edit turns the verdict (a stale answer reads ok)`,
    !edited.ok,
    said(edited),
  )
  const back = make(kept, one.dep, one.consults)
  ok(
    `${one.name}: the revert is a hit`,
    back.ok && (back.built ?? ['?']).length === 0,
    said(back),
  )

  const plainKept: Kept = new Map()
  const plain = make(plainKept, one.dep, one.calls)
  ok(`${one.name}: the calling unit builds`, plain.ok, said(plain))
  const cut = make(plainKept, one.edited, one.calls)
  ok(
    one.factsMove === true
      ? `${one.name}: the calling unit is built, the edit moved the name's facts`
      : `${one.name}: the calling unit is cut off, only the edited unit built`,
    cut.ok &&
      (cut.built ?? []).join(',') ===
        (one.factsMove === true ? 'dep.tree,entry.tree' : 'dep.tree'),
    said(cut),
  )
}

// THE KERNEL'S BODY, under the key with bodies (decision 093). A computed rule turns false, and a citation of a rule whose
// proof changes moves with it. Lean, as the rule grammar is written
const THEORY = (yes: string): string => `form flag
  case yes
  case no

task both
  take a, like flag
  take b, like flag

  like flag

  sift a
    case yes
      ${yes}
    case no
      back make no
`
const USE = `load ./dep
  find flag
  find both

rule computes-across-files
  seat a, like flag
  show hold
    is-equal
      both
        make yes
        a
      a
`

{
  const lean = { leanOf: () => true }
  const kept: Kept = new Map()
  const first = make(kept, THEORY('back b'), USE, lean)
  ok('a carried body: the rule builds', first.ok, said(first))
  const same = make(kept, THEORY('back b'), USE, lean)
  ok(
    'a carried body: nothing changed, nothing built',
    same.ok && (same.built ?? ['?']).length === 0,
    said(same),
  )
  const edited = make(kept, THEORY('back make no'), USE, lean)
  ok(
    'a carried body: the edit refutes the rule (a stale answer reads ok)',
    !edited.ok,
    said(edited),
  )
}

// THE POINTER IS ADVISORY: gone, damaged or overwritten costs a build or a right hit
const BUMP = CASES[0]!

const pointerKeys = (kept: Kept): string[] =>
  [...kept].filter(([, text]) => text.includes('"portable":"trace:')).map(([key]) => key)

{
  const kept: Kept = new Map()
  make(kept, BUMP.dep, BUMP.consults)
  const pointers = pointerKeys(kept)
  ok('a pointer per unit is stored', pointers.length === 2, pointers.join(' '))

  for (const key of pointers) {kept.delete(key)}

  const gone = make(kept, BUMP.dep, BUMP.consults)
  ok(
    'a pointer gone: both units built again, the answer the same',
    gone.ok && (gone.built ?? []).length === 2,
    said(gone),
  )
  ok('and the build writes it back', pointerKeys(kept).length === 2)

  for (const key of pointerKeys(kept)) {kept.set(key, '{"portable":"trace:nowhere#nothing#shape"}')}

  const damaged = make(kept, BUMP.dep, BUMP.consults)
  ok(
    'a pointer naming what no unit holds: a miss, the answer the same',
    damaged.ok && (damaged.built ?? []).length === 2,
    said(damaged),
  )
  const healed = make(kept, BUMP.dep, BUMP.consults)
  ok(
    'and the next build is a hit',
    healed.ok && (healed.built ?? ['?']).length === 0,
    said(healed),
  )
}

// a carried shape that is no longer carried: the locator no longer resolves, and the unit that consulted it is built
{
  const kept: Kept = new Map()
  const entry = `${IMPORT('bump')}task sure\n  take n, like number\n  like number\n  save m, bump(n)\n  send back, read m\n`
  const dep = BUMP.dep
  const twoStatements =
    'task bump\n  take n, like number\n  like number\n  save m\n    call add\n      read n\n      code 1\n  send back, read m\n'
  make(kept, dep, BUMP.consults)
  const lost = make(kept, twoStatements, BUMP.consults)
  ok(
    'a consulted shape no longer carried: the consulting unit is asked again and refuses',
    !lost.ok,
    said(lost),
  )
  const plain = make(kept, dep, entry)
  ok('another unit of the same dep builds', plain.ok, said(plain))
}

// TWO TRACES UNDER ONE NAME KEY: the same text of a unit consults differently when a name key cannot see why (an edit that
// makes a task a one-statement task moves the facts, so here the two sides differ by the edit of what is carried)
{
  const kept: Kept = new Map()
  const a = make(kept, BUMP.dep, BUMP.consults)
  const b = make(kept, BUMP.edited, BUMP.consults)
  const c = make(kept, BUMP.dep, BUMP.consults)
  const d = make(kept, BUMP.edited, BUMP.consults)
  ok(
    'going back and forth answers each side its own verdict',
    a.ok && !b.ok && c.ok && !d.ok,
    `${said(a)} / ${said(b)} / ${said(c)} / ${said(d)}`,
  )
}

// a stored key stays one answer: the keys of a body edit differ, the name key's entry never holds an answer itself
{
  const kept: Kept = new Map()
  make(kept, BUMP.dep, BUMP.calls)
  const before = new Set(kept.keys())
  make(kept, BUMP.edited, BUMP.calls)
  const added = [...kept.keys()].filter(key => !before.has(key))
  ok(
    'a body edit stores a new answer for the edited unit only, with no overwrite of an answer',
    added.length > 0 && [...before].every(key => kept.has(key)),
    String(added.length),
  )
}

// TWO COPIES OF A PROJECT IN ONE PROCESS: the hold memo's key leaves places out, so a hit in the second copy must not tell
// the first copy's locator (the replay's graph-cap read 13 built against 0 before the key took the stub's file)
{
  const build = (kept: Kept, root: string): Built => {
    const resolve: Resolver = path =>
      path === './dep' ? { file: `${root}/dep.tree`, text: BUMP.dep } : undefined

    return compileSeparate(
      { file: `${root}/entry.tree`, text: BUMP.consults },
      { resolve, cache: new CompileCache(storeOf(kept) as never), modules: slug },
    ) as Built
  }
  const one: Kept = new Map()
  const two: Kept = new Map()
  build(one, '/copy-one')
  build(two, '/copy-two')
  const again = build(two, '/copy-two')
  ok(
    'a second copy in one process: its no-op builds nothing',
    again.ok && (again.built ?? ['?']).length === 0,
    said(again),
  )
  const lists = [...two.values()].filter(text => text.includes('"portable":"trace:'))
  ok(
    'and its pointer names its own file',
    lists.some(text => text.includes('/copy-two/dep.tree#')) &&
      !lists.some(text => text.includes('/copy-one/')),
    lists.join(' '),
  )
}

// A CONSULT THE POINTER LACKS IS A KEY THAT MISSED A DEPENDENCY, and `hits` says so: the answer stored with the recorder
// silenced has an empty list, and the hit, built again with the recorder on, consults the shape
{
  const hook = globalThis as { termCarriedTrace?: unknown }
  const recorder = hook.termCarriedTrace
  const kept: Kept = new Map()
  const text = BUMP.consults.replace('task sure', 'task sure-unrecorded')
  hook.termCarriedTrace = () => true
  make(kept, BUMP.dep, text)
  hook.termCarriedTrace = recorder
  process.env.TERM_CACHE_VERIFY = 'hits'
  let raised = ''

  try {
    make(kept, BUMP.dep, text)
  } catch (error) {
    raised = String(error)
  } finally {
    delete process.env.TERM_CACHE_VERIFY
  }

  ok('a hit that consults what its pointer lacks fails `hits`', raised.includes('hits trace'), raised.slice(0, 300))
}
}

console.log(`\n${pass} passed, ${fail} failed`)

if (fail > 0) {
  process.exit(1)
}
