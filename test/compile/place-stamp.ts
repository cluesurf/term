// compile/place-stamp.tree (decision 011 rules 2, 3, 5, 6, item 0038): `stampPlaces` answers a copy of a program in
// which every place is a fresh node carrying its row in place-walk's pre-order plus one, and never writes its input.
//
//   - over a corpus (task/term/shared-nodes.ts `corpus`) at the checked and the lowered stage, where the simplifier
//     shares nodes: every place of the copy is stamped with its row (shared-nodes' census, which mirrors place-walk),
//     no place of the copy shares an object, the copy is node-json-equal to its input with `placeRow` skipped, the input
//     is unchanged and carries no `placeRow`, and the copy shares no node, nor any record holding one, with its input.
//     Every case of node.tree's expression and statement met in the corpus is counted, and a case it never met is named
//   - built by hand: one literal at two places, one pin record in a record-type's `extend.pins` and `pins`, one named
//     type with a value argument as two functions' `result`, astral text in a literal. Each comes back as distinct
//     objects with distinct rows, and the input still holds one object with no `placeRow`
//   - `samePlace` and `sameStatementPlace`: a stamped node and itself agree, two places do not, and an unstamped node
//     (row 0) is at no place
//
// Run: npx tsx test/compile/place-stamp.ts [--sample N] [--seed S]
// PLACE_STAMP_MODULE names another module (an absolute path) exporting `stampPlaces`, to test a draft before it lands.

import { programJson } from '@term/make/code/compile/node-json'
import * as sharedNodes from '../../../../../../task/term/shared-nodes'
import * as nodeTreeRead from '../../../../../../task/term/node-tree-read'

type Node = Record<string, any>
type Stamp = (program: Node[]) => Node[]
type Same = (left: Node, right: Node) => boolean

const shared = ((sharedNodes as any).corpus ? sharedNodes : (sharedNodes as any).default) as typeof sharedNodes
const treeRead = ((nodeTreeRead as any).knownRecords ? nodeTreeRead : (nodeTreeRead as any).default) as typeof nodeTreeRead

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

const argv = process.argv.slice(2)
const flag = (name: string, fallback: number): number => {
  const at = argv.indexOf(name)
  return at >= 0 ? Number(argv[at + 1]) : fallback
}
const SAMPLE = flag('--sample', 30)
const SEED = flag('--seed', 7)

type Loaded = { stampPlaces?: Stamp; samePlace?: Same; sameStatementPlace?: Same }
const raw = (await (process.env.PLACE_STAMP_MODULE
  ? import(process.env.PLACE_STAMP_MODULE)
  : import('@term/make/code/compile/place-stamp'))) as Loaded & { default?: Loaded }
const loaded: Loaded = raw.stampPlaces ? raw : (raw.default ?? {})
const stampPlaces = loaded.stampPlaces!
const samePlace = loaded.samePlace!
const sameStatementPlace = loaded.sameStatementPlace!

// the keys a place walk never enters: a `type` stays as it was (place-walk never enters it), a `span` is a leaf
const SKIP = ['type']

// every object and list reachable from a value, a `span` never entered
function reachable(value: unknown, out: Set<object>): void {
  if (value === null || typeof value !== 'object' || out.has(value)) return
  out.add(value)
  if (Array.isArray(value)) {
    for (const one of value) reachable(one, out)
    return
  }
  for (const [key, inner] of Object.entries(value)) if (key !== 'span') reachable(inner, out)
}

// how many objects reachable from a value carry a `placeRow` key
function stampedObjects(value: unknown): number {
  const all = new Set<object>()
  reachable(value, all)
  let count = 0
  for (const one of all) if (!Array.isArray(one) && 'placeRow' in one) count++
  return count
}

// the objects of the copy that hold a place of the copy at any depth (or are one) and that the input holds too: what the
// copy shares with its input. A skipped key, a match arm's `type` and a record that holds no node stay as they were
function sharedWithInput(input: Node[], copy: Node[]): number {
  const before = new Set<object>()
  reachable(input, before)
  const places = new Set<object>(shared.placesOf(copy).map(row => row.node))
  const holding = new Map<object, boolean>()
  let count = 0
  const walk = (value: unknown): boolean => {
    if (value === null || typeof value !== 'object') return false
    const known = holding.get(value)
    if (known !== undefined) return known
    holding.set(value, false)
    let holds = places.has(value)
    const entries = Array.isArray(value) ? value.map((one, at) => [String(at), one] as const) : Object.entries(value)
    for (const [key, inner] of entries) {
      if (key === 'span') continue
      if (!Array.isArray(value) && SKIP.includes(key)) continue
      if (walk(inner)) holds = true
    }
    holding.set(value, holds)
    if (holds && before.has(value)) count++
    return holds
  }
  walk(copy)
  return count
}

// ---- the corpus ----

const known = treeRead.knownRecords()
const CASES = {
  expression: new Set(known.get('expression')!.variants.map(v => v.name)),
  statement: new Set(known.get('statement')!.variants.map(v => v.name)),
}
const met = { expression: new Set<string>(), statement: new Set<string>() }

const units = shared.corpus({ sample: SAMPLE, seed: SEED })
const blank = () => ({ programs: 0, places: 0, misstamped: 0, sharedPlaces: 0, unequal: 0, moved: 0, inputStamped: 0, sharedObjects: 0, inputShared: 0, threw: 0, notBuilt: 0, stampMs: 0, compileMs: 0 })
const totals = { checked: blank(), lowered: blank() }
let firstFailure = ''

for (const unit of units) {
  for (const stage of ['checked', 'lowered'] as const) {
    const total = totals[stage]
    const compiling = performance.now()
    const built = shared.build(unit, stage === 'lowered')
    total.compileMs += performance.now() - compiling
    if (!built.program) {
      total.notBuilt++
      continue
    }
    const program = built.program
    total.programs++
    const before = programJson([], program as never)
    total.inputShared += shared.census(program, false).sharedPlaces
    let copy: Node[]
    const started = performance.now()
    try {
      copy = stampPlaces(program)
    } catch (error) {
      total.threw++
      if (!firstFailure) firstFailure = `${unit.file} ${stage}: threw ${(error as Error).message}`
      continue
    }
    total.stampMs += performance.now() - started
    const census = shared.census(copy, true)
    total.places += census.places
    total.misstamped += census.misstamped
    total.sharedPlaces += census.sharedPlaces
    if (census.misstamped > 0 && !firstFailure) firstFailure = `${unit.file} ${stage}: ${census.misstamped} misstamped`
    if (programJson(['placeRow'], copy as never) !== before) {
      total.unequal++
      if (!firstFailure) firstFailure = `${unit.file} ${stage}: program-json differs`
    }
    if (programJson([], program as never) !== before) total.moved++
    total.inputStamped += stampedObjects(program)
    const sharing = sharedWithInput(program, copy)
    total.sharedObjects += sharing
    if (sharing > 0 && !firstFailure) firstFailure = `${unit.file} ${stage}: ${sharing} objects shared with the input`
    for (const row of shared.placesOf(copy)) {
      const form = row.node.form as string
      // a name both kinds declare counts for both: the census does not say which kind a place is
      if (CASES.statement.has(form)) met.statement.add(form)
      if (CASES.expression.has(form)) met.expression.add(form)
    }
  }
}

for (const stage of ['checked', 'lowered'] as const) {
  const t = totals[stage]
  console.log(
    `${stage}: ${t.programs} programs (${t.notBuilt} not built), ${t.places} places stamped, input sharing ${t.inputShared} places; ` +
      `${t.misstamped} misstamped, ${t.sharedPlaces} shared places in the copy, ${t.unequal} unequal, ${t.moved} inputs moved, ` +
      `${t.inputStamped} input objects stamped, ${t.sharedObjects} objects shared with the input, ${t.threw} threw; stamp ${t.stampMs.toFixed(0)} ms, compile ${t.compileMs.toFixed(0)} ms (${((100 * t.stampMs) / Math.max(t.compileMs, 1)).toFixed(1)}%)`,
  )
}
const missing = (kind: 'expression' | 'statement') => [...CASES[kind]].filter(name => !met[kind].has(name))
console.log(`cases met: expression ${met.expression.size} of ${CASES.expression.size}, statement ${met.statement.size} of ${CASES.statement.size}`)
if (missing('expression').length > 0) console.log(`  expression cases the corpus never met: ${missing('expression').join(', ')}`)
if (missing('statement').length > 0) console.log(`  statement cases the corpus never met: ${missing('statement').join(', ')}`)
if (firstFailure) console.log(`first failure: ${firstFailure}`)

ok('the corpus built programs at both stages', totals.checked.programs > 0 && totals.lowered.programs > 0)
ok('the lowered corpus shares places, so the stamp has sharing to undo', totals.lowered.inputShared > 0, `${totals.lowered.inputShared}`)
for (const stage of ['checked', 'lowered'] as const) {
  const t = totals[stage]
  ok(`${stage}: every stamp ran`, t.threw === 0, `${t.threw}`)
  ok(`${stage}: every place carries its row plus one`, t.misstamped === 0 && t.places > 0, `${t.misstamped} of ${t.places}`)
  ok(`${stage}: no place of a copy shares an object`, t.sharedPlaces === 0, `${t.sharedPlaces}`)
  ok(`${stage}: every copy is node-json-equal to its input, placeRow skipped`, t.unequal === 0, `${t.unequal}`)
  ok(`${stage}: no input was written`, t.moved === 0 && t.inputStamped === 0, `${t.moved} moved, ${t.inputStamped} stamped`)
  ok(`${stage}: no copy shares a place or a record holding one with its input`, t.sharedObjects === 0, `${t.sharedObjects}`)
}

// ---- built by hand ----

const HAND = `load @term/base/exception
  find excess

form upload-excess
  like excess
    bind note, <Upload 😀 𝔸 too large>
    link policy, like text

task first
  take a, like number
  like number
  back add(a, 1)

task second
  take a, like number
  like number
  back add(a, 2)
`
const hand = shared.build({ file: 'test/compile/place-stamp-hand.tree', text: HAND }, false)
ok('the hand program compiles', hand.program !== undefined, hand.reason ?? '')
if (hand.program) {
  const program = hand.program
  const span = { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } }
  const first = program.find(s => s.form === 'function' && s.name === 'first')!
  const second = program.find(s => s.form === 'function' && s.name === 'second')!
  const record = program.find(s => s.form === 'record-type' && s.name === 'upload-excess')!
  // one literal at two places
  const literal = { form: 'string', value: 'twice 😀 𝔸', span }
  first.body = [{ form: 'return', value: { form: 'binary', op: '+', left: literal, right: literal, span }, span }]
  // one named type with a value argument, as two functions' result
  const valueArg = { form: 'integer', value: 3, span }
  const named = { kind: 'named', name: 'vec', valueArgs: [valueArg] }
  first.result = named
  second.result = named
  // one pin record in extend.pins and pins
  const pin = record.extend?.pins?.[0] ?? { name: 'note', value: { form: 'string', value: 'Upload 😀 𝔸 too large', span } }
  if (record.extend) record.extend.pins = [pin]
  record.pins = [pin]
  ok('the hand record-type has an extend to share a pin through', record.extend !== undefined)

  const before = programJson([], program as never)
  const copy = stampPlaces(program)
  const copyFirst = copy.find(s => s.form === 'function' && s.name === 'first')!
  const copySecond = copy.find(s => s.form === 'function' && s.name === 'second')!
  const copyRecord = copy.find(s => s.form === 'record-type' && s.name === 'upload-excess')!
  const sum = copyFirst.body[0].value
  ok('one literal at two places comes back as two objects', sum.left !== sum.right && sum.left !== literal && sum.right !== literal)
  ok(
    'the two literals carry two rows, each above 0',
    sum.left.placeRow > 0 && sum.right.placeRow > 0 && sum.left.placeRow !== sum.right.placeRow,
    `${sum.left.placeRow} ${sum.right.placeRow}`,
  )
  ok('both literals keep the astral text', sum.left.value === 'twice 😀 𝔸' && sum.right.value === 'twice 😀 𝔸')
  ok('the input still holds one literal object, with no placeRow', first.body[0].value.left === first.body[0].value.right && !('placeRow' in literal))
  const leftArg = copyFirst.result.valueArgs[0]
  const rightArg = copySecond.result.valueArgs[0]
  ok(
    'one named type at two results comes back as two, each value argument its own with its own row',
    copyFirst.result !== copySecond.result && copyFirst.result !== named && leftArg !== rightArg && leftArg.placeRow > 0 && rightArg.placeRow > 0 && leftArg.placeRow !== rightArg.placeRow,
    `${leftArg?.placeRow} ${rightArg?.placeRow}`,
  )
  ok('the input still shares its named type, unstamped', first.result === second.result && !('placeRow' in valueArg))
  const extendValue = copyRecord.extend.pins[0].value
  const pinValue = copyRecord.pins[0].value
  ok(
    'one pin record at extend.pins and pins comes back as two, each value with its own row',
    copyRecord.extend.pins[0] !== copyRecord.pins[0] && copyRecord.pins[0] !== pin && extendValue !== pinValue && extendValue.placeRow > 0 && pinValue.placeRow > 0 && extendValue.placeRow !== pinValue.placeRow,
    `${extendValue?.placeRow} ${pinValue?.placeRow}`,
  )
  ok('the input still shares its pin, unstamped', record.extend.pins[0] === record.pins[0] && !('placeRow' in pin.value))
  ok('the hand copy carries every row', shared.census(copy, true).misstamped === 0)
  ok('the hand copy shares no place', shared.census(copy, true).sharedPlaces === 0)
  ok('the hand copy is node-json-equal to its input, placeRow skipped', programJson(['placeRow'], copy as never) === before)
  ok('the hand input is unchanged', programJson([], program as never) === before && stampedObjects(program) === 0)
  ok('the hand copy shares nothing holding a place with its input', sharedWithInput(program, copy) === 0)

  // same-place
  ok('a stamped expression is at its own place', samePlace(sum.left, sum.left))
  ok('two places of one literal are not one place', !samePlace(sum.left, sum.right))
  ok('an unstamped expression is at no place, not even its own', !samePlace(literal, literal))
  ok('a stamped statement is at its own place', sameStatementPlace(copyFirst, copyFirst))
  ok('two statements are not one place', !sameStatementPlace(copyFirst, copySecond))
  ok('an unstamped statement is at no place', !sameStatementPlace(first, first))
}

// ---- every case, built by hand ----
// the cases a corpus program rarely holds (a probe only `term test --cover` writes, a hole the checker resolves), each
// built with its fields as node.tree declares them, the optional ones left out, and stamped beside the corpus's cases
{
  const span = { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } }
  const int = (value: number) => ({ form: 'integer', value, span })
  const ret = (value: Node) => ({ form: 'return', value, span })
  const conditional = {
    form: 'conditional',
    branches: [{ cond: { form: 'boolean', value: true, span }, value: { form: 'null', span } }],
    otherwise: { form: 'unit', span },
    span,
  }
  const program: Node[] = [
    { form: 'exit', span },
    { form: 'debug', span },
    { form: 'probe', key: 'a.tree:1', span },
    { form: 'guard', body: [ret(int(1))], catch: { name: 'problem', body: [ret(int(2))], span }, span },
    { form: 'hold', expr: { form: 'boolean', value: true, span }, span },
    { form: 'mask', name: 'show', methods: [], span },
    { form: 'instance', mask: 'show', target: 'thing', methods: [], span },
    { form: 'view', name: 'card', params: [], body: [], span },
    { form: 'roll', name: 'kind', like: 'text', span },
    { form: 'tell', name: 'upload-excess', links: [], span },
    {
      form: 'function',
      name: 'every',
      params: [],
      body: [ret(conditional), { form: 'expression', expr: { form: 'hole', name: 'later', span }, span }],
      generics: [],
      span,
    },
  ]
  const before = programJson([], program as never)
  let copy: Node[] = []
  let threw = ''
  try {
    copy = stampPlaces(program)
  } catch (error) {
    threw = (error as Error).message
  }
  ok('every hand-built case stamps', threw === '', threw)
  if (threw === '') {
    for (const row of shared.placesOf(copy)) {
      const form = row.node.form as string
      if (CASES.statement.has(form)) met.statement.add(form)
      if (CASES.expression.has(form)) met.expression.add(form)
    }
    ok('the every-case copy carries every row and shares no place', shared.census(copy, true).misstamped === 0 && shared.census(copy, true).sharedPlaces === 0)
    ok('the every-case copy is node-json-equal to its input, placeRow skipped', programJson(['placeRow'], copy as never) === before)
    ok('the every-case input is unchanged', programJson([], program as never) === before && stampedObjects(program) === 0)
  }
  ok('every expression case of node.tree is reached', missing('expression').length === 0, missing('expression').join(', '))
  ok('every statement case of node.tree is reached', missing('statement').length === 0, missing('statement').join(', '))
}

console.log(`\nplace-stamp: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
