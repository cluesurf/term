// A `sift` on a CALL'S RESULT binds exactly as a `sift` on a saved local (term-self-host-001-0510, self-host traps
// T-0006). check/judging.tree's reduce-array sifted `get(sp, 2)` directly, and once a second union with a case of the
// same name (`app`, tagged on another field) joined the program, the arm tested and read the OTHER union's tag and
// fields: the small task `get` was inlined (ir/simplifying.tree) and its value kept the callee's own type `t`, so the
// emitters found no form for the subject and took the case by NAME from whichever union declares it. An inlined call
// now carries the call's type. Each case name two unions share is held on TypeScript and Rust, through the stdlib's
// `get` and through a generic task of the file's own.
// Run from deck/term/deck/term: npx tsx test/compile/sift-call-subject.ts
import { compile } from '@term/make/code/compile/compile'
import { emitRust } from '@term/make/code/compile/rust'
import type { Source } from '@term/make/code/compile/load'
import { resolve as resolvePath } from 'node:path'
import { projectResolver } from '@term/call/code/make'

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

const project = projectResolver(resolvePath('deck/make'), 'node')

function build(main: string) {
  const resolve = (path: string, from?: string): Source | undefined =>
    (project as (p: string, f?: string) => Source | undefined)(path, from)
  return compile({ file: 'main.tree', text: main }, { resolve, leanOf: () => true } as never)
}

// the text of one emitted function, TypeScript or Rust
function slice(text: string, head: string): string {
  const at = text.indexOf(head)
  return at < 0 ? '' : text.slice(at, text.indexOf('\n}\n', at))
}

const upper = (name: string): string => name[0]!.toUpperCase() + name.slice(1)

// two unions sharing the case `name`: `elim` tagged on `e` with an `arg` field, `other` tagged on `k` with `fun`. The
// sifts are over elim's case, so every arm must test `e` and read `arg`, never `k` and `fun`
function shared(name: string): void {
  const main = `load @term/base/list
  find get

form elim
  mark tag, name e
  case ${name}
    link arg, like number
  case proj
    link at, like number

form other
  mark tag, name k
  case ${name}
    link fun, like text
  case lam
    link body, like text

task first
  head t
  take xs, like list, like t
  like t
  back get(xs, 0)

task pick-get
  take sp, like list, like elim
  like number
  sift get(sp, 0)
    case ${name}
      link arg
      back arg
    miss
      back 0

task pick-own
  take sp, like list, like elim
  like number
  sift first(sp)
    case ${name}
      link arg
      back arg
    miss
      back 0

task pick-saved
  take sp, like list, like elim
  like number
  save one, get(sp, 0)
  sift one
    case ${name}
      link arg
      back arg
    miss
      back 0

task use-other
  take o, like other
  like text
  sift o
    case ${name}
      back fun
    miss
      back <>
`
  const result = build(main)
  ok(`case ${name}: builds`, result.ok, result.ok ? '' : result.diagnostics.map(d => d.message).join(' | '))
  if (!result.ok) {
    return
  }
  const ts = result.typescript
  const rs = emitRust(result.program)
  const variant = upper(name)
  for (const fn of ['pickGet', 'pickOwn', 'pickSaved']) {
    const body = slice(ts, `function ${fn}(`)
    ok(`case ${name}: ${fn} tests elim's tag on TypeScript`, /\.e === "/.test(body) && !/\.k === "/.test(body), body)
    ok(`case ${name}: ${fn} reads elim's field on TypeScript`, /\.arg\b/.test(body) && !/\.fun\b/.test(body), body)
    const native = slice(rs, `fn ${fn.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`)}(`)
    if (native !== '') {
      ok(`case ${name}: ${fn} matches Elim::${variant} on Rust`, native.includes(`Elim::${variant}`) && !native.includes(`Other::${variant}`), native)
    }
  }
  // the other union keeps its own tag where it is sifted
  const other = slice(ts, 'function useOther(')
  ok(`case ${name}: the other union still tests its own tag`, /\.k === "/.test(other) && /\.fun\b/.test(other), other)
  const native = slice(rs, 'fn pick_get(')
  ok(`case ${name}: Rust emits pick_get`, native !== '', rs.slice(0, 400))
}

for (const name of ['app', 'call', 'some', 'value', 'variable']) {
  shared(name)
}

console.log(`\nsift-call-subject: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
