// An input's `fall` as Swift's own default, whatever it is (compile/swift.ts `swiftDefault`): a literal as written, and
// any other expression Swift can evaluate as a default, so Swift calling a Term task may leave the input out as a Term
// call may. Swift refuses `try` and `await` in a default and evaluates it without the other arguments, so a default
// that calls a raising task, or reads another input, is given none, and a Swift caller passes it. Until 2026-10-05
// only a literal was (guides: language/tasks).
// Run: npx tsx test/compile/swift-default.ts

import { spawnSync, execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { emitSwift } from '@term/make/code/compile/swift'
import { stdlibResolver } from '@term/make/code/resolve'

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

const PROGRAM = `task base
  like number
  back 40

task risky
  like number
  halt <no>

task scale
  take n, like number, fall base()
  take by, like number, fall 2
  like number
  back add(n, by)

task careful
  take n, like number, fall risky()
  like number
  back n

task twice
  take n, like number
  take m, like number, fall n
  like number
  back add(n, m)
`

const result = compile({ file: '/tmp/swift-default.tree', text: PROGRAM }, { resolve: stdlibResolver(), env: 'swift' })

if (!result.ok) {
  console.log(result.diagnostics.map(d => d.message).join('\n'))
  process.exit(1)
}

const swift = emitSwift(result.program)
// the inputs of a task's declaration, up to the arrow, since a default may hold parentheses of its own
const signature = (name: string): string => new RegExp(`func ${name}\\((.*)\\)( throws)? ->`).exec(swift)?.[1] ?? ''

ok('a call as a default is Swift\'s default', /n: Int = base\(\)/.test(signature('scale')), signature('scale'))
ok('a literal still is', /by: Int = 2/.test(signature('scale')), signature('scale'))
ok('a default that calls a raising task is given none', !/=/.test(signature('careful')), signature('careful'))
ok('nor one that reads another input', !/m: Int =/.test(signature('twice')), signature('twice'))

// Swift itself leaves the input out
if (spawnSync('which', ['swiftc']).status === 0) {
  const dir = mkdtempSync(join(tmpdir(), 'swift-default-'))
  writeFileSync(join(dir, 'main.swift'), `import Foundation\n${swift}\nprint(scale(), terminator: "")\n`)

  try {
    execFileSync('swiftc', ['-o', join(dir, 'run'), join(dir, 'main.swift')], { stdio: 'pipe' })
    const out = spawnSync(join(dir, 'run'), [], { encoding: 'utf8' }).stdout
    ok('Swift calls the task with both inputs left out, and gets 42', out === '42', out)
  } catch (error) {
    ok('Swift builds a call that leaves the inputs out', false, String((error as { stderr?: Buffer }).stderr ?? error).slice(0, 600))
  }
} else {
  console.log('skip  swiftc not installed')
}

console.log(`\nswift-default: ${pass} pass, ${fail} fail`)
process.exit(fail ? 1 : 0)
