// Named arguments, `fall` defaults, `slot` positional fields and parameters, and same-arity typed overloads.
// Run: npx tsx test/compile/slot.ts

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { transformSync } from 'esbuild'
import { compile } from '@term/make/code/compile/compile'

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

function messages(result: ReturnType<typeof compile>): string {
  return result.ok
    ? ''
    : result.diagnostics.map(d => d.message ?? d.name).join(' | ')
}

async function run(text: string): Promise<Record<string, (...args: unknown[]) => unknown>> {
  const result = compile({ file: 's.tree', text })

  if (!result.ok) {
    throw new Error(messages(result))
  }

  const dir = mkdtempSync(join(tmpdir(), 'term-slot-'))
  const file = join(dir, 's.mjs')
  writeFileSync(
    file,
    transformSync(result.typescript, { loader: 'ts', format: 'esm' }).code,
  )

  return import(pathToFileURL(file).href)
}

async function main(): Promise<void> {
  // named arguments in any order, and a default that fills in
  const NAMED = `task scale
  take value, like number
  take by, like number, fall 2
  take shift, like number, fall 0
  like number
  send back
    call add
      call multiply
        read value
        read by
      read shift

task use-named
  like number
  send back
    call scale
      bind shift, code 1
      bind value, code 5

task use-positional
  like number
  send back
    call scale
      code 5
      code 3

task use-mixed
  like number
  send back
    call scale
      code 5
      bind shift, code 4
`
  // `optimize: false` keeps the calls as written, so the argument order is visible in the output
  const named = compile({ file: 's.tree', text: NAMED })
  ok('named arguments compile', named.ok, messages(named))
  // the simplifier folds these calls to constants, so the order is proven by running them below

  const mod = await run(NAMED)
  ok('named call runs', mod.useNamed() === 11)
  ok('positional call runs', mod.usePositional() === 15)
  ok('mixed call runs', mod.useMixed() === 14)

  const UNKNOWN = `task scale
  take value, like number
  like number
  send back, read value

task use
  like number
  send back
    call scale
      bind amount, code 5
`
  ok('an unknown argument name is refused', messages(compile({ file: 's.tree', text: UNKNOWN })).includes('no parameter "amount"'))

  const GAP = `task scale
  take value, like number
  take by, like number
  take shift, like number
  like number
  send back, read value

task use
  like number
  send back
    call scale
      bind value, code 5
      bind shift, code 1
`
  ok('an omitted middle parameter without a default is refused', messages(compile({ file: 's.tree', text: GAP })).includes('needs "by"'))

  // slot parameters are positional only
  const SLOT_TASK = `task pair
  slot left, like number
  slot right, like number
  like number
  send back
    call add
      read left
      read right

task use
  like number
  send back
    call pair
      bind left, code 1
      bind right, code 2
`
  ok('naming a slot parameter is refused', messages(compile({ file: 's.tree', text: SLOT_TASK })).includes('is a slot of "pair"'))

  const SLOT_OK = `task pair
  slot left, like number
  slot right, like number
  like number
  send back
    call add
      read left
      read right

task use
  like number
  send back
    call pair
      code 1
      code 2
`
  ok('slot parameters take positional arguments', compile({ file: 's.tree', text: SLOT_OK }).ok, messages(compile({ file: 's.tree', text: SLOT_OK })))

  // slot fields on a form: positional make, in declaration order, with a fallback
  const SLOT_FORM = `form point
  slot x, like number
  slot y, like number
  link label, like text, fall text <origin>

task make-point
  like point
  send back
    make point
      code 3
      code 4

task read-label
  like text
  save p
    call make-point
  send back
    read p/label
`
  const slotForm = compile({ file: 's.tree', text: SLOT_FORM, optimize: false })
  ok('a positional make of a slotted form compiles', slotForm.ok, messages(slotForm))
  const sts = slotForm.ok ? slotForm.typescript : ''
  ok('positional values land on the slots in order', sts.includes('x: 3, y: 4'))
  ok('the fallback field is filled', sts.includes('label: "origin"'))

  const NO_SLOTS = `form point
  link x, like number
  link y, like number

task make-point
  like point
  send back
    make point
      code 3
      code 4
`
  ok('a positional make of a form without slots is refused', messages(compile({ file: 's.tree', text: NO_SLOTS })).includes('has no slots'))

  const TOO_MANY = `form point
  slot x, like number

task make-point
  like point
  send back
    make point
      code 3
      code 4
`
  ok('more values than slots is refused', messages(compile({ file: 's.tree', text: TOO_MANY })).includes('1 slot'))

  // same-arity overloads chosen by type
  const OVERLOAD = `task show
  take value, like number
  like text
  send back, text <number>

task show
  take value, like text
  like text
  send back, text <text>

task use-number
  like text
  send back
    call show, code 1

task use-text
  like text
  send back
    call show, text <hi>
`
  const overload = compile({ file: 's.tree', text: OVERLOAD })
  ok('same-arity overloads compile', overload.ok, messages(overload))

  if (overload.ok) {
    const om = await run(OVERLOAD)
    ok('the number overload is chosen', om.useNumber() === 'number')
    ok('the text overload is chosen', om.useText() === 'text')
  }

  const NO_FIT = `task show
  take value, like number
  like text
  send back, text <number>

task show
  take value, like text
  like text
  send back, text <text>

task use
  like text
  send back
    call show, true
`
  ok('an argument no overload takes is refused', messages(compile({ file: 's.tree', text: NO_FIT })).includes('no overload'))

  console.log(`\nslot: ${pass} pass, ${fail} fail`)

  if (fail > 0) {
    process.exit(1)
  }
}

main()
