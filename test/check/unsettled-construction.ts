// An OVERLOADED CONSTRUCTION NO POSITION TYPES is refused by the checker, naming its owners
// (term-self-host-001-0514, found by 0393). `make none` in a program whose file imports both the stdlib maybe and a
// `mark text` form with a case `none` is left open by infer-construction for its position to decide. Where nothing
// decides (pushed onto a list nothing reads, a local never read, handed to an `unknown`), TypeScript wrote
// `const xs: number[]` with `xs.push("none")` and Rust `vec![Primitive::None]`: each backend its own arbitrary owner.
// Now check/inferring-holes.tree refuses it at the final zonk, under the ambiguous-call switch (D10), so no backend
// sees it. A position that types it, or the qualified spelling, still builds, read on TypeScript and Rust.
// Run from deck/term/deck/term: npx tsx test/check/unsettled-construction.ts
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

const HEAD = `load @term/base/maybe
  find maybe

load @term/base/list
  find push

form primitive
  mark text
  case word
  case none

task keep
  take v, like unknown
  like boolean
  back true
`

// the TypeScript and Rust of `build`, or the diagnostics
function emitted(body: string): { ok: boolean; ts: string; rs: string; said: string } {
  const result = build(`${HEAD}\n${body}`)
  if (!result.ok) {
    return { ok: false, ts: '', rs: '', said: result.diagnostics.map(d => d.message).join(' | ') }
  }
  const ts = result.typescript
  const at = ts.indexOf('function build(')
  const rs = emitRust(result.program)
  const r = rs.indexOf('fn build(')
  return {
    ok: true,
    ts: ts.slice(at, ts.indexOf('\n}\n', at)),
    rs: rs.slice(r, rs.indexOf('\n}\n', r)),
    said: '',
  }
}

// nothing types the construction: refused, naming both owners, on every backend alike (no backend is reached)
function refused(name: string, body: string): void {
  const out = emitted(body)
  ok(
    `${name}: refused, naming maybe and primitive`,
    !out.ok && /`make none` names a case of 2 forms/.test(out.said) && out.said.includes('maybe') && out.said.includes('primitive'),
    out.ok ? `built. TypeScript: ${out.ts} Rust: ${out.rs}` : out.said,
  )
}

refused('pushed onto a list nothing reads', `task build\n  take n, like number\n  like number\n  save xs, make list\n  push(xs, make none)\n  back n\n`)
refused('a local never read', `task build\n  take n, like number\n  like number\n  save m, make none\n  back n\n`)
refused('handed to an unknown', `task build\n  take n, like number\n  like boolean\n  back keep(make none)\n`)

// a position that types it builds as that owner
{
  const out = emitted(`task build\n  take n, like number\n  like number\n  save xs, make list\n  push(xs, make none)\n  back count(xs)\n\ntask count\n  take xs, like list, like maybe, like text\n  like number\n  back xs/length\n`)
  ok('a list typed maybe: builds', out.ok, out.said)
  if (out.ok) {
    ok('a list typed maybe: TypeScript holds no text "none"', !out.ts.includes('"none"'), out.ts)
    ok('a list typed maybe: Rust builds Maybe::None', out.rs.includes('Maybe::None') && !out.rs.includes('Primitive::None'), out.rs)
  }
}
{
  const out = emitted(`task build\n  take n, like number\n  like maybe, like text\n  back make none\n`)
  ok('a maybe result: builds', out.ok, out.said)
  if (out.ok) {
    ok('a maybe result: TypeScript holds no text "none"', !out.ts.includes('"none"'), out.ts)
    ok('a maybe result: Rust builds Maybe::None', out.rs.includes('Maybe::None') && !out.rs.includes('Primitive::None'), out.rs)
  }
}
{
  const out = emitted(`task build\n  take n, like number\n  like primitive\n  back make none\n`)
  ok('a primitive result: builds', out.ok, out.said)
  if (out.ok) {
    ok('a primitive result: TypeScript returns "none"', out.ts.includes('return "none"'), out.ts)
    ok('a primitive result: Rust builds Primitive::None', out.rs.includes('Primitive::None'), out.rs)
  }
}

// the qualified spelling is the way out the refusal names
{
  const out = emitted(`task build\n  take n, like number\n  like number\n  save xs, make list\n  push(xs, make primitive/none)\n  back n\n`)
  ok('make primitive/none onto an unread list: builds', out.ok, out.said)
  if (out.ok) {
    ok('make primitive/none: TypeScript pushes "none" onto a primitive list', out.ts.includes('"none"') && !out.ts.includes('number[]'), out.ts)
    ok('make primitive/none: Rust builds Primitive::None', out.rs.includes('Primitive::None'), out.rs)
  }
}
{
  const out = emitted(`task build\n  take n, like number\n  like number\n  save xs, make list\n  push(xs, make maybe/none)\n  back n\n`)
  ok('make maybe/none onto an unread list: builds', out.ok, out.said)
  if (out.ok) {
    ok('make maybe/none: TypeScript holds no text "none"', !out.ts.includes('"none"'), out.ts)
    ok('make maybe/none: Rust builds Maybe::None', /Maybe::(<[^>]*>::)?None/.test(out.rs) && !out.rs.includes('Primitive::None'), out.rs)
  }
}

console.log(`\nunsettled-construction: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
