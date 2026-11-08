// A construction of a union's case that leaves out a field the case declares `need false`. TypeScript allows the
// omission and Rust has no default for a left-out field: `make group` with only `nodes` was `Node::Group { nodes }`
// (E0063), and a case built with none of its fields, `make unknown`, was `Type::Unknown`, a value rustc refuses for a
// variant with fields (E0533). The CLI's entry met 279 and 16 such sites (finding/native-entry.md of
// term/self-host/change/001-finish-self-host, items term-self-host-001-1055 and 1057). A left-out field now takes its
// type's empty value, as a plain record's does. Held through rustc and RUN, against TypeScript's answer.
// Run: npx tsx test/compile/rust-left-out-field.ts

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

// a case with a needed field and two left out, one of them recursive, and a case with only a left-out field
const text = `load @term/base/maybe
  find maybe

form shape
  case circle
    link radius, like number
    link label
      like text
      need false
    link inner
      like maybe, like shape
      need false
  case blank
    link free
      like boolean
      need false

task size-of
  take value, like shape
  like number
  sift value
    # a left-out field is read nowhere: TypeScript holds it as undefined, Rust as the empty value
    case circle
      link radius
      back radius
    case blank
      link free
      fork test, free
        hold
          back 1
      back 2

task sizes
  like text
  save a, make(circle, bind(radius, 3))
  save b, make(blank)
  save c, make(circle, bind(radius, 1), bind(label, <ab>))
  back <{size-of(a)}|{size-of(b)}|{size-of(c)}>
`

const want = '3|2|1'
const entries = ['sizes']
const leanOf = (file: string): boolean => file.endsWith('left-out.tree')

const node = compile(
  { file: '/gate/code/left-out.tree', text },
  { resolve: withNativeEnv('node', stdlibResolver()!), leanOf, entryPoints: entries },
)

if (!node.ok) {
  ok('the program builds for node', false, node.diagnostics.map(d => `${d.name}: ${d.message}`).join(' | '))
} else {
  const dir = mkdtempSync(join(tmpdir(), 'term-rust-left-out-field-'))
  const file = join(dir, 'module.mjs')
  writeFileSync(file, transformSync(node.typescript, { loader: 'ts', format: 'esm' }).code)
  const mod = (await import(pathToFileURL(file).href)) as { sizes: () => string }
  const answer = mod.sizes()
  ok('TypeScript answers', answer === want, answer)
}

const built = compile(
  { file: '/gate/code/left-out.tree', text },
  { resolve: withNativeEnv('rust', stdlibResolver()!), env: 'rust', leanOf, entryPoints: entries },
)

if (!built.ok) {
  ok('the program builds for rust', false, built.diagnostics.map(d => `${d.name}: ${d.message}`).join(' | '))
} else {
  const emitted = emitRust(built.program)
  const unwrap = /fn sizes\(\) -> std::result::Result/.test(emitted) ? '.ok().unwrap()' : ''
  const rust = `${emitted}\nfn main() {\n    print!("{}", sizes()${unwrap});\n}\n`

  const rustc = spawnSync('rustc', ['--version'], { encoding: 'utf8' })

  if (rustc.status !== 0) {
    console.log('skip  rustc  (not installed)')
  } else {
    const dir = mkdtempSync(join(tmpdir(), 'term-rust-left-out-field-'))
    writeFileSync(join(dir, 'main.rs'), rust)
    const binary = join(dir, 'main')
    const out = spawnSync('rustc', ['--edition', '2021', '-A', 'warnings', '-o', binary, join(dir, 'main.rs')], {
      encoding: 'utf8',
    })
    const errors = out.stderr.split('\n').filter(l => /^error/.test(l))
    ok('rustc compiles it', out.status === 0, errors.join(' | '))
    ok('no construction leaves a field out (E0063)', !errors.some(l => /E0063/.test(l)), errors.filter(l => /E0063/.test(l)).join(' | '))
    ok('no case with fields is written as a value (E0533)', !errors.some(l => /E0533/.test(l)), errors.filter(l => /E0533/.test(l)).join(' | '))

    if (out.status === 0) {
      const ran = spawnSync(binary, [], { encoding: 'utf8' })
      ok('Rust answers what TypeScript does', ran.stdout.trim() === want, ran.stdout.trim())
    }
  }
}

console.log(`\nrust-left-out-field: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
