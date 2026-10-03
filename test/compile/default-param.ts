// A parameter's `fall` default is spelled in the emitted TypeScript signature (self-hosting-0033), so TypeScript that
// calls an emitted module directly gets the default the checker fills at Term call sites. Found porting `check/arm`,
// whose twelve TypeScript callers had to pass `binds ?? []` because the default reached only Term callers.
// Run: npx tsx test/compile/default-param.ts

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

const text = `task count-binds
  take binds
    like list
      like text
    fall make list
  like number
  send back, read binds/length

task scale
  take n, like number
  take by, like number, fall 2
  like number
  send back, multiply(n, by)

task use
  like number
  save a, call count-binds
  save b, call scale, code 3
  send back, add(a, b)
`

const out = compile({ file: '/gate/code/default.tree', text })
const ts = out.ok ? out.typescript : ''

ok('it compiles', out.ok, out.ok ? '' : out.diagnostics.map(d => d.message).join(' | '))
ok('a list default is in the signature', /function countBinds\(binds: string\[\] = \[\]\)/.test(ts), ts.split('\n').find(l => l.includes('countBinds(')) ?? '')
ok('a number default is in the signature', /function scale\(n: number, by: number = 2\)/.test(ts), ts.split('\n').find(l => l.includes('function scale(')) ?? '')
ok(
  'a Term call site still passes the default itself, so its output is unchanged',
  // (`scale(3)` is folded to 6 by the optimizer, so only the call that survives is checked)
  /countBinds\(\[\]( as string\[\])?\)/.test(ts),
  ts.slice(ts.indexOf('function use')),
)

console.log(`\ndefault-param: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
