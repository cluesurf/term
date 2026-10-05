// A shared `bind` has a case for every backend (check/binds.ts). One that left a backend out was a WARNING until
// 2026-10-05: it built for the backends it had, and a program calling it failed only once built for another, at the
// emit, far from the bind. It is an error now, at the bind, naming the backends it leaves out. A bind in a
// `native/<backend>/` file is for that backend alone and is not asked for the others, and so is a bind with one case.
// Run: npx tsx test/check/bind-cases.ts

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

const bind = (cases: string[]): string => `bind now-ms, like number
${cases.map(c => `  case ${c}\n    text <0>`).join('\n')}

task run
  like number
  back now-ms()
`
const messages = (file: string, text: string): string => {
  const out = compile({ file, text })

  return out.ok ? '' : out.diagnostics.map(d => d.message).join(' | ')
}

const partial = messages('/gate/code/clock.tree', bind(['node', 'browser']))
ok('a shared bind that leaves backends out is refused, naming them', /the bind `now-ms` has no case for rust, swift, kotlin/.test(partial), partial || 'built')

const whole = messages('/gate/code/clock.tree', bind(['node', 'browser', 'rust', 'swift', 'kotlin']))
ok('a shared bind with a case for each of the five builds', whole === '', whole)

const native = messages('/gate/code/native/rust/clock.tree', bind(['rust']))
ok('a bind in a native/<backend>/ file is for that backend alone', native === '', native)

// zone's tools are `case node` binds in ordinary files: a node-only CLI, built for node alone
const single = messages('/gate/code/tool.tree', bind(['node']))
ok('a bind with one case is for that backend alone, wherever it is written', single === '', single)

const four = messages('/gate/code/clock.tree', bind(['node', 'browser', 'rust', 'swift']))
ok('a bind with four of the five is refused, naming the fifth', /has no case for kotlin/.test(four), four || 'built')

console.log(`\nbind-cases: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
