// `make none` beside a `mark text` form with a case `none` (self-host traps T038, item term-self-host-001-0053,
// diagnosed by 0393). An optional field (`like maybe, like text`, `need false`) built with `make none` must hold the
// stdlib maybe's absent value, never the text "none", whether the text form is loaded and found, loaded only, or the
// file's own. Where the file defines the text form and does not import maybe (maybe reached as a type only, through
// another module's closure), check/scope.ts `bindSharedCases` binds the construction to the file's own case, and the
// field refuses it LOUDLY: the file names maybe's case only by loading maybe. Since decision 101 (item 0514) the same
// holds where the file FINDS the text form and not maybe. Each emit is read on TypeScript and Rust.
// Run from deck/term/deck/term: npx tsx test/check/none-owner.ts
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

// a module with a text form whose case is `none`, which itself loads maybe, so maybe is in every program here
const KINDS = `load @term/base/maybe\n  find maybe\n\nform primitive\n  mark text\n  case word\n  case none\n\ntask hold-kind\n  take k, like maybe, like primitive\n  like boolean\n  back true\n`

function build(main: string) {
  const resolve = (path: string, from?: string): Source | undefined =>
    path === '@app/kinds'
      ? { file: 'kinds.tree', text: KINDS }
      : (project as (p: string, f?: string) => Source | undefined)(path, from)

  return compile({ file: 'main.tree', text: main }, { resolve, leanOf: () => true } as never)
}

const HOLDER = `load @term/base/list\n  find push\n\nform holder\n  link name\n    like maybe, like text\n    need false\n  link names\n    like list, like maybe, like text\n    need false\n`

const BODY = `task build\n  take n, like number\n  like holder\n  save m, make none\n  save xs, make list\n  push(xs, make none)\n  fork test, is-above(n, 0)\n    hold\n      back make holder, bind(name, m)\n  save h\n    make holder\n      bind name, make none\n      bind names, xs\n  save h/name, make none\n  back h\n`

// the TypeScript and Rust of `build`, or the diagnostics
function emitted(main: string): { ok: boolean; ts: string; rs: string; said: string } {
  const result = build(main)
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

// every `make none` in build is the maybe's none: no text "none" on TypeScript, no Primitive or Shade on Rust
function absent(name: string, main: string): void {
  const out = emitted(main)
  ok(`${name}: builds`, out.ok, out.said)
  if (out.ok) {
    ok(`${name}: TypeScript holds no text "none"`, !out.ts.includes('"none"') && out.ts.includes('__termVariantNone'), out.ts)
    ok(`${name}: Rust builds Maybe::None`, out.rs.includes('Maybe::None') && !/(Primitive|Shade)::None/.test(out.rs), out.rs)
  }
}

const SHADE = `form shade\n  mark text\n  case none\n  case dark\n`

absent('loaded and found, maybe loaded', `load @term/base/maybe\n  find maybe\n\nload @app/kinds\n  find primitive\n  find hold-kind\n\n${HOLDER}\n${BODY}`)

{
  // found, and maybe a type only: the one owner the file's finds reach is the text form, so the construction is its
  // case, refused loudly in a maybe position (decision 101, item term-self-host-001-0514: the owner is a fact of the
  // file, as for the file's own text form below). It built maybe's none by position until then
  const out = emitted(`load @app/kinds\n  find primitive\n  find hold-kind\n\n${HOLDER}\n${BODY}`)
  ok(
    'loaded and found, maybe a type only: refused, naming maybe',
    !out.ok && out.said.includes('expected maybe, like text, found primitive'),
    out.ok ? out.ts : out.said,
  )
}
absent('loaded, not found, maybe a type only', `load @app/kinds\n  find hold-kind\n\n${HOLDER}\n${BODY}`)
absent('the file\'s own text form, maybe loaded', `load @term/base/maybe\n  find maybe\n\nload @app/kinds\n  find hold-kind\n\n${SHADE}\n${HOLDER}\n${BODY}`)

{
  // the file's own text form and maybe a type only: the construction is the file's own case, refused loudly
  const out = emitted(`load @app/kinds\n  find hold-kind\n\n${SHADE}\n${HOLDER}\n${BODY}`)
  ok(
    'the file\'s own text form, maybe a type only: refused, naming maybe',
    !out.ok && out.said.includes('expected maybe, like text, found shade'),
    out.ok ? out.ts : out.said,
  )
}

{
  // the text form's own value still builds as itself where the position wants it
  const out = build(`load @app/kinds\n  find primitive\n\ntask pick\n  like primitive\n  back make none\n`)
  ok('a text form position still builds its own none', out.ok && out.typescript.includes('return "none"'), out.ok ? out.typescript : out.diagnostics.map(d => d.message).join(' | '))
}

console.log(`\nnone-owner: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
