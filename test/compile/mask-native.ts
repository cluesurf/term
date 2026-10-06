// Masks on every backend (guides/types/masks, 2026-10-05). `suit` wears a mask for a form declared elsewhere, and a call
// through it was `"measure" is not defined`: the instance was kept and its bodies dropped. A task with a body inside a
// `mask` is a DEFAULT a form may leave out (check/mask-defaults.ts), and calling one was not defined either. And a mask's
// task answers the type its mask declares, so `multiply(measure(x), 2)` over a `need` is an integer product, checked
// like any other: it was the gradual unknown, and every backend but Swift wrote it bare.
// Run: npx tsx test/compile/mask-native.ts   (MASK_ONLY=typescript, rust, swift or kotlin runs one)

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectResolver } from '@term/call/code/make'
import { compile } from '@term/make/code/compile/compile'
import { emitRust } from '@term/make/code/compile/rust'
import { emitKotlin } from '@term/make/code/compile/kotlin'
import { BACKENDS, runOn } from './shared/run-on'

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

// `box` wears `measurer` from a `suit`, written apart from the form. `scorer` has a default `bonus`: `player` leaves
// it out and gets `score + 1`, `team` writes its own. `total` calls `bonus` through the mask, and `run` calls it on a
// player directly
const PROGRAM = `mask measurer
  task measure
    take self

    like number

form box
  link side, like number

suit box
  wear measurer
    task measure
      take self

      like number

      back multiply(self/side, 4)

task twice
  head t, need measurer
  take x, like t

  like number

  back multiply(measure(x), 2)

mask scorer
  task score
    take self

    like number

  task bonus
    take self

    like number

    back add(score(self), 1)

form player
  link points, like number
  wear scorer
    task score
      take self

      like number

      back self/points

form team
  link wins, like number
  wear scorer
    task score
      take self

      like number

      back multiply(self/wins, 3)

    task bonus
      take self

      like number

      back 100

task total
  head t, need scorer
  take x, like t

  like number

  back multiply(bonus(x), 2)

task run
  like text

  save b, make box, bind side, 3
  save ada, make player, bind points, 7
  save reds, make team, bind wins, 2
  back <{twice(b)} {measure(b)} {total(ada)} {total(reds)} {bonus(ada)}>
`

// box: 12 measured, 24 twice; ada: bonus 8 by the default, 16 doubled; reds: its own bonus 100, 200 doubled
const EXPECTED = '24 12 16 200 8'

const dir = mkdtempSync(join(tmpdir(), 'term-mask-'))
const only = process.env.MASK_ONLY ?? ''

for (const backend of BACKENDS.filter(b => !only || b === only)) {
  const ran = runOn({ backend, program: PROGRAM, resolve: env => projectResolver(process.cwd(), env), dir, name: 'masks' })

  if (ran.form === 'skipped') {
    console.log(`skip  ${backend}: ${ran.reason}`)
    continue
  }

  ok(
    `${backend}: a suit is called through its mask and directly, a default is given to the form that leaves it out, and a form's own task wins`,
    ran.form === 'ran' && ran.output === EXPECTED,
    ran.form === 'ran' ? `got ${JSON.stringify(ran.output)}` : `${ran.stage}: ${ran.reason}`,
  )
}

// the product of a mask's task, checked. `twice`'s argument is a parameter here, so nothing bounds it
const RANGE = `mask measurer
  task measure
    take self

    like number

task twice
  head t, need measurer
  take x, like t

  like number

  back multiply(measure(x), 2)
`

if (!only || only === 'typescript') {
  const built = compile({ file: join(dir, 'range.tree'), text: RANGE }, { resolve: projectResolver(process.cwd(), 'node'), env: 'node' })
  const ts = built.ok ? built.typescript : built.diagnostics.map(d => d.message).join(' | ')

  ok('TypeScript: a mask task times two is a checked integer product', /__termIntStop|__termInt\(/.test(ts.slice(ts.indexOf('function twice'))), ts.slice(ts.indexOf('function twice')))

  if (built.ok) {
    const rust = emitRust(built.program)
    const kotlin = emitKotlin(built.program)

    ok('Rust: the same product is checked_mul', /fn twice[\s\S]*checked_mul/.test(rust), rust.slice(rust.indexOf('fn twice')))
    ok('Kotlin: the same product is Math.multiplyExact', /fun <T : Measurer> twice[\s\S]*multiplyExact/.test(kotlin), kotlin.slice(kotlin.indexOf('twice')))
  }

  // a mask task's declared parameter types hold at a call through the mask
  const wrong = compile(
    {
      file: join(dir, 'wrong.tree'),
      text: `mask sizer\n  task scale\n    take self\n    take by, like number\n\n    like number\n\ntask grow\n  head t, need sizer\n  take x, like t\n\n  like number\n\n  back scale(x, <two>)\n`,
    },
    { resolve: projectResolver(process.cwd(), 'node'), env: 'node' },
  )
  ok('a text passed where the mask declares a number is refused', !wrong.ok && wrong.diagnostics.some(d => d.message.includes('expected number, found text')), wrong.ok ? 'compiled' : wrong.diagnostics.map(d => d.message).join(' | '))
}

console.log(`\nmask-native: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
