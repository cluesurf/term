// A construction compared inside a condition, on Rust. The binary wrapped itself in one pair of parentheses, which
// `bare` drops at an `if`, so `fork test, is-equal(p, make point ...)` emitted `if p == Point { x: 1, y: 2 } {` and
// rustc refused the struct literal ("struct literals are not allowed here"). Found by deck/make/test/engine-data.tree
// on the base gate, 2026-10-04. Held through rustc and RUN.
// Run: npx tsx test/compile/rust-record-operand.ts

import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { emitRust } from '@term/make/code/compile/rust'
import { stdlibResolver } from '@term/make/code/resolve'
import { withNativeEnv } from '@term/make/code/compile/native'

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

const text = `form point
  link x, like number
  link y, like number

task at
  take x, like number
  take y, like number
  like point
  send back
    make point
      bind x, read x
      bind y, read y

task score
  take p, like point
  like number
  save total, code 0
  fork test
    hook test
      call is-equal
        read p
        make point
          bind x, code 1
          bind y, code 2
    hook hold
      save total, code 10
  fork test
    hook test
      call is-equal
        make point
          bind x, code 3
          bind y, code 4
        read p
    hook hold
      save total, code 20
  send back, read total

task run
  like number
  send back
    call add
      call score
        call at
          code 1
          code 2
      call score
        call at
          code 3
          code 4
`

const want = '30'

const built = compile(
  { file: 'record-operand.tree', text },
  { resolve: withNativeEnv('rust', stdlibResolver()!), env: 'rust', entryPoints: ['run', 'score'] },
)

if (!built.ok) {
  ok('the program builds for rust', false, built.diagnostics.map(d => `${d.name}: ${d.message}`).join(' | '))
} else {
  const rust = emitRust(built.program)
  const conditions = rust.split('\n').filter(line => /^\s*if .*Point/.test(line))

  ok('each construction in a condition keeps its own parentheses', conditions.length === 2 && conditions.every(line => /\(Point \{/.test(line)), conditions.join(' | '))

  const rustc = spawnSync('rustc', ['--version'], { encoding: 'utf8' })

  if (rustc.status !== 0) {
    console.log('skip  rustc  (not installed)')
  } else {
    const dir = mkdtempSync(join(tmpdir(), 'term-rust-record-operand-'))
    writeFileSync(join(dir, 'main.rs'), `${rust}\nfn main() {\n    println!("{}", run());\n}\n`)
    const binary = join(dir, 'main')
    const out = spawnSync('rustc', ['--edition', '2021', '-A', 'warnings', '-o', binary, join(dir, 'main.rs')], { encoding: 'utf8' })
    ok('rustc compiles it', out.status === 0, out.stderr.split('\n').filter(l => /^error/.test(l)).join(' | '))

    if (out.status === 0) {
      const ran = spawnSync(binary, [], { encoding: 'utf8' })
      ok('Rust answers 10 + 20', ran.stdout.trim() === want, (ran.stdout + ran.stderr).trim())
    }
  }
}

// the same family: a LEFT side that opens a block expression at the head of a tail. The stdlib's `big-compare`
// inlines to a `match`, so `is-equal(big-compare(a, b), 0)` returned `match .. { .. } == 0`, which Rust reads as a
// statement and then a stray `==`. Held on the text, since running it needs the num-bigint crate
const compared = compile(
  {
    file: 'block-operand.tree',
    text: `load @term/base/integer/big
  find big-integer
  find big-compare

task same
  take a, like big-integer
  take b, like big-integer
  like boolean
  send back
    call is-equal
      call big-compare
        read a
        read b
      code 0
`,
  },
  { resolve: withNativeEnv('rust', stdlibResolver()!), env: 'rust', entryPoints: ['same'] },
)

if (!compared.ok) {
  ok('the comparison builds for rust', false, compared.diagnostics.map(d => `${d.name}: ${d.message}`).join(' | '))
} else {
  const line = emitRust(compared.program).split('\n').find(text => /== 0/.test(text) && /cmp\(/.test(text)) ?? ''

  ok('a match on the left of == keeps its own parentheses', /\(match [^\n]*\}\) == 0/.test(line), line.trim())
}

console.log(`\nrust-record-operand: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
