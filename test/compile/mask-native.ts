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
import type { Ran } from './shared/run-on'

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
    // since D15 the checked product is the prelude's termMultiply, which wraps Math.multiplyExact and turns its
    // ArithmeticException into a TermStop
    ok(
      'Kotlin: the same product is termMultiply, Math.multiplyExact as a stop',
      /fun <T : Measurer> twice[\s\S]*termMultiply\(/.test(kotlin) && /fun termMultiply\(a: Long, b: Long\): Long = try \{ Math\.multiplyExact\(a, b\) \} catch \(e: ArithmeticException\) \{ throw TermStop\(/.test(kotlin),
      kotlin.slice(kotlin.indexOf('twice')),
    )
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

// the product of a mask's task, RUN past i64 on each native backend (term-compiler-0019, gap 113). `side` is 2^62, which
// fits an i64, so `measure` alone answers it; `twice` doubles it through the mask to 2^63, and the program stops with
// excess there, as a plain multiply does. On TypeScript 2^62 is already past 2^53 where `side` is made, so the stop
// comes before the mask, and it is the same stop
const PAST = (body: string): string => `mask measurer
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

      back self/side

task twice
  head t, need measurer
  take x, like t

  like number

  back multiply(measure(x), 2)

task plain
  take n, like number

  like number

  # two statements, so the simplifier keeps the task and swiftc cannot fold the product at the call
  save doubled, multiply(n, 2)
  back doubled

task run
  like text

  save big, multiply(2147483648, 2147483648)
  save b, make box, bind side, big
  back <{${body}}>
`

// THE STOP IS THE SAME ON ALL FOUR (D15, term-stdlib-parity-0015): the process ends with an exit code, not a signal,
// and says excess on stderr. Swift's own `*` trapped (killed by a signal) until its products went through termMultiply.
// A stop by a signal is `trap`, and fails here
const stopOf = (ran: Ran): string =>
  ran.form !== 'failed' || ran.stage !== 'run' ? 'no stop' : /^exit null/.test(ran.reason) ? 'trap' : /^exit [1-9]\d*: [\s\S]*excess/.test(ran.reason) ? 'excess' : 'other'

for (const backend of BACKENDS.filter(b => !only || b === only)) {
  // 2^62 fits the i64 of every native backend. TypeScript's integers end at 2^53 (note/project/term/stdlib/semantics.md),
  // so there `big` itself stops, with the same excess, before the mask is reached
  if (backend !== 'typescript') {
    const within = runOn({ backend, program: PAST('measure(b)'), resolve: env => projectResolver(process.cwd(), env), dir, name: 'mask-within' })

    if (within.form === 'skipped') {
      console.log(`skip  ${backend} range run: ${within.reason}`)
      continue
    }

    ok(`${backend}: a mask task answers 2^62 unchanged`, within.form === 'ran' && within.output === '4611686018427387904', within.form === 'ran' ? `got ${JSON.stringify(within.output)}` : `${within.stage}: ${within.reason}`)
  }

  // the plain product of the same value, beside it, and the product through the mask, which must stop exactly as the
  // plain one does
  const plain = runOn({ backend, program: PAST('plain(big)'), resolve: env => projectResolver(process.cwd(), env), dir, name: 'mask-plain' })
  const past = runOn({ backend, program: PAST('twice(b)'), resolve: env => projectResolver(process.cwd(), env), dir, name: 'mask-past' })
  ok(`${backend}: a plain multiply to 2^63 stops with excess`, stopOf(plain) === 'excess', plain.form === 'ran' ? `ran and printed ${JSON.stringify(plain.output)}` : `${plain.stage}: ${plain.reason}`)
  ok(
    `${backend}: twice through the mask, 2^63, stops with excess as the plain multiply does`,
    stopOf(past) === 'excess',
    past.form === 'ran' ? `ran and printed ${JSON.stringify(past.output)}` : `${past.stage}: ${past.reason}`,
  )
}

console.log(`\nmask-native: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
