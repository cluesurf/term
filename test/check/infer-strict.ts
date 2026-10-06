// THE TWO INFERENCE REFUSALS BEHIND THE STRICT SWITCH (check/strict.ts, decisions-2026-10.md, D10): a parameter no call
// and no use gives a type, and a call several same-arity definitions fit equally. Off, both build as they always have.
// On, each is refused naming what to write. The census of what they would refuse across the repository is
// `pnpm term:inference-census`.
// Run: sh tmp/run-term-ts.sh test/check/infer-strict.ts

import { compile } from '@term/make/code/compile/compile'
import { stdlibResolver } from '@term/make/code/resolve'
import { withNativeEnv } from '@term/make/code/compile/native'
import { setInferStrict } from '@term/make/code/check/strict'

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

const said = (text: string): string[] => {
  const built = compile({ file: 'main.tree', text }, { resolve: withNativeEnv('node', stdlibResolver()!), env: 'node' })

  return built.ok ? [] : built.diagnostics.map(d => d.message)
}

// a parameter nothing gives a type
const LONELY = `task lonely
  take value

  like text

  back <seen>
`

// a parameter a call gives a type
const CALLED = `${LONELY}
task use
  like text

  back lonely(1)
`

// two definitions of one name and arity, typed apart, and a call whose argument's type nothing has decided yet
const AMBIGUOUS = `task show
  take n, like number

  like text

  back <number>

task show
  take n, like text

  like text

  back <text>

task pass-on
  take x

  like text

  back show(x)

task use
  like text

  back show(1)
`

setInferStrict(false)
ok('off: an unconstrained parameter builds', said(LONELY).length === 0, said(LONELY).join(' | '))
ok('off: an ambiguous call builds', said(AMBIGUOUS).length === 0, said(AMBIGUOUS).join(' | '))

setInferStrict(true)
ok(
  'on: a parameter no call and no use types is refused, naming it',
  said(LONELY).some(m => m.includes('"value" of "lonely" is never given a type')),
  said(LONELY).join(' | '),
)
ok('on: a parameter a call types builds', said(CALLED).length === 0, said(CALLED).join(' | '))
ok(
  'on: a call two definitions fit equally is refused, naming both',
  said(AMBIGUOUS).some(m => m.startsWith('ambiguous call: 2 definitions of "show"') && m.includes('(number)') && m.includes('(text)')),
  said(AMBIGUOUS).join(' | '),
)
ok(
  'on: a call one definition fits is not',
  said(AMBIGUOUS).filter(m => m.startsWith('ambiguous call')).length === 1,
  said(AMBIGUOUS).join(' | '),
)

setInferStrict(false)

console.log(`\ninfer-strict: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
