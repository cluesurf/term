// Small Rust type-phase shapes the CLI's entry refused (item term-self-host-001-1104 of
// term/self-host/change/001-finish-self-host, found by 1059), one program per shape (T-1091), each held through rustc
// and RUN against TypeScript's answer:
//   maybe-free     a `make(some, x)` whose type argument the checker leaves free (x read from an untyped list) was
//                  `Maybe::<()>::Some { value: x }` (E0308 expected `()`, found `Minted`: minting.tree mask-of)
//   text-display   a `mark text` form's value in a template had no `Display` (E0277 `BinaryOp` doesn't implement
//                  `std::fmt::Display`: law-english-reading.tree binary-piece and unary-piece)
//   float-inline   a whole number given to a `float` parameter of an INLINED task stayed a whole number in the body
//                  (`scale(at, 2)` as `at * 2`, E0277 cannot multiply `f64` by `{integer}`: check/eliminate.tree)
// Run: npx tsx test/compile/rust-small-shapes.ts

import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { transformSync } from 'esbuild'
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

const shapes: { name: string; text: string; want: string }[] = [
  {
    name: 'maybe-free',
    text: `load @term/base/maybe
  find maybe

load @term/base/list
  find push

form minted
  link name, like text

task first-name
  take given, like maybe, like minted
  like text
  sift given
    case some
      link value
      back value/name
    case none
      back <>

task names
  take one, like minted
  like text
  save declared, make list
  push(declared, one)
  save defaults, make hash
  walk declared
    take each
    save defaults/{first-name(make(some, each))}, true
  save out, <>
  walk defaults/keys()
    take key
    save out, key
  back out

task check
  like text
  back names(make(minted, bind(name, <n>)))
`,
    want: 'n',
  },
  {
    name: 'text-display',
    text: `form sign
  mark text
  case plus, text <+>
  case minus, text <->
  case blank

task said
  take one, like sign
  like text
  back <the sign {one}>

task check
  like text
  back <{said(make(plus))}|{said(make(minus))}|{said(make(blank))}>
`,
    want: 'the sign +|the sign -|the sign blank',
  },
  {
    name: 'float-inline',
    text: `task scaled
  take a, like float
  take k, like float
  like float
  mark private
  back multiply(a, k)

task twice
  take at, like float
  like float
  back scaled(at, 2)

task check
  like text
  back <{twice(1.5)}>
`,
    want: '3',
  },
]

const rustc = spawnSync('rustc', ['--version'], { encoding: 'utf8' })
const leanOf = (file: string): boolean => file.endsWith('shape.tree')

for (const shape of shapes) {
  const node = compile(
    { file: '/gate/code/shape.tree', text: shape.text },
    { resolve: withNativeEnv('node', stdlibResolver()!), leanOf, entryPoints: ['check'] },
  )
  if (!node.ok) {
    ok(`${shape.name}: builds for node`, false, node.diagnostics.map(d => `${d.name}: ${d.message}`).join(' | '))
    continue
  }
  const dir = mkdtempSync(join(tmpdir(), 'term-rust-small-shapes-'))
  const file = join(dir, 'module.mjs')
  writeFileSync(file, transformSync(node.typescript, { loader: 'ts', format: 'esm' }).code)
  const mod = (await import(pathToFileURL(file).href)) as { check: () => string }
  const answer = String(mod.check())
  ok(`${shape.name}: TypeScript answers`, answer === shape.want, answer)

  const built = compile(
    { file: '/gate/code/shape.tree', text: shape.text },
    { resolve: withNativeEnv('rust', stdlibResolver()!), env: 'rust', leanOf, entryPoints: ['check'] },
  )
  if (!built.ok) {
    ok(`${shape.name}: builds for rust`, false, built.diagnostics.map(d => `${d.name}: ${d.message}`).join(' | '))
    continue
  }
  const emitted = emitRust(built.program)
  const unwrap = /fn check\([^)]*\) -> std::result::Result/.test(emitted) ? '.ok().unwrap()' : ''
  const rust = `${emitted}\nfn main() {\n    print!("{}", check()${unwrap});\n}\n`
  if (rustc.status !== 0) {
    console.log(`skip  ${shape.name}: rustc  (not installed)`)
    continue
  }
  writeFileSync(join(dir, 'main.rs'), rust)
  const binary = join(dir, 'main')
  const out = spawnSync('rustc', ['--edition', '2021', '-A', 'warnings', '-o', binary, join(dir, 'main.rs')], {
    encoding: 'utf8',
  })
  const errors = out.stderr.split('\n').filter(l => /^error/.test(l))
  ok(`${shape.name}: rustc compiles it`, out.status === 0, errors.join(' | '))
  if (out.status === 0) {
    const ran = spawnSync(binary, [], { encoding: 'utf8' })
    ok(`${shape.name}: Rust answers what TypeScript does`, ran.stdout.trim() === shape.want, ran.stdout.trim())
  }
}

console.log(`\nrust-small-shapes: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
