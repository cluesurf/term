// TypeScript tests a checked value where it stands (typescript.ts, `testedInPlace`): a `let`, a write to a plain
// variable and a `return` whose whole value is one checked operation is the value made into a temporary, the overflow
// test written in place, then the binding. Held both ways: the shape, and that it means what `__termInt` meant. A sum
// past 2^53 still raises `excess` where it happens, and a handler reading the variable after sees the value it held
// before, since the write comes after the test. A value that is more than one checked operation keeps the call.
// Run: npx tsx test/compile/ts-tested-in-place.ts

import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { stdlibResolver } from '@term/make/code/resolve'
import { withNativeEnv, nativePrelude, joinTypeScriptPrelude } from '@term/make/code/compile/native'
import { runDir } from './run-dir'

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

const PROGRAM = `task next
  take x, like number
  like number
  send back
    call add
      read x
      code 1

task climb
  take start, like number
  like text
  save x, read start
  host y
    call add
      read x
      code 1
  save x
    call add
      read y
      call next
        read x
  fork
    mark unsafe
    save x
      call add
        read x
        code 9007199254740991
    send back, text <no>
  halt take
    take problem
    send back, text <{problem/form}:{x}:{y}>

task compute
  like text
  send back
    call climb
      code 10
`

const built = compile({ file: 'main.tree', text: PROGRAM }, { resolve: withNativeEnv('node', stdlibResolver()!), env: 'node' })

if (!built.ok) {
  throw new Error(built.diagnostics.map(d => d.message).join(' | '))
}

const ts = built.typescript
const at = (pattern: RegExp): string => ts.split('\n').filter(l => pattern.test(l)).map(l => l.trim()).join(' | ')

ok(
  'a `return` of one checked sum is tested in place',
  /const (__n\d+) = x \+ 1; if \(!\(\1 <= 9007199254740991 && \1 >= -9007199254740991\)\) __termIntStop\(\1\); return \1/.test(ts),
  at(/x \+ 1/),
)
ok('a `let` of one checked sum is tested in place', /const (__n\d+) = x \+ 1; if \(.*\) __termIntStop\(\1\); const y\b/.test(ts), at(/const y/))
ok('a write of one checked sum is tested in place, the write last', /const (__n\d+) = x \+ 9007199254740991; if \(.*\) __termIntStop\(\1\); x = \1/.test(ts), at(/9007199254740991; if|x \+ 9007199254740991/))
ok(
  'a value holding a second check keeps the call for the inner one, and only the outer is in place',
  /const (__n\d+) = y \+ (__termInt\(x \+ 1\)|next\(x\)); if \(.*\) __termIntStop\(\1\); x = \1/.test(ts),
  at(/y \+/),
)

// what it means, run: 10 + 1 is y = 11, x = 11 + next(10) = 22, then 22 + 2^53 - 1 is past the safe integers
const dir = runDir('ts-tested-in-place-')
const file = join(dir, 'main.ts')
writeFileSync(file, `${joinTypeScriptPrelude(nativePrelude(built.program, 'node', () => undefined), ts)}\nprocess.stdout.write(String(compute()))\n`)
const out = execFileSync('npx', ['tsx', file], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim()
ok('the overflow raises `excess`, and the handler reads the value the variable held before', out === 'excess:22:11', out)

console.log(`\nts-tested-in-place: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
