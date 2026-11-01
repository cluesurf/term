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

console.log(`\n${pass} passed, ${fail} failed`)

if (fail > 0) {
  process.exit(1)
}
