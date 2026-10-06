// THE GRADUAL SEAM, CLOSED (guides/types/gradual, 2026-10-05). An `unknown` takes any value in, and gives one out only
// through a run-time test: `sift value` with an arm per type (`case number`, `case float`, `case text`, `case boolean`)
// and a `miss`. Inside an arm the subject IS that type. An `unknown` handed straight to a typed place is refused by
// `term make`, where it used to build: on TypeScript text came back from a task typed to return a number, and on Rust
// `rustc` refused it, not Term. `dynamic` stays the FFI's `any`. So a value of a static type is that type at run time on
// every backend, which is the line between the open surface and the kernel's typed values.
// Run: npx tsx test/compile/unknown-narrow.ts   (NARROW_ONLY=typescript, rust, swift or kotlin runs one)

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectResolver } from '@term/call/code/make'
import { compile } from '@term/make/code/compile/compile'
import { setUnknownSeam } from '@term/make/code/check/seam'
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

// one task narrows each kind, a `link` names the narrowed value apart from the subject, and a value read through two
// unknowns arrives as itself
const PROGRAM = `task describe
  take value, like unknown

  like text

  sift value
    case number
      back <whole {add(value, 1)}>
    case float
      back <fraction>
    case text
      back <text of {value}>
    case boolean
      fork test, value
        hold
          back <yes>
        miss
          back <no>
    miss
      back <other>

task doubled
  take value, like unknown

  like number

  sift value
    case number
      link n
      back multiply(n, 2)
    miss
      back 0

task relay
  take value, like unknown

  like unknown

  back value

task run
  like text

  back <{describe(41)} {describe(2.5)} {describe(<ada>)} {describe(true)} {describe(make list)} {doubled(relay(21))} {doubled(<x>)}>
`

const EXPECTED = 'whole 42 fraction text of ada yes other 42 0'

const dir = mkdtempSync(join(tmpdir(), 'term-narrow-'))
const only = process.env.NARROW_ONLY ?? ''

for (const backend of BACKENDS.filter(b => !only || b === only)) {
  const ran = runOn({ backend, program: PROGRAM, resolve: env => projectResolver(process.cwd(), env), dir, name: 'narrow' })

  if (ran.form === 'skipped') {
    console.log(`skip  ${backend}: ${ran.reason}`)
    continue
  }

  ok(
    `${backend}: an unknown is narrowed by a type arm, its subject typed inside it, a link names it apart, and a miss takes the rest`,
    ran.form === 'ran' && ran.output === EXPECTED,
    ran.form === 'ran' ? `got ${JSON.stringify(ran.output)}` : `${ran.stage}: ${ran.reason}`,
  )
}

// the refusals, which need only the checker, with the seam on
if (!only || only === 'typescript') {
  setUnknownSeam(true)

  const refused = (text: string): string[] => {
    const built = compile({ file: join(dir, 'refused.tree'), text }, { resolve: projectResolver(process.cwd(), 'node'), env: 'node' })

    return built.ok ? [] : built.diagnostics.map(d => d.message)
  }

  // the guide's seam: text through an unknown to a task that wants a number
  const seam = refused(`task bump\n  take n, like number\n\n  like number\n\n  back add(n, 1)\n\ntask pass-through\n  take value, like unknown\n\n  like number\n\n  back bump(value)\n`)
  ok('an unknown handed to a number is refused, naming the narrowing', seam.some(m => m.includes('an unknown value where a number is wanted') && m.includes('sift')), seam.join(' | '))

  const returned = refused(`task give\n  take value, like unknown\n\n  like text\n\n  back value\n`)
  ok('an unknown returned where text is the result is refused', returned.some(m => m.includes('an unknown value where a text is wanted')), returned.join(' | '))

  const added = refused(`task plus-one\n  take value, like unknown\n\n  like number\n\n  back add(value, 1)\n`)
  ok('arithmetic on an unknown is refused', added.length > 0, 'compiled')

  const missing = refused(`task f\n  take value, like unknown\n\n  like number\n\n  sift value\n    case number\n      back value\n  back 0\n`)
  ok('a sift over an unknown with no miss is refused', missing.some(m => m.includes('needs a `miss`')), missing.join(' | '))

  const form = refused(`form point\n  link x, like number\n\ntask f\n  take value, like unknown\n\n  like number\n\n  sift value\n    case point\n      back 1\n    miss\n      back 0\n`)
  ok('a form arm over an unknown is refused, saying what can be told apart', form.some(m => m.includes('number, float, text or boolean')), form.join(' | '))

  const fine = refused(`task same\n  take a, like unknown\n  take b, like unknown\n\n  like boolean\n\n  back is-equal(a, b)\n\ntask use\n  like boolean\n\n  back same(1, <a>)\n`)
  ok('any value into an unknown, and an unknown into an unknown, still build', fine.length === 0, fine.join(' | '))

  const native = refused(`dock load\n  load <global:host>, name host\n\ntask f\n  take value, like dynamic\n\n  like number\n\n  back value\n`)
  ok('a dynamic, the FFI any, still passes both ways', native.length === 0, native.join(' | '))
}

console.log(`\nunknown-narrow: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
