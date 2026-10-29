// A CASE NAMED LIKE A UNION NEVER RENAMES IT (decision 066 section 2, term-self-host-001-0378). A form with a case
// `maybe`, in a module that loads @term/base/maybe, made check/scope rename the stdlib's union `maybe__form` (the
// renaming meant for a record form a construction could take, scope.ts / scope.tree `separateCaseNames`). Every
// construction and type still bound right, but the emitters know the stdlib's `maybe` by its name: on TypeScript a
// `need false` field `like maybe` stopped being `f?: T` and was boxed, so a field left out read undefined and a match on
// it threw, and the type was emitted `MaybeForm` (Rust `Maybe__form`) beside every other module's `Maybe`.
//
// Held here: the union keeps its name on TypeScript and Rust, a `need false` maybe field is `f?: T`, the form with the
// case keeps its own name, `make rule/maybe` and `case maybe` reach the case, and the program runs alike on the four
// backends, the shape built as the entry and loaded by another file. A union of the user's own named like another
// form's case keeps its name too, and a RECORD form named like a case is still renamed (it can be built by its name).
//
// Run: npx tsx test/check/case-names-a-form.ts

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import type { Source } from '@term/make/code/compile/load'
import { emitRust } from '@term/make/code/compile/rust'
import { withNativeEnv } from '@term/make/code/compile/native'
import { stdlibResolver } from '@term/make/code/resolve'
import { BACKENDS, runOn } from '../compile/shared/run-on'

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

const RULE = `load @term/base/maybe
  find maybe

form rule
  mark tag, name kind
  case leaf
    link name, like text
    link note
      like maybe, like text
      need false
  case maybe
    link test
      like maybe, like text
      need false
    link children, like list, like rule

task first-test
  take r, like rule
  like maybe, like text
  fork case, read r
    case maybe
      send back, read test
    case leaf
      send back, read note
  send back, make none

task describe
  take m, like maybe, like text
  like text
  fork case, read m
    case some
      send back, read value
    case none
      send back, text <none>
  send back, text <none>

task build-maybe
  like rule
  save kids, make list
  send back
    make rule/maybe
      bind test, make(some, text <x>)
      bind children, read kids

task build-leaf
  like rule
  send back
    make leaf
      bind name, text <n>
      bind note, make none
`

const RUN = `task run
  like text
  save a
    call describe
      call first-test
        call build-maybe
  save b
    call describe
      call first-test
        call build-leaf
  send back, text <{a} {b}>
`

const LOADED = `load @app/rule
  find rule
  find first-test
  find describe
  find build-maybe
  find build-leaf

load @term/base/maybe
  find maybe

task again
  take r, like rule
  like maybe, like text
  send back
    call first-test
      read r

${RUN}`

function resolverOf(files: Record<string, string>, env: Parameters<typeof withNativeEnv>[0]) {
  const base = withNativeEnv(env, stdlibResolver()!)

  return (path: string, from?: string, how?: unknown): Source | undefined =>
    files[path] !== undefined ? { file: `/gate/code/${path.slice('@app/'.length)}.tree`, text: files[path]! } : (base as (p: string, f?: string, h?: unknown) => Source | undefined)(path, from, how)
}

function said(result: { ok: boolean; diagnostics?: { message: string }[] }): string {
  return result.ok ? '' : (result.diagnostics ?? []).map(d => d.message).slice(0, 4).join(' | ')
}

// ---- the shape as the entry, and loaded by another file: the TypeScript and the Rust ----

for (const [how, file, text, files] of [
  ['the entry', '/gate/code/rule.tree', `${RULE}\n${RUN}`, {}],
  ['loaded', '/gate/code/main.tree', LOADED, { '@app/rule': RULE }],
] as const) {
  const ts = compile({ file, text }, { resolve: resolverOf(files, 'node'), env: 'node' })
  ok(`${how}: it compiles for TypeScript`, ts.ok, said(ts))
  const code = ts.ok ? ts.typescript : ''
  ok(`${how}: the stdlib union keeps its name`, /export type Maybe<T = any> =/.test(code) && !/MaybeForm/.test(code), code.slice(0, 600))
  ok(`${how}: the form with the case keeps its own name`, /export type Rule =/.test(code))
  ok(`${how}: a need-false maybe field is f?: T`, /kind: "maybe"; test\?: string;/.test(code) && /note\?: string/.test(code), code.slice(code.indexOf('export type Rule'), code.indexOf('export type Rule') + 200))
  ok(`${how}: make rule/maybe builds the case`, /\{ kind: "maybe", test: /.test(code))
  ok(`${how}: case maybe tests the case`, /\.kind === "maybe"/.test(code))

  const rust = compile({ file, text }, { resolve: resolverOf(files, 'rust'), env: 'rust' })
  ok(`${how}: it compiles for Rust`, rust.ok, said(rust))
  const rs = rust.ok ? emitRust(rust.program) : ''
  ok(`${how}: Rust keeps the union's name`, /enum Maybe<T>/.test(rs) && !/Maybe__form/.test(rs))
  ok(`${how}: Rust keeps the form's name, its case a variant`, /enum Rule \{/.test(rs) && /Maybe \{ test: Maybe<String>/.test(rs))
}

// ---- run on the four backends ----

const dir = mkdtempSync(join(tmpdir(), 'term-case-names-a-form-'))

for (const backend of BACKENDS) {
  const ran = runOn({ backend, program: `${RULE}\n${RUN}`, resolve: env => withNativeEnv(env, stdlibResolver()!), dir, name: 'case-maybe' })

  if (ran.form === 'skipped') {
    console.log(`skip  ${backend}  ${ran.reason}`)
    continue
  }

  ok(`${backend}: the program answers x none`, ran.form === 'ran' && ran.output === 'x none', JSON.stringify(ran).slice(0, 400))
}

// a field left out reads none on TypeScript (it read undefined, and the match on it threw)
{
  const omitted = `${RULE.replace('      bind note, make none\n', '')}\n${RUN}`
  const ran = runOn({ backend: 'typescript', program: omitted, resolve: env => withNativeEnv(env, stdlibResolver()!), dir, name: 'case-maybe-omitted' })
  ok('typescript: a need-false maybe field left out reads none', ran.form === 'ran' && ran.output === 'x none', JSON.stringify(ran).slice(0, 400))
}

// ---- a union of the user's own named like another form's case, and a record form named like one ----

{
  // the case `pair` sits in a module the entry loads but whose union it never finds, so the entry's `make pair` naming
  // the record's fields is the record form, renamed `pair__form` and exported by its written name too (decision 045)
  const files = {
    '@app/shape': `form shape\n  case circle\n    link radius, like number\n  case dot\n\nform couple\n  case pair\n    link one, like text\n  case none-yet\n\ntask area\n  take s, like shape\n  like number\n  fork case, read s\n    case circle\n      send back, read radius\n    case dot\n      send back, code 0\n  send back, code 0\n`,
  }
  const text = `load @app/shape\n  find shape\n  find area\n\nform drawing\n  case shape\n    link inner, like shape\n  case blank\n\nform pair\n  link left, like number\n  link right, like number\n\ntask run\n  like number\n  save d\n    make drawing/shape\n      bind inner\n        make circle\n          bind radius, code 2\n  save p\n    make pair\n      bind left, code 1\n      bind right, code 3\n  fork case, read d\n    case shape\n      send back\n        call add\n          call area\n            read inner\n          read p/right\n    case blank\n      send back, code 0\n  send back, code 0\n`
  const result = compile({ file: '/gate/code/draw.tree', text }, { resolve: resolverOf(files, 'node'), env: 'node' })
  ok('a loaded union named like a case: it compiles', result.ok, said(result))
  const code = result.ok ? result.typescript : ''
  ok('a loaded union named like a case keeps its name', /export type Shape =/.test(code) && !/ShapeForm/.test(code), code.slice(0, 400))
  ok('a record form named like a case is still renamed apart', /PairForm/.test(code), code.slice(0, 400))
}

console.log(`\ncase-names-a-form: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
