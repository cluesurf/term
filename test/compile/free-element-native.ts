// A LIST OF A GENERIC FORM'S CASE WHOSE TYPE ARGUMENT NOTHING CONSTRAINS (term-self-host-001-0522, found by 0510).
// `push(xs, make none)` onto a list of maybes nothing else types: the element's type argument is a free variable.
// Rust spelled it two ways in one statement, the binding `Vec<Maybe<Rc<dyn Any>>>` and the element `Maybe::<()>::None`,
// and rustc refused the mismatch. A free type argument is `()` in a construction (compile/rust-emit.tree), so the list
// binding now spells its element's free variables `()` too, as a binding initialised by a call already did. Built and
// run on TypeScript, Rust and Kotlin where their toolchains are here, so the answer is held where it is written.
// Run: npx tsx test/compile/free-element-native.ts   (FREE_ONLY=typescript, rust, swift or kotlin runs one)
// A TypeScript test, not a `term test`: it builds with each native toolchain (P12 port debt, log.md 2026-10-31).

import { join } from 'node:path'
import { projectResolver } from '@term/call/code/make'
import { compile } from '@term/make/code/compile/compile'
import { emitRust } from '@term/make/code/compile/rust'
import { tempDir } from '../temp'
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

// a list of maybes pushed `none` twice and read for its length, a local list pushed one `none` and never read, and a
// list of pairs of maybes, so the free variable is met nested
const PROGRAM = `load @term/base/maybe
  find maybe

load @term/base/list
  find list
  find push

task count-absent
  take n, like number
  like number
  save xs, make list
  push(xs, make none)
  push(xs, make maybe/none)
  back add(xs/length, n)

task unread
  take n, like number
  like number
  save ys, make list
  push(ys, make none)
  back n

task run
  like text
  send back, <{count-absent(1)} {unread(5)}>
`

const EXPECTED = '3 5'

const dir = tempDir('term-free-element-')
const only = process.env.FREE_ONLY ?? ''

// the Rust text: the list binding and the element it holds spell the free argument alike
if (!only || only === 'rust') {
  const built = compile({ file: join(dir, 'text.tree'), text: PROGRAM }, { resolve: projectResolver(process.cwd(), 'rust'), env: 'rust' } as never)
  ok('compiles', built.ok, built.ok ? '' : built.diagnostics.map(d => d.message).join(' | '))
  if (built.ok) {
    const rs = emitRust(built.program)
    const at = rs.indexOf('fn count_absent(')
    const body = rs.slice(at, rs.indexOf('\n}\n', at))
    ok('rust: the list binding names no Rc<dyn Any> element for a free argument', !/Vec<Maybe<std::rc::Rc<dyn std::any::Any>>>/.test(body), body)
  }
}

// Swift had the same defect in its own spelling ('Maybe<Never>' handed where 'Maybe<Any>' is wanted), fixed by 0529
for (const backend of BACKENDS.filter(b => !only || b === only)) {
  const ran = runOn({
    backend,
    program: PROGRAM,
    resolve: env => projectResolver(process.cwd(), env),
    dir,
    name: 'free-element',
  })

  if (ran.form === 'skipped') {
    console.log(`skip  ${backend}: ${ran.reason}`)
    continue
  }

  ok(
    `${backend}: a list of maybes pushed none builds and runs, its length read`,
    ran.form === 'ran' && ran.output === EXPECTED,
    ran.form === 'ran' ? `got ${JSON.stringify(ran.output)}` : `${ran.stage}: ${ran.reason.slice(0, 600)}`,
  )
}

console.log(`\nfree-element-native: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
