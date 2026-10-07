// extendForms shares no pin and no field default (item term-self-host-001-0196, D011 rule 8): a form's resolved `pins`
// and its inherited `fields` hold their own records and expressions, so the checked program holds no object at two
// places. The census is task/term/shared-nodes.ts, over the program `compile(..., { optimize: false })` answers.
// Run: npx tsx test/compile/pins-unshared.ts

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as module from '../../../../../../task/term/shared-nodes'

const { build: buildUnit, census } = ((module as { default?: typeof module }).default ?? module) as typeof module

// the program `compile(..., { optimize: false })` answers, built the way the census builds a corpus file: with the
// resolver, role and lean rules of the deck its file stands in. A unit here is a virtual file of deck/make's `code/`
// (nothing is written there), a lean deck, so a unit is written lean and the stdlib it loads is read as that deck reads it
function build(unit: { file: string; text: string }): { program?: any[]; reason?: string } {
  return buildUnit(unit, false)
}

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

const TERM = join(import.meta.dirname, '..', '..')

// a form that extends a pinned form with a defaulted field, a pin that overrides an inherited one, and a third level
const chained = `load @term/base/exception
  find exception

form shape
  link side
    like number
    fall 4
  link color, like text

form square
  like shape
    bind color, <red>

form big-square
  like square
    bind color, <blue>

form tall-square
  like big-square
    bind side, 9

form upload-excess
  like exception
    bind note, <Too large>

form upload-huge
  like upload-excess
    bind note, <Huge>
`

// probe-0037/extend-pin.tree writes its `bind` beside `like`, where the mill reads a call of `form`. The pin belongs under
// the `like` it pins, so the unit indents it there, and nothing else of the probe changes
const probe = readFileSync(join(TERM, 'tmp/self-host/probe-0037/extend-pin.tree'), 'utf8').replace(/^ {2}bind /gm, '    bind ')

const units = [
  { name: 'the probe: an exception pins its note', file: join(TERM, 'deck/make/code/pins-unshared-probe.tree'), text: probe },
  { name: 'a pinned form extended, with a defaulted field', file: join(TERM, 'deck/make/code/pins-unshared-chain.tree'), text: chained },
]

for (const unit of units) {
  const built = build(unit)

  if (!built.program) {
    ok(`${unit.name}: compiles`, false, built.reason)
    continue
  }

  const found = census(built.program, false)
  ok(`${unit.name}: has places`, found.places > 0, `${found.places}`)
  ok(`${unit.name}: 0 shared`, found.shared.size === 0, `${found.shared.size} shared objects, ${found.sharedPlaces} places, first in ${found.firstShared?.root}`)

  // the resolved forms really do carry the pins and the inherited default, so a zero is not an empty program
  const forms = built.program.filter((s: any) => s.form === 'record-type') as any[]
  const pinned = forms.filter(f => (f.pins ?? []).length > 0)
  ok(`${unit.name}: a form holds a resolved pin`, pinned.length > 0, forms.map(f => f.name).join(' '))

  // a form's resolved pin is not the record of its `extend`, nor of its base form, nor is its value
  const held: string[] = []

  for (const form of pinned) {
    const own = new Set((form.extend?.pins ?? []).flatMap((p: any) => [p, p.value]))
    const base = forms.find(f => f.name === form.extend?.base?.name)
    const theirs = new Set((base?.pins ?? []).flatMap((p: any) => [p, p.value]))

    for (const pin of form.pins) {
      if (own.has(pin) || own.has(pin.value)) held.push(`${form.name}.${pin.name} is its extend's`)
      if (theirs.has(pin) || theirs.has(pin.value)) held.push(`${form.name}.${pin.name} is its base's`)
    }
  }

  ok(`${unit.name}: no resolved pin is its extend's or its base's`, held.length === 0, held.slice(0, 5).join(' | '))
}

// the inherited default stands at its own place in each derived form
{
  const built = build(units[1]!)
  const forms = (built.program ?? []).filter((s: any) => s.form === 'record-type') as any[]
  const fallbacks = forms.flatMap(f => f.fields.filter((x: any) => x.name === 'side').map((x: any) => x.fallback)).filter(Boolean)
  ok('the defaulted field is inherited by four forms', fallbacks.length >= 4, `${fallbacks.length}`)
  ok('no two forms hold one default', new Set(fallbacks).size === fallbacks.length)
}

console.log(`\n${pass} of ${pass + fail}`)
process.exit(fail ? 1 : 0)
